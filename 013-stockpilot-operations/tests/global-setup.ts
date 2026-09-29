import pg from 'pg';
import { createPool } from '../src/server/db/pool.js';
import { migrate } from '../src/server/db/migrate.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://stockpilot:stockpilot@localhost:5432/stockpilot_test';

// テストDBを作り直してマイグレーションを適用する（実データは使わない）
export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const db = createPool(TEST_DB, 1);
  await migrate(db);
  await db.end();
}
