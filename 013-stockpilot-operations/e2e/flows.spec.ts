import { test, expect, devices } from '@playwright/test';
import { Api, register, login, setupMasters, skuQty, fillQty, pickSku, selectLocation, k, today } from './helpers';

test('E2E-1 SKU登録→場所作成→初期在庫→QR表示→スマホ検索→入庫→PC反映', async ({ page, browser }) => {
  const email = await register(page);
  // 場所作成（UI）
  await page.goto('/locations');
  await page.getByRole('button', { name: '＋ 場所を追加' }).click();
  await page.getByLabel('場所コード（一意）').fill('SHELF-A');
  await page.getByLabel('名称').fill('棚A');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('棚A').first()).toBeVisible();
  // SKU登録（UI）。先頭ゼロのコード
  await page.goto('/skus/new');
  await page.getByLabel('SKUコード（必須・一意）').fill('0012-BK-M');
  await page.getByLabel('名称（必須）').fill('Tシャツ');
  await page.getByLabel('色').fill('黒');
  await page.getByLabel('サイズ').fill('M');
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('heading', { name: /0012-BK-M/ })).toBeVisible();
  // 内部QRが表示される
  await expect(page.getByAltText('内部QR 0012-BK-M')).toBeVisible();
  const skuId = page.url().split('/').pop()!;
  // 初期在庫（UI）
  await page.goto('/more/initial');
  await pickSku(page, '0012-BK-M');
  await selectLocation(page, '入庫先', '棚A');
  await fillQty(page, '数量', 8);
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await page.getByRole('button', { name: '初期在庫を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  // スマホ検索 → 発注外入庫（入庫）
  await page.goto('/inventory');
  await page.getByRole('searchbox', { name: '在庫を検索' }).fill('0012');
  await page.getByRole('searchbox', { name: '在庫を検索' }).press('Enter');
  await expect(page.locator('.item', { hasText: '0012-BK-M' }).first()).toContainText('通常 8');
  await page.goto(`/more/outside-receipt?skuId=${skuId}`);
  await expect(page.locator('.card', { hasText: '0012-BK-M' }).first()).toBeVisible();
  await selectLocation(page, '入庫先', '棚A');
  await fillQty(page, '数量', 12);
  await page.getByLabel('理由（必須）').fill('展示会の残りを持ち帰り');
  await page.getByRole('button', { name: '確認へ進む' }).click();
  // 現在8 → +12 → 20 を大きく表示
  await expect(page.locator('.change').first()).toContainText('8');
  await expect(page.locator('.change').first()).toContainText('20');
  await page.getByRole('button', { name: '発注外入庫を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  await expect(page.getByText(/8 → 20/)).toBeVisible();
  // PC（別端末）で反映
  const pc = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } });
  const pcPage = await pc.newPage();
  await login(pcPage, email);
  await pcPage.goto(`/skus/${skuId}`);
  await expect(pcPage.locator('.stat', { hasText: '利用可能' }).first()).toContainText('20');
  await pc.close();
});

