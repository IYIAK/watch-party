// Builds the static site: TWO pages, each in its own directory.
//
// The pages are generated from files that already exist in the repo, so the
// published site can never drift from the docs:
//   docs/安装教程.md             -> dist/guide/index.html  (rendered markdown body)
//   site/src/home.html           -> dist/home/index.html   (landing body)
//   site/src/layout.mjs          -> the shell both pages share
//   userscript/watch-party.user.js -> dist/{home,guide}/watch-party.user.js
//                                     (published copy has the real backend host baked in)
//
// Placeholders frozen at build time:
//   {{VERSION}}   the userscript's // @version
//   {{HOME_URL}}  config.homeUrl
//   {{GUIDE_URL}} config.guideUrl
//   {{SCRIPT_URL}} config.homeUrl + "/watch-party.user.js"
//   {{API_HOST}}  config.apiHost   (only inside the published userscript copy)
//
// Run: npm run site:build   (site/dist/ is generated, not committed)

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./src/layout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outRoot = join(here, "dist");

// Assembled from parts so this file never *contains* the banned string, which
// lets the scan below include itself instead of being exempted from it.
const FORBIDDEN = ["sc", "ene", "ee"].join("");

const die = (msg) => {
  throw new Error(`site/build: ${msg}`);
};

// ---------------------------------------------------------------------------
// Config (private, git-ignored settings first; tracked template as fallback)
// ---------------------------------------------------------------------------
function readConfig() {
  for (const name of ["config.json", "config.example.json"]) {
    try {
      return { name, config: JSON.parse(readFileSync(join(here, name), "utf8")) };
    } catch {
      /* missing or unreadable: try the next one */
    }
  }
  return { name: null, config: {} };
}
const { name: configName, config } = readConfig();
const usingRealConfig = configName === "config.json";

const PLACEHOLDER_HOST = "your-worker.example.workers.dev";
const PLACEHOLDER_SITE = "your-site.example.com";
const apiHost = String(config.apiHost || PLACEHOLDER_HOST)
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");
const homeUrl = String(config.homeUrl || "").replace(/\/+$/, "");
const homeHost = homeUrl.replace(/^https?:\/\//, "");
const guideUrl = String(config.guideUrl || "").replace(/\/+$/, "");
if (!homeUrl) die(`config ${configName || "(none)"} has no "homeUrl"`);
if (!guideUrl) die(`config ${configName || "(none)"} has no "guideUrl"`);

const replacements = {
  VERSION: "", // filled in once the userscript is read
  HOME_URL: homeUrl,
  GUIDE_URL: guideUrl,
  SCRIPT_URL: `${homeUrl}/watch-party.user.js`,
  API_HOST: apiHost,
};

/** Substitute the frozen placeholders; unknown {{keys}} are left for the
 *  post-render scan to catch, so the build fails instead of shipping a
 *  half-baked page. */
function substitute(text) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match
  );
}

// ---------------------------------------------------------------------------
// Markdown -> HTML
// ---------------------------------------------------------------------------
// Deliberately small: it covers the constructs the install guide actually uses
// (headings, tables, quoted asides, nested lists with code blocks inside items,
// fenced code). Anything fancier belongs in a real renderer, not here.

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// GitHub-style anchor, so the guide's own [附录](#附录自己搭一个后端可选) links work.
const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

