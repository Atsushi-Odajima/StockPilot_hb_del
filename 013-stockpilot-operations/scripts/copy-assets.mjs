// ビルド前に端末内デコーダの .wasm を自前配信用に配置する（CDNから取得しない）
import fs from 'node:fs';
import path from 'node:path';
const src = path.resolve('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
const dst = path.resolve('src/web/public/wasm/zxing_reader.wasm');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('copied zxing_reader.wasm');