test('E2E-2 補充候補→仕入先別発注→数量発注書→発注済み→60/30/10の分納→発注残0', async ({ page }) => {
  await register(page);
  const api = new Api(page.request);
  const m = await setupMasters(api);
  const sku = await api.post('/api/skus', {
    code: 'MUG-WH',
    name: 'マグカップ白',
    supplierId: m.sup,
    replenish: { safetyStock: 10, reorderPoint: 20, targetStock: 100, minOrderQty: 0, orderMultiple: 10 },
  });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: m.a, qty: 5 }] });
  await page.goto('/replenish');
  const card = page.locator('.card', { hasText: 'MUG-WH' });
  await expect(card).toContainText('P 5');
  await selectLocation(page, '納入場所', '棚A');
  await card.getByRole('checkbox').check();
  await expect(card.locator('input[inputmode=numeric]')).toHaveValue('100'); // ceil(95/10)*10
  await page.getByRole('button', { name: /仕入先別の発注下書きを作る/ }).click();
  await expect(page.getByText('仕入先別に発注下書きを作成しました')).toBeVisible();
  await page.getByRole('link', { name: /PO-/ }).first().click();
  await expect(page.getByRole('heading', { name: /下書き/ })).toBeVisible();
  // 数量発注書PDF（作成しても発注済みにならない）
  await page.getByRole('button', { name: 'PDFを作成' }).click();
  await expect(page.getByRole('link', { name: 'PDFを表示' })).toBeVisible();
  const href = await page.getByRole('link', { name: 'ファイルに保存' }).getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await expect(page.getByRole('heading', { name: /下書き/ })).toBeVisible();
  await page.getByRole('button', { name: '発注済みにする' }).click();
  await expect(page.getByRole('heading', { name: /発注済み/ })).toBeVisible();
  const poUrl = page.url();
  for (const [n, rest] of [
    [60, 40],
    [30, 10],
    [10, 0],
  ] as const) {
    await page.goto(poUrl);
    await page.getByRole('link', { name: '入荷を登録' }).click();
    await page.getByRole('checkbox', { name: /今回届いた/ }).check();
    await fillQty(page, '今回の数量', n);
    await expect(page.getByText(`入荷後の未入荷 ${rest}`)).toBeVisible();
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '入荷を確定する' }).click();
    await expect(page.getByText('確定済み')).toBeVisible();
  }
  await page.goto(poUrl);
  await expect(page.getByRole('heading', { name: /入荷完了/ })).toBeVisible();
  await expect(page.locator('table.list').first()).toContainText('100');
  expect(await skuQty(api, sku.id, '棚A')).toBe(105);
  const po = await api.get(`/api/pos/${poUrl.split('/').pop()}`);
  expect(po.lines[0].outstanding).toBe(0);
  expect(po.receipts).toHaveLength(3);
});

