// 認証・アカウント（SECURITY.md）
// パスワードは scrypt でハッシュ化。セッショントークンは平文を保存せず sha256 のみ保存する。
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { fail } from '../errors.js';
import { sha256, uuid } from './context.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const N = 1 << 15;
const R = 8;
const P = 1;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 32, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const h = await scrypt(pw, salt, expected.length, { N: n, r, p, maxmem: 128 * n * r * 2 });
  return crypto.timingSafeEqual(h, expected);
}

// 不在ユーザーでも同程度の時間をかけ、存在有無を推測しにくくする
let dummyHash: Promise<string> | null = null;

export function validatePasswordPolicy(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < 10) return 'パスワードは10文字以上にしてください';
  if (pw.length > 200) return 'パスワードが長すぎます';
  return null;
}

export const emailKey = (email: string) => email.trim().toLowerCase();

export async function registerAccount(
  db: Db,
  input: { email: string; password: string; businessName: string },
  entitlement: 'pending' | 'active',
): Promise<{ userId: string; tenantId: string }> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) fail('VALIDATION', 'メールアドレスの形式が正しくありません');
  const pe = validatePasswordPolicy(input.password);
  if (pe) fail('VALIDATION', pe);
  const name = input.businessName.trim();
  if (!name || name.length > 100) fail('VALIDATION', '事業者名は1〜100文字で入力してください');
  const hash = await hashPassword(input.password);
  return withTx(db, async (c) => {
    const ex = await c.query(`SELECT 1 FROM users WHERE email_key=$1`, [emailKey(email)]);
    if (ex.rowCount) fail('DUPLICATE', 'このメールアドレスは登録済みです。ログインまたはパスワード再設定を行ってください。');
    const tenantId = uuid();
    const userId = uuid();
    const wsId = uuid();
    await c.query(`INSERT INTO tenants (id, name, entitlement) VALUES ($1,$2,$3)`, [tenantId, name, entitlement]);
    await c.query(`INSERT INTO workspaces (id, tenant_id, kind, label) VALUES ($1,$2,'live','本番')`, [wsId, tenantId]);
    await c.query(`UPDATE tenants SET active_ws_id=$2 WHERE id=$1`, [tenantId, wsId]);
    await c.query(`INSERT INTO users (id, tenant_id, email, email_key, password_hash) VALUES ($1,$2,$3,$4,$5)`, [userId, tenantId, email, emailKey(email), hash]);
    await c.query(`INSERT INTO audit_log (tenant_id, ws_id, actor_user_id, action, ok) VALUES ($1,$2,$3,'account.register',true)`, [tenantId, wsId, userId]);
    return { userId, tenantId };
  });
}

export async function login(db: Db, email: string, password: string, ttlDays: number): Promise<{ token: string; userId: string; tenantId: string }> {
  const r = await db.query(`SELECT id, tenant_id, password_hash FROM users WHERE email_key=$1`, [emailKey(String(email ?? ''))]);
  if (r.rowCount === 0) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verifyPassword(String(password ?? ''), await dummyHash);
    fail('UNAUTHENTICATED', 'メールアドレスまたはパスワードが正しくありません');
  }
  const u = r.rows[0];
  const ok = await verifyPassword(String(password ?? ''), u.password_hash);
  if (!ok) {
    await db.query(`INSERT INTO audit_log (tenant_id, actor_user_id, action, ok) VALUES ($1,$2,'auth.login',false)`, [u.tenant_id, u.id]);
    fail('UNAUTHENTICATED', 'メールアドレスまたはパスワードが正しくありません');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions (id_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`, [
    sha256(token),
    u.id,
    u.tenant_id,
    String(ttlDays),
  ]);
  await db.query(`INSERT INTO audit_log (tenant_id, actor_user_id, action, ok) VALUES ($1,$2,'auth.login',true)`, [u.tenant_id, u.id]);
  return { token, userId: u.id, tenantId: u.tenant_id };
}

export interface SessionInfo {
  idHash: string;
  userId: string;
  tenantId: string;
  email: string;
  tenantName: string;
  mode: 'live' | 'sample';
  wsId: string | null;
  sampleWsId: string | null;
  entitlement: string;
  entitlementUntil: string | null;
}

export async function resolveSession(db: Db, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || token.length > 100) return null;
  const h = sha256(token);
  const r = await db.query(
    `SELECT s.id_hash, s.user_id, s.tenant_id, s.mode, s.last_seen_at, u.email, t.name, t.active_ws_id, t.sample_ws_id, t.entitlement, t.entitlement_until
     FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
     WHERE s.id_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [h],
  );
  if (r.rowCount === 0) return null;
  const s = r.rows[0];
  if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60_000) {
    await db.query(`UPDATE sessions SET last_seen_at=now() WHERE id_hash=$1`, [h]);
  }
  return {
    idHash: h,
    userId: s.user_id,
    tenantId: s.tenant_id,
    email: s.email,
    tenantName: s.name,
    mode: s.mode,
    wsId: s.mode === 'sample' ? s.sample_ws_id : s.active_ws_id,
    sampleWsId: s.sample_ws_id,
    entitlement: s.entitlement,
    entitlementUntil: s.entitlement_until,
  };
}

