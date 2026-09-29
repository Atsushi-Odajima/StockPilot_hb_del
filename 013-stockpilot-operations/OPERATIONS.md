# OPERATIONS — 運用手順

本番公開・有料契約はまだ行っていない。以下は想定手順であり、実環境での実施は販売前の残作業。

## 構成
- Node.js 22 の単一プロセス（API＋ビルド済みSPA配信）、PostgreSQL 16、永続ディスク（`DATA_DIR/storage`：写真・一時ファイル）。
- HTTPS 終端はホスティング側（リバースプロキシ）。`trustProxy` 有効。`PUBLIC_ORIGIN` は https 必須（本番起動時に検査）。

## デプロイ
```
npm ci
npm run build                 # dist/web（SPA）と dist/server（API）
cp .env.example .env          # 値を設定（秘密情報はホスティングの環境変数機能で管理）
npm run migrate:prod          # 起動時にも自動適用（MIGRATE_ON_START=0 で無効）
npm start
```
ヘルスチェック：`GET /api/health`。

## DB 更新（マイグレーション）
- `migrations/NNNN_*.sql` を番号順に1ファイル＝1トランザクションで適用（advisory lock で二重適用防止）。
- 追加前に旧スキーマのテストデータで `npm test` を実行。ロールバック方針：原則「前進のみ」。破壊的変更は（1）列追加→（2）アプリ切替→（3）旧列削除の3段階に分け、各段階の前に DB スナップショットを取る。

## 利用権の付与
```
npm run admin:prod -- show  user@example.com
npm run admin:prod -- grant user@example.com --until 2027-09-30
npm run admin:prod -- suspend user@example.com
```
`REGISTRATION_DEFAULT_ENTITLEMENT=pending` の場合、新規登録者はサンプルのみ操作可能。

## バックアップ（運営者）
- DB：ホスティングの自動バックアップ／PITR を有効化（無料枠は不可。OPERATING_COSTS.md）。加えて日次 `pg_dump -Fc`（一貫したスナップショット）を別リージョンへ保存。
- 写真：`DATA_DIR/storage/objects` を日次同期（内容アドレスなので追加のみ）。
- 復旧訓練：空の環境に `pg_restore` → 写真同期 → 起動 → `GET /api/verify` を各利用者で確認。

## 利用者向け復元の障害時
- 準備（staging）で失敗した場合、現データは変更されない。切替後に問題があれば利用者が「直前の復元を元に戻す」（退避世代へ切替）。運営者は `tenants.previous_ws_id` で同じ操作ができる。

## 監視
- ディスク使用量（写真・一時ファイル）、DB 容量、5xx 率、`/api/health`、`statement_timeout`（30秒）超過。
- `DATA_DIR/storage/tmp` の古いファイル（バックアップ作成の一時ZIP・中断した復元）を日次で削除。

## 障害対応
- 結果不明の問い合わせ：利用者の操作キーを `command_log` で照会（確定済みか判断できる）。
- 在庫不整合の疑い：`GET /api/verify`（利用者画面「バックアップ」にも表示）。
