// Deterministic verification for the website-fable-5 static site.
// Run: node website-fable-5/check.mjs   (no dependencies, exits non-zero on failure)
//
// Beyond structural checks, this script cross-verifies marketing claims against
// the repository so the site cannot drift from the product:
//   - the exit-code table in guide.html must match src/cli/headless-contract.ts
//   - every headless status in docs/headless-output.schema.json must be documented
//   - version-pinned counts ("NNN tests", "vitest NNN", "0.x.y") are forbidden

import {access, readFile, stat} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname, join, normalize} from "node:path";
import {fileURLToPath} from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repository = join(root, "..");
const failures = [];

function expect(condition, label) {
  if (!condition) failures.push(label);
}

const required = [
  "index.html", "guide.html", "404.html", "styles.css", "app.js",
  "site.webmanifest", "robots.txt", "sitemap.xml", "_headers", "README.md",
  "assets/skein-goose.svg", "assets/skein-goose-dark.svg",
  "assets/skein-goose-mono.svg", "assets/skein-goose.png",
  "assets/skein-goose-flight.png", "assets/skein-og-card.png", "assets/og-card.html"
];
for (const path of required) {
  try {
    await access(join(root, path));
  } catch {
    failures.push("missing required file: " + path);
  }
}

const index = await readFile(join(root, "index.html"), "utf8");
const guide = await readFile(join(root, "guide.html"), "utf8");
const notFound = await readFile(join(root, "404.html"), "utf8");
const css = await readFile(join(root, "styles.css"), "utf8");
const javascript = await readFile(join(root, "app.js"), "utf8");
const sitemap = await readFile(join(root, "sitemap.xml"), "utf8");
const robots = await readFile(join(root, "robots.txt"), "utf8");

// ---------- per-page structural checks ----------

function checkPage(name, html, {navigation = true} = {}) {
  expect(html.includes('<html lang="en"'), name + ": document language");
  expect(html.includes('name="generator" content="Claude Fable 5"'), name + ": authorship marker");
  expect(html.includes("skein-theme"), name + ": pre-paint theme init");
  expect(html.includes("skein-lang"), name + ": pre-paint language init");
  expect(html.includes("data-title-en") && html.includes("data-title-zh"), name + ": bilingual titles");
  expect(html.includes('name="viewport"'), name + ": viewport meta");
  const englishSpans = (html.match(/\slang="en"/gu) ?? []).length - 1;
  const chineseSpans = (html.match(/\slang="zh-CN"/gu) ?? []).length;
  expect(
    englishSpans === chineseSpans,
    name + ": bilingual parity (" + englishSpans + " en vs " + chineseSpans + " zh strings)"
  );
  if (navigation) {
    expect(html.includes("data-lang-toggle"), name + ": language toggle");
    expect(html.includes('class="skip-link"'), name + ": skip link");
    expect(html.includes("data-theme-toggle"), name + ": theme control");
    expect(html.includes("data-nav-toggle"), name + ": mobile navigation");
    expect(html.includes('rel="canonical"'), name + ": canonical URL");
    expect(html.includes('property="og:image"'), name + ": Open Graph image");
    expect(html.includes("assets/skein-og-card.png"), name + ": social card wired");
    expect(html.includes('content="1200"') && html.includes('content="630"'), name + ": social card dimensions declared");
  }
  expect(!/<script[^>]+src=["']https?:/iu.test(html), name + ": no remote scripts");
  expect(!/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/iu.test(html), name + ": no remote stylesheets");
  expect(!/\b(?:TODO|FIXME|lorem ipsum)\b/iu.test(html), name + ": no placeholder content");

  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  const duplicates = ids.filter((id, position) => ids.indexOf(id) !== position);
  expect(duplicates.length === 0, name + ": duplicate ids " + duplicates.join(", "));
  for (const anchor of [...html.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1])) {
    expect(ids.includes(anchor), name + ": missing anchor #" + anchor);
  }
  return {ids};
}

checkPage("index.html", index);
checkPage("guide.html", guide);
checkPage("404.html", notFound, {navigation: false});

for (const [name, html] of [["index.html", index], ["guide.html", guide], ["404.html", notFound]]) {
  for (const reference of [...html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/gu)].map((match) => match[1])) {
    const target = normalize(join(root, reference));
    expect(target.startsWith(root), name + ": path escaped root: " + reference);
    try {
      await access(target);
    } catch {
      failures.push(name + ": broken local reference " + reference);
    }
  }
}

// ---------- cross-page identity and linking ----------

const titleOf = (html) => (html.match(/<title>([^<]+)<\/title>/u) ?? [])[1] ?? "";
const canonicalOf = (html) => (html.match(/rel="canonical" href="([^"]+)"/u) ?? [])[1] ?? "";
const descriptionOf = (html) => (html.match(/name="description" content="([^"]+)"/u) ?? [])[1] ?? "";

