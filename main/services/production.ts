import { randomBytes } from 'crypto';
import Decimal from 'decimal.js';
import { ROLE_KEYS, type Role } from '../../shared/role-permissions';
import { getDatabase, now } from '../db';
import {
  applySupplyStockChange,
  roundCurrencyCost,
  roundUnitCost,
  resolveDbCurrencyFractionDigits,
} from './supplies';
import { SupplyUnit, assertSupplyUnit, convertQuantity, roundQuantity } from './units';

type Db = ReturnType<typeof getDatabase>;
export type ProductionOrderStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'abandoned';

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

export type ProductionStepType = 'operation' | 'wait' | 'check';
export type ProductionStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'blocked';

export interface ProductionProcessStepInput {
  stepKey: string;
  name: string;
  instructions?: string | null;
  type: ProductionStepType;
  plannedDurationMinutes?: number | null;
  dependencies?: string[];
  optional?: boolean;
  suggestedRole?: Role | null;
  suggestedResponsible?: string | null;
  resource?: string | null;
  verificationPrompt?: string | null;
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
  process_version_id: string | null;
  status: ProductionOrderStatus;
  planned_quantity: number;
  actual_quantity: number | null;
  snapshot_json: string;
  total_input_cost: number | null;
  cost_known: number;
  version: number;
  created_by: string;
  started_by: string | null;
  completed_by: string | null;
  terminal_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const positiveFinite = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new ProductionServiceError(
      400,
      `${field} must be positive and finite`,
      'quantity_invalid',
    );
  const rounded = roundQuantity(value);
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
  if (input.components.some((component) => !component || typeof component !== 'object'))
    throw new ProductionServiceError(400, 'Each component must be an object', 'component_invalid');

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

export function listPrepRecipeVersions(db: Db, outputSupplyId?: string) {
  const rows = outputSupplyId
    ? (db
        .prepare('SELECT * FROM prep_recipes WHERE output_supply_id = ? ORDER BY version DESC')
        .all(outputSupplyId) as Array<Record<string, unknown>>)
    : (db
        .prepare('SELECT * FROM prep_recipes ORDER BY output_supply_id, version DESC')
        .all() as Array<Record<string, unknown>>);
  return rows.map((row) => ({
    ...row,
    components: JSON.parse(String(row.components_json)),
  }));
}

function boundedText(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): string | null {
  if (value === undefined || value === null || value === '') {
    if (required)
      throw new ProductionServiceError(400, `${field} is required`, 'process_field_invalid');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new ProductionServiceError(
      400,
      `${field} must be a non-empty string of at most ${maxLength} characters`,
      'process_field_invalid',
    );
  }
  return value.trim();
}

function normalizeProcessSteps(
  input: unknown,
): Array<ProductionProcessStepInput & { dependencies: string[] }> {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw new ProductionServiceError(
      400,
      'steps must contain between 1 and 100 entries',
      'process_steps_invalid',
    );
  }
  const keys = new Set<string>();
  const steps = input.map((value, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProductionServiceError(
        400,
        `steps[${position}] must be an object`,
        'process_step_invalid',
      );
    }
    const raw = value as Record<string, unknown>;
    const stepKey = boundedText(raw.step_key, `steps[${position}].step_key`, 64, true)!;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(stepKey) || keys.has(stepKey)) {
      throw new ProductionServiceError(
        400,
        `steps[${position}].step_key must be unique and use letters, numbers, _ or -`,
        'process_step_key_invalid',
      );
    }
    keys.add(stepKey);
    const name = boundedText(raw.name, `steps[${position}].name`, 120, true)!;
    const type = raw.type;
    if (type !== 'operation' && type !== 'wait' && type !== 'check') {
      throw new ProductionServiceError(
        400,
        `steps[${position}].type is invalid`,
        'process_step_type_invalid',
      );
    }
    let plannedDurationMinutes: number | null = null;
    if (raw.planned_duration_minutes !== undefined && raw.planned_duration_minutes !== null) {
      if (
        typeof raw.planned_duration_minutes !== 'number' ||
        !Number.isFinite(raw.planned_duration_minutes) ||
        raw.planned_duration_minutes < 0 ||
        raw.planned_duration_minutes > 10080
      ) {
        throw new ProductionServiceError(
          400,
          `steps[${position}].planned_duration_minutes must be between 0 and 10080`,
          'process_duration_invalid',
        );
      }
      plannedDurationMinutes = raw.planned_duration_minutes;
    }
    const dependencies = raw.dependencies === undefined ? [] : raw.dependencies;
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((dependency) => typeof dependency !== 'string') ||
      new Set(dependencies).size !== dependencies.length
    ) {
      throw new ProductionServiceError(
        400,
        `steps[${position}].dependencies must be a list of unique step keys`,
        'process_dependencies_invalid',
      );
    }
    if (raw.optional !== undefined && typeof raw.optional !== 'boolean') {
      throw new ProductionServiceError(
        400,
        `steps[${position}].optional must be boolean`,
        'process_step_invalid',
      );
    }
    const suggestedRole = raw.suggested_role;
    if (
      suggestedRole !== undefined &&
      suggestedRole !== null &&
      !ROLE_KEYS.includes(suggestedRole as Role)
    ) {
      throw new ProductionServiceError(
        400,
        `steps[${position}].suggested_role is invalid`,
        'process_role_invalid',
      );
    }
    return {
      stepKey,
      name,
      instructions: boundedText(raw.instructions, `steps[${position}].instructions`, 2000),
      type: type as ProductionStepType,
      plannedDurationMinutes,
      dependencies: dependencies as string[],
      optional: raw.optional === true,
      suggestedRole: (suggestedRole as Role | null | undefined) ?? null,
      suggestedResponsible: boundedText(
        raw.suggested_responsible,
        `steps[${position}].suggested_responsible`,
        120,
      ),
      resource: boundedText(raw.resource, `steps[${position}].resource`, 120),
      verificationPrompt: boundedText(
        raw.verification_prompt,
        `steps[${position}].verification_prompt`,
        500,
      ),
    };
  });
  const byKey = new Map(steps.map((step) => [step.stepKey, step]));
  for (const step of steps) {
    for (const dependency of step.dependencies) {
      if (!byKey.has(dependency) || dependency === step.stepKey) {
        throw new ProductionServiceError(
          400,
          `Step ${step.stepKey} has an unknown or self dependency: ${dependency}`,
          'process_dependency_missing',
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      throw new ProductionServiceError(
        400,
        'Process dependencies must not contain cycles',
        'process_dependency_cycle',
      );
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)!.dependencies) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const step of steps) visit(step.stepKey);
  return steps;
}

