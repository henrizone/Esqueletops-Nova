export const migrations = [{
  id: "001_initial",
  sql: `
CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT NOT NULL DEFAULT '', last_name TEXT,
  language_code TEXT, locale TEXT NOT NULL DEFAULT 'pt_BR', is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chats (
  telegram_id BIGINT PRIMARY KEY, type TEXT NOT NULL, title TEXT, username TEXT, locale TEXT NOT NULL DEFAULT 'pt_BR',
  media_auto BOOLEAN NOT NULL DEFAULT TRUE, media_caption BOOLEAN NOT NULL DEFAULT TRUE,
  media_errors BOOLEAN NOT NULL DEFAULT TRUE, delete_source BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS afk_status (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE, username TEXT,
  first_name TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'Ausente', since TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS disabled_commands (
  chat_id BIGINT NOT NULL REFERENCES chats(telegram_id) ON DELETE CASCADE, command TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(chat_id, command)
);
CREATE TABLE IF NOT EXISTS sticker_packs (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  pack_name TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('static','animated','video')), is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sticker_packs_default_per_format ON sticker_packs(user_id, format) WHERE is_default = TRUE;
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY, actor_id BIGINT, chat_id BIGINT, action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_username_idx ON users(LOWER(username));
CREATE INDEX IF NOT EXISTS chats_type_idx ON chats(type);
CREATE INDEX IF NOT EXISTS afk_since_idx ON afk_status(since);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
`}];
