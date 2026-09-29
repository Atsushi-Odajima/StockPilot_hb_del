import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, 1);
migrate(db, undefined, (s) => console.log(s))
  .then((a) => {
    console.log(a.length ? `${a.length} migration(s) applied` : 'up to date');
    return db.end();
  })
  .catch(async (e) => {
    console.error(e.message);
    await db.end();
    process.exit(1);
  });
