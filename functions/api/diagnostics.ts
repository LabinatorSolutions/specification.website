/**
 * /api/diagnostics — same-origin Sentry tunnel to GlitchTip.
 *
 * The browser SDK (public/vendor/diagnostics.js) posts envelopes here instead
 * of to errors.rondo.club, so the page needs no third-party connect-src and the
 * visitor's IP never reaches the error tracker. This function forwards each
 * accepted envelope to one fixed GlitchTip project and nothing else.
 *
 * Guards, in order: kill switch → POST only → exact Origin → per-IP rate limit
 * → 64 KB body cap → envelope validation (our DSN, one event or transaction) →
 * upstream backoff → site-wide daily cap → forward (3 s, no redirects).
 *
 * Rate-limit state lives in D1 (strongly consistent, unlike KV). Per-IP rows are
 * keyed by an HMAC of the IP with DIAGNOSTICS_HASH_SECRET and the current
 * minute, so no raw IP is stored and rows expire within two minutes. If D1 or
 * the secret is unavailable the proxy refuses (503) rather than forwarding
 * unmetered.
 *
 * Kill switch: forwarding only happens when the DIAGNOSTICS_ENABLED Pages
 * secret is exactly "true". Change it and redeploy to toggle. The browser
 * script itself is switched by `site.diagnostics.enabled` (src/lib/site.ts).
 *
 * This route carries no Sentry instrumentation of its own, and the browser SDK
 * neither traces nor breadcrumbs requests to it, so a failing tunnel cannot
 * report on itself in a loop.
 */

import {
  DIAGNOSTICS_ORIGIN,
  DIAGNOSTICS_PUBLIC_KEY,
  DIAGNOSTICS_UPSTREAM,
  MAX_BODY_BYTES,
  PER_IP_PER_MINUTE,
  SITE_PER_DAY,
  UPSTREAM_TIMEOUT_MS,
  categoryFor,
  parseUpstreamLimits,
  validateEnvelope,
} from "../_shared/diagnostics";

type Env = {
  WEBSUB_DB?: D1Database;
  DIAGNOSTICS_ENABLED?: string;
  DIAGNOSTICS_HASH_SECRET?: string;
};

function reply(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...extra },
  });
}

// Tells the SDK to stop sending everything for `seconds` (all categories).
function backoff(status: number, seconds: number): Response {
  const s = String(Math.max(1, Math.ceil(seconds)));
  return reply(status, {
    "Retry-After": s,
    "X-Sentry-Rate-Limits": `${s}::organization`,
  });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function increment(
  db: D1Database,
  bucket: string,
  expiresAt: number,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO diagnostics_rate (bucket, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, expiresAt)
    .first<{ count: number }>();
  if (!row || typeof row.count !== "number") throw new Error("no count");
  return row.count;
}

// Reads the body with a hard byte cap, independent of Content-Length.
async function readCapped(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export const onRequest: PagesFunction<Env> = async ({
  request,
  env,
  waitUntil,
}) => {
  if (env.DIAGNOSTICS_ENABLED !== "true") return backoff(503, 3600);

  if (request.method !== "POST") return reply(405, { Allow: "POST" });
  if (request.headers.get("Origin") !== DIAGNOSTICS_ORIGIN) return reply(403);

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return reply(413);

  const db = env.WEBSUB_DB;
  const secret = env.DIAGNOSTICS_HASH_SECRET;
  const ip = request.headers.get("CF-Connecting-IP");
  if (!db || !secret || secret.length < 32) return reply(503);
  if (!ip) return reply(403);

  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const minute = Math.floor(now / 60);

  // Per-IP limit, counted for every request from an allowed Origin.
  try {
    const ipBucket = `ip:${await hmacHex(secret, `${minute}\n${ip}`)}`;
    const count = await increment(db, ipBucket, (minute + 2) * 60);
    if (count > PER_IP_PER_MINUTE) return backoff(429, (minute + 1) * 60 - now);
  } catch {
    return reply(503);
  }

  const bytes = await readCapped(request);
  if (!bytes) return reply(413);
  const envelope = validateEnvelope(bytes);
  if (!envelope.ok) return reply(400);
  const category = categoryFor(envelope.type);

  try {
    // Upstream asked us to back off: honour it without contacting GlitchTip.
    const blocked = await db
      .prepare(
        `SELECT MAX(until) AS until FROM diagnostics_backoff
         WHERE category IN ('*', ?1) AND until > ?2`,
      )
      .bind(category, now)
      .first<{ until: number | null }>();
    if (blocked?.until) return backoff(429, blocked.until - now);

    // Site-wide daily cap, counted only for envelopes we would forward.
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const dayEnd = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86400;
    const count = await increment(db, `day:${day}`, dayEnd + 86400);
    if (count > SITE_PER_DAY) return backoff(429, dayEnd - now);
  } catch {
    return reply(503);
  }

  // Opportunistic cleanup of expired rows; never blocks the response.
  if (Math.random() < 0.05) {
    waitUntil(
      db
        .batch([
          db
            .prepare(`DELETE FROM diagnostics_rate WHERE expires_at < ?1`)
            .bind(now),
          db
            .prepare(`DELETE FROM diagnostics_backoff WHERE until < ?1`)
            .bind(now),
        ])
        .catch(() => {}),
    );
  }

  // Fresh request: none of the browser's headers (cookies, auth, UA, IP) go on.
  let upstream: Response;
  try {
    upstream = await fetch(DIAGNOSTICS_UPSTREAM, {
      method: "POST",
      body: envelope.body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${DIAGNOSTICS_PUBLIC_KEY}, sentry_client=specification-website-tunnel/1.0`,
      },
    });
  } catch {
    return reply(502);
  }
  // Discard the upstream body; it never reaches the browser.
  upstream.body?.cancel().catch(() => {});

  const rateLimits = upstream.headers.get("X-Sentry-Rate-Limits");
  const retryAfter = upstream.headers.get("Retry-After");
  const limits = parseUpstreamLimits(
    rateLimits,
    retryAfter,
    upstream.status,
    nowMs,
  );
  if (limits.size > 0) {
    waitUntil(
      db
        .batch(
          [...limits].map(([cat, seconds]) =>
            db
              .prepare(
                `INSERT INTO diagnostics_backoff (category, until) VALUES (?1, ?2)
                 ON CONFLICT(category) DO UPDATE SET until = MAX(until, excluded.until)`,
              )
              .bind(cat, now + seconds),
          ),
        )
        .catch(() => {}),
    );
  }

  const relay: Record<string, string> = {};
  if (rateLimits) relay["X-Sentry-Rate-Limits"] = rateLimits;
  if (retryAfter) relay["Retry-After"] = retryAfter;

  if (upstream.status >= 200 && upstream.status < 300) return reply(200, relay);
  if (upstream.status === 429) return reply(429, relay);
  return reply(502, relay);
};
