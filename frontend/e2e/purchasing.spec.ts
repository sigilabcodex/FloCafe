import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

const STAMP = Date.now();

test('purchasing list workflow stays confirmed, responsive, and recoverable', async ({ page, request }, testInfo) => {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.status(), 'owner login should succeed').toBe(200);
  const { access_token } = await login.json();
  const headers = { Authorization: `Bearer ${access_token}` };
  const supplyNames = [`C2 Flour ${STAMP}`, `C2 Sugar ${STAMP}`, `C2 Salt ${STAMP}`];
  const supplyIds: string[] = [];
  for (const name of supplyNames) {
    const response = await request.post(`${BASE}/api/supplies`, {
      headers,
      data: { name, base_unit: 'g', stock_quantity: 0 },
    });
    expect(response.status()).toBe(201);
    supplyIds.push((await response.json()).supply.id);
  }

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'));
  await page.goto(`${BASE}/purchasing`);
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByLabel('Name').fill(`C2 Shopping ${STAMP}`);

  const addLine = async (supplyName: string, quantity: string, referencePrice?: string) => {
    await page.getByLabel('Supply').selectOption({ label: `${supplyName} (g)` });
    await page.getByLabel('Planned quantity').fill(quantity);
    await page.getByLabel('Base unit').selectOption('kg');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    if (referencePrice !== undefined) {
      const details = page.locator('details').filter({ hasText: supplyName });
      await details.locator('summary').click();
      await details.getByLabel('Reference price').fill(referencePrice);
      await details.locator('summary').click();
    }
  };
  await addLine(supplyNames[0], '1', '10');
  await addLine(supplyNames[1], '2');
  await addLine(supplyNames[2], '500', '5');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByText(supplyNames[0]).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `no horizontal overflow at ${width}px`).toBe(false);
    const button = await page.getByRole('button', { name: 'Mark acquired' }).first().boundingBox();
    expect(button?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`purchasing-${width}.png`), fullPage: true });
  }

  const listResponse = await request.get(`${BASE}/api/purchasing/lists`, { headers });
  const listId = (await listResponse.json()).lists.find((item: { name: string }) => item.name === `C2 Shopping ${STAMP}`).id;
  const detailResponse = await request.get(`${BASE}/api/purchasing/lists/${listId}`, { headers });
  const lines = (await detailResponse.json()).list.lines as Array<{ id: string; supply_id: string; version: number; reference_price: number | null }>;
  const flour = lines.find((line) => line.supply_id === supplyIds[0])!;
  expect(flour.reference_price).toBe(10);
  let forceConflict = true;
  await page.route(`**/api/purchasing/lines/${flour.id}/acquisitions`, async (route) => {
    if (forceConflict) {
      forceConflict = false;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'conflict' }) });
    } else {
      await route.continue();
    }
  });
  const flourCard = page.locator('article').filter({ hasText: supplyNames[0] });
  await flourCard.getByRole('button', { name: 'Mark acquired' }).click();
  await expect(flourCard.getByRole('heading', { name: 'Needs review' })).toBeVisible();
  await flourCard.getByRole('button', { name: 'Apply local change' }).click();
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
  await expect.poll(async () => {
    const response = await request.get(`${BASE}/api/purchasing/lists/${listId}`, { headers });
    return (await response.json()).list.lines.find((item: { id: string }) => item.id === flour.id).status;
  }).toBe('acquired');
  await page.reload();
  await page.getByText(`C2 Shopping ${STAMP}`).click();
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(flourCard.getByText('Acquired', { exact: true })).toBeVisible();
  await expect(flourCard).toContainText(/Actual price: .+10/);

  await page.getByRole('button', { name: /^Active/ }).click();
  const saltCard = page.locator('article').filter({ hasText: supplyNames[2] });
  await saltCard.getByRole('button', { name: 'Mark acquired' }).click();
  await expect(saltCard).toHaveCount(0);
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.locator('article').filter({ hasText: supplyNames[2] }).getByText('Acquired', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Active/ }).click();
  const sugarCard = page.locator('article').filter({ hasText: supplyNames[1] });
  await sugarCard.getByRole('button', { name: 'Mark acquired' }).click();
  const actualPrice = sugarCard.getByLabel('Actual price');
  await expect(actualPrice).toHaveValue('');
  await sugarCard.getByLabel('Planned quantity').fill('500');
  await sugarCard.getByLabel('Base unit').selectOption('g');
  await actualPrice.fill('3');
  await sugarCard.getByLabel('Supplier').fill('C2 Supplier');
  await sugarCard.getByLabel('Brand').fill('C2 Brand');
  await sugarCard.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sugarCard).toContainText('Purchased quantity: 500 g');
  await expect(sugarCard).toContainText('C2 Supplier');
  await expect(sugarCard).toContainText('C2 Brand');
  await sugarCard.getByRole('button', { name: 'Not found' }).click();
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.getByText('Not found', { exact: true })).toBeVisible();
  const history = await request.get(`${BASE}/api/purchasing/supplies/${supplyIds[0]}/price-history`, { headers });
  expect((await history.json()).observations.map((item: { amount: number }) => item.amount)).toEqual([10]);
  const supply = await request.get(`${BASE}/api/supplies/${supplyIds[0]}`, { headers });
  expect((await supply.json()).supply.stock_quantity).toBe(0);
});

