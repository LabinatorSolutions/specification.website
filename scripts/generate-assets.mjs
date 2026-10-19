// Generate raster icons + Open Graph images from inline SVGs at build time.
// Output goes into ./public so favicons and OG sit at predictable URLs.
//
// Per-page OG images for spec entries land at /og/spec/<category>/<slug>.png,
// per-category OG images at /og/spec/<category>.png, and the homepage default
// at /og-default.png.
import sharp from "sharp";
import { renderOgCard } from "./og-card.mjs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "public");
const ogOut = join(out, "og", "spec");
const contentRoot = join(root, "src/content/spec");
await mkdir(out, { recursive: true });
await mkdir(ogOut, { recursive: true });

const accent = "#15803d"; // green-700 — base

// Category metadata — kept in sync with src/lib/site.ts. This script is a
// pure node module run before Astro, so we can't import the TS module.
const CATEGORIES = {
  foundations: {
    title: "Foundations",
    summary: "The HTML, head, and document basics every page needs.",
  },
  seo: {
    title: "SEO",
    summary:
      "Search visibility — robots.txt, sitemaps, canonicals, structured data.",
  },
  accessibility: {
    title: "Accessibility",
    summary: "WCAG-aligned rules so people of all abilities can use the site.",
  },
  security: {
    title: "Security",
    summary: "Headers, transport, and policies that keep visitors safe.",
  },
  "well-known": {
    title: "Well-Known URIs",
    summary: "Standard, agreed-upon paths under /.well-known/.",
  },
  "agent-readiness": {
    title: "Agent Readiness",
    summary: "Things that make a site legible to AI agents and crawlers.",
  },
  performance: {
    title: "Performance",
    summary: "Core Web Vitals, caching, images, fonts, network behaviour.",
  },
  privacy: {
    title: "Privacy",
    summary: "Consent, signals, and respecting visitor choice.",
  },
  resilience: {
    title: "Resilience",
    summary: "Graceful failure — error pages, offline, redirects.",
  },
  i18n: {
    title: "Internationalisation",
    summary: "Language, locale, direction, and translated content.",
  },
};

