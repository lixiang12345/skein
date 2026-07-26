import {access, readFile, stat} from "node:fs/promises";
import {dirname, join, normalize, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repository, "website");
const required = [
  "index.html", "404.html", "styles.css", "app.js", "site.webmanifest",
  "robots.txt", "sitemap.xml", "_headers", "README.md",
  "assets/skein-goose.svg", "assets/skein-goose-dark.svg",
  "assets/skein-goose-mono.svg", "assets/skein-goose.png",
  "assets/skein-goose-flight.png"
];

for (const path of required) await access(join(root, path));

const html = await readFile(join(root, "index.html"), "utf8");
const css = await readFile(join(root, "styles.css"), "utf8");
const javascript = await readFile(join(root, "app.js"), "utf8");
const sitemap = await readFile(join(root, "sitemap.xml"), "utf8");
const manifest = JSON.parse(await readFile(join(root, "site.webmanifest"), "utf8"));

const expectations = [
  [html.includes('<html lang="en"'), "document language"],
  [html.includes('class="skip-link"'), "skip link"],
  [html.includes('rel="canonical"'), "canonical URL"],
  [html.includes('property="og:image"'), "Open Graph image"],
  [html.includes('"@type": "SoftwareApplication"'), "structured data"],
  [html.includes("data-nav-toggle"), "mobile navigation"],
  [html.includes("data-theme-toggle"), "theme control"],
  [html.includes("data-terminal-tab"), "terminal tabs"],
  [html.includes("data-copy-target"), "copy interaction"],
  [css.includes(":focus-visible"), "visible keyboard focus"],
  [css.includes("@media (prefers-reduced-motion: reduce)"), "reduced motion"],
  [css.includes("@media (max-width: 620px)"), "mobile layout"],
  [javascript.includes('event.key === "Escape"'), "escape-key navigation"],
  [javascript.includes("navigator.clipboard"), "clipboard API"],
  [javascript.includes("fallbackCopy"), "clipboard fallback"],
  [sitemap.includes("https://lixiang12345.github.io/skein/"), "sitemap canonical"],
  [manifest.name === "Skein" && manifest.icons.length > 0, "web app manifest"]
];

for (const [ok, label] of expectations) {
  if (!ok) throw new Error("Website verification failed: missing " + label + ".");
}
if (/<script[^>]+src=["']https?:/iu.test(html)) throw new Error("Website verification failed: remote scripts are not allowed.");
if (/<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:/iu.test(html)) throw new Error("Website verification failed: remote stylesheets are not allowed.");
if (/\b(?:TODO|FIXME|lorem ipsum)\b/iu.test(html + css + javascript)) throw new Error("Website verification failed: unfinished placeholder content found.");

const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error("Website verification failed: duplicate ids " + duplicateIds.join(", ") + ".");
const anchors = [...html.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1]);
for (const anchor of anchors) {
  if (!ids.includes(anchor)) throw new Error("Website verification failed: missing anchor #" + anchor + ".");
}
const localReferences = [...html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/gu)].map((match) => match[1]);
for (const reference of localReferences) {
  const target = normalize(join(root, reference));
  if (!target.startsWith(root)) throw new Error("Website verification failed: path escaped root: " + reference + ".");
  await access(target);
}

const budgets = {
  "index.html": 80_000,
  "styles.css": 70_000,
  "app.js": 20_000,
  "assets/skein-goose-flight.png": 350_000
};
for (const [path, budget] of Object.entries(budgets)) {
  const size = (await stat(join(root, path))).size;
  if (size > budget) throw new Error("Website verification failed: " + path + " is " + size + " bytes; budget is " + budget + ".");
}
process.stdout.write("Website verification passed: " + required.length + " files, anchors, assets, SEO, accessibility, privacy, and size budgets.\n");