function inline(text) {
  // Code spans are pulled out first so `**` or `[]` inside them stay literal.
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  // <https://example.com> autolinks (matched in escaped form)
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '<a href="$1">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

const cellSplit = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  // Open lists. `indent` is the column the bullets sit at.
  const lists = [];
  // A <li> stays *unclosed* until its item really ends, so nested lists and code
  // blocks land inside it instead of after it (which would break the numbering).
  let itemOpen = false;
  let i = 0;

  const closeItem = () => {
    if (itemOpen) {
      out.push("</li>");
      itemOpen = false;
    }
  };
  const closeLists = (downTo = -1) => {
    while (lists.length && lists[lists.length - 1].indent > downTo) {
      closeItem();
      out.push(`</${lists.pop().tag}>`);
    }
  };
  const append = (html) => out.push(html);

  while (i < lines.length) {
    const line = lines[i];

    // ---- fenced code ----
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        // Strip the list indentation so the code block is not padded.
        body.push(lines[i].replace(/^\s{0,3}/, ""));
        i++;
      }
      i++;
      append(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // ---- blank ----
    if (!line.trim()) {
      closeItem();
      closeLists();
      i++;
      continue;
    }

    // ---- heading ----
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeItem();
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level} id="${slug(heading[2])}">${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // ---- horizontal rule ----
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeItem();
      closeLists();
      out.push("<hr>");
      i++;
      continue;
    }

    // ---- table ----
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeItem();
      closeLists();
      const head = cellSplit(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(cellSplit(lines[i]));
        i++;
      }
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`
      );
      continue;
    }

    // ---- blockquote ----
    if (/^\s*>/.test(line)) {
      closeItem();
      closeLists();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    // ---- list item ----
    const item = line.match(/^(\s*)(?:([-*])|(\d+)\.)\s+(.*)$/);
    if (item) {
      const indent = item[1].length;
      const tag = item[2] ? "ul" : "ol";
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        // A deeper list opens inside the still-unclosed <li> above it.
        out.push(`<${tag}>`);
        lists.push({ tag, indent });
      } else if (top.tag !== tag) {
        closeItem();
        out.push(`</${top.tag}>`);
        out.push(`<${tag}>`);
        lists[lists.length - 1] = { tag, indent };
      } else {
        closeItem(); // plain sibling: end the previous item
      }
      out.push(`<li>${inline(item[4])}`);
      itemOpen = true;
      i++;
      continue;
    }

    // ---- continuation of a list item, or a paragraph ----
    if (lists.length && /^\s+\S/.test(line)) {
      append(` ${inline(line.trim())}`);
      i++;
      continue;
    }
    if (lists.length) closeLists();

    const para = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|\||```)/.test(lines[i]) &&
      !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    append(`<p>${inline(para.join(" "))}</p>`);
  }

  closeItem();
  closeLists();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

