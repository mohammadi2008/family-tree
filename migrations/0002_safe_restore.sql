-- Staging is isolated from live data until atomic replacement.
CREATE TABLE IF NOT EXISTS import_sessions (
  token TEXT PRIMARY KEY,
  base_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','validating','committing','done')),
  site_title TEXT NOT NULL,
  whatsapp_number TEXT NOT NULL DEFAULT '',
  persons_count INTEGER NOT NULL,
  marriages_count INTEGER NOT NULL,
  photos_count INTEGER NOT NULL,
  photo_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_rows (
  token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('persons','marriages','photos')),
  row_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (token, kind, row_key)
);
CREATE INDEX IF NOT EXISTS idx_import_expiry ON import_sessions (expires_at);

-- At-most-once create reservations. Completed responses can be replayed after
-- a lost connection; ambiguous pending writes are NOT blindly executed again.
CREATE TABLE IF NOT EXISTS write_requests (
  request_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','done')),
  response_status INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL
);
