// 運営者用：利用権の付与・停止（ブラウザからは実行できない。サーバー上でのみ実行する）
// 使い方:
//   npm run admin -- grant <email> [--until YYYY-MM-DD]
//   npm run admin -- suspend <email>
//   npm run admin -- show <email>
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { isValidDate } from '../shared/dates.js';

const [cmd, email, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, 1);

async function run() {
  if (!cmd || !email) {
    console.log('usage: admin grant|suspend|show <email> [--until YYYY-MM-DD]');
    return;
  }
  const u = await db.query(`SELECT u.tenant_id, t.name, t.entitlement, t.entitlement_until FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.email_key=$1`, [
    email.trim().toLowerCase(),
  ]);
  if (u.rowCount === 0) throw new Error('アカウントが見つかりません');
  const tid = u.rows[0].tenant_id;
  if (cmd === 'show') {
    console.log(u.rows[0]);
    return;
  }
  if (cmd === 'grant') {
    const i = rest.indexOf('--until');
    const until = i >= 0 ? rest[i + 1] : null;
    if (until && !isValidDate(until)) throw new Error('--until は YYYY-MM-DD');
    await db.query(`UPDATE tenants SET entitlement='active', entitlement_until=$2 WHERE id=$1`, [tid, until]);
    await db.query(`INSERT INTO audit_log (tenant_id, action, detail, ok) VALUES ($1,'admin.grant',$2,true)`, [tid, JSON.stringify({ until })]);
    console.log(`granted: ${u.rows[0].name}${until ? ` until ${until}` : ''}`);
    return;
  }
  if (cmd === 'suspend') {
    await db.query(`UPDATE tenants SET entitlement='suspended' WHERE id=$1`, [tid]);
    await db.query(`INSERT INTO audit_log (tenant_id, action, ok) VALUES ($1,'admin.suspend',true)`, [tid]);
    console.log(`suspended: ${u.rows[0].name}`);
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

run()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
