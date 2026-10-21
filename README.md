# StockPilot — 在庫と現場の作業をつなぐ

SKU・保管場所ごとの数量と変更履歴を中心に、発注・分納・入出庫・補充・棚卸しを管理するWebアプリです。

実装ブランチ：`feature/013-stockpilot-operations`。アプリ本体は `013-stockpilot-operations/`。

## できること

- 追記型の在庫台帳、数量変更・取消・競合制御
- 発注残・分納・保留、場所移動・補充・棚卸し
- CSV入出力、帳票PDF、権限、監査、バックアップ

## 現在の範囲・制限

- 売上・利益・在庫評価・税務・請求・EC同期・自動発注・AI予測は対象外です。
- パスワード再設定メールの送信サービス接続とスマートフォン実機確認が残っています。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js、PostgreSQL、PWA。

- [013-stockpilot-operations/src/server](./013-stockpilot-operations/src/server)
- [013-stockpilot-operations/src](./013-stockpilot-operations/src)
- [013-stockpilot-operations/tests](./013-stockpilot-operations/tests)

## ローカルで試す

Node.js 22.12以上、PostgreSQL。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch feature/013-stockpilot-operations https://github.com/Atsushi-Odajima/StockPilot_hb_del.git
cd StockPilot_hb_del/013-stockpilot-operations
npm ci
```

開発手順でDATABASE_URL・認証用設定とDB移行を用意し、npm run dev:server と npm run dev:web を別ターミナルで実行します。

環境設定・初期化の詳細：[セットアップ手順](./013-stockpilot-operations/DEVELOPMENT.md)。

## 検証方法

`013-stockpilot-operations/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run test:e2e
npm run build
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [013-stockpilot-operations/DEVELOPMENT.md](./013-stockpilot-operations/DEVELOPMENT.md)
- [013-stockpilot-operations/NEXT_STEPS.txt](./013-stockpilot-operations/NEXT_STEPS.txt)
- [013-stockpilot-operations/README.md](./013-stockpilot-operations/README.md)
- [013-stockpilot-operations/TEST_REPORT.md](./013-stockpilot-operations/TEST_REPORT.md)
- [013-stockpilot-operations/RELEASE_CHECKLIST.md](./013-stockpilot-operations/RELEASE_CHECKLIST.md)
- [013-stockpilot-operations/DATA_MODEL.md](./013-stockpilot-operations/DATA_MODEL.md)
- [013-stockpilot-operations/DECISIONS.md](./013-stockpilot-operations/DECISIONS.md)
- [013-stockpilot-operations/SECURITY.md](./013-stockpilot-operations/SECURITY.md)
- [013-stockpilot-operations/OPERATIONS.md](./013-stockpilot-operations/OPERATIONS.md)
- [013-stockpilot-operations/THIRD_PARTY_NOTICES.txt](./013-stockpilot-operations/THIRD_PARTY_NOTICES.txt)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
