-- 0001_init.sql — Family tree schema for Cloudflare D1 (SQLite)
-- Apply with:  npx wrangler d1 migrations apply family-tree-db --remote
-- (or paste this whole file into the D1 "Console" tab in the Cloudflare dashboard)
--
-- Notes
-- * Dates are stored as ISO Gregorian 'YYYY-MM-DD' (first day of the known
--   period) + precision (y/m/d) + input calendar (g = Gregorian, j = Jalali).
-- * Each person exists exactly ONCE. Spouses that are also blood relatives
--   (e.g. cousin marriages) are drawn in several places from the same row.
-- * Referential integrity is enforced by the API (no SQL FOREIGN KEYs) so
--   backups can be restored in any order.

CREATE TABLE IF NOT EXISTS persons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name   TEXT    NOT NULL,
  father_name  TEXT    NOT NULL DEFAULT '',
  family_name  TEXT    NOT NULL DEFAULT '',
  gender       TEXT    NOT NULL CHECK (gender IN ('m', 'f')),
  birth_date   TEXT,
  birth_prec   TEXT    CHECK (birth_prec IN ('y', 'm', 'd')),
  birth_cal    TEXT    CHECK (birth_cal IN ('g', 'j')),
  is_deceased  INTEGER NOT NULL DEFAULT 0 CHECK (is_deceased IN (0, 1)),
  death_date   TEXT,
  death_prec   TEXT    CHECK (death_prec IN ('y', 'm', 'd')),
  death_cal    TEXT    CHECK (death_cal IN ('g', 'j')),
  birth_place  TEXT    NOT NULL DEFAULT '',
  occupation   TEXT    NOT NULL DEFAULT '',
  phone        TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  father_id    INTEGER,
  mother_id    INTEGER,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  has_photo    INTEGER NOT NULL DEFAULT 0,
  photo_ver    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_persons_father ON persons (father_id);
CREATE INDEX IF NOT EXISTS idx_persons_mother ON persons (mother_id);

CREATE TABLE IF NOT EXISTS marriages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  husband_id     INTEGER NOT NULL,
  wife_id        INTEGER NOT NULL,
  marriage_date  TEXT,
  marriage_prec  TEXT CHECK (marriage_prec IN ('y', 'm', 'd')),
  marriage_cal   TEXT CHECK (marriage_cal IN ('g', 'j')),
  status         TEXT NOT NULL DEFAULT 'married' CHECK (status IN ('married', 'divorced')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (husband_id, wife_id)
);
CREATE INDEX IF NOT EXISTS idx_marriages_wife ON marriages (wife_id);

-- Photos: base64 WebP/JPEG (~100 KB), one per person.
CREATE TABLE IF NOT EXISTS photos (
  person_id   INTEGER PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Key/value settings: password_hash, password_ver, session_secret, data_version, site_title
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Login rate limiting (per IP, fixed 15-minute window)
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('data_version', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('password_ver', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'شجرة العائلة');
