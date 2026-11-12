import { getDatabase } from '../db';
import { InventoryProductLike, resolveInventoryDeduction } from './inventory';
import { SupplyUnit, convertQuantity, roundQuantity } from './units';

export type ProductAvailabilityStatus = 'available' | 'unavailable' | 'unlimited';

export type ProductAvailabilityReasonCode =
  | 'available'
  | 'unrestricted'
  | 'product_missing'
  | 'product_deleted'
  | 'product_inactive'
  | 'category_unavailable'
  | 'variant_required'
  | 'variant_missing'
  | 'variant_mismatch'
  | 'variant_inactive'
  | 'variant_configuration_invalid'
  | 'inventory_pool_unavailable'
  | 'required_addon_unavailable'
  | 'inventory_insufficient';

export type ProductAvailabilityComponentType =
  | 'product_inventory'
  | 'linked_inventory'
  | 'recipe_supply'
  | 'required_addon_group';

/** Internal diagnostic data only; this service does not expose a public API. */
export interface ProductAvailabilityComponent {
  type: ProductAvailabilityComponentType;
  name: string;
  /** Required stock per sale unit, in the component's normalized stock unit. */
  requiredPerSaleUnit: number | null;
  availableQuantity: number | null;
  unit: string | null;
  maxSellableQuantity: number | null;
}

export interface ProductAvailability {
  productId: string;
  variantId: string | null;
  status: ProductAvailabilityStatus;
  available: boolean;
  unlimited: boolean;
  /** `null` means no inventory restriction; otherwise rounded to a valid sale step. */
  maxSellableQuantity: number | null;
  reasonCode: ProductAvailabilityReasonCode;
  hasInventoryRestrictions: boolean;
  components: ProductAvailabilityComponent[];
  limitingComponent: ProductAvailabilityComponent | null;
}

interface ProductRow extends InventoryProductLike {
  id: string;
  name: string;
  category_id: string | null;
  is_active: number | null;
  deleted_at: string | null;
  category_active: number | null;
  category_deleted_at: string | null;
  sale_unit: string | null;
  allow_fractional_quantity: number | null;
  weight_precision: number | null;
  stock_quantity: number | null;
}

interface VariantRow extends InventoryProductLike {
  id: string;
  product_id: string;
  name: string;
  is_active: number | null;
  stock_quantity: number | null;
  recipe_multiplier: number | null;
}

interface RecipeRow {
  product_id: string;
  yield_quantity: number;
  is_active: number;
  supply_id: string;
  supply_name: string | null;
  base_unit: SupplyUnit | null;
  stock_quantity: number | null;
  quantity: number;
  unit: SupplyUnit;
}

interface AddonGroupRow {
  addon_group_id: string;
  name: string;
  is_required: number | null;
  min_selection: number | null;
  allow_multiple_quantities: number | null;
  addon_id: string | null;
  addon_name: string | null;
  addon_is_active: number | null;
  track_inventory: number | null;
  stock_quantity: number | null;
}

function chunks<T>(values: T[], size = 400): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function saleStep(product: ProductRow): number {
  if (
    Number(product.allow_fractional_quantity) !== 1 ||
    !['kg', 'g', 'lb', 'ml', 'cl', 'l', 'fl oz', 'oz'].includes(product.sale_unit || 'each')
  ) {
    return 1;
  }
  const precision = Number.isInteger(product.weight_precision)
    ? Math.min(4, Math.max(0, Number(product.weight_precision)))
    : 3;
  return 10 ** -precision;
}

function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const count = Math.floor(value / step + 1e-9);
  return roundQuantity(count * step);
}

function availabilityResult(
  productId: string,
  variantId: string | null,
  status: ProductAvailabilityStatus,
  reasonCode: ProductAvailabilityReasonCode,
  components: ProductAvailabilityComponent[] = [],
  hasInventoryRestrictions = false,
  maxSellableQuantity: number | null = null,
  limitingComponent: ProductAvailabilityComponent | null = null,
): ProductAvailability {
  const available = status !== 'unavailable';
  return {
    productId,
    variantId,
    status,
    available,
    unlimited: status === 'unlimited',
    maxSellableQuantity,
    reasonCode,
    hasInventoryRestrictions,
    components,
    limitingComponent,
  };
}

