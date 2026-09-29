import { test, expect } from '@playwright/test';
import { Api, register, setupMasters, skuQty, fillQty, selectLocation, k, today } from './helpers';

test('E2E-6 オフラインで出庫下書き→別端末で減少→再接続→最新数の不足を示し確定拒否', async ({ page, context }) => {
  await register(page);
  const api = new Api(page.request);
  const m = await setupMasters(api);
  const sku = await api.post('/api/skus', { code: 'BADGE', name: '缶バッジ' });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: m.a, qty: 5 }] });
  await page.goto(`/issue?skuId=${sku.id}`);
  await selectLocation(page, '出庫元', '棚A');
  await fillQty(page, '数量', 4);
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await context.setOffline(true);
  await expect(page.getByText('オフラインのため確定できません')).toBeVisible();
  await expect(page.getByRole('button', { name: '出庫を確定する' })).toHaveCount(0);
  await page.getByRole('button', { name: '端末に下書き保存' }).click();
  await expect(page.getByText('端末に下書きとして保存しました')).toBeVisible();
  // 別端末（API）で在庫が減る
  await context.setOffline(false);
  await api.post('/api/ops/issue', { idempotencyKey: k(), businessDate: today(), purpose: 'other', lines: [{ skuId: sku.id, locationId: m.a, qty: 3 }] });
  // 再接続後：自動では確定しない
  expect(await skuQty(api, sku.id, '棚A')).toBe(2);
  await page.goto('/drafts');
  await expect(page.getByText(/出庫：BADGE×4/)).toBeVisible();
  await page.getByRole('button', { name: '開いて確認' }).click();
  // 最新数量（2）を読み直して表示
  await expect(page.locator('.change').first()).toContainText('2');
  await page.getByRole('button', { name: '出庫を確定する' }).click();
  await expect(page.getByRole('alert')).toContainText(/在庫が足りません|表示していた数量から在庫が変わっています/);
  expect(await skuQty(api, sku.id, '棚A')).toBe(2);
});

test('E2E-7 共有キャンセル・PDF生成失敗・通信の結果不明でも重複や偽の成功を作らない', async ({ page }) => {
  await register(page);
  const api = new Api(page.request);
  const m = await setupMasters(api);
  const sku = await api.post('/api/skus', { code: 'PEN', name: 'ボールペン', unit: '本', supplierId: m.sup });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: m.a, qty: 10 }] });

  // (1) 結果不明：サーバーは処理したが応答が端末に届かない
  let dropped = false;
  await page.route('**/api/ops/issue', async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch(); // サーバーで確定させる
      await route.abort('connectionreset'); // 端末には届かない
    } else await route.continue();
  });
  await page.goto(`/issue?skuId=${sku.id}`);
  await selectLocation(page, '出庫元', '棚A');
  await fillQty(page, '数量', 3);
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await page.getByRole('button', { name: '出庫を確定する' }).click();
  await expect(page.getByText('結果確認中：')).toBeVisible();
  await expect(page.getByText('確定済み')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '出庫を確定する', disabled: false })).toHaveCount(0);
  await page.getByRole('button', { name: '処理状況を確認' }).click();
  await expect(page.getByText('確定済み')).toBeVisible();
  await expect(page.getByText('既に処理済みの操作でした')).toBeVisible();
  expect(await skuQty(api, sku.id, '棚A')).toBe(7); // 1回だけ反映
  await page.unroute('**/api/ops/issue');

  // (2) PDF生成失敗：発注は変わらない
  const dr = await api.post('/api/pos', { supplierId: m.sup, lines: [{ skuId: sku.id, qty: 5, locationId: m.a }] });
  await page.route('**/api/documents/*/pdf', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto(`/pos/${dr.id}`);
  await page.getByRole('button', { name: 'PDFを作成' }).click();
  await expect(page.getByText('PDFを作成できませんでした')).toBeVisible();
  await expect(page.getByRole('heading', { name: /下書き/ })).toBeVisible();
  await page.unroute('**/api/documents/*/pdf');

  // (3) 共有キャンセル：エラーや送信済みにしない
  await page.addInitScript(() => {
    (navigator as any).canShare = () => true;
    (navigator as any).share = () => Promise.reject(new DOMException('cancel', 'AbortError'));
  });
  await page.reload();
  await page.getByRole('button', { name: 'PDFを作成' }).click();
  await page.getByRole('button', { name: '共有…' }).click();
  await expect(page.getByText('共有をキャンセルしました。')).toBeVisible();
  await expect(page.getByText(/送信しました|送付済み/)).toHaveCount(0);
  const po = await api.get(`/api/pos/${dr.id}`);
  expect(po.status).toBe('draft');

  // (4) 二重タップ：同じ操作は1回だけ
  await page.goto(`/issue?skuId=${sku.id}`);
  await selectLocation(page, '出庫元', '棚A');
  await fillQty(page, '数量', 1);
  await page.getByRole('button', { name: '確認へ進む' }).click();
  const btn = page.getByRole('button', { name: '出庫を確定する' });
  await btn.dblclick();
  await expect(page.getByText('確定済み')).toBeVisible();
  expect(await skuQty(api, sku.id, '棚A')).toBe(6);
});

test('権限エラー・未ログイン・存在しないページの表示', async ({ page }) => {
  await page.goto('/inventory');
  await page.waitForURL('**/login');
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
  await page.getByLabel('メールアドレス').fill('nobody@example.test');
  await page.getByLabel('パスワード').fill('wrong-password-xx');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('alert')).toContainText('正しくありません');
});
