/**
 * Isolated production batch lifecycle tests.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/production-batches.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-production-batches-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  resetCounters,
  closeDatabase,
} = require('./helpers/test-setup');
const { getDatabase, initDatabase } = require('../main/db');
const { createSupply, getSupply, listSupplyMovements } = require('../main/services/supplies');
const {
  createPrepRecipeVersion,
  createProductionOrder,
  startProductionOrder,
  completeProductionOrder,
  getProductionOrder,
  ProductionServiceError,
} = require('../main/services/production');

function expectError(fn: () => unknown, code: string, label: string) {
  try {
    fn();
    assert(false, `${label} should fail`);
  } catch (error: any) {
    assertEqual(error?.diagnosticCode, code, label);
  }
}

function main() {
  console.log('Production batches test');
  resetCounters();
  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  const tomatillo = createSupply(db, {
    name: 'Tomatillo TEST',
    baseUnit: 'g',
    stockQuantity: 2500,
    unitCost: 0.08,
    actorUserId: actor,
  });
  const greenSauce = createSupply(db, {
    name: 'Salsa verde TEST',
    baseUnit: 'g',
    stockQuantity: 0,
    actorUserId: actor,
  });
  const onion = createSupply(db, {
    name: 'Onion TEST',
    baseUnit: 'g',
    stockQuantity: 1,
    actorUserId: actor,
  });
  const recipe = createPrepRecipeVersion(db, {
    outputSupplyId: greenSauce.id,
    yieldQuantity: 2000,
    components: [{ supplyId: tomatillo.id, quantity: 2200, unit: 'g' }],
    actorUserId: actor,
  }) as any;
  assertEqual(recipe.version, 1, 'first preparation recipe version is 1');

  const first = createProductionOrder(db, {
    recipeId: recipe.id,
    plannedQuantity: 2000,
    idempotencyKey: 'sauce-batch-001',
    actorUserId: actor,
  }) as any;
  const duplicate = createProductionOrder(db, {
    recipeId: recipe.id,
    plannedQuantity: 2000,
    idempotencyKey: 'sauce-batch-001',
    actorUserId: actor,
  }) as any;
  assertEqual(duplicate.id, first.id, 'create retry returns the original production order');
  assertEqual(
    getSupply(db, tomatillo.id).stock_quantity,
    2500,
    'queued batch does not reserve stock',
  );

  const started = startProductionOrder(db, first.id, actor, first.version) as any;
  assertEqual(started.status, 'in_progress', 'start changes production state');
  assertEqual(getSupply(db, tomatillo.id).stock_quantity, 300, 'start deducts scaled ingredients');
  const startRetry = startProductionOrder(db, first.id, actor, first.version) as any;
  assertEqual(startRetry.status, 'in_progress', 'start retry is idempotent');
  assertEqual(
    getSupply(db, tomatillo.id).stock_quantity,
    300,
    'start retry does not duplicate deduction',
  );

  expectError(
    () =>
      completeProductionOrder(db, first.id, {
        actualQuantity: 0,
        actorUserId: actor,
        expectedVersion: started.version,
      }),
    'quantity_invalid',
    'zero actual yield is rejected',
  );
  const completed = completeProductionOrder(db, first.id, {
    actualQuantity: 1850,
    actorUserId: actor,
    expectedVersion: started.version,
  }) as any;
  assertEqual(completed.status, 'completed', 'batch is completed');
  assertEqual(completed.actual_quantity, 1850, 'real yield is recorded');
  assertEqual(
    getSupply(db, greenSauce.id).stock_quantity,
    1850,
    'real output quantity is credited',
  );
  assertEqual(
    completed.total_input_cost,
    176,
    'ingredient cost is retained on the production order',
  );
  assertEqual(
    getSupply(db, greenSauce.id).unit_cost,
    Math.round((176 / 1850) * 1e10) / 1e10,
    'unit cost uses actual output at shared cost precision',
  );
  const completionRetry = completeProductionOrder(db, first.id, {
    actualQuantity: 1850,
    actorUserId: actor,
    expectedVersion: started.version,
  }) as any;
  assertEqual(completionRetry.id, first.id, 'completion retry is idempotent');
  assertEqual(
    getSupply(db, greenSauce.id).stock_quantity,
    1850,
    'completion retry does not duplicate output',
  );
  expectError(
    () =>
      completeProductionOrder(db, first.id, {
        actualQuantity: 1800,
        actorUserId: actor,
        expectedVersion: started.version,
      }),
    'completion_conflict',
    'completion replay with different yield is rejected',
  );

  const shortageRecipe = createPrepRecipeVersion(db, {
    outputSupplyId: greenSauce.id,
    yieldQuantity: 10000,
    components: [
      { supplyId: tomatillo.id, quantity: 100, unit: 'g' },
      { supplyId: onion.id, quantity: 10, unit: 'g' },
    ],
    actorUserId: actor,
  }) as any;
  const shortageOrder = createProductionOrder(db, {
    recipeId: shortageRecipe.id,
    plannedQuantity: 10000,
    idempotencyKey: 'sauce-batch-short',
    actorUserId: actor,
  }) as any;
  expectError(
    () => startProductionOrder(db, shortageOrder.id, actor, shortageOrder.version),
    'stock_insufficient',
    'insufficient stock rejects batch start',
  );
  assertEqual(
    getProductionOrder(db, shortageOrder.id).status,
    'queued',
    'failed start rolls back order state',
  );
  assertEqual(
    getSupply(db, tomatillo.id).stock_quantity,
    300,
    'failed start rolls back ingredient balance',
  );
  assertEqual(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM supply_movements WHERE reference_type = 'production_order' AND reference_id = ?",
      )
      .get(shortageOrder.id).count,
    0,
    'failed multi-component start leaves no partial movements',
  );

  const rollbackRecipe = createPrepRecipeVersion(db, {
    outputSupplyId: greenSauce.id,
    yieldQuantity: 100,
    components: [
      { supplyId: tomatillo.id, quantity: 100, unit: 'g' },
      { supplyId: onion.id, quantity: 1, unit: 'g' },
    ],
    actorUserId: actor,
  }) as any;
  const rollbackOrder = createProductionOrder(db, {
    recipeId: rollbackRecipe.id,
    plannedQuantity: 100,
    idempotencyKey: 'sauce-batch-forced-rollback',
    actorUserId: actor,
  }) as any;
  db.exec(`CREATE TEMP TRIGGER force_production_movement_failure
    BEFORE INSERT ON supply_movements
    WHEN NEW.reference_type = 'production_order' AND NEW.reference_id = '${rollbackOrder.id}'
      AND NEW.supply_id = '${onion.id}'
    BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;`);
  let forcedMovementError = false;
  try {
    startProductionOrder(db, rollbackOrder.id, actor, rollbackOrder.version);
  } catch {
    forcedMovementError = true;
  }
  assert(forcedMovementError, 'second movement insertion is forced to fail');
  assertEqual(
    getProductionOrder(db, rollbackOrder.id).status,
    'queued',
    'movement failure rolls back order status',
  );
  assertEqual(
    getSupply(db, tomatillo.id).stock_quantity,
    300,
    'movement failure rolls back the first ingredient update',
  );
  assertEqual(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM supply_movements WHERE reference_type = 'production_order' AND reference_id = ?",
      )
      .get(rollbackOrder.id).count,
    0,
    'movement failure rolls back the first ledger row',
  );
  db.exec('DROP TRIGGER force_production_movement_failure');

  const issue = listSupplyMovements(db, { supplyId: tomatillo.id }).movements.find(
    (m: any) => m.reference_id === first.id,
  );
  const output = listSupplyMovements(db, { supplyId: greenSauce.id }).movements.find(
    (m: any) => m.reference_id === first.id,
  );
  assert(issue, 'ingredient issue movement references production order');
  assertEqual(issue.quantity_delta, -2200, 'ingredient movement has negative scaled quantity');
  assert(output, 'finished output movement references production order');
  assertEqual(output.quantity_delta, 1850, 'output movement records actual yield');
  assertEqual(
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM production_order_events WHERE production_order_id = ?',
      )
      .get(first.id).count,
    3,
    'create, start, complete events are audited exactly once',
  );
  assertEqual(
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM supply_movements WHERE reference_type = ? AND reference_id = ?',
      )
      .get('production_order', first.id).count,
    2,
    'batch records two inventory movements',
  );

  console.log('--- Migration compatibility ---');
  db.pragma('foreign_keys = OFF');
  db.exec(
    'DROP TABLE production_order_events; DROP TABLE production_orders; DROP TABLE prep_recipes;',
  );
  db.pragma('user_version = 125');
  db.pragma('foreign_keys = ON');
  closeDatabase();
  initDatabase();
  const upgradedDb = getDatabase();
  assertEqual(
    upgradedDb.pragma('user_version', { simple: true }),
    126,
    'v125 temporary database upgrades to v126',
  );
  assertEqual(
    getSupply(upgradedDb, tomatillo.id).stock_quantity,
    300,
    'v126 migration preserves existing supply stock',
  );
  assertEqual(
    upgradedDb
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('prep_recipes', 'production_orders', 'production_order_events')",
      )
      .get().count,
    3,
    'v126 creates only the additive production tables',
  );
  assertEqual(
    upgradedDb.pragma('foreign_key_check').length,
    0,
    'upgraded temporary database has no foreign key violations',
  );

  const results = getResults();
  console.log(`${results.passed}/${results.total} passed, ${results.failed} failed`);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(results.failed > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(error);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
}
