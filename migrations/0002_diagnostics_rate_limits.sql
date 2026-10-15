-- Rate-limit state for the /api/diagnostics Sentry tunnel
-- (functions/api/diagnostics.ts). Shares the Pages D1 database with WebSub.
--
-- diagnostics_rate: one row per counting window. Per-IP buckets are keyed by an
-- HMAC of (secret, minute, IP), never the raw IP, and expire after two minutes;
-- the site-wide bucket is keyed by UTC date and expires after two days.
CREATE TABLE IF NOT EXISTS diagnostics_rate (
  bucket     TEXT    PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS diagnostics_rate_expires ON diagnostics_rate (expires_at);

-- diagnostics_backoff: upstream (GlitchTip) Retry-After / X-Sentry-Rate-Limits
-- deadlines per data category ("error", "transaction", or "*" for all), so the
-- proxy stops forwarding until the upstream says it may resume.
CREATE TABLE IF NOT EXISTS diagnostics_backoff (
  category TEXT    PRIMARY KEY,
  until    INTEGER NOT NULL
);
