const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kalali-pilot-'));
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
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  resetCounters,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const manifest = require('../scripts/kalali-import-v1/kalali-v1-pilot.json');
const {
  validateKalaliPilot,
  applyKalaliPilot,
  calculateKalaliCostScenario,
} = require('../main/services/kalali-catalog-import');
const { getSupply } = require('../main/services/supplies');
const {
  createProductionOrder,
  startProductionOrder,
  completeProductionOrder,
} = require('../main/services/production');
const { getRecipe } = require('../main/services/recipes');

function iid(entity: string, externalId: string) {
  return `kal_${require('crypto').createHash('sha256').update(`${entity}:${externalId}`).digest('hex').slice(0, 20)}`;
}

async function main() {
  console.log('Kalali pilot import integration');
  resetCounters();
  const db = initTestDb();
  const { userId, authHeader } = seedOwnerUser(db);
  seedTable(db, 'tbl-kalali-pilot', 71, 4);

  const dry = validateKalaliPilot(manifest);
  assertOrThrow(dry.valid, 'manifest references and units validate');
  assertEqualOrThrow(dry.counts.products, 6, 'six pilot products are represented');
  assertOrThrow(
    dry.pending.length >= 10,
    'incomplete preparations, recipes, and modifiers remain pending',
  );
  const scenario = calculateKalaliCostScenario({
    ingredientCost: 3.38,
    packagingCost: 1,
    directPrice: 85,
    appPrice: 122,
    commissionRate: 0.3,
    taxRetentionRate: null,
  });
  assertEqualOrThrow(
    scenario.direct_cost,
    4.38,
    'ingredient and packaging cost are separate but sum to direct cost',
  );
  assertEqualOrThrow(
    scenario.channel_commission_scenario,
    36.6,
    'app commission is a scenario only',
  );
  assertEqualOrThrow(
    scenario.channel_contribution_estimate,
    81.02,
    'contribution excludes tax retention',
  );
  assertEqualOrThrow(scenario.tax_retention_estimate, null, 'tax retention is not fabricated');
  const incompleteCost = calculateKalaliCostScenario({
    ingredientCost: null,
    packagingCost: null,
    directPrice: 85,
    appPrice: 122,
    commissionRate: 0.3,
  });
  assertEqualOrThrow(
    incompleteCost.direct_cost,
    null,
    'unknown ingredients and packaging do not become zero cost',
  );
  assertEqualOrThrow(
    incompleteCost.channel_contribution_estimate,
    null,
    'contribution stays unknown when any cost is missing',
  );

  const invalid = structuredClone(manifest);
  invalid.products[0].category_id = 'NO-SUCH-CATEGORY';
  let rejected = false;
  try {
    applyKalaliPilot(db, invalid, { actorUserId: userId, testOnly: true });
  } catch {
    rejected = true;
  }
  assertOrThrow(rejected, 'invalid manifest is rejected before writes');
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS c FROM catalog_external_references').get().c,
    0,
    'rejected manifest leaves no external references',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS c FROM supplies').get().c,
    0,
    'rejected manifest leaves no supplies',
  );

  const syntheticCosts: Record<string, any> = {};
  if (process.env.KALALI_V1_COSTS_FILE) {
    const costFile = require(path.resolve(process.env.KALALI_V1_COSTS_FILE));
    const unitFactor: Record<string, number> = { each: 1, g: 1, kg: 1000, ml: 1, l: 1000 };
    for (const quote of costFile.references) {
      const supply = manifest.supplies.find((row: any) => row.external_id === quote.supply_id);
      if (!supply || !unitFactor[quote.package_unit] || !unitFactor[supply.base_unit])
        throw new Error(`Invalid private cost reference for ${quote.supply_id}`);
      const normalizedQuantity =
        (quote.package_quantity * unitFactor[quote.package_unit]) / unitFactor[supply.base_unit];
      syntheticCosts[quote.supply_id] = {
        unit_cost: quote.amount / normalizedQuantity,
        unit: supply.base_unit,
        status: costFile.source_status,
        source_ref: quote.source_ref,
        observed_at: costFile.observed_at,
        supplier: quote.supplier,
        brand: quote.brand,
        test_only: false,
      };
    }
  } else {
    for (const supply of manifest.supplies)
      syntheticCosts[supply.external_id] = {
        unit_cost: supply.base_unit === 'g' ? 0.01 : supply.base_unit === 'ml' ? 0.01 : 0.1,
        unit: supply.base_unit,
        status: 'provisional',
        source_ref: 'synthetic test fixture; not a Kalali quote',
        test_only: true,
      };
    syntheticCosts['ING-CAF'] = {
      unit_cost: 0.5,
      unit: 'g',
      status: 'provisional',
      source_ref: 'synthetic test fixture; not a Kalali quote',
      test_only: true,
    };
  }
  const applied = applyKalaliPilot(db, manifest, {
    actorUserId: userId,
    testOnly: true,
    costs: syntheticCosts,
  });
  assertEqualOrThrow(applied.outcome, 'applied', 'pilot applies only with explicit testOnly flag');
  assertEqualOrThrow(
    applied.created.products,
    6,
    'all six products are recorded in the isolated database',
  );
  assertEqualOrThrow(applied.created.recipes, 4, 'four complete recipes are attached');
  assertEqualOrThrow(
    applied.created.preparations,
    1,
    'only the measured-for-test espresso preparation is created',
  );
  assertEqualOrThrow(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM catalog_external_references WHERE source_system = 'kalali'",
      )
      .get().c,
    54,
    'external IDs are retained for imported and pending records',
  );
  const externalRefs = db
    .prepare(
      "SELECT target_type, target_id FROM catalog_external_references WHERE source_system = 'kalali'",
    )
    .all();
  const targetTables: Record<string, string> = {
    category: 'categories',
    supply: 'supplies',
    product: 'products',
    recipe: 'recipes',
    prep_recipe: 'prep_recipes',
    preparation_pending: 'supplies',
    recipe_pending: 'products',
  };
  const danglingTargets = externalRefs.filter(
    (ref: any) =>
      targetTables[ref.target_type] &&
      !db.prepare(`SELECT 1 FROM ${targetTables[ref.target_type]} WHERE id = ?`).get(ref.target_id),
  );
  assertEqualOrThrow(
    danglingTargets.length,
    0,
    'all external references to FloCafe entities resolve',
  );
  const repeated = applyKalaliPilot(db, manifest, {
    actorUserId: userId,
    testOnly: true,
    costs: syntheticCosts,
  });
  assertEqualOrThrow(
    repeated.outcome,
    'no-op',
    're-execution with identical fingerprint is idempotent',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS c FROM products').get().c,
    6,
    'idempotent run creates no duplicate products',
  );
  const changedCosts = structuredClone(syntheticCosts);
  changedCosts['ING-CAF'].unit_cost *= 2;
  let changedCostRejected = false;
  try {
    applyKalaliPilot(db, manifest, { actorUserId: userId, testOnly: true, costs: changedCosts });
  } catch {
    changedCostRejected = true;
  }
  assertOrThrow(
    changedCostRejected,
    'changed cost references are rejected instead of overwriting imported costs',
  );
  assertEqualOrThrow(
    getSupply(db, iid('supply', 'ING-CAF')).unit_cost,
    syntheticCosts['ING-CAF'].unit_cost,
    'rejected cost re-run leaves the original imported cost intact',
  );
  assertEqualOrThrow(
    db.prepare('SELECT COUNT(*) AS c FROM products WHERE is_active = 1').get().c,
    4,
    'two incomplete products stay inactive',
  );
  const refs = db
    .prepare(
      "SELECT source_status, target_id FROM catalog_external_references WHERE source_entity = 'product' AND external_id = 'KAL-BEB-002'",
    )
    .get();
  assertEqualOrThrow(
    refs.source_status,
    'historical',
    'historical source status remains historical in external reference',
  );
  assertOrThrow(
    refs.target_id !== 'KAL-BEB-002',
    'FloCafe internal product key differs from stable Kalali key',
  );
  const coffeeRef = db
    .prepare(
      "SELECT metadata_json FROM catalog_external_references WHERE source_entity = 'supply' AND external_id = 'ING-CAF'",
    )
    .get();
  const coffeeMetadata = JSON.parse(coffeeRef.metadata_json);
  assertEqualOrThrow(
    coffeeMetadata.cost_status,
    'provisional',
    'coffee quote keeps its provisional state',
  );
  assertEqualOrThrow(coffeeMetadata.cost_observed_at, null, 'missing quote date is kept missing');
  if (process.env.KALALI_V1_COSTS_FILE) {
    const goudaMetadata = JSON.parse(
      db
        .prepare(
          "SELECT metadata_json FROM catalog_external_references WHERE source_entity = 'supply' AND external_id = 'ING-QUES-GOU'",
        )
        .get().metadata_json,
    );
    assertEqualOrThrow(
      goudaMetadata.cost_brand,
      'Chipilo',
      'brand attribution stays on the provisional cost reference',
    );
  }

  const coffeeId = iid('supply', 'ING-CAF');
  const espressoPrepId = iid('supply', 'PREP-ESP-DOB');
  const prepRecipe = db
    .prepare('SELECT id FROM prep_recipes WHERE output_supply_id = ? AND is_active = 1')
    .get(espressoPrepId);
  assertOrThrow(prepRecipe, 'espresso double has an active test preparation recipe');
  const order = createProductionOrder(db, {
    recipeId: prepRecipe.id,
    plannedQuantity: 1,
    idempotencyKey: 'kalali-v1-test-espresso-double',
    actorUserId: userId,
  });
  const started = startProductionOrder(db, order.id, userId, order.version);
  completeProductionOrder(db, order.id, {
    actualQuantity: 1,
    actorUserId: userId,
    expectedVersion: started.version,
  });
  assertEqualOrThrow(
    getSupply(db, coffeeId).stock_quantity,
    88,
    'production issues 12 g coffee exactly once',
  );
  assertEqualOrThrow(
    getSupply(db, espressoPrepId).stock_quantity,
    1,
    'production yields one test espresso double',
  );
  const productId = iid('product', 'KAL-BEB-002');
  const recipe = getRecipe(
    db,
    db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId).id,
  );
  assertOrThrow(recipe?.cost_known, 'espresso product recipe has a known test cost reference');
  const expectedEspressoCost = Math.round(12 * syntheticCosts['ING-CAF'].unit_cost * 100) / 100;
  assertEqualOrThrow(
    recipe.unit_cost,
    expectedEspressoCost,
    'espresso recipe cost equals 12 g times its input unit-cost reference',
  );

  const { orderRoutes } = require('../main/routes/orders');
  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const sale = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-kalali-pilot',
        items: [{ product_id: productId, quantity: 1 }],
      },
    });
    assertEqualOrThrow(sale.status, 201, 'test espresso sale is accepted by FloCafe order API');
    const item = db
      .prepare('SELECT ingredient_cost, ingredient_cost_known FROM order_items WHERE order_id = ?')
      .get(sale.data.order.id);
    assertEqualOrThrow(
      item.ingredient_cost,
      expectedEspressoCost,
      'order captures the recipe ingredient cost',
    );
    assertEqualOrThrow(item.ingredient_cost_known, 1, 'order marks recipe cost as known');
    assertEqualOrThrow(
      getSupply(db, espressoPrepId).stock_quantity,
      0,
      'sale consumes one prepared portion',
    );
    assertEqualOrThrow(
      getSupply(db, coffeeId).stock_quantity,
      88,
      'sale does not consume coffee a second time',
    );
    assertEqualOrThrow(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM supply_movements WHERE supply_id = ? AND movement_type = 'recipe_depletion'",
        )
        .get(espressoPrepId).c,
      1,
      'sale records exactly one recipe depletion for prepared espresso',
    );
    assertEqualOrThrow(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM supply_movements WHERE supply_id = ? AND movement_type = 'production_issue'",
        )
        .get(coffeeId).c,
      1,
      'coffee is issued exactly once during production',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const results = getResults();
  if (results.failed) throw new Error(`${results.failed} Kalali pilot assertions failed.`);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(`Passed ${results.passed} Kalali pilot assertions.`);
}

main().catch((error: unknown) => {
  console.error(error);
  try {
    closeDatabase();
  } catch {}
  process.exitCode = 1;
});
