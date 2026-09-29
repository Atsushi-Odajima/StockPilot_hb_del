import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { db, storage, FIXED_NOW } from './helpers.js';

export async function testApp(now = () => FIXED_NOW): Promise<FastifyInstance> {
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'unused', PUBLIC_ORIGIN: 'http://localhost:5173', WEB_DIST_DIR: '/nonexistent' } as NodeJS.ProcessEnv), registrationDefaultEntitlement: 'active' as const };
  return buildApp({ config, db: db(), storage, now });
}

export class Client {
  cookie = '';
  epoch = '';
  constructor(private app: FastifyInstance) {}
  private headers(extra: Record<string, string> = {}) {
    return { cookie: this.cookie, 'x-stockpilot-csrf': '1', 'x-data-epoch': this.epoch, ...extra };
  }
  async register(email = `u-${crypto.randomUUID()}@example.test`, password = 'correct-horse-battery') {
    const r = await this.app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-stockpilot-csrf': '1' }, payload: { email, password, businessName: '検証用事業者' } });
    if (r.statusCode !== 200) throw new Error(r.body);
    this.cookie = String(r.headers['set-cookie']).split(';')[0];
    await this.refreshEpoch();
    return email;
  }
  async refreshEpoch() {
    const me = await this.get('/api/me');
    this.epoch = me.json().dataEpoch;
  }
  get(url: string) {
    return this.app.inject({ method: 'GET', url, headers: this.headers() });
  }
  post(url: string, payload: unknown, extra: Record<string, string> = {}) {
    return this.app.inject({ method: 'POST', url, headers: this.headers(extra), payload: payload as any });
  }
  put(url: string, payload: unknown) {
    return this.app.inject({ method: 'PUT', url, headers: this.headers(), payload: payload as any });
  }
  del(url: string) {
    return this.app.inject({ method: 'DELETE', url, headers: this.headers() });
  }
  async ok<T = any>(p: Promise<{ statusCode: number; body: string; json: () => any }>): Promise<T> {
    const r = await p;
    if (r.statusCode >= 300) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
    return r.json();
  }
  upload(url: string, file: Buffer, filename: string, fields: Record<string, string> = {}, contentType = 'application/octet-stream') {
    const boundary = '----sp' + crypto.randomBytes(8).toString('hex');
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    parts.push(file);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return this.app.inject({
      method: url.includes('/photo') ? 'PUT' : 'POST',
      url,
      headers: { ...this.headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
  }
}

export const k = () => crypto.randomUUID();
