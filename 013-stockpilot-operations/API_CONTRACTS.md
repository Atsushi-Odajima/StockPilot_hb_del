# API_CONTRACTS — API の約束事

すべて `/api/` 以下、JSON。実装は `src/server/app.ts`、入力スキーマは `src/shared/schemas.ts`（zod）。

## 共通ヘッダー

| ヘッダー | 用途 |
|---|---|
| Cookie `sp_session` | HttpOnly・SameSite=Lax・本番は Secure。トークンのハッシュのみDB保存 |
| `x-stockpilot-csrf: 1` | GET 以外は必須（ないと 403 `CSRF`）。Origin ヘッダーがあれば `PUBLIC_ORIGIN` と一致必須 |
| `x-data-epoch` | 認証済みの GET 以外で必須。端末が認識しているデータ世代（＝ワークスペースID）。不一致は 409 `EPOCH_MISMATCH` |

応答は `Cache-Control: no-store`。

## エラー形式

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "利用者向け日本語", "details": { } } }
```

| code | HTTP | 意味・利用者の次の行動 |
|---|---|---|
| VALIDATION | 400 | 入力不正（details に項目） |
| UNAUTHENTICATED | 401 | 再ログイン |
| FORBIDDEN / CSRF | 403 | 画面を再読み込み |
| ENTITLEMENT_REQUIRED | 403 | 利用権なし。本番への書込み不可（サンプルは可） |
| NOT_FOUND | 404 | 存在しない、または別事業者のID（区別しない） |
| EPOCH_MISMATCH | 409 | 復元・表示切替後の古い画面。再読み込み。details.currentEpoch |
| IDEMPOTENCY_CONFLICT | 409 | 同じ操作キーで別内容。新しい操作としてやり直す |
| VERSION_CONFLICT | 409 | マスター・発注・棚卸行の版が古い |
| STALE_QTY | 409 | 画面の数量（expected）と現在数量が違う。details.stale に最新値 |
| BASIS_CHANGED | 409 | 補充判断数量が変わった。details に最新の U/O/P |
| DUPLICATE / IN_USE / STATE / INITIAL_EXISTS / IMPORT_DUPLICATE | 409 | 重複・使用中・状態不一致・初期在庫済み・同一CSV取込済み |
| INSUFFICIENT_STOCK | 422 | details.shortages（現数・必要数・他の場所） |
| OVER_RECEIPT / OVER_CAP / BALANCE_LIMIT / RESTORE_INVALID | 422 | 発注残超過・取消/返品上限超過・残高上限・復元データ不正 |
| LOCATION_LOCKED | 423 | 棚卸中の場所 |
| TOO_LARGE | 413 | ファイル・行数の上限 |
| RATE_LIMITED | 429 | 待って再試行 |
| INTERNAL | 500 | 結果不明として扱う（下記） |

## 確定コマンドと冪等性

対象：`POST /api/ops/*`、`/api/pos/:id/{place,revise,cancel-remaining,receive}`、`/api/replenish/drafts`、`/api/stocktakes`（開始）、`/api/stocktakes/:id/{confirm,cancel}`、`/api/import/:id/commit`。

- 本文に `idempotencyKey`（8〜100文字の英数・`-`・`_`、クライアントで UUID 生成）を含める。
- 同じキー＋同じ内容（キー順を固定した JSON の SHA-256）→ 前回の結果を `{"replayed": true, "result": …}` で返す。
- 同じキー＋別内容 → `IDEMPOTENCY_CONFLICT`。
- サーバーが拒否したエラー（4xx）は何も反映していない。次の送信は新しいキーを使う。
- **結果不明**（通信断・タイムアウト・5xx）：同じキーで `GET /api/ops/by-key/:key` を照会する。`found:true` なら確定済み、`found:false` なら同じキー・同じ内容で再送。新しいキーで即再実行しない（クライアント `useCommand` が実装）。
- 同じ発注への別キーでの二重入荷は、発注残の検査（`OVER_RECEIPT`）でも防ぐ。

成功応答（在庫伝票）：

```json
{ "replayed": false, "result": { "operationId": "…", "opNo": "IO-000012", "kind": "issue", "committedAt": "…", "businessDate": "2026-09-29",
  "lines": [ { "lineNo": 1, "eventId": "…", "skuId": "…", "skuCode": "…", "locationId": "…", "delta": -3, "before": 10, "after": 7, "unit": "個" } ] } }
```

## 主なエンドポイント

| メソッド・パス | 内容 |
|---|---|
| POST /api/auth/register, login, logout, reset-request, reset | 認証（10回/分/IP） |
| POST /api/auth/logout-all, password, /api/account/delete | 全セッション失効・変更・削除（要再認証） |
| GET /api/me | 利用者・データ世代・利用権 |
| POST /api/mode `{mode:'live'｜'sample', reset?}` | 本番／サンプル切替（サンプルは別ワークスペース） |
| GET /api/dashboard, /api/idle, /api/verify | 集計・直近出庫なし・台帳照合 |
| GET /api/inventory?q&filter&locationId&supplierId&limit&offset | 在庫一覧（最大200件/頁） |
| GET /api/resolve?code= | コード解決（内部QR→JAN等→SKUコード→場所コード）。未登録は unknown（自動作成しない） |
| GET /api/history?skuId&locationId&opId&kind&from&to&limit&beforeSeq | 台帳履歴（seq カーソル） |
| GET /api/ops/:id, /api/ops/by-key/:key | 伝票詳細・冪等キー照会 |
| /api/skus, /api/locations, /api/suppliers | マスター CRUD（PUT は `version` 必須）、archive、delete（参照なしのみ） |
| POST /api/skus/:id/codes, PUT /api/skus/:id/photo | 関連コード・写真（multipart。実体検査） |
| GET /api/files/:id | 写真（所有確認後に配信。公開URLなし） |
| POST /api/ops/{initial,outside-receipt,issue,transfer,disposal,correction,customer-return,supplier-return,reversal} | 在庫確定 |
| /api/pos … | 発注（下書き CRUD・place・revise・cancel-remaining・receive・sheet） |
| GET /api/pos/pending-lines | 入荷待ち明細 |
| GET /api/replenish, POST /api/replenish/drafts | 補充候補・下書き作成 |
| /api/stocktakes … | 棚卸（開始・count・reason・lines・review・confirm・cancel） |
| POST /api/labels, GET /api/documents/:id/pdf | 帳票スナップショット作成・PDF |
| /api/import/preview, /:id/commit, /:id/discard, /templates/:kind | CSV取込 |
| GET /api/export/:kind | CSV出力 |
| GET /api/backup/export, POST /api/backup/restore/preview, /:id/commit, /:id/discard, /api/backup/rollback | バックアップ・復元 |

## データ世代（dataEpoch）

- 値はアクティブなワークスペースID。復元の確定・取消（rollback）・サンプル切替で変わる。
- すべての書込みは、トランザクション先頭で `tenants` 行を FOR SHARE して現在世代と照合する（復元の切替は FOR UPDATE）。
- 端末下書きは作成時の世代を保持し、世代が違えば送信させない。