expect(titleOf(index).length > 0 && titleOf(guide).length > 0, "both pages have titles");
expect(titleOf(index) !== titleOf(guide), "index and guide titles are distinct");
expect(descriptionOf(index) !== descriptionOf(guide), "index and guide descriptions are distinct");
expect(canonicalOf(index) === "https://lixiang12345.github.io/skein/", "index canonical URL");
expect(canonicalOf(guide) === "https://lixiang12345.github.io/skein/guide.html", "guide canonical URL");
expect(index.includes('href="./guide.html"'), "index links to the guide");
expect(guide.includes('href="./index.html"'), "guide links back to the landing page");
expect(sitemap.includes("https://lixiang12345.github.io/skein/</loc>"), "sitemap lists the landing page");
expect(sitemap.includes("https://lixiang12345.github.io/skein/guide.html</loc>"), "sitemap lists the guide");
expect(robots.includes("Sitemap: https://lixiang12345.github.io/skein/sitemap.xml"), "robots.txt names the sitemap");

// ---------- truthful-claims guards ----------

for (const [name, html] of [["index.html", index], ["guide.html", guide]]) {
  expect(!/\b0\.\d+\.\d+\b/u.test(html), name + ": no version-pinned release literals");
  expect(!/\b\d{3,}\+?\s*tests?\b/iu.test(html), name + ": no test-count literals");
  expect(!/\bvitest\s+\d+\b/iu.test(html), name + ": no pinned vitest counts");
  expect(html.includes("Gemini") && html.includes("Anthropic Messages"), name + ": provider claims parity");
}

// ---------- stylesheet and script behavior ----------

expect(css.includes(":focus-visible"), "styles: visible keyboard focus");
expect(css.includes("@media (prefers-reduced-motion: reduce)"), "styles: reduced motion");
expect(css.includes("@media (max-width: 620px)"), "styles: mobile layout");
expect(css.includes("html.js [data-reveal]"), "styles: reveal gated on html.js");
expect(!/^\[data-reveal\]/mu.test(css), "styles: no ungated hidden reveal state (content must be visible without JS)");
expect(css.includes('html[lang="zh-CN"] [lang="en"]'), "styles: Chinese mode hides English strings");
expect(css.includes(':not([lang="zh-CN"]) [lang="zh-CN"]'), "styles: English mode hides Chinese strings");
expect(javascript.includes("skein-lang"), "script: language toggle persistence");
expect(javascript.includes("fallbackCopy"), "script: clipboard fallback");
expect(javascript.includes('event.key === "Escape"'), "script: escape-key navigation");
expect(javascript.includes("IntersectionObserver"), "script: reveal observer");
expect(/else\s*\{\s*revealItems/u.test(javascript), "script: reveal fallback without IntersectionObserver");

// ---------- manifest ----------

try {
  const manifest = JSON.parse(await readFile(join(root, "site.webmanifest"), "utf8"));
  expect(manifest.name === "Skein" && Array.isArray(manifest.icons) && manifest.icons.length > 0, "web app manifest");
} catch {
  failures.push("site.webmanifest is not valid JSON");
}

// ---------- social card raster dimensions ----------

try {
  const png = await readFile(join(root, "assets/skein-og-card.png"));
  expect(png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630, "social card is 1200x630");
} catch {
  failures.push("social card PNG unreadable");
}

// ---------- repository cross-checks (skipped when serving the folder standalone) ----------

const contractPath = join(repository, "src", "cli", "headless-contract.ts");
if (existsSync(contractPath)) {
  const contract = await readFile(contractPath, "utf8");
  const block = contract.match(/HEADLESS_EXIT_CODES = \{([^}]+)\}/u);
  expect(Boolean(block), "exit-code contract readable");
  if (block) {
    const statusFor = {
      completed: "verified", error: "error", needsInput: "needs_input",
      unverified: "unverified", verificationFailed: "verification_failed",
      blocked: "blocked", cancelled: "cancelled", maxTurns: "max_turns",
      tokenBudget: "token_budget", needsReview: "needs_review"
    };
    for (const [, key, code] of block[1].matchAll(/(\w+):\s*(\d+)/gu)) {
      const cell = "<td><code>" + code + "</code></td>";
      const at = guide.indexOf(cell);
      const documented = at >= 0 && guide.slice(at, at + 240).includes(statusFor[key] ?? key);
      expect(documented, "guide documents exit code " + code + " as " + (statusFor[key] ?? key));
    }
  }
}

const schemaPath = join(repository, "docs", "headless-output.schema.json");
if (existsSync(schemaPath)) {
  try {
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    for (const status of schema?.properties?.status?.enum ?? []) {
      expect(guide.includes(status), "guide mentions headless status " + status);
    }
  } catch {
    failures.push("headless schema unreadable");
  }
}

// ---------- size budgets ----------

const budgets = {
  "index.html": 90_000,
  "guide.html": 100_000,
  "styles.css": 50_000,
  "app.js": 20_000,
  "assets/skein-goose-flight.png": 350_000,
  "assets/skein-og-card.png": 450_000
};
for (const [path, budget] of Object.entries(budgets)) {
  try {
    const size = (await stat(join(root, path))).size;
    expect(size <= budget, path + " is " + size + " bytes; budget is " + budget);
  } catch {
    failures.push("cannot stat " + path);
  }
}

if (failures.length > 0) {
  process.stderr.write("Website verification failed:\n" + failures.map((line) => "  - " + line).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("website-fable-5 verification passed: " + required.length + " files, structure, cross-links, truthful-claims guards, exit-code contract, assets, and size budgets.\n");