function normalizeProcessVersionName(value: unknown): string {
  return boundedText(value, 'name', 120, true)!;
}

export function createProductionProcessVersion(
  db: Db,
  input: { recipeId: string; name: string; steps: unknown; actorUserId: string },
) {
  const recipeId = boundedText(input.recipeId, 'recipe_id', 128, true)!;
  const name = normalizeProcessVersionName(input.name);
  const actorUserId = boundedText(input.actorUserId, 'actor_user_id', 128, true)!;
  const steps = normalizeProcessSteps(input.steps);
  return db
    .transaction(() => {
      const recipe = db
        .prepare('SELECT id FROM prep_recipes WHERE id = ? AND is_active = 1')
        .get(recipeId) as { id: string } | undefined;
      if (!recipe)
        throw new ProductionServiceError(
          404,
          'Active preparation recipe not found',
          'recipe_missing',
        );
      const current = db
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS version FROM production_process_versions WHERE prep_recipe_id = ?',
        )
        .get(recipeId) as { version: number };
      db.prepare(
        'UPDATE production_process_versions SET is_active = 0 WHERE prep_recipe_id = ? AND is_active = 1',
      ).run(recipeId);
      const processVersionId = id('process');
      db.prepare(`INSERT INTO production_process_versions
      (id, prep_recipe_id, version, name, is_active, created_by, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`).run(
        processVersionId,
        recipeId,
        current.version + 1,
        name,
        actorUserId,
        now(),
      );
      const insertStep = db.prepare(`INSERT INTO production_process_steps
      (id, process_version_id, step_key, position, name, instructions, step_type,
       planned_duration_minutes, dependencies_json, is_optional, suggested_role,
       suggested_responsible, resource_label, verification_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      steps.forEach((step, position) =>
        insertStep.run(
          id('pstep'),
          processVersionId,
          step.stepKey,
          position,
          step.name,
          step.instructions,
          step.type,
          step.plannedDurationMinutes,
          JSON.stringify(step.dependencies),
          step.optional ? 1 : 0,
          step.suggestedRole,
          step.suggestedResponsible,
          step.resource,
          step.verificationPrompt,
        ),
      );
      return getProductionProcessVersion(db, processVersionId);
    })
    .immediate();
}

export function getProductionProcessVersion(db: Db, processVersionId: string) {
  const process = db
    .prepare('SELECT * FROM production_process_versions WHERE id = ?')
    .get(processVersionId) as Record<string, unknown> | undefined;
  if (!process)
    throw new ProductionServiceError(
      404,
      'Production process version not found',
      'process_missing',
    );
  const steps = db
    .prepare(
      'SELECT * FROM production_process_steps WHERE process_version_id = ? ORDER BY position',
    )
    .all(processVersionId) as Array<Record<string, unknown>>;
  return {
    ...process,
    steps: steps.map((step) => ({
      ...step,
      dependencies: JSON.parse(String(step.dependencies_json)),
    })),
  };
}

export function listProductionProcessVersions(db: Db, recipeId?: string) {
  const rows = recipeId
    ? db
        .prepare(
          'SELECT * FROM production_process_versions WHERE prep_recipe_id = ? ORDER BY version DESC',
        )
        .all(recipeId)
    : db
        .prepare('SELECT * FROM production_process_versions ORDER BY prep_recipe_id, version DESC')
        .all();
  return (rows as Array<Record<string, unknown>>).map((row) =>
    getProductionProcessVersion(db, String(row.id)),
  );
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
      const activeProcess = db
        .prepare(`SELECT id FROM production_process_versions
          WHERE prep_recipe_id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1`)
        .get(recipe.id) as { id: string } | undefined;
      const orderId = id('prod');
      const timestamp = now();
      db.prepare(`
      INSERT INTO production_orders
        (id, prep_recipe_id, output_supply_id, idempotency_key, status, planned_quantity,
         snapshot_json, created_by, created_at, process_version_id)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
        orderId,
        recipe.id,
        recipe.output_supply_id,
        key,
        plannedQuantity,
        JSON.stringify(components),
        input.actorUserId,
        timestamp,
        activeProcess?.id ?? null,
      );
      if (activeProcess) {
        const templateSteps = db
          .prepare(
            'SELECT * FROM production_process_steps WHERE process_version_id = ? ORDER BY position',
          )
          .all(activeProcess.id) as Array<Record<string, unknown>>;
        const insertStep = db.prepare(`INSERT INTO production_order_steps
          (id, production_order_id, source_step_id, step_key, position, name, instructions,
           step_type, planned_duration_minutes, dependencies_json, is_optional, suggested_role,
           suggested_responsible, resource_label, verification_prompt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const step of templateSteps) {
          insertStep.run(
            id('ostep'),
            orderId,
            step.id,
            step.step_key,
            step.position,
            step.name,
            step.instructions,
            step.step_type,
            step.planned_duration_minutes,
            step.dependencies_json,
            step.is_optional,
            step.suggested_role,
            step.suggested_responsible,
            step.resource_label,
            step.verification_prompt,
          );
        }
      }
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
      if (order.status === 'cancelled' || order.status === 'abandoned')
        throw new ProductionServiceError(409, 'Production order is terminal', 'state_terminal');
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
          movementType: 'production_issue',
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
      if (order.status === 'cancelled' || order.status === 'abandoned')
        throw new ProductionServiceError(409, 'Production order is terminal', 'state_terminal');
      if (order.status !== 'in_progress' || order.version !== input.expectedVersion)
        throw new ProductionServiceError(
          409,
          'Production order state or version changed',
          'version_conflict',
        );
      assertProductionStepsReadyForCompletion(db, order);
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
        movementType: 'production_output',
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

export function listProductionOrders(
  db: Db,
  options: { status?: ProductionOrderStatus; limit?: number } = {},
) {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const rows = options.status
    ? (db
        .prepare(
          'SELECT * FROM production_orders WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(options.status, limit) as ProductionOrderRow[])
    : (db
        .prepare('SELECT * FROM production_orders ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit) as ProductionOrderRow[]);
  return rows.map(decodeOrder);
}

export function listProductionOrderEvents(db: Db, orderId: string) {
  orderById(db, orderId);
  return db
    .prepare('SELECT * FROM production_order_events WHERE production_order_id = ? ORDER BY id')
    .all(orderId);
}

function stepById(db: Db, orderId: string, stepId: string) {
  const row = db
    .prepare('SELECT * FROM production_order_steps WHERE production_order_id = ? AND id = ?')
    .get(orderId, stepId) as Record<string, unknown> | undefined;
  if (!row)
    throw new ProductionServiceError(404, 'Production order step not found', 'step_missing');
  return row;
}

function decodeStep(row: Record<string, unknown>) {
  return {
    ...row,
    dependencies: JSON.parse(String(row.dependencies_json || '[]')) as string[],
    is_optional: Boolean(row.is_optional),
  };
}

export function listProductionOrderSteps(db: Db, orderId: string) {
  orderById(db, orderId);
  const rows = db
    .prepare('SELECT * FROM production_order_steps WHERE production_order_id = ? ORDER BY position')
    .all(orderId) as Array<Record<string, unknown>>;
  return rows.map(decodeStep);
}

export function listProductionStepEvents(db: Db, orderId: string, stepId?: string) {
  orderById(db, orderId);
  if (stepId) stepById(db, orderId, stepId);
  const rows = stepId
    ? db
        .prepare(
          'SELECT * FROM production_step_events WHERE production_order_id = ? AND production_order_step_id = ? ORDER BY id',
        )
        .all(orderId, stepId)
    : db
        .prepare('SELECT * FROM production_step_events WHERE production_order_id = ? ORDER BY id')
        .all(orderId);
  return rows;
}

function assertStepDependenciesComplete(db: Db, orderId: string, step: Record<string, unknown>) {
  const dependencies = JSON.parse(String(step.dependencies_json || '[]')) as string[];
  if (dependencies.length === 0) return;
  const rows = db
    .prepare(`SELECT step_key, status FROM production_order_steps
      WHERE production_order_id = ? AND step_key IN (${dependencies.map(() => '?').join(',')})`)
    .all(orderId, ...dependencies) as Array<{ step_key: string; status: ProductionStepStatus }>;
  const byKey = new Map(rows.map((row) => [row.step_key, row.status]));
  const incomplete = dependencies.filter((key) => {
    const status = byKey.get(key);
    return status !== 'completed' && status !== 'skipped';
  });
  if (incomplete.length > 0) {
    throw new ProductionServiceError(
      409,
      `Production step dependencies are incomplete: ${incomplete.join(', ')}`,
      'step_dependencies_incomplete',
    );
  }
}

function assertProductionStepsReadyForCompletion(db: Db, order: ProductionOrderRow) {
  if (!order.process_version_id) return;
  const steps = db
    .prepare(
      'SELECT step_key, status, is_optional FROM production_order_steps WHERE production_order_id = ?',
    )
    .all(order.id) as Array<{
    step_key: string;
    status: ProductionStepStatus;
    is_optional: number;
  }>;
  if (steps.length === 0) {
    throw new ProductionServiceError(
      409,
      'Production process snapshot is missing steps',
      'process_snapshot_missing',
    );
  }
  const unfinishedRequired = steps.filter(
    (step) => !step.is_optional && step.status !== 'completed',
  );
  if (unfinishedRequired.length > 0) {
    throw new ProductionServiceError(
      409,
      `Required production steps are unfinished: ${unfinishedRequired.map((step) => step.step_key).join(', ')}`,
      'required_steps_incomplete',
    );
  }
  const activeOptional = steps.filter(
    (step) => step.is_optional && (step.status === 'in_progress' || step.status === 'blocked'),
  );
  if (activeOptional.length > 0) {
    throw new ProductionServiceError(
      409,
      `Optional production steps need resolution: ${activeOptional.map((step) => step.step_key).join(', ')}`,
      'optional_steps_unresolved',
    );
  }
}

export type ProductionStepAction = 'start' | 'complete' | 'skip' | 'block' | 'resume';

export function transitionProductionOrderStep(
  db: Db,
  orderId: string,
  stepId: string,
  input: {
    action: ProductionStepAction;
    actorUserId: string;
    expectedVersion: number;
    idempotencyKey: string;
    reason?: string;
    verificationResult?: string;
  },
) {
  const actorUserId = boundedText(input.actorUserId, 'actor_user_id', 128, true)!;
  const idempotencyKey = boundedText(input.idempotencyKey, 'idempotency_key', 128, true)!;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ProductionServiceError(
      400,
      'expected_version must be a non-negative integer',
      'version_invalid',
    );
  }
  const reason = input.reason === undefined ? null : boundedText(input.reason, 'reason', 500, true);
  if ((input.action === 'skip' || input.action === 'block') && !reason) {
    throw new ProductionServiceError(
      400,
      'A reason is required for this stage action',
      'reason_invalid',
    );
  }
  const verificationResult =
    input.verificationResult === undefined
      ? null
      : boundedText(input.verificationResult, 'verification_result', 1000, true);
  const requestJson = JSON.stringify({ reason, verification_result: verificationResult });
  return db
    .transaction(() => {
      const priorEvent = db
        .prepare(`SELECT production_order_id, production_order_step_id, action, request_json
        FROM production_step_events WHERE idempotency_key = ?`)
        .get(idempotencyKey) as
        | {
            production_order_id: string;
            production_order_step_id: string;
            action: string;
            request_json: string;
          }
        | undefined;
      if (priorEvent) {
        const actionByInput: Record<ProductionStepAction, string> = {
          start: 'started',
          complete: 'completed',
          skip: 'skipped',
          block: 'blocked',
          resume: 'resumed',
        };
        if (
          priorEvent.production_order_id !== orderId ||
          priorEvent.production_order_step_id !== stepId ||
          priorEvent.action !== actionByInput[input.action]
        ) {
          throw new ProductionServiceError(
            409,
            'Idempotency key was used for another stage action',
            'step_idempotency_conflict',
          );
        }
        if (priorEvent.request_json !== requestJson) {
          throw new ProductionServiceError(
            409,
            'Idempotency key was reused with different stage data',
            'step_idempotency_conflict',
          );
        }
        return { ...decodeStep(stepById(db, orderId, stepId)), replayed: true };
      }

      const order = orderById(db, orderId);
      if (order.status !== 'in_progress') {
        throw new ProductionServiceError(
          409,
          'Stages can only change on an in-progress production order',
          'state_conflict',
        );
      }
      const step = stepById(db, orderId, stepId);
      if (Number(step.version) !== input.expectedVersion) {
        throw new ProductionServiceError(
          409,
          'Production step version changed',
          'step_version_conflict',
        );
      }
      const oldStatus = String(step.status) as ProductionStepStatus;
      const timestamp = now();
      let newStatus: ProductionStepStatus;
      let startedAt = step.started_at ? String(step.started_at) : null;
      let completedAt: string | null = null;
      let actualDuration: number | null = null;
      let startedBy: string | null = step.started_by ? String(step.started_by) : null;
      let completedBy: string | null = null;
      let terminalReason: string | null = null;
      let storedVerification: string | null = null;

      switch (input.action) {
        case 'start':
          if (oldStatus !== 'pending')
            throw new ProductionServiceError(
              409,
              'Only pending steps can start',
              'step_state_conflict',
            );
          assertStepDependenciesComplete(db, orderId, step);
          newStatus = 'in_progress';
          startedAt = timestamp;
          startedBy = actorUserId;
          break;
        case 'complete':
          if (oldStatus !== 'in_progress')
            throw new ProductionServiceError(
              409,
              'Only in-progress steps can complete',
              'step_state_conflict',
            );
          assertStepDependenciesComplete(db, orderId, step);
          if (step.step_type === 'check' && !verificationResult) {
            throw new ProductionServiceError(
              400,
              'A verification result is required for check steps',
              'verification_required',
            );
          }
          newStatus = 'completed';
          completedAt = timestamp;
          completedBy = actorUserId;
          storedVerification = verificationResult;
          actualDuration = startedAt
            ? Math.max(0, Math.round((Date.parse(timestamp) - Date.parse(startedAt)) / 1000))
            : null;
          break;
        case 'skip':
          if (!step.is_optional)
            throw new ProductionServiceError(
              409,
              'Only optional steps can be skipped',
              'step_not_optional',
            );
          if (oldStatus !== 'pending' && oldStatus !== 'in_progress' && oldStatus !== 'blocked') {
            throw new ProductionServiceError(
              409,
              'Step cannot be skipped from its current state',
              'step_state_conflict',
            );
          }
          assertStepDependenciesComplete(db, orderId, step);
          newStatus = 'skipped';
          completedAt = timestamp;
          completedBy = actorUserId;
          actualDuration = startedAt
            ? Math.max(0, Math.round((Date.parse(timestamp) - Date.parse(startedAt)) / 1000))
            : null;
          terminalReason = reason;
          break;
        case 'block':
          if (oldStatus !== 'pending' && oldStatus !== 'in_progress') {
            throw new ProductionServiceError(
              409,
              'Step cannot be blocked from its current state',
              'step_state_conflict',
            );
          }
          newStatus = 'blocked';
          terminalReason = reason;
          break;
        case 'resume':
          if (oldStatus !== 'blocked')
            throw new ProductionServiceError(
              409,
              'Only blocked steps can resume',
              'step_state_conflict',
            );
          assertStepDependenciesComplete(db, orderId, step);
          newStatus = 'in_progress';
          startedAt = startedAt || timestamp;
          startedBy = startedBy || actorUserId;
          terminalReason = null;
          break;
      }

      db.prepare(`UPDATE production_order_steps SET status = ?, version = version + 1,
      started_by = ?, completed_by = ?, started_at = ?, completed_at = ?,
      actual_duration_seconds = ?, verification_result = COALESCE(?, verification_result),
      terminal_reason = ? WHERE id = ?`).run(
        newStatus,
        startedBy,
        completedBy,
        startedAt,
        completedAt,
        actualDuration,
        storedVerification,
        terminalReason,
        stepId,
      );
      db.prepare('UPDATE production_orders SET version = version + 1 WHERE id = ?').run(orderId);
      const eventAction =
        input.action === 'start'
          ? 'started'
          : input.action === 'complete'
            ? 'completed'
            : input.action === 'skip'
              ? 'skipped'
              : input.action === 'block'
                ? 'blocked'
                : 'resumed';
      const details = JSON.stringify({
        from: oldStatus,
        to: newStatus,
        reason,
        verification_result: verificationResult,
      });
      db.prepare(`INSERT INTO production_step_events
      (production_order_id, production_order_step_id, action, actor_user_id, idempotency_key, request_json, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        orderId,
        stepId,
        eventAction,
        actorUserId,
        idempotencyKey,
        requestJson,
        details,
        timestamp,
      );
      return { ...decodeStep(stepById(db, orderId, stepId)), replayed: false };
    })
    .immediate();
}

export function listProductionOrderMovements(db: Db, orderId: string) {
  orderById(db, orderId);
  return db
    .prepare(`SELECT m.*, s.name AS supply_name, u.name AS actor_name
      FROM supply_movements m
      LEFT JOIN supplies s ON s.id = m.supply_id
      LEFT JOIN users u ON u.id = m.actor_user_id
      WHERE m.reference_type = 'production_order' AND m.reference_id = ?
      ORDER BY m.created_at, m.id`)
    .all(orderId);
}

function normalizeTerminalReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > 500) {
    throw new ProductionServiceError(
      400,
      'reason is required and must be at most 500 characters',
      'reason_invalid',
    );
  }
  return reason;
}

