/**
 * Browser error + performance telemetry for specification.website.
 *
 * Bundled by scripts/generate-assets.mjs into public/vendor/diagnostics.js
 * (self-hosted, script-src 'self', SRI-pinned in BaseLayout.astro) and loaded
 * in production only. Everything goes to the same-origin /api/diagnostics
 * tunnel, which forwards to GlitchTip; the browser never talks to the error
 * tracker directly.
 *
 * Privacy: dataCollection switched off (user, cookies, bodies, query
 * strings, all headers but User-Agent), no sessions, no replays, no client reports.
 * Every event, transaction and breadcrumb is scrubbed of user data, cookies,
 * headers, request bodies and query strings before it leaves the page (the
 * proxy scrubs again).
 */

import {
  browserTracingIntegration,
  init,
  type Breadcrumb,
  type Event,
} from "@sentry/browser";
import {
  DIAGNOSTICS_DSN,
  DIAGNOSTICS_ORIGIN,
} from "../../functions/_shared/diagnostics";
import { scrubTelemetry } from "../../functions/_shared/telemetry-scrub";

const TUNNEL = "/api/diagnostics";

// Integrations that would send something the tunnel refuses or we don't want.
const DROPPED = new Set(["BrowserSession"]);

function isTunnelUrl(url: unknown): boolean {
  return typeof url === "string" && url.includes(TUNNEL);
}

function scrubEvent<T extends Event>(event: T): T | null {
  // Never report on the tunnel itself.
  if (isTunnelUrl(event.request?.url)) return null;
  return scrubTelemetry(event);
}

if (location.origin === DIAGNOSTICS_ORIGIN) {
  init({
    dsn: DIAGNOSTICS_DSN,
    tunnel: TUNNEL,
    environment: "production",
    // Sentry 11 collects all of these by default; opt out at the source.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["user-agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
    },
    sendClientReports: false,
    // Required by this GlitchTip install for Sentry JS 11: classic
    // transactions instead of span streaming.
    traceLifecycle: "static",
    tracesSampleRate: 0.001,
    // No sentry-trace / baggage headers on any outgoing request.
    tracePropagationTargets: [],
    integrations: (defaults) => [
      ...defaults.filter((i) => !DROPPED.has(i.name)),
      browserTracingIntegration({
        shouldCreateSpanForRequest: (url) => !isTunnelUrl(url),
      }),
    ],
    beforeBreadcrumb(breadcrumb: Breadcrumb) {
      if (isTunnelUrl(breadcrumb.data?.url)) return null;
      return scrubTelemetry(breadcrumb);
    },
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction(event) {
      const spans = event.spans?.filter(
        (s) =>
          !isTunnelUrl(s.description) && !isTunnelUrl(s.data?.["http.url"]),
      );
      return scrubEvent({ ...event, spans });
    },
  });
}
