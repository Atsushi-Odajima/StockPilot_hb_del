-- StockPilot #013 初期スキーマ
-- 方針:
--  * 業務データはすべて ws_id（ワークスペース＝データ世代）でスコープする。
--  * 主キーは (ws_id, id)。参照は複合外部キーで、同じワークスペース内に限定する。
--  * 在庫の変動は ledger_events（追記のみ）。balances は同一トランザクションで更新する集計キャッシュ。

CREATE TABLE tenants (
  id            uuid PRIMARY KEY,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  entitlement   text NOT NULL DEFAULT 'pending' CHECK (entitlement IN ('pending','active','suspended')),
  entitlement_until date,
  active_ws_id  uuid,
  sample_ws_id  uuid,
  previous_ws_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  email_key     text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash       text PRIMARY KEY,           -- sha256(token)。トークン自体は保存しない
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode          text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','sample')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE password_resets (
  token_hash    text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz
);

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('live','sample','staging','retired')),
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  op_seq        bigint NOT NULL DEFAULT 0,   -- 伝票番号の採番
  po_seq        bigint NOT NULL DEFAULT 0,   -- 発注番号の採番
  st_seq        bigint NOT NULL DEFAULT 0    -- 棚卸番号の採番
);
CREATE INDEX workspaces_tenant_idx ON workspaces(tenant_id);

-- 添付（変更不可）。実体はストレージに sha256 で保存。
CREATE TABLE files (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  sha256    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size      integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  mime      text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id)
);

CREATE TABLE suppliers (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  code      text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 40),
  code_key  text NOT NULL,
  name      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  contact_name text NOT NULL DEFAULT '' CHECK (char_length(contact_name) <= 100),
  contact   text NOT NULL DEFAULT '' CHECK (char_length(contact) <= 300),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650),
  note      text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  archived  boolean NOT NULL DEFAULT false,
  version   integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, code_key)
);

CREATE TABLE locations (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  code      text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 40),
  code_key  text NOT NULL,
  name      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  kind      text NOT NULL CHECK (kind IN ('normal','hold')),
  archived  boolean NOT NULL DEFAULT false,
  stocktake_id uuid,                       -- 棚卸停止中なら棚卸セッションID
  rev       bigint NOT NULL DEFAULT 0,      -- この場所に関わる在庫イベントごとに加算
  version   integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, code_key)
);

CREATE TABLE skus (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  code      text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 60),
  code_key  text NOT NULL,
  name      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  group_name text NOT NULL DEFAULT '' CHECK (char_length(group_name) <= 200),
  color     text NOT NULL DEFAULT '' CHECK (char_length(color) <= 60),
  size      text NOT NULL DEFAULT '' CHECK (char_length(size) <= 60),
  attrs     text NOT NULL DEFAULT '' CHECK (char_length(attrs) <= 200),
  category  text NOT NULL DEFAULT '' CHECK (char_length(category) <= 100),
  brand     text NOT NULL DEFAULT '' CHECK (char_length(brand) <= 100),
  unit      text NOT NULL DEFAULT '個' CHECK (char_length(unit) BETWEEN 1 AND 10),
  supplier_id uuid,
  memo      text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 2000),
  photo_file_id uuid,
  archived  boolean NOT NULL DEFAULT false,
  safety_stock   integer CHECK (safety_stock IS NULL OR safety_stock BETWEEN 0 AND 1000000000),
  reorder_point  integer CHECK (reorder_point IS NULL OR reorder_point BETWEEN 0 AND 1000000000),
  target_stock   integer CHECK (target_stock IS NULL OR target_stock BETWEEN 1 AND 1000000000),
  min_order_qty  integer CHECK (min_order_qty IS NULL OR min_order_qty BETWEEN 0 AND 1000000),
  order_multiple integer CHECK (order_multiple IS NULL OR order_multiple BETWEEN 1 AND 1000000),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650),
  version   integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, code_key),
  FOREIGN KEY (ws_id, supplier_id) REFERENCES suppliers(ws_id, id),
  FOREIGN KEY (ws_id, photo_file_id) REFERENCES files(ws_id, id),
  -- 補充設定は「全部未設定」か「全部設定して 0<=安全<=発注点<目標」
  CONSTRAINT skus_replenish_all_or_none CHECK (
    (safety_stock IS NULL AND reorder_point IS NULL AND target_stock IS NULL AND min_order_qty IS NULL AND order_multiple IS NULL)
    OR (safety_stock IS NOT NULL AND reorder_point IS NOT NULL AND target_stock IS NOT NULL AND min_order_qty IS NOT NULL AND order_multiple IS NOT NULL
        AND safety_stock <= reorder_point AND reorder_point < target_stock)
  )
);
CREATE INDEX skus_name_idx ON skus(ws_id, name);

