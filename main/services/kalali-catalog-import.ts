import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { createSupply } from './supplies';
import { saveRecipe } from './recipes';
import { createPrepRecipeVersion } from './production';
import { convertQuantity, assertSupplyUnit } from './units';

const ALLOWED_STATUS = new Set(['confirmed', 'provisional', 'pending', 'historical', 'approved']);
const VALID_UNITS = new Set(['each', 'g', 'kg', 'ml', 'l']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const internalId = (entity: string, externalId: string) =>
  `kal_${createHash('sha256').update(`${entity}:${externalId}`).digest('hex').slice(0, 20)}`;

type Pilot = Record<string, any>;

export function validateKalaliPilot(pilot: Pilot) {
  const errors: string[] = [];
  const pending: string[] = [];
  if (pilot?.schema_version !== 1 || pilot?.source_system !== 'kalali')
    errors.push('Manifesto/schema no compatible.');
  const groups = ['categories', 'supplies', 'preparations', 'products', 'modifiers'];
  const scopedIds = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(pilot?.[group])) {
      errors.push(`${group} debe ser una lista.`);
      continue;
    }
    for (const row of pilot[group]) {
      const id = String(row?.external_id || '').trim();
      if (!id) errors.push(`${group}: registro sin external_id.`);
      else if (scopedIds.has(`${group}:${id}`))
        errors.push(`ID externo duplicado ${id} en ${group}.`);
      else scopedIds.add(`${group}:${id}`);
      if (!ALLOWED_STATUS.has(row?.source_status))
        errors.push(`${id || group}: estado de origen inválido.`);
      if (row?.base_unit && !VALID_UNITS.has(row.base_unit))
        errors.push(`${id}: unidad base inválida ${row.base_unit}.`);
    }
  }
  const supplyIds = new Set((pilot.supplies || []).map((x: any) => x.external_id));
  const categoryIds = new Set((pilot.categories || []).map((x: any) => x.external_id));
  const productIds = new Set((pilot.products || []).map((x: any) => x.external_id));
  for (const prep of pilot.preparations || []) {
    if (!supplyIds.has(prep.output_supply_id))
      errors.push(`${prep.external_id}: salida inexistente ${prep.output_supply_id}.`);
    if (!prep.yield_quantity || !prep.components?.length)
      pending.push(`${prep.external_id}: rendimiento o componentes pendientes.`);
    for (const item of prep.components || []) {
      if (!supplyIds.has(item.supply_id))
        errors.push(`${prep.external_id}: insumo inexistente ${item.supply_id}.`);
      if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.source_status === 'pending')
        pending.push(`${prep.external_id}: componente pendiente.`);
    }
  }
  for (const product of pilot.products || []) {
    if (!categoryIds.has(product.category_id))
      errors.push(`${product.external_id}: categoría inexistente ${product.category_id}.`);
    const components = product.recipe?.components || [];
    if (!components.length) pending.push(`${product.external_id}: receta sin componentes.`);
    for (const item of components) {
      if (!supplyIds.has(item.supply_id))
        errors.push(`${product.external_id}: insumo inexistente ${item.supply_id}.`);
      if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.source_status === 'pending')
        pending.push(`${product.external_id}: receta incompleta (${item.supply_id}).`);
      if (supplyIds.has(item.supply_id)) {
        const base = pilot.supplies.find((s: any) => s.external_id === item.supply_id)?.base_unit;
        try {
          convertQuantity(item.quantity, assertSupplyUnit(item.unit), assertSupplyUnit(base));
        } catch {
          if (item.quantity !== null)
            errors.push(`${product.external_id}: unidades incompatibles en ${item.supply_id}.`);
        }
      }
    }
    if (product.pilot_status === 'pending')
      pending.push(`${product.external_id}: producto pendiente de receta/datos.`);
    for (const channel of Object.values(product.sale_price_candidates || {}) as any[]) {
      if (
        !Number.isFinite(channel?.amount) ||
        channel.amount <= 0 ||
        channel.status === 'approved'
      ) {
        if (channel?.status === 'approved')
          pending.push(
            `${product.external_id}: precio candidato marcado approved; importador de piloto no acepta aprobación implícita.`,
          );
        else errors.push(`${product.external_id}: precio candidato inválido.`);
      }
    }
  }
  for (const modifier of pilot.modifiers || []) {
    for (const productId of modifier.applicable_to || [])
      if (!productIds.has(productId))
        errors.push(`${modifier.external_id}: producto relacionado inexistente ${productId}.`);
    if (!Number.isFinite(modifier.quantity) || !Number.isFinite(modifier.price))
      pending.push(`${modifier.external_id}: modificador pendiente; no se importa.`);
  }
  return {
    valid: errors.length === 0,
    errors,
    pending: [...new Set(pending)],
    counts: {
      categories: pilot.categories?.length || 0,
      supplies: pilot.supplies?.length || 0,
      preparations: pilot.preparations?.length || 0,
      products: pilot.products?.length || 0,
      modifiers: pilot.modifiers?.length || 0,
    },
  };
}

