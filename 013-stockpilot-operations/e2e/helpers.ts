import { expect, type Page, type APIRequestContext } from '@playwright/test';

export const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export async function register(page: Page, name = 'E2E雑貨店') {
  const email = `e2e-${uniq()}@example.test`;
  await page.goto('/register');
  await page.getByLabel('事業者名（表示・帳票の発注者名）').fill(name);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード（10文字以上）').fill('correct-horse-battery');
  await page.getByLabel('上記と注意事項を確認しました').check();
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL('**/welcome');
  return email;
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** セットアップ用API呼び出し（ログイン中のCookieを共有） */
export class Api {
  constructor(private req: APIRequestContext) {}
  async epoch() {
    return (await (await this.req.get('/api/me')).json()).dataEpoch as string;
  }
  async post(url: string, data: unknown) {
    const r = await this.req.post(url, { data, headers: { 'x-stockpilot-csrf': '1', 'x-data-epoch': await this.epoch() } });
    const body = await r.json();
    if (!r.ok()) throw new Error(`${url} ${r.status()} ${JSON.stringify(body)}`);
    return body;
  }
  async get(url: string) {
    return (await this.req.get(url)).json();
  }
}

export const k = () => crypto.randomUUID();
export const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export async function setupMasters(api: Api) {
  const sup = await api.post('/api/suppliers', { code: 'SUP1', name: 'E2E仕入先', leadTimeDays: 7 });
  const a = await api.post('/api/locations', { code: 'SHELF-A', name: '棚A', kind: 'normal' });
  const ev = await api.post('/api/locations', { code: 'EVENT', name: 'イベントケース', kind: 'normal' });
  const h = await api.post('/api/locations', { code: 'HOLD', name: '検品保留箱', kind: 'hold' });
  return { sup: sup.id, a: a.id, ev: ev.id, h: h.id };
}

export async function skuQty(api: Api, skuId: string, locationName: string) {
  const s = await api.get(`/api/skus/${skuId}`);
  return s.balances.find((b: any) => b.name === locationName)?.qty ?? 0;
}

/** 数量入力（QtyInput）。ラベルの先頭一致で探す */
export async function fillQty(page: Page, label: string, v: number, nth = 0) {
  const input = page.locator('label.field', { hasText: label }).locator('input').nth(nth);
  await input.fill(String(v));
}

export async function pickSku(page: Page, code: string) {
  const search = page.getByRole('searchbox', { name: '商品を検索' }).first();
  await search.fill(code);
  await search.press('Enter');
  // 完全一致のコードは読取と同じく直接選ばれ、商品カードが表示される
  await expect(page.getByRole('button', { name: '別の商品を選ぶ' }).last()).toBeVisible();
}

export async function selectLocation(page: Page, label: string, optionText: string) {
  const sel = page.getByLabel(label, { exact: true });
  const value = await sel.locator('option', { hasText: optionText }).first().getAttribute('value');
  await sel.selectOption(value!);
}
