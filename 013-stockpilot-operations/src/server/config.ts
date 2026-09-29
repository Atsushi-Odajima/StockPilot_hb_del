import path from 'node:path';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  dataDir: string;
  publicOrigin: string;
  registration: 'open' | 'closed';
  registrationDefaultEntitlement: 'pending' | 'active';
  mailer: 'console' | 'none';
  sessionTtlDays: number;
  webDistDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const databaseUrl = env.DATABASE_URL ?? (nodeEnv === 'production' ? '' : 'postgres://stockpilot:stockpilot@localhost:5432/stockpilot_dev');
  if (!databaseUrl) throw new Error('DATABASE_URL が未設定です');
  const publicOrigin = env.PUBLIC_ORIGIN ?? 'http://localhost:5173';
  if (nodeEnv === 'production' && !publicOrigin.startsWith('https://')) {
    throw new Error('本番環境の PUBLIC_ORIGIN は https:// である必要があります');
  }
  return {
    env: nodeEnv,
    port: Number(env.PORT ?? 8080),
    databaseUrl,
    dataDir: path.resolve(env.DATA_DIR ?? '.data'),
    publicOrigin,
    registration: env.REGISTRATION === 'closed' ? 'closed' : 'open',
    registrationDefaultEntitlement:
      env.REGISTRATION_DEFAULT_ENTITLEMENT === 'active' || (nodeEnv !== 'production' && env.REGISTRATION_DEFAULT_ENTITLEMENT !== 'pending')
        ? 'active'
        : 'pending',
    mailer: env.MAILER === 'console' ? 'console' : 'none',
    sessionTtlDays: 30,
    webDistDir: path.resolve(env.WEB_DIST_DIR ?? 'dist/web'),
  };
}
