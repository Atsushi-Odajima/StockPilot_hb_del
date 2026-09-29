# DATA_MODEL — データ構造

スキーマ：`migrations/0001_init.sql`、`0002_import_rows.sql`（PostgreSQL 16 で検証）。

## スコープ

```
tenants（事業者）1 ─ users（初版は1名）
   │ active_ws_id / sample_ws_id / previous_ws_id
   └─ workspaces（データ世代：live / sample / staging / retired）
          └─ すべての業務テーブル（主キー (ws_id, id)、参照は複合外部キー）
```

- **ワークスペース＝データ世代＝dataEpoch**。本番・サンプル・復元準備・復元前退避を同じ構造で分離する。
- 業務テーブルの参照は `(ws_id, 参照ID)` の複合外部キーなので、別ワークスペース（＝別事業者）の行は DB 制約上参照できない。
- ワークスペースの削除は全業務行へ CASCADE（アカウント削除・サンプル再作成・退避の破棄）。

## テーブル

| テーブル | 役割・主な制約 |
|---|---|
| tenants | 事業者名、利用権（pending/active/suspended、期限）、世代ポインタ |
| users | メール（小文字キーで一意）、scrypt ハッシュ |
| sessions | トークンの sha256、モード（live/sample）、期限、失効 |
| password_resets | トークン sha256、30分、1回限り |
| workspaces | 種類、伝票・発注・棚卸の採番カウンタ |
| files | 写真（sha256・サイズ・MIME は jpeg/png/webp のみ）。実体は非公開ストレージに sha256 名で保存 |
| suppliers / locations / skus | コード原文＋比較キー（NFKC・小文字・trim）で一意。locations.kind（normal/hold）、stocktake_id（停止）、rev（在庫イベント数） |
| skus 補充設定 | 全項目 NULL または「0≦安全≦発注点＜目標」を CHECK |
| sku_codes | JAN13/EAN8/CODE128/OTHER。(ws, code) 一意＝同じコードを別SKUに登録不可 |
| command_log | 冪等キー・要求ハッシュ・結果（(ws, key) 主キー） |
| purchase_orders / po_lines | 状態（draft/placed）、Q/R/C（CHECK R+C≦Q）、明細の固定ID・行番号、作成時の補充判断数量、名称スナップショット |
| po_revisions | 発注の版と理由、スナップショット |
| stocktakes / stocktake_lines / stocktake_count_history | 1場所1件の部分一意索引、基準リビジョン、未計数=NULL、行 version、計数履歴 |
| operations | 伝票ヘッダー（番号 IO-000001、目的、業務日付、確定時刻、理由、参照番号、行先、元履歴なし、外部ID） |
| ledger_events | 追記のみ。seq（確定順）、符号付き数量、元イベント・取消元・発注明細・移動の相手行、名称スナップショット |
| balances | (ws, sku, location) の残高（CHECK 0〜10億）、最終入出庫日 |
| import_batches | CSV 取込（ファイルハッシュ・列割当・元行・結果）。確定済みは (ws, 種類, ハッシュ) で一意 |
| documents | 帳票スナップショット（発注書・棚卸差異・ラベル） |
| audit_log | 操作の成否（主体・対象・時刻）。業務データ本文・パスワード・CSV本文は保存しない |

## 不変条件（テストと照合APIで確認）

1. `balances.qty` ＝ その (sku, location) の `ledger_events.qty` 合計（`verifyLedger`）
2. `po_lines.received_qty` ＝ その明細を参照するイベント（入荷＋取消）の合計
3. `locations.stocktake_id` が非NULL ⇔ その場所に counting/review の棚卸が1件
4. 残高 0≦qty≦10億、R+C≦Q、取消・返品累計≦元数量（サーバー検査）