export async function logout(db: Db, idHash: string) {
  await db.query(`UPDATE sessions SET revoked_at=now() WHERE id_hash=$1`, [idHash]);
}

export async function revokeAllSessions(db: Db, userId: string) {
  const r = await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  return r.rowCount ?? 0;
}

export async function changePassword(db: Db, userId: string, current: string, next: string) {
  const r = await db.query(`SELECT password_hash, tenant_id FROM users WHERE id=$1`, [userId]);
  if (!(await verifyPassword(current, r.rows[0].password_hash))) fail('UNAUTHENTICATED', '現在のパスワードが正しくありません');
  const pe = validatePasswordPolicy(next);
  if (pe) fail('VALIDATION', pe);
  await db.query(`UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1`, [userId, await hashPassword(next)]);
  await revokeAllSessions(db, userId);
  await db.query(`INSERT INTO audit_log (tenant_id, actor_user_id, action, ok) VALUES ($1,$2,'auth.password_change',true)`, [r.rows[0].tenant_id, userId]);
}

/** パスワード再設定トークンを発行（送信は Mailer に委ねる。存在しないメールでも同じ応答） */
export async function requestPasswordReset(db: Db, email: string): Promise<{ userEmail: string; token: string } | null> {
  const r = await db.query(`SELECT id, email FROM users WHERE email_key=$1`, [emailKey(String(email ?? ''))]);
  if (r.rowCount === 0) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [sha256(token), r.rows[0].id]);
  return { userEmail: r.rows[0].email, token };
}

export async function resetPassword(db: Db, token: string, next: string) {
  const pe = validatePasswordPolicy(next);
  if (pe) fail('VALIDATION', pe);
  const hash = await hashPassword(next);
  await withTx(db, async (c) => {
    const r = await c.query(
      `UPDATE password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(String(token ?? ''))],
    );
    if (r.rowCount === 0) fail('VALIDATION', '再設定リンクが無効か期限切れです。もう一度手続きしてください。');
    const uid = r.rows[0].user_id;
    await c.query(`UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1`, [uid, hash]);
    await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [uid]);
  });
}

/** アカウント削除：再認証と確認語を要求し、業務データ・添付参照・セッションを削除する */
export async function deleteAccount(db: Db, userId: string, password: string, confirmText: string) {
  const r = await db.query(`SELECT password_hash, tenant_id FROM users WHERE id=$1`, [userId]);
  if (r.rowCount === 0) fail('NOT_FOUND', 'アカウントが見つかりません');
  if (!(await verifyPassword(String(password ?? ''), r.rows[0].password_hash))) fail('UNAUTHENTICATED', 'パスワードが正しくありません');
  if (confirmText !== '削除します') fail('VALIDATION', '確認のため「削除します」と入力してください');
  const tenantId = r.rows[0].tenant_id;
  const files = await db.query(`SELECT DISTINCT f.sha256 FROM files f JOIN workspaces w ON w.id=f.ws_id WHERE w.tenant_id=$1`, [tenantId]);
  await withTx(db, async (c) => {
    await c.query(`DELETE FROM workspaces WHERE tenant_id=$1`, [tenantId]);
    await c.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]);
  });
  return { tenantId, fileHashes: files.rows.map((f) => f.sha256 as string) };
}

export async function setSessionMode(db: Db, idHash: string, mode: 'live' | 'sample') {
  await db.query(`UPDATE sessions SET mode=$2 WHERE id_hash=$1`, [idHash, mode]);
}
