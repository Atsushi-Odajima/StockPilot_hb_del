// カメラ読取の結合試験：自アプリが出力したQRラベルPDFを画像化し、Chromium の疑似カメラ映像として読み取る。
// 入力値のモックではなく、getUserMedia → 端末内デコーダ → コード解決 の実経路を通す。
// ※ 実機（iPhone/Android）のカメラ確認の代わりにはならない（TEST_REPORT.md に区別して記録）。
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Api, register, k, today } from './helpers';

test('内部QRラベルPDF → 疑似カメラ → 読取 → SKUを表示（数量は加算しない）', async ({ page, baseURL }) => {
  const email = await register(page);
  const api = new Api(page.request);
  const loc = await api.post('/api/locations', { code: 'A', name: '棚A', kind: 'normal' });
  const sku = await api.post('/api/skus', { code: 'QR-TEST-01', name: 'QR読取テスト商品' });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: loc.id, qty: 3 }] });
  const lbl = await api.post('/api/labels', { skuIds: [sku.id], copies: 1 });
  const pdf = await (await page.request.get(`/api/documents/${lbl.documentId}/pdf`)).body();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cam-'));
  fs.writeFileSync(path.join(dir, 'labels.pdf'), pdf);
  // 1枚目のラベル（左上）を 300dpi で画像化
  execFileSync('python3', [
    '-c',
    `import pymupdf;d=pymupdf.open('${dir}/labels.pdf');mm=72/25.4;r=pymupdf.Rect(7*mm,10*mm,7*mm+(196/3)*mm,10*mm+(277/8)*mm);d[0].get_pixmap(dpi=300,clip=r).save('${dir}/label.png')`,
  ]);
  execFileSync('python3', ['scripts/make-y4m.py', `${dir}/label.png`, `${dir}/cam.y4m`]);

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${dir}/cam.y4m`],
  });
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, permissions: ['camera'] });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.getByLabel('メールアドレス').fill(email);
  await p.getByLabel('パスワード').fill('correct-horse-battery');
  await p.getByRole('button', { name: 'ログイン' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  await p.goto('/inventory');
  await p.getByRole('button', { name: 'カメラで読み取る' }).click();
  await expect(p.getByRole('dialog', { name: 'コード読取' })).toBeVisible();
  // 読み取れたらSKU詳細へ遷移する
  await p.waitForURL(`**/skus/${sku.id}`, { timeout: 30_000 });
  await expect(p.getByRole('heading', { name: /QR-TEST-01/ })).toBeVisible();
  // カメラは停止している（ダイアログが閉じる）
  await expect(p.getByRole('dialog', { name: 'コード読取' })).toHaveCount(0);
  const engine = await p.evaluate(() => ('BarcodeDetector' in window ? 'native-available' : 'wasm-only'));
  test.info().annotations.push({ type: 'decoder', description: engine });
  // 読取だけでは数量は変わらない
  const s = await api.get(`/api/skus/${sku.id}`);
  expect(s.available).toBe(3);
  await browser.close();
});

test('JAN/EAN-13 バーコード画像 → 疑似カメラ → 出庫画面の商品選択（先頭ゼロ維持）', async ({ page, baseURL }) => {
  const email = await register(page);
  const api = new Api(page.request);
  const loc = await api.post('/api/locations', { code: 'A', name: '棚A', kind: 'normal' });
  const sku = await api.post('/api/skus', { code: 'JAN-TEST', name: 'JAN読取テスト' });
  const jan = '0012345678905'; // 先頭ゼロ・チェックデジット正
  await api.post(`/api/skus/${sku.id}/codes`, { code: jan, kind: 'JAN13' });
  await api.post('/api/ops/initial', { idempotencyKey: k(), businessDate: today(), lines: [{ skuId: sku.id, locationId: loc.id, qty: 5 }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cam-'));
  const { writeBarcode, prepareZXingModule } = await import('zxing-wasm/writer');
  prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync('node_modules/zxing-wasm/dist/writer/zxing_writer.wasm') } } as any);
  const img = await writeBarcode(jan, { format: 'EAN13', scale: 6 } as any);
  fs.writeFileSync(`${dir}/ean.png`, Buffer.from(await img.image!.arrayBuffer()));
  execFileSync('python3', ['scripts/make-y4m.py', `${dir}/ean.png`, `${dir}/cam.y4m`]);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${dir}/cam.y4m`],
  });
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, permissions: ['camera'] });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.getByLabel('メールアドレス').fill(email);
  await p.getByLabel('パスワード').fill('correct-horse-battery');
  await p.getByRole('button', { name: 'ログイン' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  await p.goto('/issue');
  await p.getByRole('button', { name: 'カメラで読み取る' }).click();
  // 読取後は止まり、写真・SKU・在庫を表示して確認させる
  await expect(p.locator('.card', { hasText: 'JAN-TEST' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(p.getByRole('dialog', { name: 'コード読取' })).toHaveCount(0);
  const s = await api.get(`/api/skus/${sku.id}`);
  expect(s.available).toBe(5);
  await browser.close();
});
