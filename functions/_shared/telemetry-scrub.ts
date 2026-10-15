/**
 * Telemetry scrubber shared by the browser SDK (public/vendor/diagnostics.js,
 * bundled from src/diagnostics/client.ts) and the /api/diagnostics proxy.
 *
 * Runs twice on purpose: once in the browser's beforeSend hooks, so nothing
 * personal leaves the visitor's machine, and again in the proxy, so a client
 * that skips the SDK (or an old cached bundle) still cannot push personal data
 * into GlitchTip.
 *
 * Removes: the user object (incl. IP), request cookies, body and query string,
 * every header except User-Agent (kept so errors can be triaged by browser),
 * every URL query string and fragment anywhere in the payload, and e-mail
 * addresses inside any string.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// Keys that never survive, wherever they appear.
const DROP_KEYS = new Set([
  "user",
  "cookies",
  "cookie",
  "query_string",
  "http.query",
  "http.fragment",
  "url.query",
  "url.fragment",
  "authorization",
  "set-cookie",
  "client.address",
  "user_agent.original",
]);

// `request.data` is the request body; elsewhere `data` (breadcrumb, span) is
// structured metadata that we keep but scrub.
const DROP_REQUEST_KEYS = new Set(["data", "env"]);

// Absolute or root-relative URL followed by a query string and/or fragment.
const URL_WITH_QUERY =
  /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function scrubString(value: string): string {
  return value.replace(URL_WITH_QUERY, "$1").replace(EMAIL, "[email]");
}

function scrubValue(value: Json, parentKey: string, depth: number): Json {
  if (depth > 32) return null;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, parentKey, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (DROP_KEYS.has(lower)) continue;
      if (parentKey === "request" && DROP_REQUEST_KEYS.has(lower)) continue;
      if (lower === "headers") {
        const ua =
          parentKey === "request" &&
          child &&
          typeof child === "object" &&
          !Array.isArray(child)
            ? Object.entries(child).find(
                ([h]) => h.toLowerCase() === "user-agent",
              )
            : undefined;
        if (ua && typeof ua[1] === "string") out[key] = { "User-Agent": ua[1] };
        continue;
      }
      out[key] = scrubValue(child, lower, depth + 1);
    }
    return out;
  }
  return value;
}

/** Returns a scrubbed deep copy. The input is not modified. */
export function scrubTelemetry<T>(payload: T): T {
  return scrubValue(payload as unknown as Json, "", 0) as unknown as T;
}