test('a cached purchasing list survives an offline reload and syncs once online', async ({ page, request }) => {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const { access_token } = await login.json();
  const headers = { Authorization: `Bearer ${access_token}` };
  const stamp = Date.now();
  const supplyResponse = await request.post(`${BASE}/api/supplies`, {
    headers,
    data: { name: `C3 Offline Flour ${stamp}`, base_unit: 'kg', stock_quantity: 0 },
  });
  expect(supplyResponse.status()).toBe(201);
  const supplyId = (await supplyResponse.json()).supply.id;
  const partialSupplyResponse = await request.post(`${BASE}/api/supplies`, {
    headers,
    data: { name: `C3 Partial Sugar ${stamp}`, base_unit: 'kg', stock_quantity: 0 },
  });
  expect(partialSupplyResponse.status()).toBe(201);
  const partialSupplyId = (await partialSupplyResponse.json()).supply.id;
  const notFoundSupplyResponse = await request.post(`${BASE}/api/supplies`, {
    headers,
    data: { name: `C3 Unavailable Salt ${stamp}`, base_unit: 'kg', stock_quantity: 0 },
  });
  expect(notFoundSupplyResponse.status()).toBe(201);
  const notFoundSupplyId = (await notFoundSupplyResponse.json()).supply.id;
  const listResponse = await request.post(`${BASE}/api/purchasing/lists`, {
    headers,
    data: {
      name: `C3 Offline List ${stamp}`,
      idempotency_key: `c3-list-${stamp}`,
      lines: [
        { supply_id: supplyId, planned_quantity: 2, planned_unit: 'kg', reference_price: 18, reference_unit: 'kg' },
        { supply_id: partialSupplyId, planned_quantity: 2, planned_unit: 'kg', reference_price: 18, reference_unit: 'kg' },
        { supply_id: notFoundSupplyId, planned_quantity: 1, planned_unit: 'kg' },
      ],
    },
  });
  expect(listResponse.status()).toBe(201);
  const list = (await listResponse.json()).list;
  const line = list.lines.find((item: { supply_id: string }) => item.supply_id === supplyId);
  const serverLists = await request.get(`${BASE}/api/purchasing/lists`, { headers });
  expect((await serverLists.json()).lists.some((item: { id: string }) => item.id === list.id)).toBe(true);

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'));
  await page.goto(`${BASE}/purchasing`);
  await expect(page.getByText(`C3 Offline List ${stamp}`)).toBeVisible();
  await page.getByText(`C3 Offline List ${stamp}`).click();
  await expect(page.getByText(`C3 Offline Flour ${stamp}`)).toBeVisible();
  const flourCard = page.locator('article').filter({ hasText: `C3 Offline Flour ${stamp}` });
  const partialCard = page.locator('article').filter({ hasText: `C3 Partial Sugar ${stamp}` });
  const notFoundCard = page.locator('article').filter({ hasText: `C3 Unavailable Salt ${stamp}` });
  const notFoundResponses: Array<{ status: number; body: string }> = [];
  page.on('response', async (response) => {
    if (response.url().includes('/not-found')) {
      notFoundResponses.push({ status: response.status(), body: await response.text().catch(() => '') });
    }
  });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cacheState = await page.evaluate(async () => ({
    purchasingShell: Boolean(await caches.match('/purchasing')),
    privateApi: Boolean(await caches.match('/api/purchasing/lists')),
    unrelatedRoute: Boolean(await caches.match('/orders')),
  }));
  expect(cacheState.purchasingShell).toBe(true);
  expect(cacheState.privateApi).toBe(false);
  expect(cacheState.unrelatedRoute).toBe(false);

  await page.context().setOffline(true);
  await flourCard.getByRole('button', { name: 'Mark acquired' }).click();
  await expect(page.getByText('Saved on this device')).toBeVisible();
  await expect(page.getByText(/\d+ pending/)).toBeVisible();
  await partialCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await partialCard.getByLabel('Planned quantity').fill('0.5');
  await partialCard.getByLabel('Actual price').fill('9');
  await partialCard.getByRole('button', { name: 'Save', exact: true }).click();
  await partialCard.getByRole('button', { name: 'Mark acquired' }).click();
  await partialCard.getByLabel('Planned quantity').fill('0.5');
  await partialCard.getByLabel('Actual price').fill('8');
  await partialCard.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(partialCard).toContainText('Purchased quantity: 1 kg');
  await notFoundCard.getByRole('button', { name: 'Not found' }).click();
  await expect(notFoundCard.getByText('Saved on this device')).toBeVisible();
  await page.reload();
  await expect(page.getByText(`C3 Offline List ${stamp}`)).toBeVisible();
  await page.getByText(`C3 Offline List ${stamp}`).click();
  await expect(flourCard.getByText('Saved on this device')).toBeVisible();
  await expect(page.locator('article').filter({ hasText: `C3 Partial Sugar ${stamp}` })).toContainText('Purchased quantity: 1 kg');
  await expect(page.locator('article').filter({ hasText: `C3 Unavailable Salt ${stamp}` }).getByText('Not found', { exact: true })).toBeVisible();

  const acquisitionUrl = `**/api/purchasing/lines/${line.id}/acquisitions`;
  await page.route(acquisitionUrl, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort();
  });
  await page.context().setOffline(false);
  await expect(flourCard.getByText('Saved on this device')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get(`${BASE}/api/purchasing/lists/${list.id}`, { headers });
    const current = (await response.json()).list;
    return current.lines.find((item: { id: string }) => item.id === line.id).status;
  }).toBe('acquired');
  await page.unroute(acquisitionUrl);
  const syncButton = page.getByRole('button', { name: 'Sync now' });
  await expect(syncButton).toBeEnabled();
  await syncButton.click();
  try {
    await expect.poll(async () => {
    const response = await request.get(`${BASE}/api/purchasing/lists/${list.id}`, { headers });
    const lines = (await response.json()).list.lines;
    const partial = lines.find((item: { supply_id: string }) => item.supply_id === partialSupplyId);
    return [lines.find((item: { id: string }) => item.id === line.id)?.status, partial?.status, partial?.purchased_quantity, lines.find((item: { supply_id: string }) => item.supply_id === notFoundSupplyId)?.status].join('|');
    }, { timeout: 20000 }).toBe('acquired|pending|1|not_found');
  } catch (error) {
    const operations = await page.evaluate(async () => new Promise((resolve, reject) => {
      const request = indexedDB.open('flo-purchasing-offline-v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction('operations', 'readonly');
        const all = transaction.objectStore('operations').getAll();
        all.onsuccess = () => resolve(all.result.map((item: { kind: string; state: string; error?: string; lineId: string }) => ({ ...item })));
      };
    }));
    throw new Error(`${String(error)}; not-found responses=${JSON.stringify(notFoundResponses)}; operations=${JSON.stringify(operations)}`);
  }
  const syncedList = (await (await request.get(`${BASE}/api/purchasing/lists/${list.id}`, { headers })).json()).list;
  expect(syncedList.lines.find((item: { supply_id: string }) => item.supply_id === partialSupplyId).status).toBe('pending');
  expect(syncedList.lines.find((item: { supply_id: string }) => item.supply_id === partialSupplyId).purchased_quantity).toBe(1);
  expect(syncedList.lines.find((item: { supply_id: string }) => item.supply_id === notFoundSupplyId).status).toBe('not_found');
  const history = await request.get(`${BASE}/api/purchasing/supplies/${supplyId}/price-history`, { headers });
  expect((await history.json()).observations).toHaveLength(1);
  const partialHistory = await request.get(`${BASE}/api/purchasing/supplies/${partialSupplyId}/price-history`, { headers });
  expect((await partialHistory.json()).observations.map((item: { amount: number }) => item.amount)).toEqual([9, 8]);
  const supplyAfter = await request.get(`${BASE}/api/supplies/${supplyId}`, { headers });
  expect((await supplyAfter.json()).supply.stock_quantity).toBe(0);
  for (const id of [partialSupplyId, notFoundSupplyId]) {
    const response = await request.get(`${BASE}/api/supplies/${id}`, { headers });
    expect((await response.json()).supply.stock_quantity).toBe(0);
  }

  // A forged local user ID must not select the previously authenticated user's cache.
  await page.context().setOffline(true);
  await page.evaluate(() => {
    const key = 'flo-purchasing-offline-session-v1';
    const identity = JSON.parse(localStorage.getItem(key) || 'null');
    if (!identity) throw new Error('Purchasing identity binding was not persisted');
    identity.userId = 'forged-user-id';
    localStorage.setItem(key, JSON.stringify(identity));
  });
  await page.reload();
  await expect(page.getByText(`C3 Offline List ${stamp}`)).toHaveCount(0);
});