-- JAN/EAN、Code128、その他のスキャン用コード。同じコードは1SKUのみ。
CREATE TABLE sku_codes (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  sku_id    uuid NOT NULL,
  code      text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 60),
  kind      text NOT NULL CHECK (kind IN ('JAN13','EAN8','CODE128','OTHER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, code),
  FOREIGN KEY (ws_id, sku_id) REFERENCES skus(ws_id, id) ON DELETE CASCADE
);
CREATE INDEX sku_codes_sku_idx ON sku_codes(ws_id, sku_id);

-- 冪等キー（全確定コマンド共通）
CREATE TABLE command_log (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idem_key  text NOT NULL CHECK (char_length(idem_key) BETWEEN 8 AND 100),
  request_hash text NOT NULL,
  command   text NOT NULL,
  result    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, idem_key)
);

-- 発注
CREATE TABLE purchase_orders (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  po_no     text NOT NULL,
  supplier_id uuid NOT NULL,
  status    text NOT NULL CHECK (status IN ('draft','placed')),
  created_date date NOT NULL,
  ordered_date date,
  due_date  date,
  location_id uuid,
  external_ref text NOT NULL DEFAULT '' CHECK (char_length(external_ref) <= 100),
  supplier_note text NOT NULL DEFAULT '' CHECK (char_length(supplier_note) <= 1000),
  internal_memo text NOT NULL DEFAULT '' CHECK (char_length(internal_memo) <= 2000),
  replaces_po_id uuid,                        -- 交換用発注の関連
  source_key text,                            -- 補充候補から作った場合の操作キー
  version   integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, po_no),
  FOREIGN KEY (ws_id, supplier_id) REFERENCES suppliers(ws_id, id),
  FOREIGN KEY (ws_id, location_id) REFERENCES locations(ws_id, id),
  FOREIGN KEY (ws_id, replaces_po_id) REFERENCES purchase_orders(ws_id, id),
  CHECK (status = 'draft' OR ordered_date IS NOT NULL)
);
CREATE INDEX po_supplier_idx ON purchase_orders(ws_id, supplier_id);

CREATE TABLE po_lines (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  po_id     uuid NOT NULL,
  line_no   integer NOT NULL,
  sku_id    uuid NOT NULL,
  qty       integer NOT NULL CHECK (qty BETWEEN 1 AND 1000000),          -- Q
  received_qty integer NOT NULL DEFAULT 0,                               -- R
  cancelled_qty integer NOT NULL DEFAULT 0,                              -- C
  due_date  date,
  location_id uuid NOT NULL,
  basis_p   bigint,               -- 補充候補から作成した時点の補充判断数量
  sku_snapshot jsonb NOT NULL,    -- 発注時の名称スナップショット
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, po_id, line_no),
  FOREIGN KEY (ws_id, po_id) REFERENCES purchase_orders(ws_id, id) ON DELETE CASCADE,
  FOREIGN KEY (ws_id, sku_id) REFERENCES skus(ws_id, id),
  FOREIGN KEY (ws_id, location_id) REFERENCES locations(ws_id, id),
  CHECK (received_qty >= 0 AND cancelled_qty >= 0 AND received_qty + cancelled_qty <= qty)
);
CREATE INDEX po_lines_sku_idx ON po_lines(ws_id, sku_id);

