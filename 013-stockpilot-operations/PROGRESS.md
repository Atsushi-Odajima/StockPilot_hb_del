# PROGRESS

最終更新：2026-09-29 ／ ブランチ：feature/013-stockpilot-operations

## 実装済み
- サーバー：認証（登録・ログイン・ログアウト・全失効・再設定・パスワード変更・アカウント削除）、利用権（運営CLI）、事業者分離（ワークスペース）、マスター（SKU・関連コード・写真・場所・仕入先）、在庫台帳エンジン（全12種別・冪等・ロック順序・負在庫防止・取消・返品）、発注（下書き・発注済み・訂正・打切り・分納・保留振分）、補充、棚卸（停止・計数・版・差異確認・確定・中止）、CSV取込6種・出力7種、帳票PDF3種（スナップショット）、バックアップ／復元（staging・検証・原子的切替・元に戻す）、サンプル領域、ダッシュボード、台帳照合。
- Web：React SPA（スマホはカード＋段階入力、PCは一覧表）、全業務画面、カメラ読取（ネイティブ→wasm切替）、キーボード型スキャナー（検索欄＋Enter）、QRラベル、結果不明時の照会、端末下書き（IndexedDB）、PWA（manifest・自作SW・更新バナー）、PDF表示/保存/共有。
- 資料：INVENTORY_RULES, API_CONTRACTS, DATA_MODEL, SECURITY, OPERATIONS, OPERATING_COSTS, DECISIONS, DEVELOPMENT, TEST_REPORT, RELEASE_CHECKLIST, THIRD_PARTY_NOTICES, 購入者向け資料（docs/buyer）、CSVテンプレート・架空サンプル。

## テスト（実行済み）
typecheck 0件、`npm test` 71件合格、Playwright 20件合格（mobile/desktop）、負荷測定完了。詳細は TEST_REPORT.md。

## 未完了・未実施
- 実機確認（iPhone Safari/PWA、Android Chrome、Windows/macOS ブラウザ、実カメラ、印刷ラベル）。
- 本番デプロイ・有料契約（ホスティング未決定、料金一部未確認）。
- パスワード再設定メールの送信サービス、S3互換ストレージドライバ。
- 障害系の一部（ENOSPC、バックアップ中断、マイグレーション失敗復旧訓練）。
- 販売条件（提供期間・容量上限・サポート・継続費負担）の決定。

## 実行したコマンド（主なもの）
```
npm run typecheck ; npm run build ; npm test ; npx playwright test ; npx tsx scripts/loadtest.ts
```
