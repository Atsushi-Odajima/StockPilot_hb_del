import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { LocalStorage } from './storage.js';
import { buildApp } from './app.js';
import path from 'node:path';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const storage = new LocalStorage(path.join(config.dataDir, 'storage'));

async function main() {
  if (process.env.MIGRATE_ON_START !== '0') await migrate(db, undefined, (s) => console.log(`[migrate] ${s}`));
  const app = await buildApp({ config, db, storage });
  const shutdown = async () => {
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((e) => {
  console.error('起動に失敗しました:', e.message);
  process.exit(1);
});
