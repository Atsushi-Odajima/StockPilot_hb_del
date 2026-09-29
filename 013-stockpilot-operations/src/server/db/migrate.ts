import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './pool.js';

export const MIGRATIONS_DIR = path.resolve(process.env.MIGRATIONS_DIR ?? 'migrations');

/** 未適用のマイグレーションを番号順に1ファイル＝1トランザクションで適用する */
export async function migrate(db: Db, dir = MIGRATIONS_DIR, log: (s: string) => void = () => undefined): Promise<string[]> {
  const c = await db.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // 複数インスタンス同時起動時の二重適用を防ぐ
    await c.query('SELECT pg_advisory_lock(830013)');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      log(`applied ${f}`);
      applied.push(f);
    }
    return applied;
  } finally {
    await c.query('SELECT pg_advisory_unlock(830013)').catch(() => undefined);
    c.release();
  }
}

export function latestSchemaVersion(dir = MIGRATIONS_DIR): number {
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return files.length ? Number(files[files.length - 1].slice(0, 4)) : 0;
}
