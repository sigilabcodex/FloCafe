import { randomBytes } from 'crypto';
import Decimal from 'decimal.js';
import { getDatabase, now } from '../db';
import {
  applySupplyStockChange,
  roundCurrencyCost,
  roundUnitCost,
  resolveDbCurrencyFractionDigits,
} from './supplies';
import { SupplyUnit, assertSupplyUnit, convertQuantity, roundQuantity } from './units';

type Db = ReturnType<typeof getDatabase>;

export class ProductionServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = 'ProductionServiceError';
  }
}

export interface PrepComponentInput {
  supplyId: string;
  quantity: number;
  unit: SupplyUnit;
}

interface SnapshotComponent {
  supply_id: string;
  quantity: number;
  unit: SupplyUnit;
  unit_cost: number | null;
  line_cost: number | null;
}

interface ProductionOrderRow {
  id: string;
  prep_recipe_id: string;
  output_supply_id: string;
  idempotency_key: string;
  status: 'queued' | 'in_progress' | 'completed';
  planned_quantity: number;
  actual_quantity: number | null;
  snapshot_json: string;
  total_input_cost: number | null;
  cost_known: number;
  version: number;
  created_by: string;
  started_by: string | null;
  completed_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const positiveFinite = (value: unknown, field: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new ProductionServiceError(
      400,
      `${field} must be positive and finite`,
      'quantity_invalid',
    );
  const rounded = roundQuantity(number);
  if (rounded <= 0)
    throw new ProductionServiceError(
      400,
      `${field} is below inventory precision`,
      'quantity_invalid',
    );
  return rounded;
};

function orderById(db: Db, orderId: string): ProductionOrderRow {
  const row = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(orderId) as
    | ProductionOrderRow
    | undefined;
  if (!row) throw new ProductionServiceError(404, 'Production order not found', 'order_missing');
  return row;
}

function decodeOrder(row: ProductionOrderRow) {
  return { ...row, snapshot: JSON.parse(row.snapshot_json) as SnapshotComponent[] };
}

export function createPrepRecipeVersion(
  db: Db,
  input: {
    outputSupplyId: string;
    yieldQuantity: number;
    components: PrepComponentInput[];
    actorUserId: string;
  },
) {
  const output = db
    .prepare(
      'SELECT id, base_unit FROM supplies WHERE id = ? AND deleted_at IS NULL AND is_active = 1',
    )
    .get(input.outputSupplyId) as { id: string; base_unit: SupplyUnit } | undefined;
  if (!output) throw new ProductionServiceError(404, 'Output supply not found', 'supply_missing');
  if (!input.actorUserId)
    throw new ProductionServiceError(400, 'actor_user_id is required', 'actor_missing');
  const yieldQuantity = positiveFinite(input.yieldQuantity, 'yield_quantity');
  if (!Array.isArray(input.components) || input.components.length === 0)
    throw new ProductionServiceError(
      400,
      'At least one component is required',
      'components_missing',
    );

  const seen = new Set<string>();
  const components = input.components.map((component) => {
    const supplyId = String(component.supplyId || '').trim();
    if (!supplyId || seen.has(supplyId) || supplyId === output.id)
      throw new ProductionServiceError(
        400,
        'Invalid or duplicate component supply',
        'component_invalid',
      );
    seen.add(supplyId);
    const supply = db
      .prepare(
        'SELECT id, base_unit FROM supplies WHERE id = ? AND deleted_at IS NULL AND is_active = 1',
      )
      .get(supplyId) as { id: string; base_unit: SupplyUnit } | undefined;
    if (!supply)
      throw new ProductionServiceError(
        404,
        `Component supply ${supplyId} not found`,
        'supply_missing',
      );
    const unit = assertSupplyUnit(component.unit, 'unit');
    const quantity = positiveFinite(component.quantity, 'component.quantity');
    return {
      supply_id: supply.id,
      quantity: convertQuantity(quantity, unit, supply.base_unit),
      unit: supply.base_unit,
    };
  });

  return db
    .transaction(() => {
      const current = db
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS version FROM prep_recipes WHERE output_supply_id = ?',
        )
        .get(output.id) as { version: number };
      db.prepare(
        'UPDATE prep_recipes SET is_active = 0 WHERE output_supply_id = ? AND is_active = 1',
      ).run(output.id);
      const recipeId = id('prep');
      db.prepare(`
      INSERT INTO prep_recipes
        (id, output_supply_id, version, yield_quantity, components_json, is_active, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
        recipeId,
        output.id,
        current.version + 1,
        yieldQuantity,
        JSON.stringify(components),
        input.actorUserId,
        now(),
      );
      return db.prepare('SELECT * FROM prep_recipes WHERE id = ?').get(recipeId);
    })
    .immediate();
}

export function createProductionOrder(
  db: Db,
  input: { recipeId: string; plannedQuantity: number; idempotencyKey: string; actorUserId: string },
) {
  const key = String(input.idempotencyKey || '').trim();
  if (!key || key.length > 128)
    throw new ProductionServiceError(
      400,
      'A valid idempotency key is required',
      'idempotency_invalid',
    );
  const plannedQuantity = positiveFinite(input.plannedQuantity, 'planned_quantity');
  if (!input.actorUserId)
    throw new ProductionServiceError(400, 'actor_user_id is required', 'actor_missing');

  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT * FROM production_orders WHERE idempotency_key = ?')
        .get(key) as ProductionOrderRow | undefined;
      if (existing) {
        if (
          existing.prep_recipe_id !== input.recipeId ||
          existing.planned_quantity !== plannedQuantity
        )
          throw new ProductionServiceError(
            409,
            'Idempotency key was already used with different input',
            'idempotency_conflict',
          );
        return decodeOrder(existing);
      }
      const recipe = db
        .prepare('SELECT * FROM prep_recipes WHERE id = ? AND is_active = 1')
        .get(input.recipeId) as
        | { id: string; output_supply_id: string; yield_quantity: number; components_json: string }
        | undefined;
      if (!recipe)
        throw new ProductionServiceError(
          404,
          'Active preparation recipe not found',
          'recipe_missing',
        );
      const factor = plannedQuantity / Number(recipe.yield_quantity);
      const components = (
        JSON.parse(recipe.components_json) as Omit<SnapshotComponent, 'unit_cost' | 'line_cost'>[]
      ).map((component) => ({
        ...component,
        quantity: roundQuantity(component.quantity * factor),
        unit_cost: null,
        line_cost: null,
      }));
      const orderId = id('prod');
      const timestamp = now();
      db.prepare(`
      INSERT INTO production_orders
        (id, prep_recipe_id, output_supply_id, idempotency_key, status, planned_quantity,
         snapshot_json, created_by, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
        orderId,
        recipe.id,
        recipe.output_supply_id,
        key,
        plannedQuantity,
        JSON.stringify(components),
        input.actorUserId,
        timestamp,
      );
      db.prepare(`INSERT INTO production_order_events (production_order_id, action, actor_user_id, created_at)
      VALUES (?, 'created', ?, ?)`).run(orderId, input.actorUserId, timestamp);
      return decodeOrder(orderById(db, orderId));
    })
    .immediate();
}

export function startProductionOrder(
  db: Db,
  orderId: string,
  actorUserId: string,
  expectedVersion: number,
) {
  return db
    .transaction(() => {
      const order = orderById(db, orderId);
      if (order.status === 'in_progress' || order.status === 'completed') return decodeOrder(order);
      if (order.version !== expectedVersion)
        throw new ProductionServiceError(
          409,
          'Production order version changed',
          'version_conflict',
        );
      if (order.status !== 'queued')
        throw new ProductionServiceError(
          409,
          'Production order cannot be started',
          'state_conflict',
        );
      if (!actorUserId)
        throw new ProductionServiceError(400, 'actor_user_id is required', 'actor_missing');

      const components = JSON.parse(order.snapshot_json) as SnapshotComponent[];
      const prepared = components.map((component) => {
        const supply = db
          .prepare(
            'SELECT stock_quantity, unit_cost FROM supplies WHERE id = ? AND deleted_at IS NULL',
          )
          .get(component.supply_id) as
          | { stock_quantity: number; unit_cost: number | null }
          | undefined;
        if (!supply)
          throw new ProductionServiceError(404, 'Component supply not found', 'supply_missing');
        if (Number(supply.stock_quantity) + 1e-8 < component.quantity)
          throw new ProductionServiceError(
            409,
            `Insufficient stock for supply ${component.supply_id}`,
            'stock_insufficient',
          );
        const unitCost = supply.unit_cost === null ? null : Number(supply.unit_cost);
        return {
          ...component,
          unit_cost: unitCost,
          line_cost:
            unitCost === null
              ? null
              : roundCurrencyCost(
                  new Decimal(component.quantity).mul(unitCost),
                  resolveDbCurrencyFractionDigits(db),
                ),
        };
      });
      const costKnown = prepared.every((component) => component.line_cost !== null);
      const totalCost = costKnown
        ? roundCurrencyCost(
            prepared.reduce((sum, component) => sum.plus(component.line_cost!), new Decimal(0)),
            resolveDbCurrencyFractionDigits(db),
          )
        : null;
      const timestamp = now();
      for (const component of prepared) {
        const result = applySupplyStockChange(db, {
          supplyId: component.supply_id,
          quantityDelta: -component.quantity,
          movementType: 'recipe_depletion',
          unit: component.unit,
          unitCost: component.unit_cost,
          totalCost: component.line_cost,
          reason: `Production issue ${order.id}`,
          actorUserId,
          referenceType: 'production_order',
          referenceId: order.id,
          createdAt: timestamp,
        });
        if (result.stockAfter < -1e-8)
          throw new ProductionServiceError(
            409,
            `Insufficient stock for supply ${component.supply_id}`,
            'stock_insufficient',
          );
      }
      db.prepare(`UPDATE production_orders SET status = 'in_progress', snapshot_json = ?, total_input_cost = ?,
      cost_known = ?, started_by = ?, started_at = ?, version = version + 1 WHERE id = ?`).run(
        JSON.stringify(prepared),
        totalCost,
        costKnown ? 1 : 0,
        actorUserId,
        timestamp,
        order.id,
      );
      db.prepare(`INSERT INTO production_order_events (production_order_id, action, actor_user_id, details_json, created_at)
      VALUES (?, 'started', ?, ?, ?)`).run(
        order.id,
        actorUserId,
        JSON.stringify({ cost_known: costKnown, total_input_cost: totalCost }),
        timestamp,
      );
      return decodeOrder(orderById(db, order.id));
    })
    .immediate();
}

export function completeProductionOrder(
  db: Db,
  orderId: string,
  input: { actualQuantity: number; actorUserId: string; expectedVersion: number },
) {
  const actualQuantity = positiveFinite(input.actualQuantity, 'actual_quantity');
  if (!input.actorUserId)
    throw new ProductionServiceError(400, 'actor_user_id is required', 'actor_missing');
  return db
    .transaction(() => {
      const order = orderById(db, orderId);
      if (order.status === 'completed') {
        if (Number(order.actual_quantity) !== actualQuantity)
          throw new ProductionServiceError(
            409,
            'Completed order has a different actual quantity',
            'completion_conflict',
          );
        return decodeOrder(order);
      }
      if (order.status !== 'in_progress' || order.version !== input.expectedVersion)
        throw new ProductionServiceError(
          409,
          'Production order state or version changed',
          'version_conflict',
        );
      const snapshot = JSON.parse(order.snapshot_json) as SnapshotComponent[];
      const costKnown =
        snapshot.length > 0 && snapshot.every((component) => component.line_cost !== null);
      const totalCost = costKnown ? Number(order.total_input_cost) : null;
      const batchUnitCost = costKnown
        ? roundUnitCost(new Decimal(totalCost!).div(actualQuantity))
        : null;
      const output = db
        .prepare(
          'SELECT stock_quantity, unit_cost, base_unit FROM supplies WHERE id = ? AND deleted_at IS NULL',
        )
        .get(order.output_supply_id) as
        | { stock_quantity: number; unit_cost: number | null; base_unit: SupplyUnit }
        | undefined;
      if (!output)
        throw new ProductionServiceError(404, 'Output supply not found', 'supply_missing');
      const stockBefore = Number(output.stock_quantity);
      const stockAfter = roundQuantity(stockBefore + actualQuantity);
      const previousCost = output.unit_cost === null ? null : Number(output.unit_cost);
      const unitCostAfter =
        batchUnitCost === null
          ? previousCost
          : previousCost === null || stockBefore <= 0
            ? batchUnitCost
            : roundUnitCost(
                new Decimal(stockBefore)
                  .mul(previousCost)
                  .plus(new Decimal(actualQuantity).mul(batchUnitCost))
                  .div(stockAfter),
              );
      const timestamp = now();
      applySupplyStockChange(db, {
        supplyId: order.output_supply_id,
        quantityDelta: actualQuantity,
        movementType: 'adjustment',
        unit: output.base_unit,
        unitCost: batchUnitCost,
        totalCost,
        unitCostAfter,
        reason: `Production output ${order.id}; planned ${order.planned_quantity}, actual ${actualQuantity}`,
        actorUserId: input.actorUserId,
        referenceType: 'production_order',
        referenceId: order.id,
        createdAt: timestamp,
      });
      db.prepare(`UPDATE production_orders SET status = 'completed', actual_quantity = ?, completed_by = ?,
      completed_at = ?, version = version + 1 WHERE id = ?`).run(
        actualQuantity,
        input.actorUserId,
        timestamp,
        order.id,
      );
      db.prepare(`INSERT INTO production_order_events (production_order_id, action, actor_user_id, details_json, created_at)
      VALUES (?, 'completed', ?, ?, ?)`).run(
        order.id,
        input.actorUserId,
        JSON.stringify({
          planned_quantity: order.planned_quantity,
          actual_quantity: actualQuantity,
          total_input_cost: totalCost,
          unit_cost: batchUnitCost,
          variance: roundQuantity(Number(order.planned_quantity) - actualQuantity),
        }),
        timestamp,
      );
      return decodeOrder(orderById(db, order.id));
    })
    .immediate();
}

export function getProductionOrder(db: Db, orderId: string) {
  return decodeOrder(orderById(db, orderId));
}
