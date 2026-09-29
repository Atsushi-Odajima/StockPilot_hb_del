import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createPool, type Db } from '../src/server/db/pool.js';
import { LocalStorage } from '../src/server/storage.js';
import type { Ctx } from '../src/server/services/context.js';
import { registerAccount } from '../src/server/services/auth.js';
import { insertLocation, insertSku, insertSupplier } from '../src/server/services/masters.js';
import { withTx } from '../src/server/db/pool.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://stockpilot:stockpilot@localhost:5432/stockpilot_test';
// テスト時刻を固定（実行日で結果が変わらないように）
export const FIXED_NOW = new Date('2026-03-31T03:00:00Z'); // JST 2026-03-31 12:00
export const TODAY = '2026-03-31';

let pool: Db | null = null;
export function db(): Db {
  pool ??= createPool(TEST_DB, 20);
  return pool;
}
export async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
export const storage = new LocalStorage(storageDir);

export const key = () => crypto.randomUUID();

/** 独立した初期データ：新しい事業者を作り、Ctx を返す */
export async function newTenant(now = FIXED_NOW): Promise<Ctx> {
  const email = `t-${crypto.randomUUID()}@example.test`;
  const { userId, tenantId } = await registerAccount(db(), { email, password: 'correct-horse-battery', businessName: 'テスト事業者' }, 'active');
  const ws = await db().query(`SELECT active_ws_id FROM tenants WHERE id=$1`, [tenantId]);
  return { db: db(), storage, tenantId, userId, wsId: ws.rows[0].active_ws_id, mode: 'live', now: () => now };
}

export async function loc(ctx: Ctx, code: string, kind: 'normal' | 'hold' = 'normal') {
  return (await withTx(ctx.db, (c) => insertLocation(c, ctx.wsId, { code, name: code, description: '', kind }))).id;
}

export async function supplier(ctx: Ctx, code = 'SUP1') {
  return (await withTx(ctx.db, (c) => insertSupplier(c, ctx.wsId, { code, name: `仕入先${code}`, contactName: '', contact: '', leadTimeDays: 7, note: '' }))).id;
}

export async function sku(ctx: Ctx, code: string, extra: Partial<Parameters<typeof insertSku>[2]> = {}) {
  return (
    await withTx(ctx.db, (c) =>
      insertSku(c, ctx.wsId, {
        code,
        name: `商品${code}`,
        groupName: '',
        color: '',
        size: '',
        attrs: '',
        category: '',
        brand: '',
        unit: '個',
        supplierId: null,
        memo: '',
        replenish: null,
        leadTimeDays: null,
        ...extra,
      }),
    )
  ).id;
}

export async function balance(ctx: Ctx, skuId: string, locationId: string): Promise<number> {
  const r = await ctx.db.query(`SELECT qty FROM balances WHERE ws_id=$1 AND sku_id=$2 AND location_id=$3`, [ctx.wsId, skuId, locationId]);
  return r.rowCount ? Number(r.rows[0].qty) : 0;
}

export async function ledgerSum(ctx: Ctx, skuId: string, locationId: string): Promise<number> {
  const r = await ctx.db.query(`SELECT coalesce(sum(qty),0)::bigint q FROM ledger_events WHERE ws_id=$1 AND sku_id=$2 AND location_id=$3`, [ctx.wsId, skuId, locationId]);
  return Number(r.rows[0].q);
}

export async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c !== code) throw new Error(`expected ${code} but got ${c}: ${(e as Error).message}`);
    return e as { code: string; details?: any; message: string };
  }
  throw new Error(`expected error ${code} but succeeded`);
}
