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

const ACTIONS_INNER = `
    <div class="actions">
      <a class="btn primary" id="install" href="{{SCRIPT_URL}}">一键安装脚本</a>
      <button class="btn" type="button" id="copy">复制脚本代码</button>
      <button class="btn" type="button" id="copyurl">复制安装地址</button>
    </div>
    <p class="note">
      使用前需安装 <strong>Tampermonkey（油猴）</strong>，步骤见 <a href="{{GUIDE_URL}}">安装教程</a>。
      当前版本 <code>v{{VERSION}}</code>。未安装油猴时「一键安装脚本」不会生效，可改用「复制脚本代码」；
      邀请朋友时点「复制安装地址」，把链接发给对方即可。
    </p>`;

// Two shapes: a card of its own when the row sits above the body (the guide page,
// whose step 2 points at it), and a plain inline block when the body places the
// row inside its own hero — otherwise the hero would read as three stacked cards.
const ACTION_ROW = `  <section class="card install" aria-label="安装">${ACTIONS_INNER}
  </section>`;
const ACTION_ROW_INLINE = `  <div class="actions-inline" aria-label="安装">${ACTIONS_INNER}
  </div>`;

export function renderPage({ title, description, bodyHtml, activeTab }) {
  const wantsInlineActions = String(bodyHtml).includes(ACTIONS_TOKEN);
  // Above the body (default), or empty when the body places the row itself.
  const actionsAbove = wantsInlineActions ? "" : `${ACTION_ROW}\n\n`;
  const body = wantsInlineActions
    ? String(bodyHtml).split(ACTIONS_TOKEN).join(ACTION_ROW_INLINE)
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

/* ---- page: home — 两条进度条对齐 -----------------------------------------
   Two player rows, one per person, so "同步" is readable at a glance: the host's
   row never moves, the member's catches up, holds, dissolves away and repeats.
   Colour carries meaning only where the product has two people: blue is the host,
   amber is the member. Everything else stays quiet.
   -------------------------------------------------------------------------- */
.page-home {
  --host:#2b6cff;                        /* the host's timeline = the brand blue */
  --host-ink:#1d4ed8;                    /* readable on white for its timecode */
  --guest:#F59E0B;                       /* the member's — a clean amber, no text on it */
  --guest-ink:#B45309;                   /* its timecode, dark enough to read */
  --track:#eef1f7;
}
  /* Display voice: HarmonyOS Sans where it exists, YaHei otherwise — both are
     already on the machine, and neither is the reflex system-ui default. */
  .home h1, .home h2, .home h3 { font-family:"HarmonyOS Sans SC","Microsoft YaHei",system-ui,sans-serif; }
  .home .hero { padding:30px 28px 26px; }
  .home .hero h1 { margin:0 0 12px; font-size:clamp(28px,4.6vw,40px); line-height:1.2;
    letter-spacing:-.02em; font-weight:700; }
  .home .lede { margin:0; max-width:34em; font-size:15.5px; line-height:1.85; color:var(--dim); }

  /* The three actions, inline in the hero */
  .home .actions-inline { margin:24px 0 0; }
  .home .actions-inline .note code { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
    font-size:.88em; background:#f1f4f9; border:1px solid var(--line); border-radius:6px;
    padding:1px 6px; color:#39424f; overflow-wrap:anywhere; }
  .home .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .home .btn { font:inherit; font-size:14px; border-radius:10px; padding:11px 20px; cursor:pointer;
    border:1px solid var(--line); background:#f5f7fb; color:var(--ink); text-decoration:none;
    transition:background .15s, border-color .15s, filter .15s; }
  .home .btn:hover { background:#eef2f8; border-color:#d5dde9; }
  .home .btn.primary { background:var(--host); border-color:transparent; color:#fff; font-weight:700; }
  .home .btn.primary:hover { filter:brightness(1.06); }
  .home .btn.ok { background:#1f9e57; border-color:transparent; color:#fff; font-weight:700; }
  .home .note { margin:14px 0 0; font-size:13px; line-height:1.75; color:var(--dim); }
  .home .note a { color:var(--blue); }

  /* THE moment: two player rows. The seam between loops is bridged with a
     dissolve — the member's row fades and blurs out at the aligned position and
     resolves back in at its starting position, so nothing ever snaps visibly.
     This is the only animated element on the page. */
  .home .sync { display:flex; flex-direction:column; gap:14px; margin:28px 0 0; }
  .home .player { display:flex; align-items:center; gap:11px; }
  .home .play { flex:0 0 auto; width:0; height:0; border-style:solid; border-width:5px 0 5px 8px;
    border-color:transparent transparent transparent var(--dim); }
  .home .player.host .play { border-left-color:var(--host); }
  .home .player.guest .play { border-left-color:var(--guest); }
  .home .who { flex:0 0 3em; font-size:13px; color:var(--dim); }
  /* Thin enough to read as a scrubber, and the glow must not be clipped */
  .home .bar { position:relative; flex:1 1 auto; height:8px; border-radius:99px;
    background:var(--track); }
  .home .fill { position:absolute; left:0; top:0; bottom:0; border-radius:99px; }
  /* the leading edge: a bright head with a halo, so the bar glows where it moves */
  .home .fill::after { content:""; position:absolute; right:-2px; top:50%; width:9px; height:9px;
    margin-top:-4.5px; border-radius:50%; background:#fff;
    box-shadow:0 0 0 2.5px currentColor, 0 0 12px 3px currentColor; }
  .home .fill.host { width:74%; color:var(--host);
    background:linear-gradient(90deg, #9dbcff, var(--host));
    box-shadow:0 0 14px rgba(43,108,255,.45); }
  .home .fill.guest { width:74%; color:var(--guest);
    background:linear-gradient(90deg, #ffd08a, var(--guest));
    box-shadow:0 0 14px rgba(245,158,11,.45);
    animation:catchup 6.2s ease-in-out infinite; }
  .home .at { flex:0 0 3.6em; text-align:right; color:var(--dim); font-size:12.5px;
    font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-variant-numeric:tabular-nums; }
  .home .player.host .at { color:var(--host-ink); }
  .home .player.guest .at { color:var(--guest-ink); }
  @keyframes catchup {
    0%   { width:36%; opacity:0; filter:blur(3px); }
    6%   { opacity:1; filter:blur(0); }
    22%  { width:74%; }
    90%  { width:74%; opacity:1; filter:blur(0); }
    100% { width:74%; opacity:0; filter:blur(3px); }
  }
  @media (prefers-reduced-motion: reduce) { .home .fill.guest { animation:none; } }

  /* The path: a real four-step sequence, hung off a rail whose ticks carry the
     order — so the numbers are information, not decoration. */
  .home .path { margin:52px 0 0; }
  .home h2 { margin:0; font-size:20px; letter-spacing:-.01em; }
  .home .rail { list-style:none; margin:20px 0 0; padding:0 0 0 30px; position:relative;
    counter-reset:step; }
  .home .rail::before { content:""; position:absolute; left:7px; top:8px; bottom:10px; width:2px;
    border-radius:2px; background:linear-gradient(rgba(76,141,255,.85), rgba(76,141,255,.12)); }
  .home .rail > li { position:relative; margin:0 0 30px; }
  /* the tick carries the order: a playhead marker you can count */
  .home .rail > li::before { counter-increment:step; content:counter(step);
    position:absolute; left:-30px; top:3px; width:17px; height:17px; border-radius:50%;
    background:var(--host); color:#08101F; font-size:11px; font-weight:700; line-height:17px;
    text-align:center; }
  .home .rail h3 { margin:0 0 6px; font-size:16.5px; }
  .home .rail p { margin:0 0 12px; max-width:38em; font-size:14px; line-height:1.8; color:var(--dim); }
  .home .stores { display:flex; flex-wrap:wrap; gap:9px; margin:0 0 12px; }
  .home .store { font-size:13.5px; font-weight:600; text-decoration:none; color:var(--blue);
    background:#eef3ff; border:1px solid #dbe5ff; border-radius:10px; padding:9px 16px;
    transition:background .15s, border-color .15s; }
  .home .store:hover { background:#e3ecff; border-color:#c3d3ff; }

  /* Feature / FAQ lists: two quiet columns, no card chrome anywhere */
  .home .facts { margin:52px 0 0; }
  .home .pairs { margin:20px 0 0; }
  .home .pairs > div { display:grid; grid-template-columns:minmax(9em,14em) 1fr; gap:6px 22px;
    padding:13px 0; border-top:1px solid var(--line); }
  .home .pairs > div:first-child { border-top:0; padding-top:0; }
  .home .pairs dt { font-weight:600; }
  .home .pairs dd { margin:0; color:var(--dim); font-size:14px; line-height:1.75; }

  /* Supported-site chips */
  .home .sites { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0; }
  .home .chip { display:inline-block; font-size:13.5px; font-weight:600; color:#39424f;
    background:#eef2f8; border:1px solid var(--line); border-radius:99px; padding:5px 14px; }

  /* The miniatures: the interface people will actually look for, reproduced
     small. A dashed frame says "this is a picture", not a live control. */
  .home .demo { display:flex; align-items:center; justify-content:center; gap:14px;
    margin:0 0 4px; padding:20px 16px; border:1px dashed #dbe2ec;
    border-radius:14px; background:#f7f9fc; }

  /* The miniatures keep the real interface's own colours — the panel really is a
     white card — so they read as pictures of the product rather than decoration. */
  /* ① the userscript menu, its first row being the one to click */
  .home .menu { width:236px; background:#fff; border:1px solid #e6eaf1; border-radius:11px;
    box-shadow:0 8px 22px rgba(15,23,42,.10); padding:5px; }
  .home .menu-head { display:flex; align-items:center; gap:8px; padding:5px 9px 7px;
    border-bottom:1px solid #f0f3f8; margin-bottom:4px; }
  .home .menu-name { flex:1 1 auto; font-size:11px; font-weight:600; color:#1b2130;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .home .menu-switch { flex:0 0 auto; width:22px; height:12px; border-radius:99px; background:var(--host);
    position:relative; }
  .home .menu-switch::after { content:""; position:absolute; right:2px; top:2px; width:8px; height:8px;
    border-radius:50%; background:#fff; }
  .home .menu-row { display:flex; align-items:center; gap:7px; font-size:11px; color:#5b6472;
    padding:6px 9px; border-radius:7px; white-space:nowrap; overflow:hidden; }
  .home .menu-row svg { flex:0 0 auto; color:#98a3b5; }
  .home .menu-row span { overflow:hidden; text-overflow:ellipsis; }
  .home .menu-row.on { background:#e9f0ff; color:#1c3fae; font-weight:600; }
  .home .menu-row.on svg { color:#1c3fae; }

  /* ② the panel itself, plus its round button — the icon is the same one the
     script really draws, so the picture matches what people will see */
  .home .mini-panel { width:196px; background:#fff; border-radius:14px; padding:11px 12px;
    box-shadow:0 12px 30px rgba(15,23,42,.13); }
  .home .mini-title { margin:0 0 7px; font-size:11.5px; font-weight:700; color:#1b2130; }
  .home .mini-input { font-size:10.5px; color:#9aa4b5; background:#f5f7fb; border:1px solid #e7ebf2;
    border-radius:7px; padding:6px 8px; }
  .home .mini-btn { margin:7px 0; font-size:10.5px; font-weight:600; color:#fff; text-align:center;
    background:var(--host); border-radius:8px; padding:7px 8px; }
  .home .mini-join { display:flex; gap:6px; }
  .home .mini-input.sm { flex:1 1 auto; }
  .home .mini-ghost { flex:0 0 auto; font-size:10.5px; color:#4a5568; background:#f5f7fb;
    border:1px solid #e3e8f0; border-radius:8px; padding:6px 10px; }
  .home .mini-fab { flex:0 0 auto; width:44px; height:44px; border-radius:50%; display:flex;
    align-items:center; justify-content:center; color:#fff; opacity:.8;
    background:linear-gradient(150deg,#6d8bff,#2b6cff);
    box-shadow:0 10px 28px rgba(43,108,255,.42), inset 0 1px 0 rgba(255,255,255,.38); }

  /* ③ the room code, then the two people who just joined it */
  .home .mini-code { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-size:20px;
    font-weight:700; letter-spacing:.2em; color:#1b2130; background:#fff; border-radius:11px;
    padding:9px 14px 9px 18px; box-shadow:0 12px 30px rgba(15,23,42,.13); }
  .home .mini-people { display:flex; flex-direction:column; gap:7px; font-size:12px; color:var(--dim); }
  .home .mini-people > div { display:flex; align-items:center; gap:7px; }
  .home .mini-people b { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
    font-variant-numeric:tabular-nums; color:var(--ink); font-weight:600; }
  .home .dot { flex:0 0 auto; width:7px; height:7px; border-radius:50%; background:#1f9e57; }

  /* Closing line */
  .home .tail { margin:48px 0 0; font-size:14px; color:var(--dim); }
  .home .tail a { color:var(--blue); }

  @media (max-width: 640px) {
    .home .hero { padding:22px 16px 20px; }
    .home .pairs > div { grid-template-columns:1fr; gap:3px 0; }
    .home .store { flex:1 1 100%; text-align:center; }
    .home .demo { padding:16px 12px; }
    .home .sync { margin-top:22px; }
  }
</style>
</head>
<body class="page-${activeTab === "home" ? "home" : "guide"}">
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
  「一起看」是一个油猴脚本，同步服务器地址已写入脚本。源码见 <a href="${GITHUB_URL}">GitHub</a>。
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