CREATE TABLE po_revisions (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  po_id     uuid NOT NULL,
  version   integer NOT NULL,
  action    text NOT NULL,
  reason    text NOT NULL DEFAULT '',
  snapshot  jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  FOREIGN KEY (ws_id, po_id) REFERENCES purchase_orders(ws_id, id) ON DELETE CASCADE
);

-- 棚卸セッション
CREATE TABLE stocktakes (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  st_no     text NOT NULL,
  location_id uuid NOT NULL,
  status    text NOT NULL CHECK (status IN ('counting','review','confirmed','cancelled')),
  base_rev  bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  business_date date NOT NULL,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '',
  outside_movement_note text NOT NULL DEFAULT '',
  version   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, st_no),
  FOREIGN KEY (ws_id, location_id) REFERENCES locations(ws_id, id)
);
-- 1場所につき進行中の棚卸は1件
CREATE UNIQUE INDEX stocktakes_active_uq ON stocktakes(ws_id, location_id) WHERE status IN ('counting','review');

CREATE TABLE stocktake_lines (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  stocktake_id uuid NOT NULL,
  sku_id    uuid NOT NULL,
  theoretical_qty bigint NOT NULL CHECK (theoretical_qty >= 0),
  counted_qty bigint CHECK (counted_qty IS NULL OR counted_qty BETWEEN 0 AND 1000000000),  -- NULL=未計数
  reason_code text,
  reason_note text NOT NULL DEFAULT '' CHECK (char_length(reason_note) <= 500),
  added_during_count boolean NOT NULL DEFAULT false,
  version   integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, stocktake_id, sku_id),
  FOREIGN KEY (ws_id, stocktake_id) REFERENCES stocktakes(ws_id, id) ON DELETE CASCADE,
  FOREIGN KEY (ws_id, sku_id) REFERENCES skus(ws_id, id)
);

CREATE TABLE stocktake_count_history (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  line_id   uuid NOT NULL,
  counted_qty bigint,
  counted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id),
  FOREIGN KEY (ws_id, line_id) REFERENCES stocktake_lines(ws_id, id) ON DELETE CASCADE
);

ALTER TABLE locations ADD FOREIGN KEY (ws_id, stocktake_id) REFERENCES stocktakes(ws_id, id) DEFERRABLE INITIALLY DEFERRED;

-- 伝票（在庫操作のヘッダー）
CREATE TABLE operations (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  op_no     text NOT NULL,
  kind      text NOT NULL CHECK (kind IN (
              'initial','po_receipt','outside_receipt','issue','customer_return','supplier_return',
              'transfer','disposal','stocktake_adjust','correction','reversal')),
  purpose   text CHECK (purpose IS NULL OR purpose IN ('sale','sample','business_use','other')),
  business_date date NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  po_id     uuid,
  stocktake_id uuid,
  import_id uuid,
  reason    text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  note      text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  external_ref text NOT NULL DEFAULT '' CHECK (char_length(external_ref) <= 100),
  destination_label text NOT NULL DEFAULT '' CHECK (char_length(destination_label) <= 100),
  no_source boolean NOT NULL DEFAULT false,   -- 元履歴なし返品
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, op_no),
  FOREIGN KEY (ws_id, po_id) REFERENCES purchase_orders(ws_id, id),
  FOREIGN KEY (ws_id, stocktake_id) REFERENCES stocktakes(ws_id, id)
);
CREATE INDEX operations_committed_idx ON operations(ws_id, committed_at DESC);