// The published copy is what people actually install, so it gets the real host
// baked in (the `@connect` line needs a hostname, not a URL).
const source = readFileSync(join(root, "userscript", "watch-party.user.js"), "utf8");
const version = (source.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || "dev";
replacements.VERSION = version;
const bakedScript = source
  .split(PLACEHOLDER_HOST)
  .join(apiHost)
  // The update/download URLs point at the site hosting the script, not at the API.
  .split(PLACEHOLDER_SITE)
  .join(homeHost || PLACEHOLDER_SITE)
  .replace(/\{\{API_HOST\}\}/g, apiHost);
const baked = bakedScript !== source;
const script = substitute(bakedScript);
if (usingRealConfig && !baked) die("real apiHost was not baked into the userscript copy");
if (usingRealConfig && bakedScript.includes(PLACEHOLDER_SITE)) {
  die(`the real site host was not baked in (config.homeUrl = ${homeUrl})`);
}

const doc = readFileSync(join(root, "docs", "安装教程.md"), "utf8").replace(/^\uFEFF/, "");
const homeBody = readFileSync(join(here, "src", "home.html"), "utf8").replace(/^\uFEFF/, "");

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const guideBody = `<article class="doc">\n${renderMarkdown(doc)}\n</article>`;

const pages = [
  {
    file: join(outRoot, "home", "index.html"),
    html: renderPage({
      title: "一起看 · 视频同步",
      description: "和朋友异地看同一个视频，进度自动对齐。约 10 分钟装好，不需要懂编程。",
      bodyHtml: homeBody,
      activeTab: "home",
    }),
  },
  {
    file: join(outRoot, "guide", "index.html"),
    html: renderPage({
      title: "一起看 · 视频同步 —— 安装教程",
      description: "和朋友异地看同一个视频，进度自动对齐。约 10 分钟装好，不需要懂编程。",
      bodyHtml: guideBody,
      activeTab: "guide",
    }),
  },
];

// ---------------------------------------------------------------------------
// Hard rules — the build must fail loudly rather than publish a broken site
// ---------------------------------------------------------------------------

// 1. Nothing under site/src/ (nor this file, nor the tracked config template)
//    may carry a real deployment domain.
function scanForForbidden() {
  const targets = [join(here, "build.mjs"), join(here, "config.example.json")];
  for (const entry of readdirSync(join(here, "src"), { withFileTypes: true })) {
    if (entry.isFile()) targets.push(join(here, "src", entry.name));
  }
  for (const file of targets) {
    if (readFileSync(file, "utf8").includes(FORBIDDEN)) {
      die(`forbidden domain string in ${file.replace(root + "/", "").replace(root + "\\", "")}`);
    }
  }
}

// 2. No `{{` may survive into a generated file — an unknown key, a truncated
//    placeholder or a stray brace all mean the same thing: stop the build.
function scanForPlaceholders(file, text) {
  const at = String(text).indexOf("{{");
  if (at !== -1) die(`unsubstituted placeholder in ${file}: …${String(text).slice(at, at + 40)}…`);
}

// 3. Everything inline: no external stylesheet/script/font/image.
function scanForExternalAssets(file, html) {
  const bad = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\bhref="data:/i.test(m[0])) bad.push(m[0]);
  }
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) bad.push("<script src=…>");
  if (/<style\b[^>]*\bsrc\s*=/i.test(html)) bad.push("<style src=…>");
  for (const tag of ["img", "iframe", "video", "audio", "source", "object", "embed"]) {
    if (new RegExp(`<${tag}\\b`, "i").test(html)) bad.push(`<${tag}>`);
  }
  if (/@import/i.test(html)) bad.push("@import");
  if (/url\(\s*['"]?https?:/i.test(html)) bad.push("url(http…)");
  if (bad.length) die(`external asset reference in ${file}: ${bad.join(", ")}`);
}

scanForForbidden();

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
// Validate everything BEFORE touching site/dist/, so a failed build never
// leaves a half-written output tree behind.
const rendered = pages.map((page) => {
  const html = substitute(page.html);
  const rel = page.file.slice(outRoot.length + 1);
  scanForPlaceholders(rel, html);
  scanForExternalAssets(rel, html);
  return { ...page, rel, html };
});
scanForPlaceholders("watch-party.user.js", script);

rmSync(outRoot, { recursive: true, force: true });

const written = [];
for (const page of rendered) {
  mkdirSync(dirname(page.file), { recursive: true });
  writeFileSync(page.file, page.html);
  written.push({ rel: page.rel, bytes: Buffer.byteLength(page.html) });
}

// The userscript is published into BOTH directories, byte-identical.
const scriptTargets = ["home", "guide"].map((dir) => {
  const file = join(outRoot, dir, "watch-party.user.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, script);
  return { rel: `${dir}/watch-party.user.js`, file };
});
{
  // Read back exactly what landed on disk: no leftover `{{`, and the two
  // published copies must be byte-identical and carry the real apiHost.
  for (const page of rendered) scanForPlaceholders(page.rel, readFileSync(page.file, "utf8"));
  for (const t of scriptTargets) scanForPlaceholders(t.rel, readFileSync(t.file, "utf8"));
  const [a, b] = scriptTargets.map((t) => readFileSync(t.file));
  if (!a.equals(b)) die("the two published watch-party.user.js copies differ");
  if (!a.includes(apiHost)) die("published watch-party.user.js does not contain the real apiHost");
}

console.log(
  `site/dist: home/index.html (${(written[0].bytes / 1024).toFixed(1)} KB) + ` +
    `guide/index.html (${(written[1].bytes / 1024).toFixed(1)} KB) + ` +
    `2× watch-party.user.js v${version}` +
    (baked ? `（后端已注入 ${apiHost}）` : "（未找到 site/config.json，脚本里仍是占位地址）")
);
