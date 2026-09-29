import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 非公開オブジェクトストレージの抽象。実体は sha256 をキーに変更不可で保存する。
 * 初版はローカル永続ボリューム実装のみ（S3互換ドライバは OPERATIONS.md の残作業）。
 * 公開URLは発行せず、認証済みAPIが所有確認後に中身を返す。
 */
export interface Storage {
  put(data: Buffer): Promise<string>;
  get(sha256: string): Promise<Buffer | null>;
  has(sha256: string): Promise<boolean>;
  remove(sha256: string): Promise<void>;
  tmpDir(): string;
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {
    fs.mkdirSync(path.join(root, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  }
  private p(sha: string) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad object key');
    return path.join(this.root, 'objects', sha.slice(0, 2), sha);
  }
  async put(data: Buffer): Promise<string> {
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const dest = this.p(sha);
    if (fs.existsSync(dest)) return sha;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = path.join(this.root, 'tmp', `${sha}.${process.pid}.${Date.now()}`);
    await fs.promises.writeFile(tmp, data, { mode: 0o600 });
    await fs.promises.rename(tmp, dest);
    return sha;
  }
  async get(sha: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.p(sha));
    } catch {
      return null;
    }
  }
  async has(sha: string): Promise<boolean> {
    return fs.existsSync(this.p(sha));
  }
  async remove(sha: string): Promise<void> {
    await fs.promises.rm(this.p(sha), { force: true });
  }
  tmpDir(): string {
    return path.join(this.root, 'tmp');
  }
}

/** 画像の実体検査（拡張子・申告MIMEではなく先頭バイトで判定） */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc', 'heim', 'heis'].includes(brand)) return 'image/heic';
  }
  return null;
}