export function calculateKalaliCostScenario(input: {
  ingredientCost: number | null;
  packagingCost: number | null;
  directPrice: number | null;
  appPrice: number | null;
  commissionRate: number | null;
  taxRetentionRate?: number | null;
}) {
  const money = (value: number | null) =>
    value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100;
  const directCost =
    input.ingredientCost === null || input.packagingCost === null
      ? null
      : money(input.ingredientCost + input.packagingCost);
  const commission =
    input.appPrice === null || input.commissionRate === null
      ? null
      : money(input.appPrice * input.commissionRate);
  return {
    ingredient_cost: input.ingredientCost,
    packaging_cost: input.packagingCost,
    direct_cost: directCost,
    direct_sale_candidate: input.directPrice,
    direct_contribution_estimate:
      directCost === null || input.directPrice === null
        ? null
        : money(input.directPrice - directCost),
    channel_sale_candidate: input.appPrice,
    channel_commission_scenario: commission,
    channel_contribution_estimate:
      directCost === null || input.appPrice === null || commission === null
        ? null
        : money(input.appPrice - commission - directCost),
    tax_retention_estimate:
      input.taxRetentionRate == null || input.appPrice === null
        ? null
        : money(input.appPrice * input.taxRetentionRate),
    platform_settlement_estimate: null,
    tax_retention_status: 'pending; not modeled as a definitive cost',
    approval_status: 'provisional; not approved for sale',
  };
}

