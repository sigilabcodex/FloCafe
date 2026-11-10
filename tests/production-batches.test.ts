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
  cancelProductionOrder,
  abandonProductionOrder,
  getProductionOrder,
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

  const pendingTerminalOrder = createProductionOrder(db, {
    recipeId: rollbackRecipe.id,
    plannedQuantity: 100,
    idempotencyKey: 'sauce-batch-cancelled',
    actorUserId: actor,
  }) as any;
  const cancelled = cancelProductionOrder(db, pendingTerminalOrder.id, {
    actorUserId: actor,
    reason: 'Schedule changed',
    expectedVersion: pendingTerminalOrder.version,
  }) as any;
  assertEqual(cancelled.status, 'cancelled', 'queued order can be cancelled');
  assertEqual(
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM supply_movements WHERE reference_type = ? AND reference_id = ?',
      )
      .get('production_order', pendingTerminalOrder.id).count,
    0,
    'queued cancellation creates no inventory movements',
  );
  assertEqual(
    cancelProductionOrder(db, pendingTerminalOrder.id, {
      actorUserId: actor,
      reason: 'Schedule changed',
      expectedVersion: pendingTerminalOrder.version,
    }).status,
    'cancelled',
    'queued cancellation retry is idempotent',
  );
  expectError(
    () => startProductionOrder(db, pendingTerminalOrder.id, actor, cancelled.version),
    'state_terminal',
    'cancelled order cannot be started',
  );

  const abandonOrder = createProductionOrder(db, {
    recipeId: rollbackRecipe.id,
    plannedQuantity: 100,
    idempotencyKey: 'sauce-batch-abandoned',
    actorUserId: actor,
  }) as any;
  const abandonStart = startProductionOrder(
    db,
    abandonOrder.id,
    actor,
    abandonOrder.version,
  ) as any;
  const stockBeforeAbandon = getSupply(db, tomatillo.id).stock_quantity;
  expectError(
    () =>
      abandonProductionOrder(db, abandonOrder.id, {
        actorUserId: actor,
        reason: '',
        expectedVersion: abandonStart.version,
      }),
    'reason_invalid',
    'abandonment requires a non-empty reason',
  );
  const abandoned = abandonProductionOrder(db, abandonOrder.id, {
    actorUserId: actor,
    reason: 'Batch contaminated',
    expectedVersion: abandonStart.version,
  }) as any;
  assertEqual(abandoned.status, 'abandoned', 'in-progress order can be abandoned');
  assertEqual(
    getSupply(db, tomatillo.id).stock_quantity,
    stockBeforeAbandon,
    'abandonment does not restore issued ingredients',
  );
  assertEqual(
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM supply_movements WHERE reference_type = ? AND reference_id = ?',
      )
      .get('production_order', abandonOrder.id).count,
    2,
    'abandonment adds no output or restore movements',
  );
  assertEqual(
    abandonProductionOrder(db, abandonOrder.id, {
      actorUserId: actor,
      reason: 'Batch contaminated',
      expectedVersion: abandonStart.version,
    }).status,
    'abandoned',
    'abandonment retry is idempotent',
  );
  expectError(
    () =>
      completeProductionOrder(db, abandonOrder.id, {
        actorUserId: actor,
        actualQuantity: 100,
        expectedVersion: abandoned.version,
      }),
    'state_terminal',
    'abandoned order cannot be completed',
  );

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
  db.exec(`DELETE FROM production_order_events
    WHERE production_order_id IN (SELECT id FROM production_orders WHERE status IN ('cancelled', 'abandoned'));
    DELETE FROM production_orders WHERE status IN ('cancelled', 'abandoned');`);
  const legacyMovementCount = Number(
    db.prepare('SELECT COUNT(*) AS count FROM supply_movements').get().count,
  );
  const legacyTomatilloStock = Number(getSupply(db, tomatillo.id).stock_quantity);
  const legacyOrderCount = Number(
    db.prepare('SELECT COUNT(*) AS count FROM production_orders').get().count,
  );
  const legacyEvents = db
    .prepare('SELECT * FROM production_order_events ORDER BY id')
    .all() as any[];
  const legacyEventCount = legacyEvents.length;
  db.pragma('foreign_keys = OFF');
  db.exec(`
    UPDATE supply_movements SET movement_type = 'recipe_depletion' WHERE movement_type = 'production_issue';
    UPDATE supply_movements SET movement_type = 'adjustment' WHERE movement_type = 'production_output';
    CREATE TABLE supply_movements_v126 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supply_id TEXT NOT NULL REFERENCES supplies(id),
      quantity_delta REAL NOT NULL,
      movement_type TEXT NOT NULL CHECK (movement_type IN ('receive', 'count', 'adjustment', 'waste', 'recipe_depletion', 'recipe_restore')),
      unit TEXT NOT NULL CHECK (unit IN ('each', 'g', 'kg', 'ml', 'l')),
      stock_after REAL NOT NULL,
      reason TEXT,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      reference_type TEXT,
      reference_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      unit_cost REAL DEFAULT NULL,
      total_cost REAL DEFAULT NULL,
      unit_cost_after REAL DEFAULT NULL
    );
    INSERT INTO supply_movements_v126 SELECT * FROM supply_movements;
    DROP TABLE supply_movements;
    ALTER TABLE supply_movements_v126 RENAME TO supply_movements;
    CREATE INDEX idx_supply_movements_supply_created ON supply_movements(supply_id, created_at, id);
    CREATE INDEX idx_supply_movements_reference ON supply_movements(reference_type, reference_id);
    CREATE INDEX idx_supply_movements_created ON supply_movements(created_at, id);

    DROP TABLE production_order_events;
    CREATE TABLE production_orders_v126 (
      id TEXT PRIMARY KEY,
      prep_recipe_id TEXT NOT NULL REFERENCES prep_recipes(id),
      output_supply_id TEXT NOT NULL REFERENCES supplies(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed')),
      planned_quantity REAL NOT NULL CHECK (planned_quantity > 0),
      actual_quantity REAL CHECK (actual_quantity > 0),
      snapshot_json TEXT NOT NULL,
      total_input_cost REAL,
      cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1)),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      created_by TEXT NOT NULL REFERENCES users(id),
      started_by TEXT REFERENCES users(id),
      completed_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );
    INSERT INTO production_orders_v126
      (id, prep_recipe_id, output_supply_id, idempotency_key, status, planned_quantity, actual_quantity,
       snapshot_json, total_input_cost, cost_known, version, created_by, started_by, completed_by,
       created_at, started_at, completed_at)
    SELECT id, prep_recipe_id, output_supply_id, idempotency_key, status, planned_quantity, actual_quantity,
       snapshot_json, total_input_cost, cost_known, version, created_by, started_by, completed_by,
       created_at, started_at, completed_at
    FROM production_orders WHERE status IN ('queued', 'in_progress', 'completed');
    DROP TABLE production_orders;
    ALTER TABLE production_orders_v126 RENAME TO production_orders;
    CREATE INDEX idx_production_orders_status_created ON production_orders(status, created_at);
    CREATE TABLE production_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      production_order_id TEXT NOT NULL REFERENCES production_orders(id),
      action TEXT NOT NULL CHECK (action IN ('created', 'started', 'completed')),
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(production_order_id, action)
    );
  `);
  const restoreLegacyEvent = db.prepare(`INSERT INTO production_order_events
    (id, production_order_id, action, actor_user_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const event of legacyEvents) {
    if (['created', 'started', 'completed'].includes(event.action)) {
      restoreLegacyEvent.run(
        event.id,
        event.production_order_id,
        event.action,
        event.actor_user_id,
        event.details_json,
        event.created_at,
      );
    }
  }
  db.pragma('user_version = 126');
  db.pragma('foreign_keys = ON');
  closeDatabase();
  initDatabase();
  const upgradedDb = getDatabase();
  assertEqual(
    upgradedDb.pragma('user_version', { simple: true }),
    127,
    'v126 temporary database upgrades to v127',
  );
  assertEqual(
    getSupply(upgradedDb, tomatillo.id).stock_quantity,
    legacyTomatilloStock,
    'v126 migration preserves existing supply stock',
  );
  assertEqual(
    upgradedDb
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('prep_recipes', 'production_orders', 'production_order_events')",
      )
      .get().count,
    3,
    'v127 retains all production tables',
  );
  assertEqual(
    upgradedDb.pragma('foreign_key_check').length,
    0,
    'upgraded temporary database has no foreign key violations',
  );
  assertEqual(
    Number(upgradedDb.prepare('SELECT COUNT(*) AS count FROM supply_movements').get().count),
    legacyMovementCount,
    'v127 preserves every v126 supply movement',
  );
  assertEqual(
    Number(upgradedDb.prepare('SELECT COUNT(*) AS count FROM production_orders').get().count),
    legacyOrderCount,
    'v127 preserves v126 production orders and snapshots',
  );
  assertEqual(
    Number(upgradedDb.prepare('SELECT COUNT(*) AS count FROM production_order_events').get().count),
    legacyEventCount,
    'v127 preserves all events for v126 terminal-compatible orders',
  );
  const movementCheck = String(
    (
      upgradedDb
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'supply_movements'")
        .get() as { sql: string }
    ).sql,
  );
  assert(
    movementCheck.includes('production_issue') && movementCheck.includes('production_output'),
    'v127 movement constraint includes production types',
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