/**
 * Calculate base-product and variant availability for a set of catalog IDs.
 * Catalog, recipe, pool, and required-addon rows are loaded in batches so the
 * query count does not grow with the number of requested products.
 */
export function calculateProductsAvailability(
  db: ReturnType<typeof getDatabase>,
  productIds: string[],
): ProductAvailability[] {
  const ids = [...new Set(productIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  const products: ProductRow[] = [];
  for (const batch of chunks(ids)) {
    const marks = batch.map(() => '?').join(', ');
    products.push(
      ...(db
        .prepare(`
          SELECT p.id, p.name, p.category_id, p.is_active, p.deleted_at,
                 p.sale_unit, p.allow_fractional_quantity, p.weight_precision,
                 p.track_inventory, p.inventory_product_id, p.inventory_deduction_quantity,
                 p.stock_quantity,
                 c.is_active AS category_active, c.deleted_at AS category_deleted_at
          FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.id IN (${marks})
        `)
        .all(...batch) as ProductRow[]),
    );
  }

  const productById = new Map(products.map((product) => [product.id, product]));
  const foundIds = products.map((product) => product.id);
  if (foundIds.length === 0) {
    return ids.map((productId) =>
      availabilityResult(productId, null, 'unavailable', 'product_missing', [], false, 0),
    );
  }

  const variants: VariantRow[] = [];
  for (const batch of chunks(foundIds)) {
    const marks = batch.map(() => '?').join(', ');
    variants.push(
      ...(db
        .prepare(`
          SELECT id, product_id, name, is_active, track_inventory,
                 inventory_product_id, inventory_deduction_quantity,
                 recipe_multiplier, stock_quantity
          FROM product_variants
          WHERE product_id IN (${marks})
        `)
        .all(...batch) as VariantRow[]),
    );
  }
  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const variant of variants) {
    const list = variantsByProduct.get(variant.product_id) ?? [];
    list.push(variant);
    variantsByProduct.set(variant.product_id, list);
  }

  const recipeRows: RecipeRow[] = [];
  for (const batch of chunks(foundIds)) {
    const marks = batch.map(() => '?').join(', ');
    recipeRows.push(
      ...(db
        .prepare(`
          SELECT r.product_id, r.yield_quantity, r.is_active,
                 ri.supply_id, s.name AS supply_name, s.base_unit,
                 s.stock_quantity, ri.quantity, ri.unit
          FROM recipes r
          JOIN recipe_items ri ON ri.recipe_id = r.id
          LEFT JOIN supplies s ON s.id = ri.supply_id
          WHERE r.product_id IN (${marks})
          ORDER BY r.product_id, ri.created_at, ri.id
        `)
        .all(...batch) as RecipeRow[]),
    );
  }
  const recipesByProduct = new Map<string, RecipeRow[]>();
  for (const row of recipeRows) {
    const list = recipesByProduct.get(row.product_id) ?? [];
    list.push(row);
    recipesByProduct.set(row.product_id, list);
  }

  const groupLinks: Array<{ product_id: string; addon_group_id: string }> = [];
  for (const batch of chunks(foundIds)) {
    const marks = batch.map(() => '?').join(', ');
    groupLinks.push(
      ...(db
        .prepare(`
          SELECT DISTINCT linked.product_id, linked.addon_group_id
          FROM (
            SELECT agp.product_id, agp.addon_group_id
            FROM addon_group_product agp
            WHERE agp.product_id IN (${marks})
            UNION
            SELECT p.id AS product_id, cag.addon_group_id
            FROM products p
            JOIN category_addon_groups cag ON cag.category_id = p.category_id
            WHERE p.id IN (${marks})
          ) linked
        `)
        .all(...batch, ...batch) as Array<{ product_id: string; addon_group_id: string }>),
    );
  }
  const groupsByProduct = new Map<string, Set<string>>();
  const allGroupIds = new Set<string>();
  for (const link of groupLinks) {
    const groupIds = groupsByProduct.get(link.product_id) ?? new Set<string>();
    groupIds.add(link.addon_group_id);
    groupsByProduct.set(link.product_id, groupIds);
    allGroupIds.add(link.addon_group_id);
  }

  const addonRows: AddonGroupRow[] = [];
  for (const batch of chunks([...allGroupIds])) {
    if (batch.length === 0) continue;
    const marks = batch.map(() => '?').join(', ');
    addonRows.push(
      ...(db
        .prepare(`
          SELECT g.id AS addon_group_id, g.name, g.is_required, g.min_selection,
                 g.allow_multiple_quantities,
                 a.id AS addon_id, a.name AS addon_name, a.is_active AS addon_is_active,
                 a.track_inventory, a.stock_quantity
          FROM addon_groups g
          LEFT JOIN addons a ON a.addon_group_id = g.id
          WHERE g.id IN (${marks}) AND g.is_active = 1
          ORDER BY g.sort_order, g.id, a.sort_order, a.id
        `)
        .all(...batch) as AddonGroupRow[]),
    );
  }
  const addonsByGroup = new Map<string, AddonGroupRow[]>();
  for (const row of addonRows) {
    const list = addonsByGroup.get(row.addon_group_id) ?? [];
    list.push(row);
    addonsByGroup.set(row.addon_group_id, list);
  }

  const inventoryTargetIds = new Set<string>();
  for (const product of products) {
    for (const variant of [null, ...(variantsByProduct.get(product.id) ?? [])]) {
      const deduction = resolveInventoryDeduction(product, 1, variant);
      if (deduction && !deduction.variantId) inventoryTargetIds.add(String(deduction.productId));
    }
  }
  const inventoryTargets = new Map<
    string,
    { name: string; stock: number; deletedAt: string | null }
  >();
  for (const batch of chunks([...inventoryTargetIds])) {
    if (batch.length === 0) continue;
    const marks = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, name, stock_quantity, deleted_at FROM products WHERE id IN (${marks})`)
      .all(...batch) as Array<{
      id: string;
      name: string;
      stock_quantity: number | null;
      deleted_at: string | null;
    }>;
    for (const row of rows) {
      inventoryTargets.set(row.id, {
        name: row.name,
        stock: Number(row.stock_quantity ?? 0),
        deletedAt: row.deleted_at,
      });
    }
  }

  const results: ProductAvailability[] = [];
  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id) ?? [];
    const hasActiveVariants = productVariants.some((variant) => Number(variant.is_active) === 1);
    const forms: Array<{ variant: VariantRow | null; variantId: string | null }> = [
      { variant: null, variantId: null },
      ...productVariants.map((variant) => ({ variant, variantId: variant.id })),
    ];

    for (const form of forms) {
      const variant = form.variant;
      const basicReason: ProductAvailabilityReasonCode | null = product.deleted_at
        ? 'product_deleted'
        : Number(product.is_active) !== 1
          ? 'product_inactive'
          : product.category_id &&
              (product.category_active === null ||
                Number(product.category_active) !== 1 ||
                product.category_deleted_at !== null)
            ? 'category_unavailable'
            : variant && Number(variant.is_active) !== 1
              ? 'variant_inactive'
              : !variant && hasActiveVariants
                ? 'variant_required'
                : null;
      if (basicReason) {
        results.push(
          availabilityResult(product.id, form.variantId, 'unavailable', basicReason, [], false, 0),
        );
        continue;
      }

      const step = saleStep(product);
      const components: ProductAvailabilityComponent[] = [];
      let hasInventoryRestrictions = false;
      let maxSellableQuantity = Number.POSITIVE_INFINITY;
      let limitingComponent: ProductAvailabilityComponent | null = null;
      let reasonCode: ProductAvailabilityReasonCode = 'available';

      const deduction = resolveInventoryDeduction(product, 1, variant);
      if (deduction) {
        hasInventoryRestrictions = true;
        let name: string;
        let availableQuantity: number;
        let type: ProductAvailabilityComponentType;
        if (deduction.variantId) {
          name = variant?.name ?? product.name;
          availableQuantity = Number(variant?.stock_quantity ?? 0);
          type = 'product_inventory';
        } else {
          const pool = inventoryTargets.get(String(deduction.productId));
          if (!pool || pool.deletedAt) {
            reasonCode = 'inventory_pool_unavailable';
            components.push({
              type: 'linked_inventory',
              name: pool?.name ?? product.name,
              requiredPerSaleUnit: roundQuantity(deduction.deductedQuantity),
              availableQuantity: 0,
              unit: 'each',
              maxSellableQuantity: 0,
            });
            maxSellableQuantity = 0;
            limitingComponent = components[components.length - 1];
            type = 'linked_inventory';
            name = pool?.name ?? product.name;
            availableQuantity = 0;
          } else {
            name = pool.name;
            availableQuantity = pool.stock;
            type =
              String(deduction.productId) === product.id ? 'product_inventory' : 'linked_inventory';
          }
        }

        const componentMax = floorToStep(availableQuantity / deduction.deductedQuantity, step);
        if (componentMax < maxSellableQuantity) {
          maxSellableQuantity = componentMax;
          limitingComponent = {
            type,
            name,
            requiredPerSaleUnit: roundQuantity(deduction.deductedQuantity),
            availableQuantity: roundQuantity(availableQuantity),
            unit: 'each',
            maxSellableQuantity: componentMax,
          };
        }
        if (
          !components.some(
            (component) =>
              component.type === 'linked_inventory' && reasonCode === 'inventory_pool_unavailable',
          )
        ) {
          components.push(limitingComponent!);
        }
      }

      const recipeRequirements = new Map<
        string,
        {
          recipe: RecipeRow;
          quantityPerSaleUnit: number;
        }
      >();
      for (const recipe of recipesByProduct.get(product.id) ?? []) {
        if (Number(recipe.is_active) !== 1) continue;
        const multiplier = Number(variant?.recipe_multiplier ?? 1);
        const yieldQuantity = Number(recipe.yield_quantity);
        if (
          !Number.isFinite(multiplier) ||
          multiplier <= 0 ||
          !Number.isFinite(yieldQuantity) ||
          yieldQuantity <= 0
        ) {
          reasonCode = 'variant_configuration_invalid';
          maxSellableQuantity = 0;
          continue;
        }
        if (!recipe.supply_name || !recipe.base_unit) {
          reasonCode = 'inventory_pool_unavailable';
          maxSellableQuantity = 0;
          continue;
        }
        const supplyPerSaleUnit = roundQuantity(
          (convertQuantity(Number(recipe.quantity), recipe.unit, recipe.base_unit) * multiplier) /
            yieldQuantity,
        );
        if (supplyPerSaleUnit <= 0) continue;
        const current = recipeRequirements.get(recipe.supply_id);
        recipeRequirements.set(recipe.supply_id, {
          recipe: current?.recipe ?? recipe,
          quantityPerSaleUnit: roundQuantity(
            (current?.quantityPerSaleUnit ?? 0) + supplyPerSaleUnit,
          ),
        });
      }

      for (const {
        recipe,
        quantityPerSaleUnit: supplyPerSaleUnit,
      } of recipeRequirements.values()) {
        hasInventoryRestrictions = true;
        const availableQuantity = Number(recipe.stock_quantity ?? 0);
        const componentMax = floorToStep(availableQuantity / supplyPerSaleUnit, step);
        const component: ProductAvailabilityComponent = {
          type: 'recipe_supply',
          name: recipe.supply_name!,
          requiredPerSaleUnit: supplyPerSaleUnit,
          availableQuantity: roundQuantity(availableQuantity),
          unit: recipe.base_unit!,
          maxSellableQuantity: componentMax,
        };
        components.push(component);
        if (componentMax < maxSellableQuantity) {
          maxSellableQuantity = componentMax;
          limitingComponent = component;
        }
      }

      for (const groupId of groupsByProduct.get(product.id) ?? []) {
        const groupOptions = addonsByGroup.get(groupId) ?? [];
        if (groupOptions.length === 0) continue;
        const group = groupOptions[0];
        const requiredSelectionCount =
          Number(group.is_required) === 1
            ? Math.max(1, Number(group.min_selection || 1))
            : Math.max(0, Number(group.min_selection || 0));
        if (requiredSelectionCount === 0) continue;
        const activeOptions = groupOptions.filter(
          (option) => option.addon_id && Number(option.addon_is_active) === 1,
        );
        const optionCaps = activeOptions.map((option) =>
          Number(option.track_inventory) === 1
            ? floorToStep(Number(option.stock_quantity ?? 0), step)
            : Number.POSITIVE_INFINITY,
        );
        const maxFromGroup =
          Number(group.allow_multiple_quantities) === 1
            ? optionCaps.length === 0
              ? 0
              : Math.max(
                  ...optionCaps.map((cap) =>
                    Number.isFinite(cap)
                      ? floorToStep(cap / requiredSelectionCount, step)
                      : Number.POSITIVE_INFINITY,
                  ),
                )
            : optionCaps.length < requiredSelectionCount
              ? 0
              : [...optionCaps].sort((left, right) => right - left)[requiredSelectionCount - 1];
        const normalizedMax = Number.isFinite(maxFromGroup)
          ? floorToStep(maxFromGroup, step)
          : Number.POSITIVE_INFINITY;
        const hasTrackedOption = activeOptions.some(
          (option) => Number(option.track_inventory) === 1,
        );
        if (hasTrackedOption) hasInventoryRestrictions = true;
        const component: ProductAvailabilityComponent = {
          type: 'required_addon_group',
          name: group.name,
          requiredPerSaleUnit: requiredSelectionCount,
          availableQuantity: null,
          unit: 'selections',
          maxSellableQuantity: Number.isFinite(normalizedMax) ? normalizedMax : null,
        };
        components.push(component);
        if (normalizedMax === 0) reasonCode = 'required_addon_unavailable';
        if (normalizedMax < maxSellableQuantity) {
          maxSellableQuantity = normalizedMax;
          limitingComponent = component;
        }
      }

      if (
        reasonCode === 'inventory_pool_unavailable' ||
        reasonCode === 'variant_configuration_invalid'
      ) {
        results.push(
          availabilityResult(
            product.id,
            form.variantId,
            'unavailable',
            reasonCode,
            components,
            hasInventoryRestrictions,
            0,
            limitingComponent,
          ),
        );
      } else if (reasonCode === 'required_addon_unavailable') {
        results.push(
          availabilityResult(
            product.id,
            form.variantId,
            'unavailable',
            reasonCode,
            components,
            hasInventoryRestrictions,
            0,
            limitingComponent,
          ),
        );
      } else if (maxSellableQuantity !== Number.POSITIVE_INFINITY && maxSellableQuantity <= 0) {
        results.push(
          availabilityResult(
            product.id,
            form.variantId,
            'unavailable',
            'inventory_insufficient',
            components,
            hasInventoryRestrictions,
            0,
            limitingComponent,
          ),
        );
      } else if (maxSellableQuantity === Number.POSITIVE_INFINITY) {
        results.push(
          availabilityResult(
            product.id,
            form.variantId,
            'unlimited',
            'unrestricted',
            components,
            false,
          ),
        );
      } else {
        results.push(
          availabilityResult(
            product.id,
            form.variantId,
            'available',
            'available',
            components,
            hasInventoryRestrictions,
            maxSellableQuantity,
            limitingComponent,
          ),
        );
      }
    }
  }

  const output = [...results];
  for (const productId of ids) {
    if (!productById.has(productId)) {
      output.push(
        availabilityResult(productId, null, 'unavailable', 'product_missing', [], false, 0),
      );
    }
  }
  return output;
}

/** Calculate one commercial form; foreign and missing variants fail closed. */
export function calculateProductAvailability(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  variantId?: string | null,
): ProductAvailability {
  const results = calculateProductsAvailability(db, [productId]);
  if (variantId === undefined || variantId === null || variantId === '') {
    return results.find((result) => result.productId === productId && result.variantId === null)!;
  }
  const matched = results.find((result) => result.variantId === variantId);
  if (matched) return matched;
  const variant = db
    .prepare('SELECT id, product_id FROM product_variants WHERE id = ?')
    .get(variantId) as { id: string; product_id: string } | undefined;
  const reasonCode: ProductAvailabilityReasonCode = !variant
    ? 'variant_missing'
    : variant.product_id !== productId
      ? 'variant_mismatch'
      : 'variant_inactive';
  return availabilityResult(productId, variantId, 'unavailable', reasonCode, [], false, 0);
}