export function cancelProductionOrder(
  db: Db,
  orderId: string,
  input: { actorUserId: string; reason: string; expectedVersion: number },
) {
  const reason = normalizeTerminalReason(input.reason);
  if (!input.actorUserId)
    throw new ProductionServiceError(400, 'actor_user_id is required', 'actor_missing');
  return db
    .transaction(() => {
      const order = orderById(db, orderId);
      if (order.status === 'cancelled') {
        if (order.terminal_reason !== reason)
          throw new ProductionServiceError(
            409,
            'Cancelled order has a different reason',
            'terminal_conflict',
          );
        return decodeOrder(order);
      }
      if (order.status !== 'queued')
        throw new ProductionServiceError(
          409,
          'Only queued production orders can be cancelled',
          'state_conflict',
        );
      if (order.version !== input.expectedVersion)
        throw new ProductionServiceError(
          409,
          'Production order version changed',
          'version_conflict',
        );
      const timestamp = now();
      db.prepare(`UPDATE production_orders SET status = 'cancelled', terminal_reason = ?, cancelled_by = ?,
        cancelled_at = ?, version = version + 1 WHERE id = ?`).run(
        reason,
        input.actorUserId,
        timestamp,
        order.id,
      );
      db.prepare(`INSERT INTO production_order_events
        (production_order_id, action, actor_user_id, details_json, created_at)
        VALUES (?, 'cancelled', ?, ?, ?)`).run(
        order.id,
        input.actorUserId,
        JSON.stringify({ reason }),
        timestamp,
      );
      return decodeOrder(orderById(db, order.id));
    })
    .immediate();
}