/** Applies only to a newly created disposable test database. All writes are atomic. */
export function applyKalaliPilot(
  db: any,
  pilot: Pilot,
  options: {
    actorUserId: string;
    testOnly: true;
    costs?: Record<
      string,
      {
        unit_cost: number;
        unit: string;
        status?: string;
        source_ref?: string;
        observed_at?: string | null;
        supplier?: string | null;
        brand?: string | null;
        test_only?: boolean;
      }
    >;
  },
) {
  if (options?.testOnly !== true)
    throw new Error('Kalali pilot importer is restricted to disposable test databases.');
  const dbPath = path.resolve(String(db?.name || ''));
  const dbParent = path.dirname(dbPath);
  const tmpRoot = path.resolve(os.tmpdir());
  if (
    path.basename(dbPath) !== 'flo.db' ||
    path.dirname(dbParent) !== tmpRoot ||
    !path.basename(dbParent).startsWith('flo-kalali-pilot-')
  ) {
    throw new Error(
      'Refusing Kalali import: database path is not a fresh /tmp/flo-kalali-pilot-*/flo.db test database.',
    );
  }
  const report = validateKalaliPilot(pilot);
  if (!report.valid) throw new Error(`Manifest rejected: ${report.errors.join(' ')}`);
  if (!options.actorUserId) throw new Error('actorUserId required.');
  const fingerprint = hash({ pilot, cost_references: options.costs || {} });
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM catalog_external_references WHERE source_system = 'kalali'")
    .get().n;
  if (existing) {
    const refs = db
      .prepare(
        "SELECT DISTINCT source_fingerprint FROM catalog_external_references WHERE source_system = 'kalali'",
      )
      .all();
    if (refs.length === 1 && refs[0].source_fingerprint === fingerprint)
      return {
        ...report,
        outcome: 'no-op',
        created: { categories: 0, supplies: 0, products: 0, recipes: 0, preparations: 0 },
      };
    throw new Error(
      'Kalali references already exist with another or partial fingerprint; refusing overwrite.',
    );
  }
  const created = { categories: 0, supplies: 0, products: 0, recipes: 0, preparations: 0 };
  const tx = db.transaction(() => {
    const insertRef = db.prepare(`INSERT INTO catalog_external_references
      (source_system, source_entity, external_id, target_type, target_id, source_status, source_fingerprint, metadata_json)
      VALUES ('kalali', ?, ?, ?, ?, ?, ?, ?)`);
    for (const category of pilot.categories) {
      const id = internalId('category', category.external_id);
      db.prepare(
        `INSERT INTO categories (id, name, is_active, created_at, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(id, category.name);
      insertRef.run(
        'category',
        category.external_id,
        'category',
        id,
        category.source_status,
        fingerprint,
        JSON.stringify({ source_ref: category.source_ref }),
      );
      created.categories++;
    }
    for (const supply of pilot.supplies) {
      const id = internalId('supply', supply.external_id);
      const stock = Number(pilot.test_only?.opening_balances?.[supply.external_id] || 0);
      const cost = options.costs?.[supply.external_id];
      createSupply(db, {
        id,
        name: supply.name,
        baseUnit: supply.base_unit,
        stockQuantity: stock,
        unitCost: cost?.unit_cost ?? null,
        unitCostUnit: cost?.unit || supply.base_unit,
        actorUserId: options.actorUserId,
      });
      insertRef.run(
        'supply',
        supply.external_id,
        'supply',
        id,
        supply.source_status,
        fingerprint,
        JSON.stringify({
          source_ref: supply.source_ref,
          cost_status: cost?.status || supply.cost_status,
          cost_source_ref: cost?.source_ref || null,
          cost_observed_at: cost?.observed_at ?? null,
          cost_supplier: cost?.supplier || null,
          cost_brand: cost?.brand || null,
          test_cost_override: cost?.test_only === true,
          kind: supply.kind,
          test_opening_balance: stock > 0,
        }),
      );
      created.supplies++;
    }
    for (const prep of pilot.preparations) {
      if (
        !prep.yield_quantity ||
        !prep.components?.length ||
        prep.components.some(
          (c: any) =>
            !Number.isFinite(c.quantity) || c.quantity <= 0 || c.source_status === 'pending',
        )
      ) {
        insertRef.run(
          'preparation',
          prep.external_id,
          'preparation_pending',
          internalId('supply', prep.output_supply_id),
          prep.source_status,
          fingerprint,
          JSON.stringify({
            pending_reason: prep.pending_reason,
            coproduct_of: prep.coproduct_of || null,
          }),
        );
        continue;
      }
      const prepRecipe = createPrepRecipeVersion(db, {
        outputSupplyId: internalId('supply', prep.output_supply_id),
        yieldQuantity: prep.yield_quantity,
        components: prep.components.map((c: any) => ({
          supplyId: internalId('supply', c.supply_id),
          quantity: c.quantity,
          unit: c.unit,
        })),
        actorUserId: options.actorUserId,
      });
      insertRef.run(
        'preparation',
        prep.external_id,
        'prep_recipe',
        (prepRecipe as { id: string }).id,
        prep.source_status,
        fingerprint,
        JSON.stringify({ output_supply_id: prep.output_supply_id }),
      );
      created.preparations++;
    }
    for (const product of pilot.products) {
      const complete =
        product.pilot_status !== 'pending' &&
        product.recipe?.components?.length > 0 &&
        product.recipe.components.every(
          (c: any) =>
            Number.isFinite(c.quantity) && c.quantity > 0 && c.source_status !== 'pending',
        );
      const id = internalId('product', product.external_id);
      const categoryId = internalId('category', product.category_id);
      const candidate = product.sale_price_candidates?.direct?.amount || 0;
      const displayName = `${product.name} (DEMO)`;
      db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, track_inventory, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(
        id,
        categoryId,
        displayName,
        candidate,
        complete ? 1 : 0,
      );
      insertRef.run(
        'product',
        product.external_id,
        'product',
        id,
        product.source_status,
        fingerprint,
        JSON.stringify({
          source_ref: product.source_ref,
          pilot_status: product.pilot_status,
          price_candidates: product.sale_price_candidates,
          approved: false,
        }),
      );
      created.products++;
      if (complete) {
        const recipe = saveRecipe(db, {
          productId: id,
          yieldQuantity: product.recipe.yield_quantity || 1,
          items: product.recipe.components.map((c: any) => ({
            supplyId: internalId('supply', c.supply_id),
            quantity: c.quantity,
            unit: c.unit,
          })),
        });
        created.recipes++;
        insertRef.run(
          'recipe',
          product.recipe.external_id,
          'recipe',
          recipe.id,
          product.recipe.source_status,
          fingerprint,
          JSON.stringify({ product_external_id: product.external_id }),
        );
      } else if (product.recipe?.external_id) {
        insertRef.run(
          'recipe',
          product.recipe.external_id,
          'recipe_pending',
          id,
          product.recipe.source_status,
          fingerprint,
          JSON.stringify({ product_external_id: product.external_id, pending: true }),
        );
      }
    }
    for (const modifier of pilot.modifiers) {
      insertRef.run(
        'modifier',
        modifier.external_id,
        'modifier_pending',
        modifier.external_id,
        modifier.source_status,
        fingerprint,
        JSON.stringify({
          pending_reason: modifier.pending_reason,
          applicable_to: modifier.applicable_to || [],
        }),
      );
    }
  });
  tx.immediate();
  return { ...report, outcome: 'applied', created };
}
