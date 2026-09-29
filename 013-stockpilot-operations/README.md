# StockPilot — 在庫オペレーション管理（商品#013）

発注・分納・入出庫・場所移動・補充・棚卸しを、PCとスマホでつなぐ認証付きWebアプリ。
「何がどこに何個あり、あと何個届き、次に何個補充すればよいかを確認できます。」

- 中心：SKU別・保管場所別の現物数量と、その変更履歴（追記のみの台帳）
- 対象外：売上・利益・粗利・在庫評価額・原価・税・請求・入金・EC同期・自動発注・AI予測

| 資料 | 内容 |
|---|---|
| [INVENTORY_RULES.md](INVENTORY_RULES.md) | 数量定義・台帳・発注残・補充式・保留・取消・棚卸 |
| [API_CONTRACTS.md](API_CONTRACTS.md) | 確定コマンド・冪等キー・version・dataEpoch・エラー |
| [DATA_MODEL.md](DATA_MODEL.md) / [DECISIONS.md](DECISIONS.md) | データ構造・設計判断 |
| [SECURITY.md](SECURITY.md) / [OPERATIONS.md](OPERATIONS.md) / [OPERATING_COSTS.md](OPERATING_COSTS.md) | セキュリティ・運用・費用 |
| [DEVELOPMENT.md](DEVELOPMENT.md) / [TEST_REPORT.md](TEST_REPORT.md) / [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | 開発・試験結果・販売前確認 |
| [PLAN.md](PLAN.md) / [PROGRESS.md](PROGRESS.md) / [NEXT_STEPS.txt](NEXT_STEPS.txt) | 計画・進捗・再開 |
| docs/buyer/ | 購入者向け説明書・CSVテンプレート・架空サンプル |

クイックスタートは DEVELOPMENT.md。
