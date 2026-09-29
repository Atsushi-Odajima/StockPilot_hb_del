import pg from 'pg';

// bigint / date は文字列のまま受け取り、アプリ側で変換する（日付を UTC Date にしない）
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint overflow');
  return n;
});

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: url, max, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000 } as pg.PoolConfig);
  pool.on('error', (err) => {
    // アイドル接続のエラー。プロセスを落とさず記録のみ（接続文字列は出力しない）
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

const RETRYABLE = new Set(['40P01', '40001']); // deadlock / serialization failure

export interface TxOptions {
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  readOnly?: boolean;
  retries?: number;
}

/** 短いトランザクションを実行。デッドロック・直列化失敗は同じ内容で再試行する。 */
export async function withTx<T>(db: Db, fn: (c: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const c = await db.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}${opts.readOnly ? ' READ ONLY' : ''}`);
      await c.query(`SET LOCAL lock_timeout = '10s'`);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) {
        await new Promise((res) => setTimeout(res, 20 + Math.random() * 80 * (attempt + 1)));
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
}
