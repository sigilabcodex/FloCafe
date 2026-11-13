const Module = require('module');
const originalLoad = Module._load;
const originalResolveFilename = Module._resolveFilename;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchasing-core-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options?: unknown) {
  const resolved = request.startsWith('@/') ? path.resolve(__dirname, '../frontend/src', request.slice(2)) : request;
  return originalResolveFilename.call(this, resolved, parent, isMain, options);
};
const { initTestDb, seedOwnerUser, assertOrThrow, assertEqualOrThrow, resetCounters, getResults, createApp, startServer, api } = require('./helpers/test-setup');
const { createSupply, getSupply } = require('../main/services/supplies');
const { createPurchasingList, getPurchasingList, acquirePurchasingLine, listPriceObservations, correctPriceObservation, markPurchasingLineNotFound } = require('../main/services/purchasing');

async function main() {
  resetCounters();
  const frontendRequire = Module.createRequire(path.resolve(__dirname, '../frontend/package.json'));
  const React = frontendRequire('react');
  const ReactDOMServer = frontendRequire('react-dom/server');
  const { ShoppingListCard } = require('../frontend/src/components/purchasing/ShoppingListCard');
  const renderedCard = ReactDOMServer.renderToStaticMarkup(React.createElement(ShoppingListCard, {
    name: 'Weekly flour', lineCount: 3, lineCountLabel: 'shopping list lines', createdAt: 'Nov 12', onSelect: () => undefined,
  }));
  assertOrThrow(renderedCard.includes('Weekly flour') && renderedCard.includes('3 · shopping list lines'), 'shopping list card renders list summary');
  assertOrThrow(renderedCard.includes('min-h-24') && renderedCard.includes('type="button"'), 'shopping list card provides a touch-sized button');
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const actor = owner.userId;
  assertOrThrow(Boolean(db.prepare('SELECT id FROM users WHERE id=?').get(actor)), 'synthetic purchasing actor is present');
  const supply = createSupply(db, { name: 'Flour', baseUnit: 'kg', stockQuantity: 12, unitCost: 20, actorUserId: actor });
  const stockBefore = getSupply(db, supply.id);
  const listInput = { name: 'Weekly', actorUserId: actor, idempotencyKey: 'list-1', lines: [
    { supplyId: supply.id, plannedQuantity: 10, plannedUnit: 'kg', supplier: 'Mill A', brand: 'Mill', referencePrice: 50, referenceUnit: 'kg', referenceSource: 'invoice', referenceObservedAt: '2026-10-01T10:00:00Z' },
  ] };
  const list = createPurchasingList(db, listInput);
  assertEqualOrThrow(list.lines.length, 1, 'list creation persists and returns its line');
  assertEqualOrThrow(list.lines[0].reference_price, 50, 'explicit reference price is retained');
  assertEqualOrThrow(createPurchasingList(db, listInput).id, list.id, 'list creation retry returns the original list');
  try { createPurchasingList(db, { ...listInput, name: 'Changed' }); assertOrThrow(false, 'list retry with changed data conflicts'); }
  catch (error: any) { assertEqualOrThrow(error.code, 'idempotency_conflict', 'list idempotency key protects request data'); }
  const line = list.lines[0];
  const defaults = db.prepare("SELECT details_json FROM purchasing_line_events WHERE line_id=? AND action='acquired'").get(line.id);
  assertOrThrow(defaults === undefined, 'no acquisition provenance exists before purchase confirmation');
  const purchasingRoutes = require('../main/routes/purchasing').purchasingRoutes;
  const server = await startServer(createApp({ '/api/purchasing': purchasingRoutes }));
  try {
    const denied = await api(server.baseUrl, '/api/purchasing/lists');
    assertEqualOrThrow(denied.status, 401, 'purchasing API requires authentication');
    const listed = await api(server.baseUrl, '/api/purchasing/lists', { headers: owner.authHeader });
    assertEqualOrThrow(listed.status, 200, 'authenticated purchaser can query lists');
    const apiList = await api(server.baseUrl, '/api/purchasing/lists', { method: 'POST', headers: owner.authHeader,
      body: { name: 'API List', idempotency_key: 'api-list', lines: [{ supply_id: supply.id, planned_quantity: 1, planned_unit: 'kg', reference_price: 9 }] } });
    assertEqualOrThrow(apiList.status, 201, 'purchaser can create a list through the private API');
    const apiLine = apiList.data.list.lines[0];
    const apiAcquisition = await api(server.baseUrl, `/api/purchasing/lines/${apiLine.id}/acquisitions`, { method: 'POST', headers: owner.authHeader,
      body: { idempotency_key: 'api-acq', expected_version: 0 } });
    assertEqualOrThrow(apiAcquisition.status, 201, 'purchaser can confirm acquisition through the private API');
    const apiHistory = await api(server.baseUrl, `/api/purchasing/supplies/${supply.id}/price-history`, { headers: owner.authHeader });
    assertEqualOrThrow(apiHistory.data.observations.length, 1, 'private API exposes associated price history');
    const apiLatestPrice = await api(server.baseUrl, '/api/purchasing/prices/latest', { headers: owner.authHeader });
    assertEqualOrThrow(apiLatestPrice.data.observations[0]?.supply_id, supply.id, 'purchasing UI can query each supply latest price');
  } finally {
    await new Promise<void>((resolve, reject) => server.server.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }
  const first = acquirePurchasingLine(db, { lineId: line.id, actorUserId: actor, idempotencyKey: 'acq-full', expectedVersion: 0 });
  assertEqualOrThrow(first.status, 'acquired', 'planned values are accepted as defaults');
  const provenance = JSON.parse(db.prepare("SELECT details_json FROM purchasing_line_events WHERE line_id=? AND action='acquired'").get(line.id).details_json);
  assertOrThrow(provenance.defaults_accepted.includes('quantity') && provenance.defaults_accepted.includes('price'), 'accepted defaults are attributed in the audit event');
  assertEqualOrThrow(provenance.explicitly_corrected.length, 0, 'unchanged values are not marked as corrections');
  const replay = acquirePurchasingLine(db, { lineId: line.id, actorUserId: actor, idempotencyKey: 'acq-full', expectedVersion: 0 });
  assertEqualOrThrow(replay.replayed, true, 'same operation is idempotent');
  try {
    acquirePurchasingLine(db, { lineId: line.id, actorUserId: actor, idempotencyKey: 'acq-full', expectedVersion: 0, price: 55 });
    assertOrThrow(false, 'reused key with changed values conflicts');
  } catch (error: any) { assertEqualOrThrow(error.code, 'idempotency_conflict', 'changed idempotent request conflicts'); }
  assertEqualOrThrow(getPurchasingList(db, list.id).lines[0].status, 'acquired', 'acquired status is queryable');
  assertEqualOrThrow(listPriceObservations(db, supply.id).find((row: any) => row.brand === 'Mill').normalized_unit_cost, 5, 'total acquisition price normalizes to per kg base unit');
  const priorObservation = listPriceObservations(db, supply.id)[0];
  correctPriceObservation(db, { observationId: priorObservation.id, actorUserId: actor, amount: 52, unit: 'kg', reason: 'Invoice correction', idempotencyKey: 'corr-1' });
  const history = listPriceObservations(db, supply.id);
  assertEqualOrThrow(history.length, 3, 'correction appends a new historical observation');
  const correction = history.find((row: any) => row.source === 'correction');
  assertEqualOrThrow(correction.corrects_observation_id, priorObservation.id, 'correction links to prior observation');
  assertEqualOrThrow(correction.correction_reason, 'Invoice correction', 'correction reason is audited');
  correctPriceObservation(db, { observationId: priorObservation.id, actorUserId: actor, amount: 52, unit: 'kg', reason: 'Invoice correction', idempotencyKey: 'corr-1' });
  assertEqualOrThrow(listPriceObservations(db, supply.id).length, 3, 'correction retry does not append another version');
  assertEqualOrThrow(getSupply(db, supply.id).stock_quantity, stockBefore.stock_quantity, 'acquisition does not change stock');
  assertEqualOrThrow(getSupply(db, supply.id).unit_cost, stockBefore.unit_cost, 'acquisition does not change WAC');

  const noRef = createPurchasingList(db, { name: 'No quote', actorUserId: actor, idempotencyKey: 'list-no-ref', lines: [{ supplyId: supply.id, plannedQuantity: 8, plannedUnit: 'kg' }] }).lines[0];
  try { acquirePurchasingLine(db, { lineId: noRef.id, actorUserId: actor, idempotencyKey: 'no-price', expectedVersion: 0 }); assertOrThrow(false, 'unknown price is not zero'); }
  catch (error: any) { assertEqualOrThrow(error.code, 'price_required', 'missing reference requires an actual price'); }
  const partialLine = createPurchasingList(db, { name: 'Partial', actorUserId: actor, idempotencyKey: 'list-partial', lines: [{ supplyId: supply.id, plannedQuantity: 10, plannedUnit: 'kg', referencePrice: 40 }] }).lines[0];
  const partial = acquirePurchasingLine(db, { lineId: partialLine.id, actorUserId: actor, idempotencyKey: 'partial-1', expectedVersion: 0, quantity: 4, price: 42, brand: 'Other', supplier: 'Mill C' });
  assertEqualOrThrow(partial.status, 'pending', 'partial acquisition retains pending balance');
  assertEqualOrThrow(partial.purchasedQuantity, 4, 'partial quantity is accumulated');
  assertEqualOrThrow(listPriceObservations(db, supply.id).at(-1).brand, 'Other', 'explicit brand difference is recorded');
  assertEqualOrThrow(listPriceObservations(db, supply.id).at(-1).supplier, 'Mill C', 'explicit supplier difference is recorded');
  const partialAudit = JSON.parse(db.prepare("SELECT details_json FROM purchasing_line_events WHERE line_id=? AND action='acquired'").get(partialLine.id).details_json);
  assertOrThrow(partialAudit.explicitly_corrected.includes('quantity') && partialAudit.explicitly_corrected.includes('price') && partialAudit.explicitly_corrected.includes('brand') && partialAudit.explicitly_corrected.includes('supplier'), 'corrected fields are auditable');
  const convertedLine = createPurchasingList(db, { name: 'Presentation', actorUserId: actor, idempotencyKey: 'list-presentation', lines: [{ supplyId: supply.id, plannedQuantity: 1, plannedUnit: 'kg' }] }).lines[0];
  const converted = acquirePurchasingLine(db, { lineId: convertedLine.id, actorUserId: actor, idempotencyKey: 'converted', expectedVersion: 0, quantity: 500, unit: 'g', price: 25, supplier: 'Mill B' });
  assertEqualOrThrow(converted.purchasedQuantity, 0.5, 'partial quantity converts to the supply base unit');
  assertEqualOrThrow(listPriceObservations(db, supply.id).at(-1).normalized_unit_cost, 50, '500 g package price normalizes to cost per kg');
  assertEqualOrThrow(listPriceObservations(db, supply.id).at(-1).unit, 'g', 'history preserves the original presentation unit');
  assertEqualOrThrow(listPriceObservations(db, supply.id).at(-1).observed_quantity, 500, 'history preserves presentation quantity');
  assertEqualOrThrow(listPriceObservations(db, supply.id).at(-1).supplier, 'Mill B', 'supplier correction is stored on acquisition');
  const missingLine = createPurchasingList(db, { name: 'Unavailable', actorUserId: actor, idempotencyKey: 'list-unavailable', lines: [{ supplyId: supply.id, plannedQuantity: 1, plannedUnit: 'kg' }] }).lines[0];
  const missing = markPurchasingLineNotFound(db, { lineId: missingLine.id, actorUserId: actor, expectedVersion: 0, idempotencyKey: 'missing-1' });
  assertEqualOrThrow(missing.status, 'not_found', 'not-found state is retained');
  try { acquirePurchasingLine(db, { lineId: partialLine.id, actorUserId: actor, idempotencyKey: 'conflict-line', expectedVersion: 0, price: 1 }); assertOrThrow(false, 'stale line version conflicts'); }
  catch (error: any) { assertEqualOrThrow(error.code, 'conflict', 'optimistic version conflict is reported'); }
  const chronological = listPriceObservations(db, supply.id);
  assertOrThrow(chronological.every((row: any, index: number) => index === 0 || chronological[index - 1].effective_at <= row.effective_at), 'history sorts by effective date');
  assertEqualOrThrow(db.pragma('foreign_key_check').length, 0, 'purchasing schema has no foreign key violations');
  const backupPath = path.join(testDir, 'purchasing-backup.db');
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  const Database = require('better-sqlite3');
  const restored = new Database(backupPath, { readonly: true });
  assertEqualOrThrow(restored.pragma('user_version', { simple: true }), 129, 'backup retains current purchasing schema version');
  assertEqualOrThrow(restored.prepare('SELECT COUNT(*) AS count FROM purchasing_price_observations WHERE supply_id=?').get(supply.id).count, 5, 'backup preserves acquisitions and price corrections');
  assertEqualOrThrow(restored.pragma('integrity_check', { simple: true }), 'ok', 'restored backup passes SQLite integrity check');
  restored.close();
  const result = getResults();
  if (result.failed) throw new Error(`${result.failed} purchasing assertions failed`);
}
main().catch((error: unknown) => { console.error(error); process.exit(1); });