test('an offline purchase keeps its intent through a version conflict', async ({ page, request }) => {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const { access_token } = await login.json();
  const headers = { Authorization: `Bearer ${access_token}` };
  const stamp = Date.now();
  const supplyResponse = await request.post(`${BASE}/api/supplies`, {
    headers,
    data: { name: `C3 Conflict Flour ${stamp}`, base_unit: 'kg', stock_quantity: 0 },
  });
  expect(supplyResponse.status()).toBe(201);
  const supplyId = (await supplyResponse.json()).supply.id;
  const listResponse = await request.post(`${BASE}/api/purchasing/lists`, {
    headers,
    data: {
      name: `C3 Conflict List ${stamp}`,
      idempotency_key: `c3-conflict-list-${stamp}`,
      lines: [{ supply_id: supplyId, planned_quantity: 2, planned_unit: 'kg', reference_price: 30, reference_unit: 'kg' }],
    },
  });
  expect(listResponse.status()).toBe(201);
  const list = (await listResponse.json()).list;
  const line = list.lines[0];

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'));
  await page.goto(`${BASE}/purchasing`);
  await page.getByText(`C3 Conflict List ${stamp}`).click();
  await expect(page.getByText(`C3 Conflict Flour ${stamp}`)).toBeVisible();
  const card = page.locator('article').filter({ hasText: `C3 Conflict Flour ${stamp}` });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await page.context().setOffline(true);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Planned quantity').fill('0.5');
  await card.getByLabel('Actual price').fill('31');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText('Saved on this device')).toBeVisible();
  await page.reload();
  await page.getByText(`C3 Conflict List ${stamp}`).click();
  await expect(page.getByText(`C3 Conflict Flour ${stamp}`)).toBeVisible();

  const competingPurchase = await request.post(`${BASE}/api/purchasing/lines/${line.id}/acquisitions`, {
    headers,
    data: { quantity: 0.5, unit: 'kg', price: 35, expected_version: 0, idempotency_key: `c3-race-${stamp}` },
  });
  expect(competingPurchase.status()).toBe(201);
  await page.context().setOffline(false);
  await expect(page.getByText(/Needs review: 1/)).toBeVisible();
  const listButton = page.getByRole('button', { name: new RegExp(`C3 Conflict List ${stamp}`) });
  if (await listButton.count()) await listButton.click();
  await expect(card.getByText('Needs review').first()).toBeVisible();
  await expect(card.getByText(/Your intended change/)).toBeVisible();
  await expect(card).toContainText('31');
  await card.getByRole('button', { name: 'Apply local change' }).click();
  await expect.poll(async () => {
    const response = await request.get(`${BASE}/api/purchasing/lists/${list.id}`, { headers });
    const current = (await response.json()).list.lines[0];
    return `${current.status}|${current.purchased_quantity}`;
  }).toBe('pending|1');
  const stock = await request.get(`${BASE}/api/supplies/${supplyId}`, { headers });
  expect((await stock.json()).supply.stock_quantity).toBe(0);
});
