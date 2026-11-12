/**
 * Configurable production process and stage execution tests.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/production-processes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-production-processes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  assert,
  assertEqual,
  getResults,
  resetCounters,
  closeDatabase,
  seedOwnerUser,
} = require('./helpers/test-setup');
const { getDatabase, initDatabase } = require('../main/db');
const { createSupply, getSupply, listSupplyMovements } = require('../main/services/supplies');
const {
  abandonProductionOrder,
  completeProductionOrder,
  createPrepRecipeVersion,
  createProductionOrder,
  createProductionProcessVersion,
  getProductionOrder,
  listProductionOrderSteps,
  listProductionStepEvents,
  startProductionOrder,
  transitionProductionOrderStep,
} = require('../main/services/production');

function expectError(fn: () => unknown, code: string, label: string) {
  try {
    fn();
    assert(false, `${label} should fail`);
  } catch (error: any) {
    assertEqual(error?.diagnosticCode, code, label);
  }
}

function completeStep(db: any, orderId: string, step: any, actor: string, suffix: string) {
  const started = transitionProductionOrderStep(db, orderId, step.id, {
    action: 'start',
    actorUserId: actor,
    expectedVersion: step.version,
    idempotencyKey: `${suffix}:start`,
  });
  return transitionProductionOrderStep(db, orderId, step.id, {
    action: 'complete',
    actorUserId: actor,
    expectedVersion: started.version,
    idempotencyKey: `${suffix}:complete`,
    verificationResult: step.step_type === 'check' ? 'passed' : undefined,
  });
}

function simulateV127(db: any) {
  const beforeOrder = db
    .prepare('SELECT * FROM production_orders ORDER BY created_at LIMIT 1')
    .get();
  const beforeEvents = db.prepare('SELECT * FROM production_order_events ORDER BY id').all();
  const beforeMovements = db.prepare('SELECT * FROM supply_movements ORDER BY id').all();
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE production_step_events;
    DROP TABLE production_order_steps;
    DROP TABLE production_process_steps;
    DROP TABLE production_process_versions;
    DROP TABLE production_order_events;
    CREATE TABLE production_orders_v127 (
      id TEXT PRIMARY KEY,
      prep_recipe_id TEXT NOT NULL REFERENCES prep_recipes(id),
      output_supply_id TEXT NOT NULL REFERENCES supplies(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed', 'cancelled', 'abandoned')),
      planned_quantity REAL NOT NULL CHECK (planned_quantity > 0),
      actual_quantity REAL CHECK (actual_quantity > 0),
      snapshot_json TEXT NOT NULL,
      total_input_cost REAL,
      cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1)),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      created_by TEXT NOT NULL REFERENCES users(id),
      started_by TEXT REFERENCES users(id),
      completed_by TEXT REFERENCES users(id),
      cancelled_by TEXT REFERENCES users(id),
      abandoned_by TEXT REFERENCES users(id),
      terminal_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      abandoned_at TEXT
    );
    INSERT INTO production_orders_v127 (
      id, prep_recipe_id, output_supply_id, idempotency_key, status, planned_quantity,
      actual_quantity, snapshot_json, total_input_cost, cost_known, version,
      created_by, started_by, completed_by, cancelled_by, abandoned_by, terminal_reason,
      created_at, started_at, completed_at, cancelled_at, abandoned_at
    ) SELECT
      id, prep_recipe_id, output_supply_id, idempotency_key, status, planned_quantity,
      actual_quantity, snapshot_json, total_input_cost, cost_known, version,
      created_by, started_by, completed_by, cancelled_by, abandoned_by, terminal_reason,
      created_at, started_at, completed_at, cancelled_at, abandoned_at
    FROM production_orders;
    DROP TABLE production_orders;
    ALTER TABLE production_orders_v127 RENAME TO production_orders;
    CREATE INDEX idx_production_orders_status_created ON production_orders(status, created_at);
    CREATE TABLE production_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      production_order_id TEXT NOT NULL REFERENCES production_orders(id),
      action TEXT NOT NULL CHECK (action IN ('created', 'started', 'completed', 'cancelled', 'abandoned')),
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(production_order_id, action)
    );
  `);
  const restoreEvent = db.prepare(`INSERT INTO production_order_events
    (id, production_order_id, action, actor_user_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const event of beforeEvents) {
    restoreEvent.run(
      event.id,
      event.production_order_id,
      event.action,
      event.actor_user_id,
      event.details_json,
      event.created_at,
    );
  }
  db.pragma('user_version = 127');
  db.pragma('foreign_keys = ON');
  return { beforeOrder, beforeEvents, beforeMovements };
}

function main() {
  console.log('Production process test');
  resetCounters();
  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  const flour = createSupply(db, {
    name: 'Brioche flour TEST',
    baseUnit: 'g',
    stockQuantity: 5000,
    unitCost: 0.01,
    actorUserId: actor,
  });
  const brioche = createSupply(db, {
    name: 'Brioche TEST',
    baseUnit: 'g',
    stockQuantity: 0,
    actorUserId: actor,
  });
  const recipe = createPrepRecipeVersion(db, {
    outputSupplyId: brioche.id,
    yieldQuantity: 100,
    components: [{ supplyId: flour.id, quantity: 100, unit: 'g' }],
    actorUserId: actor,
  }) as any;

  const simpleProcess = createProductionProcessVersion(db, {
    recipeId: recipe.id,
    name: 'Producir brioche',
    actorUserId: actor,
    steps: [
      {
        step_key: 'produce',
        name: 'Producir brioche',
        type: 'operation',
        planned_duration_minutes: 120,
      },
    ],
  }) as any;
  assertEqual(simpleProcess.version, 1, 'first process version is version 1');
  assertEqual(simpleProcess.steps.length, 1, 'simple brioche process has one step');

  expectError(
    () =>
      createProductionProcessVersion(db, {
        recipeId: recipe.id,
        name: 'Cycle',
        actorUserId: actor,
        steps: [
          { step_key: 'a', name: 'A', type: 'operation', dependencies: ['b'] },
          { step_key: 'b', name: 'B', type: 'operation', dependencies: ['a'] },
        ],
      }),
    'process_dependency_cycle',
    'cyclic process dependencies are rejected',
  );
  expectError(
    () =>
      createProductionProcessVersion(db, {
        recipeId: recipe.id,
        name: 'Missing dependency',
        actorUserId: actor,
        steps: [{ step_key: 'a', name: 'A', type: 'operation', dependencies: ['missing'] }],
      }),
    'process_dependency_missing',
    'unknown process dependencies are rejected',
  );

  const simpleOrder = createProductionOrder(db, {
    recipeId: recipe.id,
    plannedQuantity: 100,
    idempotencyKey: 'brioche-simple-order',
    actorUserId: actor,
  }) as any;
  assertEqual(
    simpleOrder.process_version_id,
    simpleProcess.id,
    'new order selects active process version',
  );
  const simpleStep = listProductionOrderSteps(db, simpleOrder.id)[0];
  assertEqual(simpleStep.name, 'Producir brioche', 'order snapshots simple step definition');

  const detailedProcess = createProductionProcessVersion(db, {
    recipeId: recipe.id,
    name: 'Brioche detallado (ilustrativo)',
    actorUserId: actor,
    steps: [
      {
        step_key: 'weigh',
        name: 'Pesar ingredientes',
        type: 'operation',
        planned_duration_minutes: 5,
      },
      {
        step_key: 'knead',
        name: 'Amasar',
        type: 'operation',
        planned_duration_minutes: 12,
        dependencies: ['weigh'],
        suggested_role: 'chef',
        resource: 'Batidora 1',
      },
      {
        step_key: 'bulk-ferment',
        name: 'Fermentación en bloque',
        type: 'wait',
        planned_duration_minutes: 90,
        dependencies: ['knead'],
      },
      {
        step_key: 'shape',
        name: 'Dividir y formar',
        type: 'operation',
        planned_duration_minutes: 10,
        dependencies: ['bulk-ferment'],
      },
      {
        step_key: 'proof',
        name: 'Fermentación final',
        type: 'wait',
        planned_duration_minutes: 60,
        dependencies: ['shape'],
      },
      {
        step_key: 'egg-wash',
        name: 'Aplicar barniz',
        type: 'operation',
        dependencies: ['shape'],
        optional: true,
      },
      {
        step_key: 'bake',
        name: 'Hornear',
        type: 'operation',
        planned_duration_minutes: 18,
        dependencies: ['proof', 'egg-wash'],
        resource: 'Horno B',
      },
      {
        step_key: 'cool',
        name: 'Enfriar',
        type: 'wait',
        planned_duration_minutes: 30,
        dependencies: ['bake'],
      },
      {
        step_key: 'quality',
        name: 'Verificar y registrar rendimiento',
        type: 'check',
        dependencies: ['cool'],
        verification_prompt: 'Registrar color y rendimiento',
      },
    ],
  }) as any;
  assertEqual(detailedProcess.version, 2, 'second process template increments version');
  assertEqual(
    detailedProcess.steps.length,
    9,
    'detailed brioche process has nine illustrative steps',
  );
  assertEqual(
    listProductionOrderSteps(db, simpleOrder.id).length,
    1,
    'new template does not alter an existing order snapshot',
  );

  const detailedOrder = createProductionOrder(db, {
    recipeId: recipe.id,
    plannedQuantity: 100,
    idempotencyKey: 'brioche-detailed-order',
    actorUserId: actor,
  }) as any;
  const orderSteps = listProductionOrderSteps(db, detailedOrder.id);
  assertEqual(
    detailedOrder.process_version_id,
    detailedProcess.id,
    'next order snapshots the new active version',
  );
  assertEqual(orderSteps.length, 9, 'detailed order receives its own step snapshot');
  assertEqual(
    orderSteps[2].planned_duration_minutes,
    90,
    'wait duration is retained as planned metadata',
  );
  assertEqual(orderSteps[1].resource_label, 'Batidora 1', 'resource label is snapshotted');
  assertEqual(orderSteps[5].is_optional, true, 'optional step flag is snapshotted');

  const newerProcess = createProductionProcessVersion(db, {
    recipeId: recipe.id,
    name: 'Proceso simplificado actualizado',
    actorUserId: actor,
    steps: [{ step_key: 'produce', name: 'Producir brioche', type: 'operation' }],
  }) as any;
  assertEqual(newerProcess.version, 3, 'third process template is versioned');
  assertEqual(
    listProductionOrderSteps(db, detailedOrder.id).length,
    9,
    'later template version leaves detailed order snapshot unchanged',
  );

  const beforeQueueStock = getSupply(db, flour.id).stock_quantity;
  assertEqual(beforeQueueStock, 5000, 'creating process orders does not reserve ingredients');
  const startedOrder = startProductionOrder(
    db,
    detailedOrder.id,
    actor,
    detailedOrder.version,
  ) as any;
  assertEqual(getSupply(db, flour.id).stock_quantity, 4900, 'batch start deducts ingredients once');
  const movementsAfterStart = listSupplyMovements(db, { supplyId: flour.id }).movements.length;
  const current = () => listProductionOrderSteps(db, detailedOrder.id);
  const step = (key: string) => current().find((item: any) => item.step_key === key);

  expectError(
    () =>
      transitionProductionOrderStep(db, detailedOrder.id, step('knead').id, {
        action: 'start',
        actorUserId: actor,
        expectedVersion: 0,
        idempotencyKey: 'knead-before-weigh',
      }),
    'step_dependencies_incomplete',
    'a step cannot start before its dependencies',
  );
  expectError(
    () =>
      completeProductionOrder(db, detailedOrder.id, {
        actualQuantity: 90,
        actorUserId: actor,
        expectedVersion: startedOrder.version,
      }),
    'required_steps_incomplete',
    'batch cannot complete with required steps pending',
  );
  assertEqual(
    getSupply(db, brioche.id).stock_quantity,
    0,
    'premature completion does not credit output',
  );

  const weigh = step('weigh');
  const weighStarted = transitionProductionOrderStep(db, detailedOrder.id, weigh.id, {
    action: 'start',
    actorUserId: actor,
    expectedVersion: weigh.version,
    idempotencyKey: 'weigh-start',
  });
  const weighReplay = transitionProductionOrderStep(db, detailedOrder.id, weigh.id, {
    action: 'start',
    actorUserId: actor,
    expectedVersion: weigh.version,
    idempotencyKey: 'weigh-start',
  });
  assertEqual(weighReplay.replayed, true, 'same stage command is idempotent');
  expectError(
    () =>
      transitionProductionOrderStep(db, detailedOrder.id, weigh.id, {
        action: 'complete',
        actorUserId: actor,
        expectedVersion: weigh.version,
        idempotencyKey: 'weigh-start',
      }),
    'step_idempotency_conflict',
    'idempotency key cannot be reused for another action',
  );
  expectError(
    () =>
      transitionProductionOrderStep(db, detailedOrder.id, weigh.id, {
        action: 'complete',
        actorUserId: actor,
        expectedVersion: weigh.version,
        idempotencyKey: 'weigh-stale',
      }),
    'step_version_conflict',
    'stale stage version is rejected',
  );
  transitionProductionOrderStep(db, detailedOrder.id, weigh.id, {
    action: 'complete',
    actorUserId: actor,
    expectedVersion: weighStarted.version,
    idempotencyKey: 'weigh-complete',
  });

  for (const key of ['knead', 'bulk-ferment', 'shape', 'proof']) {
    const item = step(key);
    completeStep(db, detailedOrder.id, item, actor, `step-${key}`);
  }
  const eggWash = step('egg-wash');
  expectError(
    () =>
      transitionProductionOrderStep(db, detailedOrder.id, eggWash.id, {
        action: 'skip',
        actorUserId: actor,
        expectedVersion: eggWash.version,
        idempotencyKey: 'egg-wash-skip-no-reason',
      }),
    'reason_invalid',
    'skipping an optional stage requires a reason',
  );
  transitionProductionOrderStep(db, detailedOrder.id, eggWash.id, {
    action: 'skip',
    actorUserId: actor,
    expectedVersion: eggWash.version,
    idempotencyKey: 'egg-wash-skip',
    reason: 'No barniz for this batch',
  });

  const bake = step('bake');
  const bakeStarted = transitionProductionOrderStep(db, detailedOrder.id, bake.id, {
    action: 'start',
    actorUserId: actor,
    expectedVersion: bake.version,
    idempotencyKey: 'bake-start',
  });
  expectError(
    () =>
      transitionProductionOrderStep(db, detailedOrder.id, bake.id, {
        action: 'block',
        actorUserId: actor,
        expectedVersion: bakeStarted.version,
        idempotencyKey: 'bake-block-no-reason',
      }),
    'reason_invalid',
    'blocking a stage requires a reason',
  );
  const blockedBake = transitionProductionOrderStep(db, detailedOrder.id, bake.id, {
    action: 'block',
    actorUserId: actor,
    expectedVersion: bakeStarted.version,
    idempotencyKey: 'bake-block',
    reason: 'Waiting for oven availability',
  });
  expectError(
    () =>
      completeProductionOrder(db, detailedOrder.id, {
        actualQuantity: 90,
        actorUserId: actor,
        expectedVersion: getProductionOrder(db, detailedOrder.id).version,
      }),
    'required_steps_incomplete',
    'a blocked required stage prevents batch completion',
  );
  const resumedBake = transitionProductionOrderStep(db, detailedOrder.id, bake.id, {
    action: 'resume',
    actorUserId: actor,
    expectedVersion: blockedBake.version,
    idempotencyKey: 'bake-resume',
  });
  transitionProductionOrderStep(db, detailedOrder.id, bake.id, {
    action: 'complete',
    actorUserId: actor,
    expectedVersion: resumedBake.version,
    idempotencyKey: 'bake-complete',
  });
  for (const key of ['cool']) {
    const item = step(key);
    completeStep(db, detailedOrder.id, item, actor, `step-${key}`);
  }
  const quality = step('quality');
  const qualityStarted = transitionProductionOrderStep(db, detailedOrder.id, quality.id, {
    action: 'start',
    actorUserId: actor,
    expectedVersion: quality.version,
    idempotencyKey: 'quality-start',
  });
  expectError(
    () =>
      transitionProductionOrderStep(db, detailedOrder.id, quality.id, {
        action: 'complete',
        actorUserId: actor,
        expectedVersion: qualityStarted.version,
        idempotencyKey: 'quality-no-result',
      }),
    'verification_required',
    'check stages require a verification result',
  );
  const qualityComplete = transitionProductionOrderStep(db, detailedOrder.id, quality.id, {
    action: 'complete',
    actorUserId: actor,
    expectedVersion: qualityStarted.version,
    idempotencyKey: 'quality-complete',
    verificationResult: 'Passed; 91 pieces after cooling',
  });
  assertEqual(
    qualityComplete.verification_result,
    'Passed; 91 pieces after cooling',
    'verification result is audited on the step',
  );
  assertEqual(
    listSupplyMovements(db, { supplyId: flour.id }).movements.length,
    movementsAfterStart,
    'stage transitions do not create ingredient movements',
  );
  assertEqual(
    getSupply(db, brioche.id).stock_quantity,
    0,
    'stage transitions do not credit output',
  );
  assert(
    listProductionStepEvents(db, detailedOrder.id, bake.id).length === 4,
    'block, resume and bake transitions are auditable',
  );
  assert(
    listProductionStepEvents(db, detailedOrder.id).length >= 15,
    'process event history includes stage transitions',
  );

  const detailedOrderAfterStages = getProductionOrder(db, detailedOrder.id) as any;
  const completedBatch = completeProductionOrder(db, detailedOrder.id, {
    actualQuantity: 91,
    actorUserId: actor,
    expectedVersion: detailedOrderAfterStages.version,
  }) as any;
  assertEqual(completedBatch.actual_quantity, 91, 'final batch records the real yield');
  assertEqual(
    getSupply(db, brioche.id).stock_quantity,
    91,
    'finished output is credited at batch completion',
  );
  assertEqual(
    getSupply(db, flour.id).stock_quantity,
    4900,
    'only batch start consumes the ingredient',
  );

  const simpleOrderStarted = startProductionOrder(
    db,
    simpleOrder.id,
    actor,
    simpleOrder.version,
  ) as any;
  const simpleRunStep = listProductionOrderSteps(db, simpleOrder.id)[0];
  const simpleStepStarted = transitionProductionOrderStep(db, simpleOrder.id, simpleRunStep.id, {
    action: 'start',
    actorUserId: actor,
    expectedVersion: simpleRunStep.version,
    idempotencyKey: 'simple-start',
  });
  transitionProductionOrderStep(db, simpleOrder.id, simpleRunStep.id, {
    action: 'complete',
    actorUserId: actor,
    expectedVersion: simpleStepStarted.version,
    idempotencyKey: 'simple-complete',
  });
  const simpleBatch = completeProductionOrder(db, simpleOrder.id, {
    actualQuantity: 95,
    actorUserId: actor,
    expectedVersion: getProductionOrder(db, simpleOrder.id).version,
  }) as any;
  assertEqual(simpleBatch.actual_quantity, 95, 'single-step process completes a batch');
  assertEqual(
    getSupply(db, brioche.id).stock_quantity,
    186,
    'single-step output is credited normally',
  );

  const legacyOrder = createProductionOrder(db, {
    recipeId: recipe.id,
    plannedQuantity: 100,
    idempotencyKey: 'v127-legacy-order',
    actorUserId: actor,
  }) as any;
  startProductionOrder(db, legacyOrder.id, actor, legacyOrder.version);
  const migrationSnapshot = simulateV127(db);
  closeDatabase();
  initDatabase();
  const upgradedDb = getDatabase();
  assertEqual(
    upgradedDb.pragma('user_version', { simple: true }),
    128,
    'temporary v127 database upgrades to v128',
  );
  assertEqual(
    upgradedDb.pragma('foreign_key_check').length,
    0,
    'v128 upgrade has no foreign key violations',
  );
  const migratedOrder = upgradedDb
    .prepare('SELECT * FROM production_orders WHERE id = ?')
    .get(migrationSnapshot.beforeOrder.id) as any;
  assertEqual(
    migratedOrder.status,
    migrationSnapshot.beforeOrder.status,
    'v128 preserves v127 order state',
  );
  assertEqual(
    migratedOrder.process_version_id,
    null,
    'legacy order remains compatible without a process',
  );
  assertEqual(
    upgradedDb.prepare('SELECT COUNT(*) AS count FROM production_order_events').get().count,
    migrationSnapshot.beforeEvents.length,
    'v128 preserves existing order events',
  );
  assertEqual(
    upgradedDb.prepare('SELECT COUNT(*) AS count FROM supply_movements').get().count,
    migrationSnapshot.beforeMovements.length,
    'v128 preserves inventory movements',
  );
  assertEqual(
    upgradedDb.prepare('SELECT COUNT(*) AS count FROM production_order_steps').get().count,
    0,
    'v128 does not fabricate process steps for legacy orders',
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
