# DEVELOPMENT — 開発手順

## 必要なもの
Node.js 22.12 以上、PostgreSQL 16（開発・テスト用）、Python 3 ＋ PyMuPDF（E2Eのカメラ試験・PDF目視確認のみ）。

## セットアップ
```
service postgresql start          # 環境に応じて
createuser -s stockpilot; createdb -O stockpilot stockpilot_dev; createdb -O stockpilot stockpilot_test; createdb -O stockpilot stockpilot_e2e
npm ci
npm run migrate                   # stockpilot_dev に適用
npm run dev:server                # :8080（API）
npm run dev:web                   # :5173（Vite、/api を :8080 へ中継）
```
既定の開発DB URL：`postgres://stockpilot:stockpilot@localhost:5432/stockpilot_dev`（`DATABASE_URL` で変更）。開発環境では新規登録の利用権は active。

## テスト
```
npm run typecheck
npm test                          # 統合テスト（stockpilot_test を毎回作り直す）
npm run build && npx playwright test   # E2E（stockpilot_e2e を作り直し、:8090 で起動）
npm run loadtest                  # 負荷測定（stockpilot_load）→ docs/LOADTEST_RESULT.md
```
Playwright は付属の Chromium を使う（`playwright install` 不要な環境向け）。

## ディレクトリ
```
src/shared   入力スキーマ・上限・日付・コード（サーバー／ブラウザ共通）
src/domain   補充計算・発注状態（純粋関数）
src/server   Fastify アプリ、services/（業務処理）、pdf/、db/
src/web      React SPA・PWA（public/ に manifest・sw.js・アイコン）
migrations   SQL マイグレーション
tests        統合テスト（vitest）   e2e  E2E（Playwright）
scripts      ビルド・E2Eサーバー・負荷測定・疑似カメラ映像生成
assets/fonts Noto Sans JP（OFL）
docs         負荷測定結果・サンプル説明、buyer/（購入者向け資料）
```

## 規約
- 在庫を変える処理は必ず `applyOperation()` を通す。ロック順序は inventory.ts 冒頭のコメント。
- 確定コマンドは `runCommand()`（冪等キー）で包む。
- 新しいテーブルは `ws_id` を持ち、主キー (ws_id, id)、参照は複合外部キー。