const STATUS_LABEL = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
  avoid: "Avoid",
};
// The mark: a W whose final upstroke shoots past cap height to form a
// checkmark tail. Single stroked path, round caps & joins for a clean
// icon read. Path is on a 0..64 grid and scaled per size.
const WCheck = (cx, cy, scale, stroke) => {
  const pt = (x, y) => `${cx + (x - 32) * scale},${cy + (y - 32) * scale}`;
  const d = [
    `M${pt(12, 26)}`,
    `L${pt(22, 46)}`,
    `L${pt(30, 31)}`,
    `L${pt(38, 46)}`,
    `L${pt(52, 18)}`,
  ].join(" ");
  return `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
};

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img">
  <rect width="512" height="512" rx="96" fill="${accent}"/>
  ${WCheck(256, 256, 7.5, 48)}
</svg>`;

// Maskable: per W3C maskable spec, the mark must fit inside an inscribed
// circle of ~80% diameter, leaving safe zone for launcher masks.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img">
  <rect width="512" height="512" fill="${accent}"/>
  ${WCheck(256, 256, 5, 36)}
</svg>`;

// ---- Field-guide Open Graph templates (1200×675) ----
function homepageCard(topicCount) {
  return {
    home: true,
    summary:
      "A field guide to the technical details that matter. For humans and agents.",
    footnote: `${topicCount} topics · ${Object.keys(CATEGORIES).length} areas`,
  };
}
function specPageCard({ title, summary, category, status }) {
  return {
    title,
    summary,
    label: CATEGORIES[category]?.title || category,
    footnote: STATUS_LABEL[status] || status,
  };
}
function pageCard({ eyebrow, title, subtitle, footnote }) {
  return { title, summary: subtitle, label: eyebrow, footnote };
}
function categoryCard({ category, count }) {
  const cat = CATEGORIES[category] || { title: category, summary: "" };
  return {
    title: cat.title,
    summary: cat.summary,
    label: `${count} topics in this category`,
  };
}

// ---- Frontmatter loader ----
// Reads our spec frontmatter shape — single-line string keys (title, slug,
// category, summary, status, draft). We don't need a full YAML parser; the
// schema is enforced by Astro's content config so the inputs are predictable.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    let val = rawVal.trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      try {
        val = JSON.parse(val);
      } catch {
        val = val.slice(1, -1);
      }
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function loadAllSpecs() {
  const specs = [];
  let dirs;
  try {
    dirs = await readdir(contentRoot, { withFileTypes: true });
  } catch {
    return specs;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const catDir = join(contentRoot, d.name);
    const files = await readdir(catDir);
    for (const file of files) {
      if (!/\.mdx?$/.test(file)) continue;
      const text = await readFile(join(catDir, file), "utf8");
      const fm = parseFrontmatter(text);
      if (!fm) continue;
      if (fm.draft === "true" || fm.draft === true) continue;
      const slug = fm.slug || file.replace(/\.mdx?$/, "");
      specs.push({
        slug,
        category: fm.category || d.name,
        title: fm.title || slug,
        summary: fm.summary || "",
        status: fm.status || "recommended",
      });
    }
  }
  return specs;
}

// ---- Rendering helpers ----

async function png(svg, size, file) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(join(out, file));
  console.log(`  wrote /${file} (${size}×${size})`);
}

async function ogPng(card, file) {
  await writeFile(join(out, file), await renderOgCard(card));
}

// ---- Run ----

console.log("Generating assets…");
await png(iconSvg, 192, "icon-192.png");
await png(iconSvg, 512, "icon-512.png");
await png(maskableSvg, 512, "icon-maskable-512.png");
await png(iconSvg, 180, "apple-touch-icon.png");

// ICO: 16×16 + 32×32 PNGs packed by sharp.
const ico16 = await sharp(Buffer.from(iconSvg)).resize(16, 16).png().toBuffer();
const ico32 = await sharp(Buffer.from(iconSvg)).resize(32, 32).png().toBuffer();
function ico(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((buf, i) => {
    const sz = i === 0 ? 16 : 32;
    const off = 6 + i * 16;
    dir.writeUInt8(sz === 256 ? 0 : sz, off + 0);
    dir.writeUInt8(sz === 256 ? 0 : sz, off + 1);
    dir.writeUInt8(0, off + 2);
    dir.writeUInt8(0, off + 3);
    dir.writeUInt16LE(1, off + 4);
    dir.writeUInt16LE(32, off + 6);
    dir.writeUInt32LE(buf.length, off + 8);
    dir.writeUInt32LE(offset, off + 12);
    offset += buf.length;
  });
  return Buffer.concat([dir, ...images]);
}
await writeFile(join(out, "favicon.ico"), ico([ico16, ico32]));
console.log("  wrote /favicon.ico (16+32)");

// OG images
const specs = await loadAllSpecs();
console.log(`  found ${specs.length} spec entries`);

await ogPng(homepageCard(specs.length), "og-default.png");
console.log("  wrote /og-default.png (homepage, 1200×675)");

// Per-category
const byCategory = {};
for (const s of specs) (byCategory[s.category] ||= []).push(s);

for (const cat of Object.keys(CATEGORIES)) {
  const count = (byCategory[cat] || []).length;
  await ogPng(
    categoryCard({ category: cat, count }),
    join("og", "spec", `${cat}.png`),
  );
}
console.log(
  `  wrote ${Object.keys(CATEGORIES).length} category OG images → /og/spec/*.png`,
);

// Per spec page
let written = 0;
for (const s of specs) {
  const dir = join(ogOut, s.category);
  await mkdir(dir, { recursive: true });
  await ogPng(specPageCard(s), join("og", "spec", s.category, `${s.slug}.png`));
  written++;
}
console.log(
  `  wrote ${written} per-page OG images → /og/spec/<category>/<slug>.png`,
);

// Marketing / standalone pages — each gets a bespoke OG with the same brand
// frame so the set reads as a family on social timelines. Wired up by passing
// `ogImage` to BaseLayout on the matching page.
const marketingPages = [
  {
    slug: "spec",
    eyebrow: "ALL TOPICS",
    title: "Browse the specification.",
    subtitle:
      "Every topic, grouped by category. Required, recommended, optional, avoid.",
    footnote: `${specs.length} topics across ${Object.keys(CATEGORIES).length} categories`,
  },
  {
    slug: "checklist",
    eyebrow: "CHECKLIST",
    title: "The printable checklist.",
    subtitle: "Every topic in one list. Tickable, filterable, print-friendly.",
    footnote: `${specs.length} items to tick off`,
  },
  {
    slug: "about",
    eyebrow: "ABOUT",
    title: "What this site is.",
    subtitle:
      "Platform-agnostic standards. Built in the open. Cited from primary sources.",
  },
  {
    slug: "contribute",
    eyebrow: "CONTRIBUTE",
    title: "Open a pull request.",
    subtitle:
      "Spot a gap, a stale fact, or a missing topic? Sources required, opinions optional.",
  },
  {
    slug: "mcp",
    eyebrow: "MCP SERVER",
    title: "Query the spec.",
    subtitle:
      "Read-only MCP server at mcp.specification.website. No auth, no cookies.",
  },
  {
    slug: "changelog",
    eyebrow: "CHANGELOG",
    title: "What changed, and when.",
    subtitle:
      "New topics, status changes, and honest removals. Newest first, with sources.",
  },
  {
    slug: "considered",
    eyebrow: "CONSIDERED",
    title: "What we left out.",
    subtitle:
      "Standards we read, weighed, and did not adopt — with the reason, and what would change it.",
  },
  {
    slug: "privacy",
    eyebrow: "PRIVACY",
    title: "Almost nothing collected.",
    subtitle:
      "Cookieless analytics. No IP storage. No third-party scripts beyond Plausible.",
  },
  {
    slug: "search",
    eyebrow: "SEARCH",
    title: "Search the spec.",
    subtitle:
      "Full-text search over every topic. Powered by Pagefind, in the browser.",
  },
  {
    slug: "404",
    eyebrow: "404",
    title: "Page not found.",
    subtitle:
      "The page you tried to reach does not exist. Try the checklist or the search.",
  },
];

for (const p of marketingPages) {
  await ogPng(pageCard(p), join("og", `${p.slug}.png`));
}
console.log(
  `  wrote ${marketingPages.length} marketing OG images → /og/<slug>.png`,
);

// Vendor third-party runtime libraries we want self-hosted (script-src 'self').
// DOMPurify backs the Trusted Types default policy (see public/trusted-types-policy.js)
// so the strict CSP can require trusted values without pulling in a remote script.
const vendorOut = join(out, "vendor");
await mkdir(vendorOut, { recursive: true });
const dompurifySrc = join(
  root,
  "node_modules",
  "dompurify",
  "dist",
  "purify.min.js",
);
await writeFile(join(vendorOut, "purify.min.js"), await readFile(dompurifySrc));
console.log("  vendored DOMPurify → /vendor/purify.min.js");

// Browser telemetry: @sentry/browser plus our config/scrubber
// (src/diagnostics/client.ts), bundled into one self-hosted file so it stays
// script-src 'self' and can carry an SRI hash like every other script. Output
// is deterministic, so an unchanged source leaves the committed file untouched.
const { build: esbuild } = await import("esbuild");
await esbuild({
  entryPoints: [join(root, "src", "diagnostics", "client.ts")],
  outfile: join(vendorOut, "diagnostics.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  legalComments: "eof",
  // Strip the SDK's debug logger (Sentry's documented tree-shaking flag).
  define: { __SENTRY_DEBUG__: "false" },
  logLevel: "warning",
});
console.log("  bundled Sentry browser SDK → /vendor/diagnostics.js");

console.log("Done.");
