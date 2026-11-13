import { randomBytes } from 'node:crypto';
import { now } from '../db';
import { roundUnitCost } from './supplies';
import { convertQuantity, assertSupplyUnit, type SupplyUnit } from './units';

type Db = ReturnType<typeof import('../db').getDatabase>;
type PurchasingLineRow = {
  id: string; list_id: string; supply_id: string; planned_quantity: number; planned_unit: SupplyUnit;
  planned_supplier: string | null; planned_brand: string | null; reference_price: number | null;
  purchased_quantity: number; purchased_unit: SupplyUnit | null; status: string; version: number;
  base_unit: SupplyUnit;
};
export class PurchasingError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string) {
    super(message);
    this.name = 'PurchasingError';
  }
}
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const text = (value: unknown, field: string, required = false): string | null => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PurchasingError(400, `${field} is required`, 'validation');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > 200) throw new PurchasingError(400, `${field} is invalid`, 'validation');
  return value.trim() || null;
};
const positive = (v: unknown, field: string, allowZero = false): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) throw new PurchasingError(400, `${field} is invalid`, 'validation');
  return n;
};

export function createPurchasingList(db: Db, input: { name: string; actorUserId: string; idempotencyKey: string; lines: Array<Record<string, unknown>> }) {
  const name = text(input.name, 'name', true)!;
  const key = text(input.idempotencyKey, 'idempotencyKey', true)!;
  if (key.length > 128 || !input.actorUserId || !Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) {
    throw new PurchasingError(400, 'actor, idempotency key and at least one line are required', 'validation');
  }
  const timestamp = now();
  const lines = input.lines.map((line) => {
    const supplyId = text(line.supplyId, 'supplyId', true)!;
    if (!db.prepare('SELECT id FROM supplies WHERE id=? AND deleted_at IS NULL').get(supplyId)) {
      throw new PurchasingError(404, `Supply ${supplyId} not found`, 'supply_not_found');
    }
    const quantity = positive(line.plannedQuantity, 'plannedQuantity');
    const unit = assertSupplyUnit(line.plannedUnit, 'plannedUnit');
    const price = line.referencePrice === undefined || line.referencePrice === null ? null : positive(line.referencePrice, 'referencePrice', true);
    const priceUnit = line.referenceUnit == null ? (price === null ? null : unit) : assertSupplyUnit(line.referenceUnit, 'referenceUnit');
    return {
      supplyId, quantity, unit, supplier: text(line.supplier, 'supplier'), brand: text(line.brand, 'brand'), price, priceUnit,
      observedAt: price === null ? null : text(line.referenceObservedAt, 'referenceObservedAt'),
      source: price === null ? null : (text(line.referenceSource, 'referenceSource') || 'operator'),
    };
  });
  const requestJson = JSON.stringify({ name, lines });
  const previous = db.prepare('SELECT id,request_json FROM purchasing_lists WHERE idempotency_key=?').get(key) as { id: string; request_json: string } | undefined;
  if (previous) {
    if (previous.request_json !== requestJson) throw new PurchasingError(409, 'Idempotency key was already used with different list data', 'idempotency_conflict');
    return { ...getPurchasingList(db, previous.id), replayed: true };
  }
  const listId = id('plist');
  const insertLine = db.prepare(`INSERT INTO purchasing_list_lines
    (id,list_id,supply_id,planned_quantity,planned_unit,planned_supplier,planned_brand,reference_price,reference_unit,reference_observed_at,reference_source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertList = db.transaction(() => {
    db.prepare('INSERT INTO purchasing_lists (id,idempotency_key,request_json,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(listId, key, requestJson, name, input.actorUserId, timestamp, timestamp);
    for (const line of lines) {
      insertLine.run(id('pline'), listId, line.supplyId, line.quantity, line.unit,
        line.supplier, line.brand, line.price, line.priceUnit, line.observedAt || (line.price === null ? null : timestamp), line.source, timestamp, timestamp);
    }
  });
  try { insertList.immediate(); } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    const duplicate = db.prepare('SELECT id,request_json FROM purchasing_lists WHERE idempotency_key=?').get(key) as { id: string; request_json: string } | undefined;
    if (String(code || '').includes('CONSTRAINT') && duplicate) {
      if (duplicate.request_json !== requestJson) throw new PurchasingError(409, 'Idempotency key was already used with different list data', 'idempotency_conflict');
      return { ...getPurchasingList(db, duplicate.id), replayed: true };
    }
    throw error;
  }
  return getPurchasingList(db, listId);
}

export function getPurchasingList(db: Db, listId: string) {
  const list = db.prepare('SELECT * FROM purchasing_lists WHERE id = ?').get(listId);
  if (!list) throw new PurchasingError(404, 'Purchasing list not found', 'not_found');
  const lines = db.prepare(`SELECT l.*, s.name AS supply_name, s.base_unit FROM purchasing_list_lines l
    JOIN supplies s ON s.id=l.supply_id WHERE l.list_id=? ORDER BY l.created_at,l.id`).all(listId);
  return { ...list as object, lines };
}

export function listPurchasingLists(db: Db) {
  return db.prepare(`SELECT l.*, COUNT(i.id) AS line_count FROM purchasing_lists l
    LEFT JOIN purchasing_list_lines i ON i.list_id=l.id GROUP BY l.id ORDER BY l.created_at DESC`).all();
}

export function acquirePurchasingLine(db: Db, input: {
  lineId: string; actorUserId: string; idempotencyKey: string; expectedVersion: number;
  quantity?: number; unit?: string; price?: number; supplier?: string | null; brand?: string | null; effectiveAt?: string;
}) {
  const key = text(input.idempotencyKey, 'idempotencyKey', true)!;
  if (key.length > 128 || !input.actorUserId || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new PurchasingError(400, 'Invalid operation identity or expected version', 'validation');
  const line = db.prepare(`SELECT l.*,s.base_unit FROM purchasing_list_lines l JOIN supplies s ON s.id=l.supply_id WHERE l.id=?`).get(input.lineId) as PurchasingLineRow | undefined;
  if (!line) throw new PurchasingError(404, 'Purchasing line not found', 'not_found');
  const quantity = positive(input.quantity ?? line.planned_quantity, 'quantity');
  const unit: SupplyUnit = assertSupplyUnit(input.unit ?? line.planned_unit, 'unit');
  const price = input.price === undefined ? line.reference_price : positive(input.price, 'price', true);
  if (price === null || price === undefined) throw new PurchasingError(400, 'A price is required when no reference price exists', 'price_required');
  const supplier = input.supplier === undefined ? line.planned_supplier : text(input.supplier, 'supplier');
  const brand = input.brand === undefined ? line.planned_brand : text(input.brand, 'brand');
  const timestamp = now();
  const requestedEffectiveAt = text(input.effectiveAt, 'effectiveAt');
  const effectiveAt = requestedEffectiveAt || timestamp;
  const purchaseId = id('acq');
  const observationId = id('price');
  const request = { quantity, unit, price, supplier, brand, effectiveAt: requestedEffectiveAt };
  const prior = db.prepare('SELECT * FROM purchasing_acquisitions WHERE idempotency_key=?').get(key) as { line_id: string; request_json: string } | undefined;
  if (prior) {
    if (prior.line_id !== line.id || prior.request_json !== JSON.stringify(request)) {
      throw new PurchasingError(409, 'Idempotency key was already used with different acquisition data', 'idempotency_conflict');
    }
    return { ...prior, replayed: true };
  }
  if (line.version !== input.expectedVersion) throw new PurchasingError(409, 'Purchasing line changed; reload before retrying', 'conflict');
  if (line.status !== 'pending') throw new PurchasingError(409, 'Purchasing line is not pending', 'conflict');
  const transaction = db.transaction(() => {
    const acceptedDefaults: string[] = [];
    const corrected: string[] = [];
    const provenance: Array<[string, unknown]> = [
      ['quantity', input.quantity], ['unit', input.unit], ['price', input.price],
      ['supplier', input.supplier], ['brand', input.brand],
    ];
    for (const [field, provided] of provenance) (provided === undefined ? acceptedDefaults : corrected).push(field);
    db.prepare(`INSERT INTO purchasing_acquisitions
      (id,line_id,idempotency_key,quantity,unit,price,supplier,brand,actor_user_id,created_at,request_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(purchaseId, line.id, key, quantity, unit, price, supplier, brand, input.actorUserId, timestamp, JSON.stringify(request));
    const normalized = roundUnitCost(price / convertQuantity(quantity, unit, line.base_unit));
    db.prepare(`INSERT INTO purchasing_price_observations
      (id,acquisition_id,line_id,supply_id,amount,observed_quantity,unit,normalized_unit_cost,supplier,brand,effective_at,recorded_at,source,actor_user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(observationId, purchaseId, line.id, line.supply_id, price, quantity, unit, normalized, supplier, brand, effectiveAt, timestamp, 'confirmed_acquisition', input.actorUserId);
    const acquiredBase = convertQuantity(line.purchased_quantity, line.purchased_unit || line.planned_unit, line.base_unit) + convertQuantity(quantity, unit, line.base_unit);
    const plannedBase = convertQuantity(line.planned_quantity, line.planned_unit, line.base_unit);
    const complete = acquiredBase >= plannedBase;
    db.prepare(`UPDATE purchasing_list_lines SET purchased_quantity=?,purchased_unit=?,actual_supplier=?,actual_brand=?,actual_price=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
      .run(acquiredBase, line.base_unit, supplier, brand, price, complete ? 'acquired' : 'pending', timestamp, line.id, input.expectedVersion);
    db.prepare(`INSERT INTO purchasing_line_events (line_id,actor_user_id,action,details_json,created_at) VALUES (?,?,?,?,?)`)
      .run(line.id, input.actorUserId, 'acquired', JSON.stringify({ idempotency_key: key, defaults_accepted: acceptedDefaults, explicitly_corrected: corrected, acquired_quantity: quantity, unit }), timestamp);
    return { acquisitionId: purchaseId, observationId, status: complete ? 'acquired' : 'pending', purchasedQuantity: acquiredBase, version: input.expectedVersion + 1, replayed: false };
  });
  try { return transaction.immediate(); } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    const duplicate = db.prepare('SELECT * FROM purchasing_acquisitions WHERE idempotency_key=?').get(key) as { line_id: string; request_json: string } | undefined;
    if (String(code || '').includes('CONSTRAINT') && duplicate) {
      if (duplicate.line_id !== line.id || duplicate.request_json !== JSON.stringify(request)) {
        throw new PurchasingError(409, 'Idempotency key was already used with different acquisition data', 'idempotency_conflict');
      }
      return { ...duplicate, replayed: true };
    }
    throw error;
  }
}

