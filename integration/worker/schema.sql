-- Kush Collective · Lightspeed connection service (Cloudflare D1)
-- Safe to run repeatedly.

-- One row only: the store's connection. Tokens are AES-GCM encrypted before they are stored.
CREATE TABLE IF NOT EXISTS connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT 'disconnected',   -- disconnected | connected | reauth_required
  domain_prefix TEXT,
  access_enc TEXT,
  refresh_enc TEXT,
  expires_at INTEGER,                           -- unix seconds
  requested_scope TEXT,
  granted_scope TEXT,
  retailer_name TEXT,
  outlets_json TEXT,
  connected_at TEXT,
  last_refresh_at TEXT,
  last_check_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  refreshing_until INTEGER
);

-- Single-use OAuth state values (CSRF protection), valid for 10 minutes.
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Connection audit trail. Never contains tokens.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);

-- Failed manager sign-ins, for rate limiting.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- Mock Lightspeed (development only).
CREATE TABLE IF NOT EXISTS mock_codes (
  code TEXT PRIMARY KEY,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mock_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- access | refresh
  scope TEXT,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
