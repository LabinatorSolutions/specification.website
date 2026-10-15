// Assertions for the /api/diagnostics Sentry tunnel.
//
// Run with: npm run test:diagnostics
//
// Part 1 (always): the pure envelope validator, scrubber and upstream
// rate-limit parser from functions/_shared/, bundled on the fly with esbuild
// because they import each other without file extensions.
//
// Part 2 (when DIAGNOSTICS_BASE_URL is set, e.g. http://localhost:8788 from
// `wrangler pages dev dist`): HTTP behaviour of the live function: method,
// Origin, size, payload validation, per-IP limit, daily cap and fail-closed
// paths. Valid envelopes in part 2 really are forwarded to GlitchTip, so it
// sends only two, tagged `test`.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "diagnostics-test-"));
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(process.cwd(), "functions/_shared/diagnostics.ts"))};
   export * from ${JSON.stringify(join(process.cwd(), "functions/_shared/telemetry-scrub.ts"))};`,
);
const outfile = join(dir, "bundle.mjs");
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  logLevel: "error",
});
const {
  DIAGNOSTICS_DSN,
  MAX_BODY_BYTES,
  validateEnvelope,
  parseUpstreamLimits,
  scrubTelemetry,
} = await import(pathToFileURL(outfile).href);

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  ok    ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}

const enc = new TextEncoder();
const id = () => crypto.randomUUID().replaceAll("-", "");
const header = (extra = {}) =>
  JSON.stringify({
    event_id: id(),
    dsn: DIAGNOSTICS_DSN,
    sent_at: new Date().toISOString(),
    ...extra,
  });

export function errorEnvelope(
  message = "test error",
  { withLength = false } = {},
) {
  const payload = JSON.stringify({
    event_id: id(),
    platform: "javascript",
    environment: "test",
    tags: { test: "true" },
    timestamp: Date.now() / 1000,
    exception: { values: [{ type: "Error", value: message }] },
    request: {
      url: "https://specification.website/search/?q=secret#frag",
      headers: {
        "User-Agent": "test-agent",
        Cookie: "a=b",
        Authorization: "Bearer x",
      },
      cookies: { a: "b" },
      data: "body",
      query_string: "q=secret",
    },
    user: { ip_address: "203.0.113.9", email: "a@b.example" },
    breadcrumbs: [
      {
        category: "navigation",
        data: { from: "/a?x=1", to: "/b?mail=a@b.example" },
      },
    ],
  });
  const itemHeader = withLength
    ? JSON.stringify({ type: "event", length: enc.encode(payload).length })
    : JSON.stringify({ type: "event" });
  return `${header()}\n${itemHeader}\n${payload}\n`;
}

export function transactionEnvelope(name = "/test-transaction") {
  const now = Date.now() / 1000;
  const traceId = id();
  const payload = JSON.stringify({
    type: "transaction",
    event_id: id(),
    platform: "javascript",
    environment: "test",
    tags: { test: "true" },
    transaction: name,
    start_timestamp: now - 1,
    timestamp: now,
    contexts: {
      trace: { trace_id: traceId, span_id: id().slice(0, 16), op: "pageload" },
    },
    spans: [],
  });
  return `${header({ trace: { trace_id: traceId, public_key: DIAGNOSTICS_DSN.split("//")[1].split("@")[0] } })}\n${JSON.stringify({ type: "transaction" })}\n${payload}\n`;
}

console.log("validateEnvelope");
check("accepts an error event and scrubs it", () => {
  const r = validateEnvelope(enc.encode(errorEnvelope()));
  assert.equal(r.ok, true);
  assert.equal(r.type, "event");
  const payload = JSON.parse(r.body.split("\n")[2]);
  assert.equal(payload.user, undefined);
  assert.equal(payload.request.url, "https://specification.website/search/");
  assert.deepEqual(payload.request.headers, { "User-Agent": "test-agent" });
  assert.equal(payload.request.cookies, undefined);
  assert.equal(payload.request.data, undefined);
  assert.equal(payload.request.query_string, undefined);
  assert.equal(payload.breadcrumbs[0].data.from, "/a");
  assert.equal(payload.breadcrumbs[0].data.to, "/b");
});
check("accepts an item with explicit length", () => {
  assert.equal(
    validateEnvelope(enc.encode(errorEnvelope("x", { withLength: true }))).ok,
    true,
  );
});
check("accepts a transaction", () => {
  const r = validateEnvelope(enc.encode(transactionEnvelope()));
  assert.equal(r.ok, true);
  assert.equal(r.type, "transaction");
});
check("rebuilt envelope carries a correct byte length", () => {
  const r = validateEnvelope(enc.encode(errorEnvelope("é unicode ✓")));
  const [, itemHeader, payload] = r.body.split("\n");
  assert.equal(JSON.parse(itemHeader).length, enc.encode(payload).length);
});
const reject = (label, body) =>
  check(`rejects ${label}`, () =>
    assert.equal(validateEnvelope(enc.encode(body)).ok, false),
  );
reject("empty body", "");
reject("garbage", "not an envelope at all");
reject("JSON array header", `[]\n{"type":"event"}\n{}\n`);
reject(
  "a different DSN",
  errorEnvelope().replace(DIAGNOSTICS_DSN, "https://abc@errors.rondo.club/1"),
);
reject(
  "another host",
  errorEnvelope().replace("errors.rondo.club", "evil.example"),
);
reject("a missing DSN", `{"event_id":"x"}\n{"type":"event"}\n{}\n`);
reject("two items", errorEnvelope() + `{"type":"event"}\n{}\n`);
reject("an attachment", `${header()}\n{"type":"attachment","length":2}\nhi\n`);
reject("a session", `${header()}\n{"type":"session"}\n{"sid":"x"}\n`);
reject("sessions", `${header()}\n{"type":"sessions"}\n{"aggregates":[]}\n`);
reject("a replay", `${header()}\n{"type":"replay_event"}\n{}\n`);
reject("a client report", `${header()}\n{"type":"client_report"}\n{}\n`);
reject(
  "a transaction disguised as event",
  `${header()}\n{"type":"event"}\n{"type":"transaction"}\n`,
);
reject("a non-JSON payload", `${header()}\n{"type":"event"}\nnope\n`);
reject(
  "a truncated length",
  `${header()}\n{"type":"event","length":999}\n{}\n`,
);
reject(
  "an oversized body",
  `${header()}\n{"type":"event"}\n{"x":"${"a".repeat(MAX_BODY_BYTES)}"}\n`,
);

console.log("scrubTelemetry");
check("strips query strings and e-mails in nested strings", () => {
  const out = scrubTelemetry({
    message: "failed GET https://x.example/a?token=1 for me@x.example",
    spans: [{ description: "GET /api?x=1" }],
  });
  assert.equal(out.message, "failed GET https://x.example/a for [email]");
  assert.equal(out.spans[0].description, "GET /api");
});

console.log("parseUpstreamLimits");
check("reads X-Sentry-Rate-Limits categories", () => {
  const m = parseUpstreamLimits(
    "60:transaction:key, 2700:default;error;security:organization",
    null,
    200,
  );
  assert.equal(m.get("transaction"), 60);
  assert.equal(m.get("error"), 2700);
});
check("empty category list means all", () => {
  assert.equal(
    parseUpstreamLimits("120::organization", null, 429).get("*"),
    120,
  );
});
check("falls back to Retry-After on 429", () => {
  assert.equal(parseUpstreamLimits(null, "30", 429).get("*"), 30);
});
check("ignores Retry-After on success", () => {
  assert.equal(parseUpstreamLimits(null, "30", 200).size, 0);
});

const base = process.env.DIAGNOSTICS_BASE_URL;
if (base) {
  console.log(`HTTP against ${base}`);
  const url = `${base}/api/diagnostics`;
  const ORIGIN = "https://specification.website";
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      body,
      headers: { Origin: ORIGIN, "Content-Type": "text/plain", ...headers },
    });

  if (process.env.DIAGNOSTICS_EXPECT === "closed") {
    await checkAsync(
      "fails closed (503) without rate-limit storage",
      async () => {
        const r = await post(errorEnvelope("must not arrive"));
        assert.equal(r.status, 503);
      },
    );
  } else {
    await checkAsync("GET is 405", async () =>
      assert.equal((await fetch(url)).status, 405),
    );
    await checkAsync("foreign Origin is 403", async () =>
      assert.equal(
        (await post(errorEnvelope(), { Origin: "https://evil.example" }))
          .status,
        403,
      ),
    );
    await checkAsync("missing Origin is 403", async () => {
      const r = await fetch(url, { method: "POST", body: errorEnvelope() });
      assert.equal(r.status, 403);
    });
    await checkAsync("invalid payload is 400", async () =>
      assert.equal((await post("garbage")).status, 400),
    );
    await checkAsync("attachment is 400", async () =>
      assert.equal(
        (await post(`${header()}\n{"type":"attachment","length":2}\nhi\n`))
          .status,
        400,
      ),
    );
    await checkAsync("over 64 KB is 413", async () =>
      assert.equal((await post("a".repeat(MAX_BODY_BYTES + 1))).status, 413),
    );
    await checkAsync(
      "valid error event is forwarded (200), body empty",
      async () => {
        const r = await post(
          errorEnvelope("specification.website tunnel test error"),
        );
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "");
      },
    );
    await checkAsync("valid transaction is forwarded (200)", async () =>
      assert.equal(
        (await post(transactionEnvelope("/tunnel-test-transaction"))).status,
        200,
      ),
    );
    await checkAsync(
      "per-IP limit: request 21 in a minute is 429 with Retry-After",
      async () => {
        // Seven requests so far this minute (the 405 above was before the
        // counter). Pad to 20 with invalid bodies, which count but are not sent.
        let last;
        for (let i = 0; i < 20; i++) last = await post("garbage");
        assert.equal(last.status, 429);
        assert.ok(Number(last.headers.get("Retry-After")) > 0);
        assert.ok(last.headers.get("X-Sentry-Rate-Limits"));
      },
    );
  }
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
