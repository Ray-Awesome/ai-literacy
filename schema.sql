CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  birth_date        TEXT    NOT NULL,
  is_minor          INTEGER NOT NULL DEFAULT 0,
  guardian_name     TEXT,
  guardian_relation TEXT,
  guardian_contact  TEXT,
  agreed_terms      INTEGER NOT NULL DEFAULT 0,
  agreed_privacy    INTEGER NOT NULL DEFAULT 0,
  guardian_consent  INTEGER NOT NULL DEFAULT 0,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  item_key    TEXT    NOT NULL,
  prompt      TEXT,
  answer      TEXT    NOT NULL,
  page_url    TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, item_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);
