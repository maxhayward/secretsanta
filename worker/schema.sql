CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings (key, value) VALUES ('phase', 'register');

-- Household names are seeded directly in D1 so they stay out of this public repo.
CREATE TABLE IF NOT EXISTS households (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  household TEXT NOT NULL,
  household_key TEXT NOT NULL,
  password TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  is_organiser INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  giver_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_key_at ON attempts (key, at);