-- 在庫台帳（追記のみ）
CREATE TABLE ledger_events (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  seq       bigint GENERATED ALWAYS AS IDENTITY,
  op_id     uuid NOT NULL,
  line_no   integer NOT NULL,
  kind      text NOT NULL CHECK (kind IN (
              'initial','po_receipt','outside_receipt','issue_sale','issue_other','customer_return',
              'supplier_return','transfer_out','transfer_in','disposal','stocktake_adjust','correction','reversal')),
  sku_id    uuid NOT NULL,
  location_id uuid NOT NULL,
  qty       integer NOT NULL CHECK (qty <> 0 AND qty BETWEEN -1000000000 AND 1000000000),
  business_date date NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  po_line_id uuid,
  source_event_id uuid,       -- 顧客返品の元出庫、仕入先返品の元受領
  reversal_of_event_id uuid,  -- 取消元
  transfer_pair_line integer, -- 移動の相手側 line_no
  reason    text NOT NULL DEFAULT '',
  sku_snapshot jsonb NOT NULL,
  location_snapshot jsonb NOT NULL,
  PRIMARY KEY (ws_id, id),
  UNIQUE (ws_id, op_id, line_no),
  FOREIGN KEY (ws_id, op_id) REFERENCES operations(ws_id, id),
  FOREIGN KEY (ws_id, sku_id) REFERENCES skus(ws_id, id),
  FOREIGN KEY (ws_id, location_id) REFERENCES locations(ws_id, id),
  FOREIGN KEY (ws_id, po_line_id) REFERENCES po_lines(ws_id, id),
  FOREIGN KEY (ws_id, source_event_id) REFERENCES ledger_events(ws_id, id),
  FOREIGN KEY (ws_id, reversal_of_event_id) REFERENCES ledger_events(ws_id, id)
);
CREATE INDEX ledger_sku_loc_idx ON ledger_events(ws_id, sku_id, location_id, seq);
CREATE INDEX ledger_seq_idx ON ledger_events(ws_id, seq DESC);
CREATE INDEX ledger_po_line_idx ON ledger_events(ws_id, po_line_id) WHERE po_line_id IS NOT NULL;
CREATE INDEX ledger_source_idx ON ledger_events(ws_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX ledger_reversal_idx ON ledger_events(ws_id, reversal_of_event_id) WHERE reversal_of_event_id IS NOT NULL;

-- 確定イベントの更新・削除を禁止（ワークスペース削除の CASCADE は許可）
CREATE FUNCTION ledger_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ledger_events is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = OLD.ws_id) THEN
    RAISE EXCEPTION 'ledger_events is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_events_no_update BEFORE UPDATE ON ledger_events FOR EACH ROW EXECUTE FUNCTION ledger_events_immutable();
CREATE TRIGGER ledger_events_no_delete BEFORE DELETE ON ledger_events FOR EACH ROW EXECUTE FUNCTION ledger_events_immutable();

-- 残高（集計キャッシュ）。負在庫と上限をDBでも守る。
CREATE TABLE balances (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id    uuid NOT NULL,
  location_id uuid NOT NULL,
  qty       bigint NOT NULL CHECK (qty >= 0 AND qty <= 1000000000),
  last_in_date date,
  last_out_date date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, sku_id, location_id),
  FOREIGN KEY (ws_id, sku_id) REFERENCES skus(ws_id, id),
  FOREIGN KEY (ws_id, location_id) REFERENCES locations(ws_id, id)
);
CREATE INDEX balances_loc_idx ON balances(ws_id, location_id);

-- CSV取込
CREATE TABLE import_batches (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('skus','locations','suppliers','initial_stock','po_drafts','movements')),
  file_hash text NOT NULL,
  file_name text NOT NULL DEFAULT '',
  encoding  text NOT NULL,
  mapping   jsonb NOT NULL,
  status    text NOT NULL CHECK (status IN ('preview','committed','discarded')),
  row_count integer NOT NULL,
  excluded_rows jsonb NOT NULL DEFAULT '[]',
  result    jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  PRIMARY KEY (ws_id, id)
);
CREATE UNIQUE INDEX import_committed_uq ON import_batches(ws_id, kind, file_hash) WHERE status = 'committed';

-- 帳票スナップショット
CREATE TABLE documents (
  ws_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id        uuid NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('po_sheet','stocktake_diff','labels')),
  ref_id    uuid,
  snapshot  jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ws_id, id)
);

-- 監査ログ（業務データ世代をまたいで残す）
CREATE TABLE audit_log (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ws_id     uuid,
  actor_user_id uuid,
  action    text NOT NULL,
  target    text NOT NULL DEFAULT '',
  detail    jsonb NOT NULL DEFAULT '{}',
  ok        boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_idx ON audit_log(tenant_id, created_at DESC);
