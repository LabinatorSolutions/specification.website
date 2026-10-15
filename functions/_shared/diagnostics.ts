/**
 * Pure logic for the /api/diagnostics Sentry tunnel (functions/api/diagnostics.ts):
 * the fixed destination, envelope validation + rebuild, and upstream rate-limit
 * header parsing. No bindings here, so scripts/test-diagnostics.mjs can import
 * it straight into Node.
 */

import { scrubTelemetry } from "./telemetry-scrub";

/**
 * The one destination this proxy forwards to. The public key in a DSN is not a
 * secret (every browser SDK ships it); what keeps the proxy from being an open
 * relay is that neither host nor project can be chosen by the request.
 */
export const DIAGNOSTICS_DSN =
  "https://770f3173c6014c8a89c8ece6b93ea21e@errors.rondo.club/8";
export const DIAGNOSTICS_PUBLIC_KEY = "770f3173c6014c8a89c8ece6b93ea21e";
export const DIAGNOSTICS_UPSTREAM = "https://errors.rondo.club/api/8/envelope/";
export const DIAGNOSTICS_ORIGIN = "https://specification.website";

export const MAX_BODY_BYTES = 64 * 1024;
export const PER_IP_PER_MINUTE = 20;
export const SITE_PER_DAY = 2000;
export const UPSTREAM_TIMEOUT_MS = 3000;

export type ItemType = "event" | "transaction";
const ALLOWED_ITEM_TYPES = new Set<string>(["event", "transaction"]);

// Envelope header fields we pass on. Anything else is dropped.
const HEADER_FIELDS = ["event_id", "sent_at", "sdk", "trace"] as const;

export type EnvelopeResult =
  { ok: true; type: ItemType; body: string } | { ok: false; reason: string };

const NEWLINE = 0x0a;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isBlank(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b !== NEWLINE && b !== 0x0d && b !== 0x20 && b !== 0x09) return false;
  }
  return true;
}

/**
 * Validates a Sentry envelope and returns a rebuilt, scrubbed copy.
 *
 * Accepts exactly: an envelope header whose `dsn` is our project DSN, then one
 * item of type `event` or `transaction` with a JSON-object payload, then
 * nothing (a trailing newline is fine). Attachments, sessions, replays, client
 * reports, logs, profiles and multi-item envelopes are all refused.
 */
export function validateEnvelope(bytes: Uint8Array): EnvelopeResult {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_BODY_BYTES) return { ok: false, reason: "too large" };

  const headerEnd = bytes.indexOf(NEWLINE);
  if (headerEnd < 0) return { ok: false, reason: "no item" };
  const header = parseObject(bytes.subarray(0, headerEnd));
  if (!header) return { ok: false, reason: "bad envelope header" };
  if (header.dsn !== DIAGNOSTICS_DSN) return { ok: false, reason: "wrong dsn" };

  const itemStart = headerEnd + 1;
  const itemHeaderEnd = bytes.indexOf(NEWLINE, itemStart);
  if (itemHeaderEnd < 0) return { ok: false, reason: "no item payload" };
  const itemHeader = parseObject(bytes.subarray(itemStart, itemHeaderEnd));
  if (!itemHeader) return { ok: false, reason: "bad item header" };
  const type = itemHeader.type;
  if (typeof type !== "string" || !ALLOWED_ITEM_TYPES.has(type)) {
    return { ok: false, reason: "item type not allowed" };
  }

  const payloadStart = itemHeaderEnd + 1;
  let payloadEnd: number;
  if (itemHeader.length !== undefined) {
    const length = itemHeader.length;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
      return { ok: false, reason: "bad length" };
    }
    payloadEnd = payloadStart + length;
    if (payloadEnd > bytes.length) return { ok: false, reason: "truncated" };
  } else {
    const nl = bytes.indexOf(NEWLINE, payloadStart);
    payloadEnd = nl < 0 ? bytes.length : nl;
  }

  // Exactly one item: whatever follows the payload must be whitespace only.
  if (!isBlank(bytes.subarray(payloadEnd))) {
    return { ok: false, reason: "more than one item" };
  }

  const payload = parseObject(bytes.subarray(payloadStart, payloadEnd));
  if (!payload) return { ok: false, reason: "bad payload" };
  if (type === "transaction" && payload.type !== "transaction") {
    return { ok: false, reason: "payload type mismatch" };
  }
  // Error/message events carry no `type`; anything typed under `event` is
  // something else (a transaction, feedback, …) smuggled past the item check.
  if (type === "event" && payload.type !== undefined) {
    return { ok: false, reason: "payload type mismatch" };
  }

  const cleanHeader: Record<string, unknown> = {};
  for (const field of HEADER_FIELDS) {
    if (header[field] !== undefined) cleanHeader[field] = header[field];
  }
  // The DSN goes on after scrubbing: `key@host` looks like an e-mail address.
  const scrubbedHeader = {
    ...scrubTelemetry(cleanHeader),
    dsn: DIAGNOSTICS_DSN,
  };
  const cleanPayload = JSON.stringify(scrubTelemetry(payload));
  const body =
    JSON.stringify(scrubbedHeader) +
    "\n" +
    JSON.stringify({ type, length: encoder.encode(cleanPayload).length }) +
    "\n" +
    cleanPayload +
    "\n";
  return { ok: true, type: type as ItemType, body };
}

/** Sentry data category for an item type, as used in X-Sentry-Rate-Limits. */
export function categoryFor(type: ItemType): "error" | "transaction" {
  return type === "transaction" ? "transaction" : "error";
}

/**
 * Seconds to back off for `category` according to upstream response headers.
 * X-Sentry-Rate-Limits wins over Retry-After when present (Sentry's own SDK
 * order). Format: `<seconds>:<cat;cat|empty=all>:<scope>[:...]`, comma-separated.
 * Returns a map category → seconds, with "*" for all categories.
 */
export function parseUpstreamLimits(
  rateLimits: string | null,
  retryAfter: string | null,
  status: number,
  now: number = Date.now(),
): Map<string, number> {
  const out = new Map<string, number>();
  if (rateLimits) {
    for (const limit of rateLimits.trim().split(",")) {
      const [secondsRaw, categoriesRaw = ""] = limit.trim().split(":");
      const seconds = Number.parseInt(secondsRaw, 10);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      const categories = categoriesRaw.split(";").filter(Boolean);
      if (categories.length === 0) {
        out.set("*", Math.max(out.get("*") ?? 0, seconds));
      } else {
        for (const c of categories) {
          const key = c === "default" ? "error" : c;
          out.set(key, Math.max(out.get(key) ?? 0, seconds));
        }
      }
    }
    return out;
  }
  if (status === 429) {
    let seconds = 60;
    if (retryAfter) {
      const asNumber = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(asNumber) && String(asNumber) === retryAfter.trim()) {
        seconds = asNumber;
      } else {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) seconds = Math.ceil((date - now) / 1000);
      }
    }
    if (seconds > 0) out.set("*", Math.min(seconds, 86400));
  }
  return out;
}