test('E2E-3 棚A→イベントケースへ移動→販売目的出庫→残品を棚Aへ戻す（利益計算なし）', async ({ page }) => {
  await register(page);
  const api = new Api(page.request);
  const m = await setupMasters(api);
  const sku = await api.post('/api/skus', { code: 'ST-CAT', name: 'ステッカーねこ', unit: '枚' });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: m.a, qty: 20 }] });
  // 移動
  await page.goto(`/transfer?skuId=${sku.id}`);
  await selectLocation(page, '移動元', '棚A');
  await selectLocation(page, '移動先', 'イベントケース');
  await fillQty(page, '移動する数量', 6);
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await page.getByRole('button', { name: '移動を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  expect(await skuQty(api, sku.id, '棚A')).toBe(14);
  expect(await skuQty(api, sku.id, 'イベントケース')).toBe(6);
  // イベントで販売目的出庫
  await page.goto(`/issue?skuId=${sku.id}`);
  await selectLocation(page, '出庫元', 'イベントケース');
  await fillQty(page, '数量', 4);
  await page.getByLabel('行先ラベル（任意）').fill('週末クラフト市');
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await expect(page.getByText('販売', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '出庫を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/売上|利益|粗利/);
  // 残品を棚Aへ
  await page.goto(`/transfer?skuId=${sku.id}`);
  await selectLocation(page, '移動元', 'イベントケース');
  await selectLocation(page, '移動先', '棚A');
  await fillQty(page, '移動する数量', 2);
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await page.getByRole('button', { name: '移動を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  expect(await skuQty(api, sku.id, '棚A')).toBe(16);
  expect(await skuQty(api, sku.id, 'イベントケース')).toBe(0);
  expect((await api.get('/api/verify')).ok).toBe(true);
});

test('E2E-4 返品を保留入庫→一部を通常へ、一部を廃棄→数量と履歴', async ({ page }) => {
  await register(page);
  const api = new Api(page.request);
  const m = await setupMasters(api);
  const sku = await api.post('/api/skus', { code: 'TOTE', name: 'トートバッグ' });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: m.a, qty: 10 }] });
  await api.post('/api/ops/issue', { idempotencyKey: k(), businessDate: today(), purpose: 'sale', externalRef: 'ORDER-77', lines: [{ skuId: sku.id, locationId: m.a, qty: 5 }] });
  await page.goto('/more/customer-return');
  await pickSku(page, 'TOTE');
  const srcSel = page.getByLabel('元の出庫履歴');
  await srcSel.selectOption({ index: 1 });
  await fillQty(page, '戻った数量', 3);
  await page.getByRole('button', { name: '返品入庫を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  expect(await skuQty(api, sku.id, '検品保留箱')).toBe(3);
  expect(await skuQty(api, sku.id, '棚A')).toBe(5); // 良品へ勝手に加算しない
  // 2個を検品OKで通常へ（理由必須）
  await page.goto(`/transfer?skuId=${sku.id}`);
  await selectLocation(page, '移動元', '検品保留箱');
  await selectLocation(page, '移動先', '棚A');
  await fillQty(page, '移動する数量', 2);
  await expect(page.getByRole('button', { name: '確認へ進む' })).toBeDisabled();
  await page.getByLabel(/理由/).fill('検品OK');
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await page.getByRole('button', { name: '移動を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  // 1個を廃棄
  await page.goto(`/more/disposal?skuId=${sku.id}`);
  await selectLocation(page, '出庫元', '検品保留箱');
  await fillQty(page, '数量', 1);
  await page.getByLabel('理由（必須）').fill('汚れが落ちないため廃棄');
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await page.getByRole('button', { name: '破損・廃棄を確定する' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  expect(await skuQty(api, sku.id, '棚A')).toBe(7);
  expect(await skuQty(api, sku.id, '検品保留箱')).toBe(0);
  await page.goto(`/history?skuId=${sku.id}`);
  for (const t of ['顧客返品入庫', '破損・廃棄', '販売目的出庫']) await expect(page.locator('table.list').getByText(t).first()).toBeVisible();
});

test('E2E-5 棚卸停止→計数→差異確認→確定→停止解除→台帳再集計', async ({ page }) => {
  await register(page);
  const api = new Api(page.request);
  const m = await setupMasters(api);
  const s1 = await api.post('/api/skus', { code: 'KH-01', name: 'キーホルダー' });
  const s2 = await api.post('/api/skus', { code: 'KH-02', name: 'キーホルダー2' });
  await api.post('/api/ops/initial', {
    idempotencyKey: k(),
    businessDate: today(),
    lines: [
      { skuId: s1.id, locationId: m.a, qty: 10 },
      { skuId: s2.id, locationId: m.a, qty: 4 },
    ],
  });
  await page.goto('/stocktakes');
  await selectLocation(page, '対象の場所', '棚A');
  await page.getByRole('button', { name: 'この場所を停止して棚卸を開始' }).click();
  await page.waitForURL(/\/stocktakes\/[0-9a-f-]{36}/);
  // 停止中は入出庫できない
  const blocked = await page.request.post('/api/ops/issue', {
    headers: { 'x-stockpilot-csrf': '1', 'x-data-epoch': await api.epoch() },
    data: { idempotencyKey: k(), businessDate: today(), purpose: 'sale', lines: [{ skuId: s1.id, locationId: m.a, qty: 1 }] },
  });
  expect(blocked.status()).toBe(423);
  // 理論在庫は初期表示で隠す
  await expect(page.getByText('開始時理論')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '未計数が2件あります' })).toBeDisabled();
  const c1 = page.locator('.card', { hasText: 'KH-01' });
  await c1.getByLabel(/実数/).fill('8');
  await c1.getByRole('button', { name: '記録' }).click();
  await expect(c1.getByText('計数済み 8')).toBeVisible();
  const c2 = page.locator('.card', { hasText: 'KH-02' });
  await c2.getByLabel(/実数/).fill('4');
  await c2.getByRole('button', { name: '記録' }).click();
  await expect(c2.getByText('計数済み 4')).toBeVisible();
  await page.getByRole('button', { name: '差異を確認する' }).click();
  await expect(page.locator('.card', { hasText: 'KH-01' })).toContainText('差異 -2');
  await expect(page.getByRole('button', { name: '棚卸を確定する' })).toBeDisabled();
  await page.locator('.card', { hasText: 'KH-01' }).getByLabel('差異の理由').selectOption('loss');
  await page.getByRole('button', { name: '棚卸を確定する' }).click();
  await expect(page.getByRole('heading', { name: /確定/ })).toBeVisible();
  expect(await skuQty(api, s1.id, '棚A')).toBe(8);
  expect(await skuQty(api, s2.id, '棚A')).toBe(4);
  expect((await api.get('/api/verify')).ok).toBe(true);
  const locs = await api.get('/api/locations');
  expect(locs.find((l: any) => l.id === m.a).stocktakeId).toBeNull();
  // 差異PDF
  await page.getByRole('button', { name: 'PDFを作成' }).click();
  await expect(page.getByRole('link', { name: 'PDFを表示' })).toBeVisible();
});