export function abandonProductionOrder(
  db: Db,
  orderId: string,
  input: { actorUserId: string; reason: string; expectedVersion: number },
) {
  const reason = normalizeTerminalReason(input.reason);
  if (!input.actorUserId)
    throw new ProductionServiceError(400, 'actor_user_id is required', 'actor_missing');
  return db
    .transaction(() => {
      const order = orderById(db, orderId);
      if (order.status === 'abandoned') {
        if (order.terminal_reason !== reason)
          throw new ProductionServiceError(
            409,
            'Abandoned order has a different reason',
            'terminal_conflict',
          );
        return decodeOrder(order);
      }
      if (order.status !== 'in_progress')
        throw new ProductionServiceError(
          409,
          'Only in-progress production orders can be abandoned',
          'state_conflict',
        );
      if (order.version !== input.expectedVersion)
        throw new ProductionServiceError(
          409,
          'Production order version changed',
          'version_conflict',
        );
      const timestamp = now();
      db.prepare(`UPDATE production_orders SET status = 'abandoned', terminal_reason = ?, abandoned_by = ?,
        abandoned_at = ?, version = version + 1 WHERE id = ?`).run(
        reason,
        input.actorUserId,
        timestamp,
        order.id,
      );
      db.prepare(`INSERT INTO production_order_events
        (production_order_id, action, actor_user_id, details_json, created_at)
        VALUES (?, 'abandoned', ?, ?, ?)`).run(
        order.id,
        input.actorUserId,
        JSON.stringify({ reason, ingredients_restored: false }),
        timestamp,
      );
      return decodeOrder(orderById(db, order.id));
    })
    .immediate();
}