export function listPriceObservations(db: Db, supplyId: string) {
  return db.prepare(`SELECT * FROM purchasing_price_observations WHERE supply_id=? ORDER BY effective_at,recorded_at,rowid`).all(supplyId);
}

export function correctPriceObservation(db: Db, input: { observationId: string; actorUserId: string; amount: number; quantity?: number; unit: string; reason: string; effectiveAt?: string; idempotencyKey: string }) {
  const previous = db.prepare('SELECT * FROM purchasing_price_observations WHERE id=?').get(input.observationId) as {
    id: string; acquisition_id: string | null; line_id: string; supply_id: string; observed_quantity: number;
    supplier: string | null; brand: string | null; effective_at: string;
  } | undefined;
  if (!previous) throw new PurchasingError(404, 'Price observation not found', 'not_found');
  const key = text(input.idempotencyKey, 'idempotencyKey', true)!;
  const amount = positive(input.amount, 'amount', true);
  const quantity = positive(input.quantity ?? previous.observed_quantity, 'quantity');
  const unit = assertSupplyUnit(input.unit, 'unit');
  const reason = text(input.reason, 'reason', true)!;
  const duplicate = db.prepare(`SELECT details_json FROM purchasing_line_events
    WHERE json_extract(details_json, '$.idempotency_key')=?`).get(key) as { details_json: string } | undefined;
  if (duplicate) {
    const prior = JSON.parse(duplicate.details_json);
    if (prior.observation_id !== previous.id || prior.amount !== amount || prior.quantity !== quantity || prior.unit !== unit || prior.reason !== reason) {
      throw new PurchasingError(409, 'Idempotency key was already used with different correction data', 'idempotency_conflict');
    }
    return listPriceObservations(db, previous.supply_id);
  }
  const supply = db.prepare('SELECT base_unit FROM supplies WHERE id=?').get(previous.supply_id) as { base_unit: SupplyUnit } | undefined;
  if (!supply) throw new PurchasingError(404, 'Supply not found', 'supply_not_found');
  const normalized = roundUnitCost(amount / convertQuantity(quantity, unit, supply.base_unit));
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO purchasing_price_observations
      (id,acquisition_id,line_id,supply_id,amount,observed_quantity,unit,normalized_unit_cost,supplier,brand,effective_at,recorded_at,source,corrects_observation_id,correction_reason,actor_user_id)
      VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id('price'), previous.line_id, previous.supply_id, amount, quantity, unit, normalized, previous.supplier, previous.brand, text(input.effectiveAt, 'effectiveAt') || previous.effective_at, timestamp, 'correction', previous.id, reason, input.actorUserId);
    db.prepare('INSERT INTO purchasing_line_events (line_id,actor_user_id,action,details_json,created_at) VALUES (?,?,?,?,?)').run(previous.line_id, input.actorUserId, 'price_corrected', JSON.stringify({ observation_id: previous.id, idempotency_key: key, amount, quantity, unit, reason }), timestamp);
  }).immediate();
  return listPriceObservations(db, previous.supply_id);
}

