CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO app_state (id, data, updated_at)
VALUES (
  1,
  '{"users":{},"receipts":{},"households":{},"expenses":{},"settlements":{},"tokens":{}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL CHECK (json_valid(sess) AND json_type(sess) = 'object'),
  expire INTEGER NOT NULL CHECK (expire > 0),
  user_key TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);
CREATE INDEX IF NOT EXISTS user_sessions_user_key_idx ON user_sessions (user_key);
