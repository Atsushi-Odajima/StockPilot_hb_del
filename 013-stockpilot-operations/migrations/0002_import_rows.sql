-- CSV取込：正規化済み行の保持と、外部一意IDによる重複・衝突検出
ALTER TABLE import_batches ADD COLUMN rows jsonb NOT NULL DEFAULT '[]';
ALTER TABLE import_batches ADD COLUMN errors jsonb NOT NULL DEFAULT '[]';
ALTER TABLE import_batches ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE operations ADD COLUMN external_id text CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 100);
ALTER TABLE operations ADD COLUMN external_hash text;
CREATE UNIQUE INDEX operations_external_id_uq ON operations(ws_id, external_id) WHERE external_id IS NOT NULL;
ALTER TABLE operations ADD FOREIGN KEY (ws_id, import_id) REFERENCES import_batches(ws_id, id);