export function markPurchasingLineNotFound(db: Db, input: { lineId: string; actorUserId: string; expectedVersion: number; idempotencyKey: string }) {
  const line = db.prepare('SELECT * FROM purchasing_list_lines WHERE id=?').get(input.lineId) as {
    id: string; version: number; status: string;
  } | undefined;
  if (!line) throw new PurchasingError(404, 'Purchasing line not found', 'not_found');
  const key = text(input.idempotencyKey, 'idempotencyKey', true)!;
  if (key.length > 128 || !input.actorUserId || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new PurchasingError(400, 'Invalid operation identity or expected version', 'validation');
  const event = db.prepare(`SELECT details_json FROM purchasing_line_events WHERE json_extract(details_json,'$.idempotency_key')=?`).get(key) as { details_json: string } | undefined;
  if (event) {
    const details = JSON.parse(event.details_json);
    if (details.line_id !== line.id || details.action !== 'not_found') throw new PurchasingError(409, 'Idempotency key was already used with different data', 'idempotency_conflict');
    return { ...line, replayed: true };
  }
  if (line.version !== input.expectedVersion || line.status !== 'pending') throw new PurchasingError(409, 'Purchasing line changed; reload before retrying', 'conflict');
  const timestamp = now();
  db.transaction(() => {
    db.prepare("UPDATE purchasing_list_lines SET status='not_found',version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, line.id, input.expectedVersion);
    db.prepare('INSERT INTO purchasing_line_events (line_id,actor_user_id,action,details_json,created_at) VALUES (?,?,?,?,?)').run(line.id, input.actorUserId, 'not_found', JSON.stringify({ action: 'not_found', line_id: line.id, idempotency_key: key }), timestamp);
  }).immediate();
  return { ...line, status: 'not_found', version: input.expectedVersion + 1, replayed: false };
}
