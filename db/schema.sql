-- Cloudflare D1 schema. Apply with:
--   npx wrangler d1 execute statement-converter --remote --file db/schema.sql
-- Every statement is idempotent so re-running it is safe.

-- ---------- feedback (public form + quick votes) ----------
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  kind       TEXT    NOT NULL,          -- idea | bug | bank_request | praise | other | conversion_ok | conversion_problem
  rating     INTEGER,
  message    TEXT    NOT NULL DEFAULT '',
  email      TEXT,
  page       TEXT,
  context    TEXT,                      -- JSON: conversion status and counts, never statement content
  ip_hash    TEXT,
  status     TEXT    NOT NULL DEFAULT 'new'  -- new | planned | done | wontfix
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);
CREATE INDEX IF NOT EXISTS feedback_ip ON feedback (ip_hash, created_at);

-- ---------- accounts ----------
CREATE TABLE IF NOT EXISTS teams (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL DEFAULT '',
  plan                   TEXT NOT NULL DEFAULT 'free',   -- free | pro | firm
  plan_status            TEXT NOT NULL DEFAULT 'active', -- active | trialing | past_due | canceled
  plan_source            TEXT NOT NULL DEFAULT 'web',    -- web | apple | google
  plan_interval          TEXT,                           -- month | year
  period_end             TEXT,
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT,
  revenuecat_app_user_id TEXT UNIQUE,
  brand_name             TEXT,
  brand_color            TEXT,
  brand_logo_url         TEXT,
  embed_key              TEXT UNIQUE,
  embed_origins          TEXT,                           -- comma-separated sites allowed to embed
  inbox_address          TEXT UNIQUE,                    -- local part for email import, e.g. "k3x9q2"
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  role       TEXT NOT NULL DEFAULT 'owner',              -- owner | member
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS users_team ON users (team_id);

CREATE TABLE IF NOT EXISTS login_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  link_hash   TEXT NOT NULL UNIQUE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  invite_team TEXT,                                      -- set when the code comes from a team invite
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes (email, created_at);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (team_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  client     TEXT NOT NULL DEFAULT 'web',                -- web | ios | android
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- ---------- usage and billing ----------
CREATE TABLE IF NOT EXISTS usage (
  team_id TEXT NOT NULL,
  period  TEXT NOT NULL,                                  -- YYYY-MM
  kind    TEXT NOT NULL,                                  -- statements | api_pages | ai_statements
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, period, kind)
);

CREATE TABLE IF NOT EXISTS billing_events (
  id          TEXT PRIMARY KEY,                           -- provider event id, for idempotency
  provider    TEXT NOT NULL,                              -- stripe | revenuecat
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------- API ----------
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id),
  name         TEXT NOT NULL DEFAULT '',
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_team ON api_keys (team_id);

-- ---------- categorization ----------
CREATE TABLE IF NOT EXISTS rules (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id),
  pattern    TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',            -- contains | regex
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (team_id, pattern, match_type)
);

-- ---------- integrations (QuickBooks, Xero, Dropbox, Google Drive) ----------
CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id),
  provider      TEXT NOT NULL,                            -- quickbooks | xero | dropbox | gdrive
  external_id   TEXT,                                     -- QuickBooks realm id, Xero tenant id, Drive folder id
  access_enc    TEXT NOT NULL,                            -- AES-GCM encrypted
  refresh_enc   TEXT,
  expires_at    TEXT,
  settings      TEXT NOT NULL DEFAULT '{}',               -- JSON: account mapping, folder paths
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (team_id, provider)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  verifier   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS folder_files (
  team_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  file_id      TEXT NOT NULL,
  status       TEXT NOT NULL,                             -- converted | failed
  detail       TEXT,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (team_id, provider, file_id)
);

CREATE TABLE IF NOT EXISTS pushes (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                              -- date|amount|description, stops double posting
  external_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (team_id, provider, fingerprint)
);

-- ---------- client portal ----------
CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  name        TEXT NOT NULL,
  email       TEXT,
  token_hash  TEXT NOT NULL UNIQUE,
  token_enc   TEXT NOT NULL,                              -- so the firm can copy the link again
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS clients_team ON clients (team_id);

CREATE TABLE IF NOT EXISTS client_uploads (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  r2_key      TEXT NOT NULL,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',                -- new | converted
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS uploads_team ON client_uploads (team_id, created_at);

-- ---------- email import ----------
CREATE TABLE IF NOT EXISTS email_jobs (
  sender_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS email_jobs_sender ON email_jobs (sender_hash, created_at);

-- ---------- rate limits (generic) ----------
CREATE TABLE IF NOT EXISTS rate_events (
  bucket     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS rate_events_bucket ON rate_events (bucket, created_at);
