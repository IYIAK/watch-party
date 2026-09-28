// Shared page shell for the static site.
//
// renderPage({ title, description, bodyHtml, activeTab }) returns one complete
// HTML document. Everything it needs is inline — no external stylesheet, font
// or image — so the published pages keep working on a network that blocks most
// CDNs (only the tab links and the GitHub link leave the site).
//
// The {{VERSION}} / {{HOME_URL}} / {{GUIDE_URL}} / {{SCRIPT_URL}} placeholders
// are deliberately left in the returned string: site/build.mjs substitutes them
// and fails the build if any `{{` survives into a generated file.

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GITHUB_URL = "https://github.com/IYIAK/watch-party";

// Shown as 〔首页｜安装教程｜GitHub〕; `activeTab` is "home" | "guide".
const TABS = [
  { id: "home", label: "首页", href: "{{HOME_URL}}" },
  { id: "guide", label: "安装教程", href: "{{GUIDE_URL}}" },
  { id: "github", label: "GitHub", href: GITHUB_URL },
];

// Inline SVG favicon: a ▶ play mark on the brand blue. Data URI, so it never
// costs a network request (and never hits a blocked host).
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="14" fill="#2b6cff"/>` +
      `<path d="M25 18l24 14-24 14z" fill="#fff"/></svg>`
  );

function renderTabs(activeTab) {
  return TABS.map((t) => {
    const on = t.id === activeTab;
    const cls = on ? ' class="tab on"' : ' class="tab"';
    const cur = on ? ' aria-current="page"' : "";
    return `      <a${cls} href="${t.href}"${cur}>${t.label}</a>`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// The action row — defined ONCE, placed in ONE of two positions.
//
//   * Default: at the top of <main>, before the body. That is what the
//     tutorial page needs: its step 2 says 「点上面的「一键安装脚本」」.
//   * If a body contains the literal {{ACTIONS}} token, the row is spliced in
//     at that spot instead and nothing is rendered on top — the landing page
//     uses this to show its hero (h1 + pitch) before the buttons.
//
// The token is consumed here, so it can never reach build.mjs's `{{` scan.
// ---------------------------------------------------------------------------
const ACTIONS_TOKEN = "{{ACTIONS}}";

const ACTION_ROW = `  <section class="card install" aria-label="安装">
    <div class="actions">
      <a class="btn primary" id="install" href="{{SCRIPT_URL}}">一键安装脚本</a>
      <button class="btn" type="button" id="copy">复制脚本代码</button>
      <button class="btn" type="button" id="copyurl">复制安装地址</button>
    </div>
    <p class="note">
      使用前需安装 <strong>Tampermonkey（油猴）</strong>，步骤见 <a href="{{GUIDE_URL}}">安装教程</a>。
      当前版本 <code>v{{VERSION}}</code>。未安装油猴时「一键安装脚本」不会生效，可改用「复制脚本代码」。
    </p>
  </section>`;

export function renderPage({ title, description, bodyHtml, activeTab }) {
  const wantsInlineActions = String(bodyHtml).includes(ACTIONS_TOKEN);
  // Above the body (default), or empty when the body places the row itself.
  const actionsAbove = wantsInlineActions ? "" : `${ACTION_ROW}\n\n`;
  const body = wantsInlineActions
    ? String(bodyHtml).split(ACTIONS_TOKEN).join(ACTION_ROW)
    : bodyHtml;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" href="${FAVICON}">
<style>
/* ==========================================================================
   SHARED BASE — inlined into every page by site/src/layout.mjs.
   No CSS imports, no remote url(...) and no external stylesheet/font/image:
   the whole site must render from this one block.
   >>> Page-specific styles belong AFTER the closing marker below. <<<
   ========================================================================== */
  :root { --ink:#1b2130; --dim:#5b6472; --line:#e6eaf1; --blue:#2b6cff; --bg:#f7f8fb; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font: 15px/1.75 -apple-system, system-ui, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 0 20px; }

  header.bar { position: sticky; top:0; z-index:10; background:rgba(255,255,255,.88);
    backdrop-filter: blur(10px); border-bottom:1px solid var(--line); }
  header.bar .wrap { display:flex; align-items:center; flex-wrap:wrap; gap:12px 14px; min-height:54px;
    padding-top:6px; padding-bottom:6px; }
  .logo { font-weight:700; white-space:nowrap; }
  nav.tabs { margin-left:auto; display:flex; gap:4px; font-size:13.5px; }
  .tab { color:var(--dim); text-decoration:none; padding:4px 11px; border-radius:9px; white-space:nowrap; }
  .tab:hover { color:var(--blue); background:#eef2f8; }
  .tab.on { color:var(--blue); background:#e9f0ff; font-weight:600; }
  .ver { font-size:12px; color:var(--dim); background:#eef2f8; border-radius:99px; padding:2px 9px; white-space:nowrap; }

  main.wrap { padding-top:24px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:18px; padding:22px 26px;
    margin:0 0 22px; box-shadow:0 10px 30px rgba(15,23,42,.05); }
  .install h1 { margin:0 0 8px; font-size:26px; letter-spacing:-.4px; }
  .install > p.lede { margin:0 0 16px; color:var(--dim); }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .btn { font:inherit; font-size:14px; border-radius:11px; padding:10px 18px; cursor:pointer;
    border:1px solid var(--line); background:#f5f7fb; color:var(--ink); text-decoration:none;
    transition: background .15s, border-color .15s, filter .15s; }
  .btn:hover { background:#eef2f8; border-color:#d5dde9; }
  .btn.primary { background:linear-gradient(150deg,#6d8bff,#2b6cff); color:#fff;
    border-color:rgba(43,108,255,.30); font-weight:600; }
  .btn.primary:hover { filter:brightness(1.07); }
  .btn.ok { background:linear-gradient(150deg,#45e39d,#1f9e57); color:#fff; border-color:transparent; font-weight:600; }
  .note { margin:14px 0 0; font-size:13px; color:var(--dim); }
  .note a { color:var(--blue); }
  .page { margin-bottom:34px; }

  .hero { background:#fff; border:1px solid var(--line); border-radius:18px; padding:26px;
    margin:0 0 22px; box-shadow:0 10px 30px rgba(15,23,42,.05); }
  .hero h1 { margin:0 0 8px; font-size:26px; letter-spacing:-.4px; }
  .hero p { margin:0; color:var(--dim); }

  article.doc { background:#fff; border:1px solid var(--line); border-radius:18px;
    padding:30px 30px 34px; box-shadow:0 10px 30px rgba(15,23,42,.05); }
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
    nav.tabs { margin-left:0; }
    .card { padding:18px 16px; }
    .hero { padding:20px; } .hero h1 { font-size:21px; }
    article.doc { padding:20px 18px 24px; }
  }
/* ==========================================================================
   END OF SHARED BASE — append page-specific styles below this marker.
   ========================================================================== */

/* ---- page: home ---- */
  /* Scoped with .home (the wrapper site/src/home.html adds) so nothing here
     can leak into the guide page. */
  .home .hero p { margin:0; }
  .home .hero p + p { margin-top:13px; }
  .home .hero a:not(.btn) { color:var(--blue); }
  .home .hero code, .home .note code, .home p.card code {
    font-family: ui-monospace, Consolas, "Courier New", monospace; font-size:.86em;
    background:#f1f4f9; border:1px solid var(--line); border-radius:6px;
    padding:1px 5px; color:#39424f; overflow-wrap:anywhere; }

  /* One-line caption sitting directly under the action row (home only) */
  .home p.card { margin:0 0 22px; font-size:14.5px; color:var(--dim); }

  .home .card h2 { margin:0 0 14px; font-size:19px; letter-spacing:-.2px; }
  .home .card p { margin:10px 0; }
  .home .card > :first-child { margin-top:0; }
  .home .card > :last-child { margin-bottom:0; }
  .home .card a:not(.btn) { color:var(--blue); }

  /* Store buttons — 直达 Chrome / Edge / Firefox 的油猴商店 */
  .home .stores { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0 16px; }
  .home .store { display:inline-flex; align-items:center; justify-content:center;
    font-size:14px; font-weight:600; text-decoration:none; color:var(--blue);
    background:#eef3ff; border:1px solid #dbe5ff; border-radius:11px; padding:9px 16px;
    transition: background .15s, border-color .15s; }
  .home .store:hover { background:#e3ecff; border-color:#c3d3ff; }

  /* Feature cards */
  .home .feats { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:12px; }
  .home .feat { background:#f7f9fc; border:1px solid var(--line); border-radius:13px; padding:13px 15px; }
  .home .feat strong { display:block; margin-bottom:4px; font-size:14.5px; }
  .home .feat span { display:block; color:var(--dim); font-size:13.5px; line-height:1.65; }

  /* Supported-site chips */
  .home .sites { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .home .chip { display:inline-block; font-size:13.5px; font-weight:600; color:#39424f;
    background:#eef2f8; border:1px solid var(--line); border-radius:99px; padding:4px 13px; }

  /* FAQ */
  .home .faq { margin:0; }
  .home .faq dt { margin-top:16px; }
  .home .faq dt:first-child { margin-top:0; }
  .home .faq dt strong { font-size:15px; }
  .home .faq dd { margin:4px 0 0; color:var(--dim); }

  /* Closing line */
  .home .tail { margin:22px 0 0; text-align:center; font-size:14px; color:var(--dim); }
  .home .tail a:not(.btn) { color:var(--blue); }

  @media (max-width: 560px) {
    .home .card h2 { font-size:17.5px; }
    .home .feats { grid-template-columns:1fr; gap:10px; }
    .home .stores { gap:8px; }
    .home .store { flex:1 1 100%; }
  }
</style>
</head>
<body>
<header class="bar">
  <div class="wrap">
    <span class="logo">▶ 一起看</span>
<nav class="tabs">
${renderTabs(activeTab)}
</nav>
    <span class="ver">v{{VERSION}}</span>
  </div>
</header>

<main class="wrap">
${actionsAbove}  <div class="page">
${body}
  </div>
</main>

<footer>
  一起看 · 视频同步 &nbsp;·&nbsp; 同步服务器地址已写入脚本 &nbsp;·&nbsp;
  <a href="${GITHUB_URL}">GitHub</a>
</footer>

<script>
(function () {
  // The canonical install link: a fixed URL, not location.origin, so the copied
  // address works no matter which of the two sites the page is served from.
  var SCRIPT_URL = "{{SCRIPT_URL}}";
  // The copy sits next to this page (the build publishes it in both dirs).
  var LOCAL = new URL("watch-party.user.js", document.baseURI).href;
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
    fetch(LOCAL, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(copyText)
      .then(function () {
        copyBtn.disabled = false;
        flash(copyBtn, "已复制，可粘贴到油猴", true);
      })
      .catch(function () {
        copyBtn.disabled = false;
        // Last resort: show the source so it can be selected by hand.
        window.open(LOCAL, "_blank");
        flash(copyBtn, "已打开脚本源码，请全选后复制", false);
      });
  });

  urlBtn.addEventListener("click", function () {
    copyText(SCRIPT_URL)
      .then(function () { flash(urlBtn, "安装地址已复制", true); })
      .catch(function () { flash(urlBtn, "复制失败，请手动复制", false); });
  });
})();
</script>
</body>
</html>
`;
}
