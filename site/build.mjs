// Builds the static install page.
//
// The page is generated from files that already exist in the repo, so the
// published site can never drift from the docs:
//   docs/安装教程.md            -> the page body
//   userscript/watch-party.user.js -> version shown + the copy/install payload
//
// Run: npm run site:build   (site/public/ is generated, not committed)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(here, "public");

// Private, git-ignored local settings (real domain). Falls back to the tracked
// example, so a fresh clone builds a generic page with no deployment address.
function readConfig() {
  for (const name of ["config.json", "config.example.json"]) {
    try {
      return JSON.parse(readFileSync(join(here, name), "utf8"));
    } catch {
      /* try the next one */
    }
  }
  return {};
}
const config = readConfig();
const PLACEHOLDER_HOST = "your-worker.example.workers.dev";
const apiHost = String(config.apiHost || PLACEHOLDER_HOST).replace(/^https?:\/\//, "").replace(/\/$/, "");

const doc = readFileSync(join(root, "docs", "安装教程.md"), "utf8").replace(/^\uFEFF/, "");
// The published copy is what people actually install, so it gets the real host
// baked in (the `@connect` line needs a hostname, not a URL).
const source = readFileSync(join(root, "userscript", "watch-party.user.js"), "utf8");
const script = source.split(PLACEHOLDER_HOST).join(apiHost);
const version = (source.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || "dev";
const baked = script !== source;

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
// Page shell
// ---------------------------------------------------------------------------
const body = renderMarkdown(doc);

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>一起看 · 视频同步 —— 安装教程</title>
<meta name="description" content="和朋友异地看同一个视频，进度自动对齐。约 10 分钟装好，不需要懂编程。">
<style>
  :root { --ink:#1b2130; --dim:#5b6472; --line:#e6eaf1; --blue:#2b6cff; --bg:#f7f8fb; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font: 15px/1.75 -apple-system, system-ui, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 0 20px; }
  header.bar { position: sticky; top:0; z-index:10; background:rgba(255,255,255,.88);
    backdrop-filter: blur(10px); border-bottom:1px solid var(--line); }
  header.bar .wrap { display:flex; align-items:center; gap:16px; height:54px; }
  .logo { font-weight:700; }
  header.bar nav { margin-left:auto; display:flex; gap:16px; font-size:13.5px; }
  header.bar nav a { color:var(--dim); text-decoration:none; }
  header.bar nav a:hover { color:var(--blue); }
  .ver { font-size:12px; color:var(--dim); background:#eef2f8; border-radius:99px; padding:2px 9px; }

  .hero { background:#fff; border:1px solid var(--line); border-radius:18px; padding:26px;
    margin:26px 0 22px; box-shadow:0 10px 30px rgba(15,23,42,.05); }
  .hero h1 { margin:0 0 8px; font-size:26px; letter-spacing:-.4px; }
  .hero p { margin:0 0 18px; color:var(--dim); }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .btn { font:inherit; font-size:14px; border-radius:11px; padding:10px 18px; cursor:pointer;
    border:1px solid var(--line); background:#f5f7fb; color:var(--ink); text-decoration:none;
    transition: background .15s, border-color .15s, filter .15s; }
  .btn:hover { background:#eef2f8; border-color:#d5dde9; }
  .btn.primary { background:linear-gradient(150deg,#6d8bff,#2b6cff); color:#fff;
    border-color:rgba(43,108,255,.30); font-weight:600; }
  .btn.primary:hover { filter:brightness(1.07); }
  .btn.ok { background:linear-gradient(150deg,#45e39d,#1f9e57); color:#fff; border-color:transparent; font-weight:600; }
  .note { margin:16px 0 0; font-size:13px; color:var(--dim); }

  article.doc { background:#fff; border:1px solid var(--line); border-radius:18px;
    padding:30px 30px 34px; box-shadow:0 10px 30px rgba(15,23,42,.05); margin-bottom:34px; }
  article.doc h1 { font-size:24px; margin:0 0 14px; }
  article.doc h2 { font-size:19px; margin:34px 0 12px; padding-top:18px; border-top:1px solid var(--line); }
  article.doc h2:first-of-type { border-top:0; padding-top:0; }
  article.doc h3 { font-size:16px; margin:24px 0 8px; }
  article.doc p { margin:10px 0; }
  article.doc ul, article.doc ol { margin:10px 0; padding-left:22px; }
  article.doc li { margin:5px 0; }
  article.doc blockquote { margin:14px 0; padding:12px 16px; background:#f5f8ff;
    border-left:3px solid #9db6ff; border-radius:0 10px 10px 0; color:#39424f; }
  article.doc blockquote p { margin:4px 0; }
  article.doc code { background:#f1f4f9; border:1px solid #e6eaf1; border-radius:6px;
    padding:1px 5px; font-size:.9em; font-family:ui-monospace, Consolas, "Courier New", monospace; }
  article.doc pre { background:#0f172a; color:#e6edf7; border-radius:11px; padding:14px 16px;
    overflow-x:auto; margin:12px 0; }
  article.doc pre code { background:none; border:0; padding:0; color:inherit; font-size:13px; line-height:1.6; }
  article.doc a { color:var(--blue); }
  article.doc hr { border:0; border-top:1px solid var(--line); margin:30px 0; }
  article.doc .tw { overflow-x:auto; margin:14px 0; }
  article.doc table { border-collapse:collapse; width:100%; font-size:14px; }
  article.doc th, article.doc td { border:1px solid var(--line); padding:8px 12px; text-align:left; }
  article.doc th { background:#f7f9fc; font-weight:600; }

  footer { color:var(--dim); font-size:13px; text-align:center; padding:0 20px 44px; }
  footer a { color:var(--dim); }
  @media (max-width: 560px) {
    header.bar nav { display:none; }
    .hero { padding:20px; } .hero h1 { font-size:21px; }
    article.doc { padding:20px 18px 24px; }
  }
</style>
</head>
<body>
<header class="bar">
  <div class="wrap">
    <span class="logo">▶ 一起看</span>
    <nav>
      <a href="#第一步装-tampermonkey大家叫它油猴">装油猴</a>
      <a href="#第二步安装脚本">装脚本</a>
      <a href="#第四步和朋友一起看">怎么用</a>
      <a href="#常见问题">常见问题</a>
      <a href="#附录自己搭一个后端可选">自建后端</a>
    </nav>
    <span class="ver">v${version}</span>
  </div>
</header>

<main class="wrap">
  <section class="hero">
    <h1>和朋友一起看，进度自动对齐</h1>
    <p>你和朋友在不同地方，看同一个视频 —— 房主暂停你就暂停，房主拖进度条你就跟着跳，谁卡了大家一起等他。</p>
    <div class="actions">
      <a class="btn primary" href="/watch-party.user.js" id="install">一键安装脚本</a>
      <button class="btn" type="button" id="copy">复制脚本代码</button>
      <button class="btn" type="button" id="copyurl">复制安装地址</button>
    </div>
    <p class="note">
      需要先装 <strong>Tampermonkey（油猴）</strong>，见下面第一步。当前版本 <code>v${version}</code>。
      没装油猴时「一键安装」不会生效，用「复制脚本代码」也可以。
    </p>
  </section>

  <article class="doc">
${body}
  </article>
</main>

<footer>
  一起看 · 视频同步 &nbsp;·&nbsp; 同步服务器地址写在脚本里
</footer>

<script>
(function () {
  var RAW = "/watch-party.user.js";
  var copyBtn = document.getElementById("copy");
  var urlBtn = document.getElementById("copyurl");

  function flash(btn, text, ok) {
    var original = btn.getAttribute("data-label") || btn.textContent;
    btn.setAttribute("data-label", original);
    btn.textContent = text;
    if (ok) btn.classList.add("ok");
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove("ok");
    }, 2600);
  }

  function execCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("execCommand copy failed"));
    });
  }

  function copyText(text) {
    // The async clipboard API is the nice path, but it can also *reject* (no
    // permission, no user gesture, Firefox quirks), so the legacy path is a
    // fallback for that too — not only for its absence.
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return execCopy(text); });
    }
    return execCopy(text);
  }

  copyBtn.addEventListener("click", function () {
    copyBtn.disabled = true;
    copyBtn.textContent = "复制中…";
    fetch(RAW, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(copyText)
      .then(function () {
        copyBtn.disabled = false;
        flash(copyBtn, "✓ 已复制，去油猴粘贴", true);
      })
      .catch(function () {
        copyBtn.disabled = false;
        // Last resort: show the source so it can be selected by hand.
        window.open(RAW, "_blank");
        flash(copyBtn, "已打开源码，请全选复制", false);
      });
  });

  urlBtn.addEventListener("click", function () {
    copyText(location.origin + "/watch-party.user.js")
      .then(function () { flash(urlBtn, "✓ 地址已复制", true); })
      .catch(function () { flash(urlBtn, "复制失败，请手动复制", false); });
  });
})();
</script>
</body>
</html>
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), page);
writeFileSync(join(outDir, "watch-party.user.js"), script);
console.log(
  `site/public: index.html (${(page.length / 1024).toFixed(1)} KB) + watch-party.user.js v${version}` +
    (baked ? `（后端已注入 ${apiHost}）` : "（未找到 site/config.json，脚本里仍是占位地址）")
);
