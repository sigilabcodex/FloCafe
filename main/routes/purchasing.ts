import { Router, type Request, type Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import { acquirePurchasingLine, correctPriceObservation, createPurchasingList, getPurchasingList, listPriceObservations, listPurchasingLists, markPurchasingLineNotFound } from '../services/purchasing';

const router = Router();
const actor = (req: Request) => String((req as Request & { user?: { userId?: string } }).user?.userId || '');
function fail(res: Response, error: unknown) {
  const e = error as { statusCode?: number; message?: string; code?: string };
  const status = Number.isInteger(e.statusCode) ? e.statusCode! : 500;
  if (status >= 500) console.error('[API] Purchasing error:', error);
  return res.status(status).json({ error: status >= 500 ? 'Internal server error' : e.message, ...(e.code && { code: e.code }) });
}
router.get('/lists', requirePermission('supplies.manage'), (_req, res) => res.json({ lists: listPurchasingLists(getDatabase()) }));
router.post('/lists', requirePermission('supplies.manage'), (req, res) => {
  try {
    const body = req.body || {};
    const lines = Array.isArray(body.lines) ? body.lines as Array<Record<string, unknown>> : [];
    const list = createPurchasingList(getDatabase(), { name: body.name, actorUserId: actor(req), idempotencyKey: body.idempotency_key, lines: lines.map((line) => ({
      supplyId: line.supply_id, plannedQuantity: line.planned_quantity, plannedUnit: line.planned_unit,
      supplier: line.supplier, brand: line.brand, referencePrice: line.reference_price, referenceUnit: line.reference_unit,
      referenceObservedAt: line.reference_observed_at, referenceSource: line.reference_source,
    })) });
    return res.status(201).json({ list });
  } catch (error) { return fail(res, error); }
});
router.get('/lists/:id', requirePermission('supplies.manage'), (req, res) => {
  try { return res.json({ list: getPurchasingList(getDatabase(), String(req.params.id)) }); } catch (error) { return fail(res, error); }
});
router.post('/lines/:id/acquisitions', requirePermission('supplies.manage'), (req, res) => {
  try {
    const body = req.body || {};
    const result = acquirePurchasingLine(getDatabase(), { lineId: String(req.params.id), actorUserId: actor(req),
      idempotencyKey: body.idempotency_key, expectedVersion: body.expected_version,
      quantity: body.quantity, unit: body.unit, price: body.price, supplier: body.supplier, brand: body.brand, effectiveAt: body.effective_at });
    return res.status(result.replayed ? 200 : 201).json({ acquisition: result });
  } catch (error) { return fail(res, error); }
});
router.post('/lines/:id/not-found', requirePermission('supplies.manage'), (req, res) => {
  try {
    const body = req.body || {};
    const result = markPurchasingLineNotFound(getDatabase(), { lineId: String(req.params.id), actorUserId: actor(req), expectedVersion: body.expected_version, idempotencyKey: body.idempotency_key });
    return res.status(200).json({ line: result });
  } catch (error) { return fail(res, error); }
});
router.get('/supplies/:id/price-history', requirePermission('supplies.manage'), (req, res) => res.json({ observations: listPriceObservations(getDatabase(), String(req.params.id)) }));
router.post('/price-observations/:id/corrections', requirePermission('supplies.manage'), (req, res) => {
  try {
    const body = req.body || {};
    const observations = correctPriceObservation(getDatabase(), { observationId: String(req.params.id), actorUserId: actor(req), amount: body.amount, quantity: body.quantity, unit: body.unit, reason: body.reason, effectiveAt: body.effective_at, idempotencyKey: body.idempotency_key });
    return res.status(201).json({ observations });
  } catch (error) { return fail(res, error); }
});
export const purchasingRoutes = router;
