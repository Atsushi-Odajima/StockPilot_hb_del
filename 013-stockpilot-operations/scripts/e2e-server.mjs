// E2E 用：専用DBを作り直してビルド済みサーバーを起動する（実データは使わない）
import pg from 'pg';
import { spawn } from 'node:child_process';
const url = process.env.E2E_DATABASE_URL ?? 'postgres://stockpilot:stockpilot@localhost:5432/stockpilot_e2e';
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await c.end();
const p = spawn('node', ['dist/server/main.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: url, PORT: '8090', PUBLIC_ORIGIN: 'http://localhost:8090', DATA_DIR: '.data-e2e', REGISTRATION_DEFAULT_ENTITLEMENT: 'active', LOG_LEVEL: 'warn' },
});
process.on('SIGTERM', () => p.kill('SIGTERM'));
process.on('SIGINT', () => p.kill('SIGINT'));
p.on('exit', (code) => process.exit(code ?? 0));
