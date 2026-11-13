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
      await route.abort('failed');
    }
  });
  const flourCard = page.locator('article').filter({ hasText: supplyNames[0] });
  await flourCard.getByRole('button', { name: 'Mark acquired' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This list changed' })).toBeVisible();
  await flourCard.getByRole('button', { name: 'Mark acquired' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Failed to save' })).toBeVisible();
  await expect(flourCard.getByText('Active', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });

  await flourCard.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(flourCard.getByLabel('Planned quantity')).toHaveValue('1');
  await expect(flourCard.getByLabel('Actual price')).toHaveValue('10');
  await flourCard.getByLabel('Actual price').fill('12');
  await flourCard.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.getByText('Acquired', { exact: true })).toBeVisible();

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
  expect((await history.json()).observations.map((item: { amount: number }) => item.amount)).toEqual([12]);
  const supply = await request.get(`${BASE}/api/supplies/${supplyIds[0]}`, { headers });
  expect((await supply.json()).supply.stock_quantity).toBe(0);
});
