/**
 * Backend product availability calculation with isolated synthetic catalog data.
 * Usage: node tests/run-electron-node-test.cjs tests/product-availability.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-availability-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const assert = require('node:assert/strict');
const {
  initTestDb,
  seedCategory,
  seedProduct,
  seedOwnerUser,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { createSupply } = require('../main/services/supplies');
const {
  saveRecipe,
  buildRecipeSnapshot,
  applyRecipeSnapshot,
} = require('../main/services/recipes');
const { withTxn } = require('../main/db');
const {
  calculateProductAvailability,
  calculateProductsAvailability,
} = require('../main/services/product-availability');

const db = initTestDb();
const owner = seedOwnerUser(db);
seedCategory(db, 'cat-availability', 'Availability');

function product(id: string, options: Record<string, unknown> = {}): void {
  seedProduct(db, id, String(options.category_id ?? 'cat-availability'), id, 100, options as any);
}

function variant(input: {
  id: string;
  productId: string;
  name: string;
  track?: number;
  stock?: number;
  inventoryProductId?: string | null;
  deductionQuantity?: number;
  multiplier?: number;
  active?: number;
}): void {
  db.prepare(`
    INSERT INTO product_variants (
      id, product_id, name, price, track_inventory, stock_quantity,
      inventory_product_id, inventory_deduction_quantity, recipe_multiplier,
      is_active, created_at, updated_at
    ) VALUES (?, ?, ?, 100, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.productId,
    input.name,
    input.track ?? 0,
    input.stock ?? 0,
    input.inventoryProductId ?? null,
    input.deductionQuantity ?? 1,
    input.multiplier ?? 1,
    input.active ?? 1,
    now(),
    now(),
  );
}

function addonGroup(input: {
  id: string;
  name: string;
  required: number;
  minimum: number;
  multiple?: number;
  productId?: string;
  categoryId?: string;
}): void {
  db.prepare(`INSERT INTO addon_groups (
    id, name, is_required, min_selection, max_selection,
    allow_multiple_quantities, is_active, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 20, ?, 1, ?, ?)`).run(
    input.id,
    input.name,
    input.required,
    input.minimum,
    input.multiple ?? 0,
    now(),
    now(),
  );
  if (input.productId) {
    db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)').run(
      input.productId,
      input.id,
    );
  }
  if (input.categoryId) {
    db.prepare('INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)').run(
      input.categoryId,
      input.id,
    );
  }
}

function addon(input: {
  id: string;
  groupId: string;
  name: string;
  tracked: number;
  stock: number;
  active?: number;
}): void {
  db.prepare(`INSERT INTO addons (
    id, addon_group_id, name, price, is_active, track_inventory, stock_quantity,
    created_at, updated_at
  ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
    input.id,
    input.groupId,
    input.name,
    input.active ?? 1,
    input.tracked,
    input.stock,
    now(),
    now(),
  );
}

function availability(productId: string, variantId?: string | null) {
  return calculateProductAvailability(db, productId, variantId);
}

try {
  console.log('Product availability service');

  // Active/inactive/deleted catalog state and category policy.
  product('p-active');
  assert.equal(
    availability('p-active').status,
    'unlimited',
    'active product without controls is unlimited',
  );
  product('p-inactive');
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run('p-inactive');
  assert.equal(
    availability('p-inactive').reasonCode,
    'product_inactive',
    'inactive product is unavailable',
  );
  product('p-deleted');
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(now(), 'p-deleted');
  assert.equal(
    availability('p-deleted').reasonCode,
    'product_deleted',
    'deleted product is unavailable',
  );
  product('p-category-inactive');
  db.prepare('UPDATE categories SET is_active = 0 WHERE id = ?').run('cat-availability');
  assert.equal(
    availability('p-category-inactive').reasonCode,
    'category_unavailable',
    'inactive category blocks sale',
  );
  db.prepare('UPDATE categories SET is_active = 1 WHERE id = ?').run('cat-availability');

  // Direct stock: sufficient, exact and insufficient.
  product('p-direct', { track_inventory: true, stock_quantity: 5 });
  const direct = availability('p-direct');
  assert.equal(direct.status, 'available', 'tracked product with stock is available');
  assert.equal(direct.maxSellableQuantity, 5, 'direct pool determines max sellable quantity');
  product('p-direct-exact', { track_inventory: true, stock_quantity: 2 });
  assert.equal(
    availability('p-direct-exact').maxSellableQuantity,
    2,
    'exact direct balance yields exact maximum',
  );
  product('p-direct-empty', { track_inventory: true, stock_quantity: 0 });
  assert.equal(
    availability('p-direct-empty').reasonCode,
    'inventory_insufficient',
    'empty direct pool blocks sale',
  );

  // A linked stock pool applies even when the sellable product is not tracked.
  product('p-linked-pool', { track_inventory: true, stock_quantity: 12 });
  product('p-linked-sellable', {
    track_inventory: false,
    inventory_product_id: 'p-linked-pool',
    inventory_deduction_quantity: 0.5,
  });
  const linked = availability('p-linked-sellable');
  assert.equal(linked.maxSellableQuantity, 24, 'linked pool factor determines available quantity');
  assert.equal(
    linked.limitingComponent?.type,
    'linked_inventory',
    'linked pool is reported as limiter',
  );

  // Brownie presentations share an intermediate supply, with distinct portions.
  const brownieSupply = createSupply(db, {
    name: 'Brownie portions',
    baseUnit: 'each',
    stockQuantity: 17,
    actorUserId: owner.userId,
  });
  product('p-brownie-single');
  product('p-brownie-box');
  saveRecipe(db, {
    productId: 'p-brownie-single',
    items: [{ supplyId: brownieSupply.id, quantity: 1, unit: 'each' }],
  });
  saveRecipe(db, {
    productId: 'p-brownie-box',
    items: [{ supplyId: brownieSupply.id, quantity: 8, unit: 'each' }],
  });
  const brownieAvailability = calculateProductsAvailability(db, [
    'p-brownie-single',
    'p-brownie-box',
  ]);
  assert.equal(
    brownieAvailability.find((row: any) => row.productId === 'p-brownie-single')
      ?.maxSellableQuantity,
    17,
    'single brownie form uses one shared portion',
  );
  assert.equal(
    brownieAvailability.find((row: any) => row.productId === 'p-brownie-box')?.maxSellableQuantity,
    2,
    'box form uses eight shared portions',
  );

  // Mollete-style multi-ingredient recipe and limiting component.
  const baguette = createSupply(db, {
    name: 'Baguette',
    baseUnit: 'each',
    stockQuantity: 3,
    actorUserId: owner.userId,
  });
  const cheese = createSupply(db, {
    name: 'Cheese',
    baseUnit: 'g',
    stockQuantity: 600,
    actorUserId: owner.userId,
  });
  const salsa = createSupply(db, {
    name: 'Salsa',
    baseUnit: 'ml',
    stockQuantity: 2000,
    actorUserId: owner.userId,
  });
  product('p-mollete');
  saveRecipe(db, {
    productId: 'p-mollete',
    items: [
      { supplyId: baguette.id, quantity: 0.5, unit: 'each' },
      { supplyId: cheese.id, quantity: 80, unit: 'g' },
      { supplyId: salsa.id, quantity: 100, unit: 'ml' },
    ],
  });
  const mollete = availability('p-mollete');
  assert.equal(
    mollete.maxSellableQuantity,
    6,
    'fractional baguette and multiple ingredients constrain quantity',
  );
  assert.equal(mollete.limitingComponent?.name, 'Baguette', 'limiting recipe supply is identified');

  // Aggregate repeated rows for the same supply before dividing its stock.
  const duplicateSupply = createSupply(db, {
    name: 'Repeated recipe supply',
    baseUnit: 'g',
    stockQuantity: 5,
    actorUserId: owner.userId,
  });
  product('p-duplicate-recipe-supply');
  saveRecipe(db, {
    productId: 'p-duplicate-recipe-supply',
    items: [{ supplyId: duplicateSupply.id, quantity: 2, unit: 'g' }],
  });
  const duplicateRecipe = db
    .prepare('SELECT id FROM recipes WHERE product_id = ?')
    .get('p-duplicate-recipe-supply') as { id: string };
  db.prepare(`INSERT INTO recipe_items (id, recipe_id, supply_id, quantity, unit, created_at)
    VALUES ('duplicate-recipe-row', ?, ?, 2, 'g', ?)`).run(
    duplicateRecipe.id,
    duplicateSupply.id,
    now(),
  );
  assert.equal(
    availability('p-duplicate-recipe-supply').maxSellableQuantity,
    1,
    'duplicate rows for one supply are summed before availability is calculated',
  );

  // Espresso is made to order: no espresso stock, only measured coffee supply.
  const coffee = createSupply(db, {
    name: 'Espresso coffee',
    baseUnit: 'g',
    stockQuantity: 150,
    actorUserId: owner.userId,
  });
  product('p-espresso', { track_inventory: false, stock_quantity: 0 });
  saveRecipe(db, {
    productId: 'p-espresso',
    items: [{ supplyId: coffee.id, quantity: 18, unit: 'g' }],
  });
  assert.equal(
    availability('p-espresso').maxSellableQuantity,
    8,
    'recipe supply controls a product without finished stock',
  );

  // kg/g and l/ml conversions, fractional recipe amounts, and yield != 1.
  const flour = createSupply(db, {
    name: 'Flour',
    baseUnit: 'kg',
    stockQuantity: 1.5,
    actorUserId: owner.userId,
  });
  const milk = createSupply(db, {
    name: 'Milk',
    baseUnit: 'l',
    stockQuantity: 1,
    actorUserId: owner.userId,
  });
  product('p-converted-yield');
  saveRecipe(db, {
    productId: 'p-converted-yield',
    yieldQuantity: 4,
    items: [
      { supplyId: flour.id, quantity: 1200, unit: 'g' },
      { supplyId: milk.id, quantity: 1000, unit: 'ml' },
    ],
  });
  const yieldResult = availability('p-converted-yield');
  assert.equal(
    yieldResult.maxSellableQuantity,
    4,
    'yield and kg/g conversion determine per-sale usage',
  );
  assert.equal(
    yieldResult.limitingComponent?.name,
    'Milk',
    'converted liquid component is reported as limiter',
  );

  const fractionStock = createSupply(db, {
    name: 'Fractional spice',
    baseUnit: 'g',
    stockQuantity: 1,
    actorUserId: owner.userId,
  });
  product('p-fractional-sale', {
    sale_unit: 'kg',
    allow_fractional_quantity: true,
    weight_precision: 2,
  });
  saveRecipe(db, {
    productId: 'p-fractional-sale',
    items: [{ supplyId: fractionStock.id, quantity: 0.3, unit: 'g' }],
  });
  assert.equal(
    availability('p-fractional-sale').maxSellableQuantity,
    3.33,
    'maximum is rounded down to allowed sale precision',
  );

  // Shared ingredient status can make a non-tracked product unavailable.
  const exhausted = createSupply(db, {
    name: 'Exhausted shared supply',
    baseUnit: 'g',
    stockQuantity: 0,
    actorUserId: owner.userId,
  });
  product('p-recipe-empty', { track_inventory: true, stock_quantity: 99 });
  saveRecipe(db, {
    productId: 'p-recipe-empty',
    items: [{ supplyId: exhausted.id, quantity: 2, unit: 'g' }],
  });
  const recipeEmpty = availability('p-recipe-empty');
  assert.equal(
    recipeEmpty.status,
    'unavailable',
    'positive tracked product stock does not override empty recipe supply',
  );
  assert.equal(
    recipeEmpty.reasonCode,
    'inventory_insufficient',
    'recipe shortage has an inventory reason',
  );
  assert.equal(
    recipeEmpty.limitingComponent?.type,
    'recipe_supply',
    'recipe supply is identified as limiter',
  );

  // Variant multiplier and pools; inactive, missing and foreign variants fail closed.
  const variantSupply = createSupply(db, {
    name: 'Variant coffee',
    baseUnit: 'g',
    stockQuantity: 16,
    actorUserId: owner.userId,
  });
  product('p-variant-recipe');
  saveRecipe(db, {
    productId: 'p-variant-recipe',
    items: [{ supplyId: variantSupply.id, quantity: 2, unit: 'g' }],
  });
  variant({ id: 'v-eight', productId: 'p-variant-recipe', name: 'Eight portions', multiplier: 8 });
  variant({ id: 'v-inactive', productId: 'p-variant-recipe', name: 'Retired', active: 0 });
  assert.equal(
    availability('p-variant-recipe').reasonCode,
    'variant_required',
    'parent with active variants requires a selection',
  );
  assert.equal(
    availability('p-variant-recipe', 'v-eight').maxSellableQuantity,
    1,
    'recipe multiplier scales component consumption',
  );
  assert.equal(
    availability('p-variant-recipe', 'v-inactive').reasonCode,
    'variant_inactive',
    'inactive variant is unavailable',
  );
  assert.equal(
    availability('p-variant-recipe', 'v-missing').reasonCode,
    'variant_missing',
    'missing variant is unavailable',
  );
  product('p-variant-pool-target', { track_inventory: true, stock_quantity: 12 });
  product('p-variant-linked');
  variant({
    id: 'v-linked',
    productId: 'p-variant-linked',
    name: 'Linked pool',
    inventoryProductId: 'p-variant-pool-target',
    deductionQuantity: 2,
  });
  assert.equal(
    availability('p-variant-linked', 'v-linked').maxSellableQuantity,
    6,
    'variant linked pool factor controls availability',
  );
  assert.equal(
    availability('p-variant-recipe', 'v-linked').reasonCode,
    'variant_mismatch',
    'foreign variant is unavailable',
  );

  // Required addon inventory constrains; optional addon inventory does not.
  product('p-required-addon');
  addonGroup({
    id: 'g-required',
    name: 'Required filling',
    required: 1,
    minimum: 1,
    productId: 'p-required-addon',
  });
  addon({
    id: 'a-required',
    groupId: 'g-required',
    name: 'Available filling',
    tracked: 1,
    stock: 4,
  });
  assert.equal(
    availability('p-required-addon').maxSellableQuantity,
    4,
    'required tracked addon limits sellable quantity',
  );
  db.prepare('UPDATE addons SET stock_quantity = 0 WHERE id = ?').run('a-required');
  assert.equal(
    availability('p-required-addon').reasonCode,
    'required_addon_unavailable',
    'required tracked addon with zero stock blocks sale',
  );

  product('p-optional-addon');
  addonGroup({
    id: 'g-optional',
    name: 'Optional topping',
    required: 0,
    minimum: 0,
    productId: 'p-optional-addon',
  });
  addon({
    id: 'a-optional',
    groupId: 'g-optional',
    name: 'Optional topping',
    tracked: 1,
    stock: 0,
  });
  assert.equal(
    availability('p-optional-addon').status,
    'unlimited',
    'empty optional addon does not restrict base product availability',
  );

  product('p-required-multiple-addons');
  addonGroup({
    id: 'g-two-required',
    name: 'Choose two',
    required: 1,
    minimum: 2,
    productId: 'p-required-multiple-addons',
  });
  addon({
    id: 'a-choice-one',
    groupId: 'g-two-required',
    name: 'Choice one',
    tracked: 1,
    stock: 10,
  });
  addon({
    id: 'a-choice-two',
    groupId: 'g-two-required',
    name: 'Choice two',
    tracked: 1,
    stock: 3,
  });
  assert.equal(
    availability('p-required-multiple-addons').maxSellableQuantity,
    3,
    'required addon group uses the limiting required combination',
  );

  product('p-required-multi-quantity');
  addonGroup({
    id: 'g-multi-quantity',
    name: 'Choose quantity',
    required: 1,
    minimum: 2,
    multiple: 1,
    productId: 'p-required-multi-quantity',
  });
  addon({
    id: 'a-multi-quantity',
    groupId: 'g-multi-quantity',
    name: 'Tracked choice',
    tracked: 1,
    stock: 6,
  });
  assert.equal(
    availability('p-required-multi-quantity').maxSellableQuantity,
    3,
    'multiple quantities divide tracked addon stock by required selections',
  );

  product('p-required-untracked-multi');
  addonGroup({
    id: 'g-untracked-multi',
    name: 'Untracked quantity',
    required: 1,
    minimum: 2,
    multiple: 1,
    productId: 'p-required-untracked-multi',
  });
  addon({
    id: 'a-untracked-multi',
    groupId: 'g-untracked-multi',
    name: 'Untracked option',
    tracked: 0,
    stock: 0,
  });
  assert.equal(
    availability('p-required-untracked-multi').status,
    'unlimited',
    'untracked addon can satisfy a multiple-quantity requirement without inventory restriction',
  );

  // A group inherited from category settings is also enforced.
  seedCategory(db, 'cat-addon-availability', 'Addon availability');
  product('p-category-addon', { category_id: 'cat-addon-availability' });
  addonGroup({
    id: 'g-category',
    name: 'Category required',
    required: 1,
    minimum: 1,
    categoryId: 'cat-addon-availability',
  });
  addon({ id: 'a-category', groupId: 'g-category', name: 'Category choice', tracked: 1, stock: 2 });
  assert.equal(
    availability('p-category-addon').maxSellableQuantity,
    2,
    'category-linked required addon is included',
  );

  // A calculated result is a read snapshot; a committed sale changes the next calculation.
  const staleBeforeSale = availability('p-brownie-single');
  const saleSnapshot = buildRecipeSnapshot(db, 'p-brownie-single', 1)!;
  withTxn(() =>
    applyRecipeSnapshot(db, saleSnapshot, {
      direction: 'deplete',
      actorUserId: owner.userId,
      referenceId: 'availability-stale-read',
    }),
  );
  assert.equal(
    staleBeforeSale.maxSellableQuantity,
    17,
    'previous availability result remains a read snapshot',
  );
  assert.equal(
    availability('p-brownie-single').maxSellableQuantity,
    16,
    'recalculation observes stock consumed by another sale',
  );

  // Service output contains no cost or supplier/admin fields and has no HTTP route.
  const serialized = JSON.stringify(availability('p-brownie-single'));
  assert.equal(
    /unit_cost|supplier_id|supplier_name|inventory_product_id/i.test(serialized),
    false,
    'availability output omits costs, supplier details and internal pool IDs',
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'product_availability'",
      )
      .get().count,
    0,
    'availability service introduces no schema object',
  );
  let preparedQueries = 0;
  const countedDb = {
    prepare(sql: string) {
      preparedQueries++;
      return db.prepare(sql);
    },
  };
  calculateProductsAvailability(countedDb as any, [
    'p-brownie-single',
    'p-brownie-box',
    'p-mollete',
    'p-espresso',
    'p-variant-recipe',
  ]);
  assert.ok(
    preparedQueries <= 6,
    'batch availability uses a bounded set of queries, not per-product queries',
  );

  console.log('Product availability checks passed');
} finally {
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}
