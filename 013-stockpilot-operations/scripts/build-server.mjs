// サーバーを1ファイルにまとめる（node_modules は外部参照）
import { build } from 'esbuild';
await build({
  entryPoints: ['src/server/main.ts', 'src/server/db/migrate-cli.ts', 'src/server/admin-cli.ts'],
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  entryNames: '[name]',
});
console.log('server built');
