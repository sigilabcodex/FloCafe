/**
 * Production API and sale integration test.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/production-api.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-production-api-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  seedTable,
  api,
  assert,
  assertEqual,
  getResults,
  resetCounters,
  closeDatabase,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const jwt = require('jsonwebtoken');
const { registerRoutes } = require('../main/routes/index');
const { createSupply, getSupply } = require('../main/services/supplies');

function addRoleUser(db: any, id: string, role: string) {
  db.prepare(`INSERT INTO users
    (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(
    id,
    id,
    `${id}@test.local`,
    'not-used',
    role,
  );
  const token = jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), {
    expiresIn: '1h',
  });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  resetCounters();
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const chefHeaders = addRoleUser(db, 'chef-production-test', 'chef');
  const cashierHeaders = addRoleUser(db, 'cashier-production-test', 'cashier');
  seedCategory(db, 'cat-production-api', 'Production API');
  seedProduct(db, 'prod-chilaquiles-test', 'cat-production-api', 'Chilaquiles TEST', 150, {
    track_inventory: false,
    stock_quantity: 0,
  });
  seedTable(db, 'tbl-production-api', 1, 4);

  const tomatillo = createSupply(db, {
    name: 'Tomatillo API TEST',
    baseUnit: 'g',
    stockQuantity: 3000,
    unitCost: 0.05,
    actorUserId: owner.userId,
  });
  const onion = createSupply(db, {
    name: 'Onion API TEST',
    baseUnit: 'g',
    stockQuantity: 250,
    unitCost: 0.02,
    actorUserId: owner.userId,
  });
  const salsa = createSupply(db, {
    name: 'Salsa verde API TEST',
    baseUnit: 'g',
    stockQuantity: 0,
    actorUserId: owner.userId,
  });

  const { orderRoutes } = require('../main/routes/orders');
  const { orderItemRoutes } = require('../main/routes/order-items');
  const app = createApp({ '/api/orders': orderRoutes, '/api/order-items': orderItemRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    const cashierOrders = await api(baseUrl, '/api/production/orders', { headers: cashierHeaders });
    assertEqual(cashierOrders.status, 403, 'cashier cannot view production orders');
    const cashierCreate = await api(baseUrl, '/api/production/orders', {
      method: 'POST',
      headers: cashierHeaders,
      body: {},
    });
    assertEqual(cashierCreate.status, 403, 'cashier cannot create production orders');
    const cashierRecipe = await api(baseUrl, `/api/production/recipes/${salsa.id}/versions`, {
      method: 'POST',
      headers: cashierHeaders,
      body: {},
    });
    assertEqual(cashierRecipe.status, 403, 'cashier cannot manage preparation recipes');

    const chefOrders = await api(baseUrl, '/api/production/orders', { headers: chefHeaders });
    assertEqual(chefOrders.status, 200, 'chef can view production orders');
    const chefManage = await api(baseUrl, `/api/production/recipes/${salsa.id}/versions`, {
      method: 'POST',
      headers: chefHeaders,
      body: {},
    });
    assertEqual(chefManage.status, 403, 'chef cannot manage recipe versions');

    const createRecipe = await api(baseUrl, `/api/production/recipes/${salsa.id}/versions`, {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        yield_quantity: 2000,
        components: [
          { supply_id: tomatillo.id, quantity: 2200, unit: 'g' },
          { supply_id: onion.id, quantity: 100, unit: 'g' },
        ],
      },
    });
    assertEqual(createRecipe.status, 201, 'owner creates a preparation recipe version');
    const recipe = createRecipe.data.recipe;
    const malformedRecipe = await api(baseUrl, `/api/production/recipes/${salsa.id}/versions`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { yield_quantity: 1, components: [null] },
    });
    assertEqual(malformedRecipe.status, 400, 'malformed recipe components are rejected');

    const invalidStatus = await api(baseUrl, '/api/production/orders?status=unknown', {
      headers: owner.authHeader,
    });
    assertEqual(invalidStatus.status, 400, 'invalid production status filter is rejected');
    const invalidVersion = await api(baseUrl, '/api/production/orders/not-real/start', {
      method: 'POST',
      headers: owner.authHeader,
      body: { expected_version: -1 },
    });
    assertEqual(invalidVersion.status, 400, 'invalid expected version is rejected');

    const createOrder = await api(baseUrl, '/api/production/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        recipe_id: recipe.id,
        planned_quantity: 2000,
        idempotency_key: 'kalali-salsa-api-001',
      },
    });
    assertEqual(createOrder.status, 201, 'owner creates a production order');
    const order = createOrder.data.order;
    const start = await api(baseUrl, `/api/production/orders/${order.id}/start`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { expected_version: order.version },
    });
    assertEqual(start.status, 200, 'production order starts');
    assertEqual(getSupply(db, tomatillo.id).stock_quantity, 800, 'start consumes 2200 g tomatillo');
    assertEqual(getSupply(db, onion.id).stock_quantity, 150, 'start consumes 100 g onion');

    const completion = await api(baseUrl, `/api/production/orders/${order.id}/complete`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { expected_version: start.data.order.version, actual_quantity: 1800 },
    });
    assertEqual(completion.status, 200, 'production order completes with actual yield');
    assertEqual(
      getSupply(db, salsa.id).stock_quantity,
      1800,
      'production credits actual 1800 g salsa',
    );

    const salesRecipe = await api(baseUrl, '/api/recipes/product/prod-chilaquiles-test', {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        yield_quantity: 1,
        items: [{ supply_id: salsa.id, quantity: 165, unit: 'g' }],
      },
    });
    assertEqual(salesRecipe.status, 200, 'chilaquiles sale recipe accepts 165 g salsa');
    const sale = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-production-api',
        items: [{ product_id: 'prod-chilaquiles-test', quantity: 1 }],
      },
    });
    assertEqual(sale.status, 201, 'chilaquiles order is created after production');
    assertEqual(
      getSupply(db, salsa.id).stock_quantity,
      1635,
      'sale consumes 165 g from produced salsa',
    );

    const movements = await api(baseUrl, `/api/production/orders/${order.id}/movements`, {
      headers: owner.authHeader,
    });
    assertEqual(movements.status, 200, 'production order movements are queryable');
    assertEqual(
      movements.data.movements.length,
      3,
      'production order lists two issues and one output',
    );
    assert(
      movements.data.movements.some(
        (movement: any) => movement.movement_type === 'production_issue',
      ),
      'issue movement has a production-specific type',
    );
    assert(
      movements.data.movements.some(
        (movement: any) =>
          movement.movement_type === 'production_output' && movement.total_cost !== null,
      ),
      'output movement includes cost data',
    );
    const events = await api(baseUrl, `/api/production/orders/${order.id}/events`, {
      headers: owner.authHeader,
    });
    assertEqual(events.data.events.length, 3, 'creation, start and completion are auditable');
    const historyFilter = await api(
      baseUrl,
      '/api/supplies/movements?movement_type=production_output',
      {
        headers: owner.authHeader,
      },
    );
    assertEqual(historyFilter.status, 200, 'supply history accepts production movement filters');

    const queuedOrder = await api(baseUrl, '/api/production/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        recipe_id: recipe.id,
        planned_quantity: 100,
        idempotency_key: 'kalali-cancel-pending',
      },
    });
    const cancelQueued = await api(
      baseUrl,
      `/api/production/orders/${queuedOrder.data.order.id}/cancel`,
      {
        method: 'POST',
        headers: owner.authHeader,
        body: { expected_version: queuedOrder.data.order.version, reason: 'Plan changed' },
      },
    );
    assertEqual(cancelQueued.status, 200, 'owner cancels a queued batch');
    assertEqual(
      cancelQueued.data.order.status,
      'cancelled',
      'cancel endpoint returns terminal state',
    );
    const queuedMovements = await api(
      baseUrl,
      `/api/production/orders/${queuedOrder.data.order.id}/movements`,
      { headers: owner.authHeader },
    );
    assertEqual(
      queuedMovements.data.movements.length,
      0,
      'queued API cancellation has no movements',
    );

    const activeOrder = await api(baseUrl, '/api/production/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        recipe_id: recipe.id,
        planned_quantity: 100,
        idempotency_key: 'kalali-abandon-active',
      },
    });
    const activeStart = await api(
      baseUrl,
      `/api/production/orders/${activeOrder.data.order.id}/start`,
      {
        method: 'POST',
        headers: owner.authHeader,
        body: { expected_version: activeOrder.data.order.version },
      },
    );
    const stockAfterIssue = getSupply(db, tomatillo.id).stock_quantity;
    const abandonNoReason = await api(
      baseUrl,
      `/api/production/orders/${activeOrder.data.order.id}/abandon`,
      {
        method: 'POST',
        headers: owner.authHeader,
        body: { expected_version: activeStart.data.order.version, reason: '  ' },
      },
    );
    assertEqual(abandonNoReason.status, 400, 'abandon endpoint requires a reason');
    const abandon = await api(
      baseUrl,
      `/api/production/orders/${activeOrder.data.order.id}/abandon`,
      {
        method: 'POST',
        headers: owner.authHeader,
        body: { expected_version: activeStart.data.order.version, reason: 'Quality check failed' },
      },
    );
    assertEqual(abandon.status, 200, 'owner can abandon an in-progress batch');
    assertEqual(abandon.data.order.status, 'abandoned', 'abandon endpoint returns terminal state');
    assertEqual(
      getSupply(db, tomatillo.id).stock_quantity,
      stockAfterIssue,
      'abandon endpoint does not restore ingredients',
    );
    const abandonedCompletion = await api(
      baseUrl,
      `/api/production/orders/${activeOrder.data.order.id}/complete`,
      {
        method: 'POST',
        headers: owner.authHeader,
        body: { expected_version: abandon.data.order.version, actual_quantity: 100 },
      },
    );
    assertEqual(abandonedCompletion.status, 409, 'abandoned batch cannot later be completed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`${results.passed}/${results.total} passed, ${results.failed} failed`);
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
