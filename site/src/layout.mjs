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
      使用前需安装 <strong>Tampermonkey（油猴）</strong>，下方有完整安装引导。
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

// Landing page only: pick the theme before first paint (saved choice, else the
// system preference), so a light-mode visitor never sees a dark flash.
const THEME_BOOT = `<script>
(function () {
  var t;
  try { t = localStorage.getItem("wp-theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") t = window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
})();
</script>
`;

const THEME_TOGGLE = `    <button class="theme" id="theme" type="button" aria-label="切换浅色 / 深色模式">
      <svg class="moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
      <svg class="sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>
`;

export function renderPage({ title, description, bodyHtml, activeTab }) {
  const wantsInlineActions = String(bodyHtml).includes(ACTIONS_TOKEN);
  const actionsInner = wantsInlineActions
    ? ACTIONS_INNER
    : ACTIONS_INNER.replace("下方有完整安装引导。", '详细步骤见 <a href="{{GUIDE_URL}}">安装教程</a>。');
  // Above the body (default), or empty when the body places the row itself.
  const actionRow = wantsInlineActions
    ? `  <div class="actions-inline" aria-label="安装">${actionsInner}
  </div>`
    : `  <section class="card install" aria-label="安装">${actionsInner}
  </section>`;
  const actionsAbove = wantsInlineActions ? "" : `${actionRow}\n\n`;
  const body = wantsInlineActions
    ? String(bodyHtml).split(ACTIONS_TOKEN).join(actionRow)
    : bodyHtml;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${THEME_BOOT}<title>${escapeHtml(title)}</title>
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
  html { scroll-behavior:smooth; }
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

/* ---- page: home — 午夜放映厅 ---------------------------------------------
   A dark room with two light sources, because the product has two people:
   blue is the host, amber is the member. They meet in one gradient only where
   the page talks about being in sync. Everything else stays near-black.
   -------------------------------------------------------------------------- */
.page-home {
  --bg:#05060b; --ink:#eef1f8; --dim:#a4acbf; --faint:#7d869a;
  --line:rgba(255,255,255,.08); --glass:rgba(255,255,255,.032);
  --host:#5b8cff; --host-soft:#a9c1ff; --guest:#ffb04a; --guest-soft:#ffd59a;
  --sync:linear-gradient(92deg,#8fb0ff 0%,#c9a6ff 48%,#ffc27a 100%);
  --display:"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;
  background:var(--bg); color:var(--ink); overflow-x:hidden;
}
/* film grain over everything, fixed so it never scrolls with content */
.page-home::after { content:""; position:fixed; inset:0; z-index:100; pointer-events:none; opacity:.07;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }

.page-home header.bar { background:rgba(5,6,11,.62); border-bottom-color:var(--line);
  backdrop-filter:blur(16px) saturate(150%); -webkit-backdrop-filter:blur(16px) saturate(150%); }
.page-home header.bar .wrap { max-width:1160px; min-height:62px; }
.page-home .logo { color:var(--ink); letter-spacing:.06em; }
.page-home .tab { color:var(--dim); }
.page-home .tab:hover { color:var(--ink); background:rgba(255,255,255,.06); }
.page-home .tab.on { color:var(--ink); background:rgba(255,255,255,.1); }
.page-home .ver { color:var(--dim); background:rgba(255,255,255,.06); font-family:var(--mono); }
.page-home main.wrap { max-width:1160px; padding-top:0; }
.page-home .page { margin-bottom:0; }
.page-home footer { color:var(--faint); padding-top:30px; border-top:1px solid var(--line); }
.page-home footer a { color:var(--dim); }
.page-home ::selection { background:rgba(91,140,255,.4); color:#fff; }

.home { position:relative; isolation:isolate; }
.home .defs { position:absolute; width:0; height:0; overflow:hidden; }
/* the header shares the content column's width, so logo and hero start on the
   same vertical line */
.page-home header.bar .wrap { max-width:1160px; }
.home h1, .home h2, .home h3 { font-family:var(--display); }
.home em { font-style:normal; background:var(--sync); -webkit-background-clip:text; background-clip:text; color:transparent; }

/* ---- hero ---- */
.home .hero { position:relative; text-align:center; margin:0; padding:104px 0 20px;
  background:none; border:0; border-radius:0; box-shadow:none; }
.home .hero::before { content:""; position:absolute; z-index:-1; left:50%; top:-160px; width:1400px; height:900px;
  transform:translateX(-50%); pointer-events:none;
  background:
    radial-gradient(32% 38% at 32% 42%, rgba(91,140,255,.30), transparent 70%),
    radial-gradient(30% 34% at 70% 48%, rgba(255,176,74,.20), transparent 70%),
    radial-gradient(40% 30% at 50% 10%, rgba(160,130,255,.14), transparent 70%);
  animation:aurora 18s ease-in-out infinite alternate; }
@keyframes aurora {
  0%   { transform:translateX(-50%) scale(1); filter:hue-rotate(0deg); }
  100% { transform:translateX(-48%) scale(1.08); filter:hue-rotate(-14deg); }
}
.home .eyebrow { display:inline-flex; align-items:center; gap:10px; margin:0 0 30px; padding:7px 15px 7px 12px;
  border:1px solid rgba(255,255,255,.12); border-radius:99px; background:rgba(255,255,255,.04);
  color:#b7bfd2; font-size:12.5px; letter-spacing:.08em; }
.home .live { position:relative; width:7px; height:7px; border-radius:50%; background:#4ade80; }
.home .live::after { content:""; position:absolute; inset:-4px; border-radius:50%; border:1.5px solid #4ade80;
  animation:ping 2s cubic-bezier(0,0,.2,1) infinite; }
@keyframes ping { 0% { transform:scale(.6); opacity:.9; } 100% { transform:scale(2); opacity:0; } }
.home .hero h1 { margin:0 auto; font-size:clamp(46px,8.4vw,104px); line-height:1.04; font-weight:800;
  letter-spacing:-.045em; color:#f5f7fc; text-wrap:balance;
  /* both lines end in a full-width mark (，。), whose glyph only fills the left
     half of its box — centering on the full box leaves the type looking left-
     heavy, so nudge the whole heading back onto the optical centre */
  transform:translateX(.25em); }
/* the two lines overlap: the first sits back as a fading echo, the second rides
   up over it, so the eye reads depth instead of two stacked lines */
.home .hero h1 .l1 { color:transparent;
  background:linear-gradient(180deg, rgba(228,232,244,.62), rgba(228,232,244,.20));
  -webkit-background-clip:text; background-clip:text; }
.home .hero h1 em { display:inline-block; position:relative; top:-.2em; z-index:1;
  padding-bottom:.06em; background-size:200% 100%;
  animation:sheen 8s ease-in-out infinite alternate; }
@keyframes sheen { 0% { background-position:0% 0; } 100% { background-position:100% 0; } }
.home .lede { margin:30px auto 0; max-width:34em; font-size:17px; line-height:1.9; color:var(--dim); }

/* the shell's action row, re-dressed for the dark room */
.home .actions-inline { margin:40px auto 0; max-width:640px; }
.home .hero-guide-link { display:inline-flex; align-items:center; gap:7px; margin-top:18px;
  color:var(--dim); font-size:13px; text-decoration:none; transition:color .2s, transform .2s; }
.home .hero-guide-link:hover { color:var(--host-soft); transform:translateY(2px); }
.home .actions { display:flex; flex-wrap:wrap; justify-content:center; gap:12px; }
.home .btn { position:relative; overflow:hidden; font:inherit; font-size:14.5px; font-weight:500;
  padding:13px 24px; border-radius:99px; cursor:pointer; text-decoration:none; color:var(--ink);
  background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.14);
  transition:background .2s, border-color .2s, transform .2s, box-shadow .2s; }
.home .btn:hover { background:rgba(255,255,255,.1); border-color:rgba(255,255,255,.28); transform:translateY(-1px); }
.home .btn.primary { color:#fff; font-weight:700; border-color:transparent;
  background:linear-gradient(135deg,#5f8cff,#3d63f2 55%,#5b48ec);
  box-shadow:0 0 0 1px rgba(140,170,255,.45) inset, 0 14px 40px -10px rgba(91,140,255,.9); }
.home .btn.primary::after { content:""; position:absolute; top:0; bottom:0; left:-60%; width:40%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);
  transform:skewX(-20deg); animation:glint 4.5s ease-in-out infinite; }
@keyframes glint { 0%, 60% { left:-60%; } 100% { left:130%; } }
.home .btn.primary:hover { box-shadow:0 0 0 1px rgba(160,190,255,.6) inset, 0 18px 50px -10px rgba(91,140,255,1); }
.home .btn.ok { background:linear-gradient(135deg,#4ade80,#16a34a); color:#04220f; border-color:transparent; font-weight:700; }
.home .note { margin:16px auto 0; max-width:40em; font-size:13px; line-height:1.8; color:var(--faint); }
.home .note strong { color:var(--dim); font-weight:600; }
.home .note a { color:var(--host-soft); }
.home .note code { font-family:var(--mono); font-size:.9em; color:var(--dim); background:rgba(255,255,255,.06);
  border:1px solid var(--line); border-radius:6px; padding:1px 6px; }

/* ---- the stage: two screens that really are in sync ---- */
.home .stage { position:relative; display:grid; grid-template-columns:1fr 150px 1fr; align-items:center;
  max-width:1080px; margin:76px auto 0; padding:0 48px; perspective:1800px; text-align:left; }
.home .screen { position:relative; padding:10px 10px 12px; border-radius:18px;
  background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.11);
  box-shadow:0 50px 90px -40px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.08);
  transition:transform .8s cubic-bezier(.2,.8,.2,1); }
.home .screen::after { content:""; position:absolute; z-index:-1; left:12%; right:12%; bottom:-34px; height:60px;
  background:var(--c); filter:blur(46px); opacity:.42; border-radius:50%; }
.home .screen.host { --c:var(--host); --c-soft:var(--host-soft); transform:rotateY(16deg); transform-origin:right center; }
.home .screen.guest { --c:var(--guest); --c-soft:var(--guest-soft); transform:rotateY(-16deg); transform-origin:left center; }
.home .stage:hover .screen { transform:rotateY(0); }
.home .chrome { display:flex; align-items:center; gap:6px; padding:2px 4px 10px; }
.home .chrome > i { width:8px; height:8px; border-radius:50%; background:rgba(255,255,255,.14); }
.home .tag { margin-left:auto; display:inline-flex; align-items:center; gap:7px; font-size:12px; color:#c4cbdb; }
.home .who-dot { width:7px; height:7px; border-radius:50%; background:var(--c); box-shadow:0 0 10px var(--c); }
.home .frame { position:relative; aspect-ratio:16/9; border-radius:10px; overflow:hidden; background:#000; }
.home .frame::before { content:""; position:absolute; inset:0; z-index:1; pointer-events:none;
  background:radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,.55)); }
.home .frame::after { content:""; position:absolute; inset:0; z-index:2; pointer-events:none; border-radius:10px;
  box-shadow:inset 0 0 0 2px var(--c), inset 0 0 40px var(--c); opacity:0; }
.home .screen.synced .frame::after { animation:lockon .9s ease-out; }
@keyframes lockon { 0% { opacity:1; } 100% { opacity:0; } }
.home .film { display:block; width:100%; height:100%; }
.home .state { position:absolute; inset:0; z-index:3; display:grid; place-items:center;
  background:rgba(4,6,14,0); transition:background .35s; }
.home .state > i { grid-area:1/1; opacity:0; transition:opacity .3s, transform .3s; transform:scale(.8); }
.home .pz { width:34px; height:34px; border-radius:50%; background:rgba(255,255,255,.14);
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); position:relative; }
.home .pz::before, .home .pz::after { content:""; position:absolute; top:11px; width:4px; height:12px; border-radius:2px; background:#fff; }
.home .pz::before { left:12px; } .home .pz::after { right:12px; }
.home .spin { width:28px; height:28px; border-radius:50%; border:2.5px solid rgba(255,255,255,.2);
  border-top-color:var(--c-soft); animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.home .screen.paused .state, .home .screen.buffering .state { background:rgba(4,6,14,.42); }
.home .screen.paused .pz, .home .screen.buffering .spin { opacity:1; transform:none; }
.home .scrub { position:relative; height:4px; margin:13px 3px 0; border-radius:99px; background:rgba(255,255,255,.1); }
.home .scrub-fill { position:absolute; left:0; top:0; bottom:0; width:52.4%; border-radius:99px;
  background:linear-gradient(90deg,transparent,var(--c)); box-shadow:0 0 12px var(--c); }
.home .scrub-fill::after { content:""; position:absolute; right:-5px; top:50%; width:10px; height:10px; margin-top:-5px;
  border-radius:50%; background:#fff; box-shadow:0 0 0 3px var(--c), 0 0 16px 2px var(--c); }
.home .meta { display:flex; justify-content:space-between; margin:10px 3px 0; font:12px/1 var(--mono);
  font-variant-numeric:tabular-nums; color:var(--faint); }
.home .meta .tc { color:var(--c-soft); }

.home .link { position:relative; height:120px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; }
.home .delta { display:inline-block; padding:6px 11px; border-radius:99px; white-space:nowrap;
  font:600 12px/1 var(--mono); font-variant-numeric:tabular-nums; color:#dfe5f3;
  background:rgba(12,14,24,.85); border:1px solid rgba(255,255,255,.14);
  box-shadow:0 0 24px rgba(160,140,255,.25); transition:color .3s, border-color .3s; }
.home .stage.apart .delta { color:var(--guest-soft); border-color:rgba(255,176,74,.5); }
.home .beam { position:relative; width:100%; height:2px; border-radius:2px;
  background:linear-gradient(90deg,var(--host),#b39bff,var(--guest)); opacity:.55; box-shadow:0 0 14px rgba(170,150,255,.5); }
.home .beam i { position:absolute; top:50%; left:0; width:22px; height:4px; margin:-2px 0 0 -11px; border-radius:4px;
  background:#fff; box-shadow:0 0 12px 3px #c9b8ff; opacity:0; }
.home .stage.send .beam i { animation:travel .6s cubic-bezier(.5,0,.3,1) both; }
.home .stage.send .beam i:nth-child(2) { animation-delay:.08s; }
.home .stage.send .beam i:nth-child(3) { animation-delay:.16s; }
@keyframes travel { 0% { left:0; opacity:0; } 15% { opacity:1; } 85% { opacity:1; } 100% { left:100%; opacity:0; } }

.home .ticker { grid-column:1/-1; list-style:none; margin:46px auto 0; padding:0; width:min(420px,100%);
  font:12.5px/1 var(--mono); color:var(--dim); min-height:84px; }
.home .ticker li { display:flex; align-items:center; gap:12px; padding:6px 0; animation:tickin .45s ease-out both; }
.home .ticker li:nth-child(2) { opacity:.5; } .home .ticker li:nth-child(3) { opacity:.22; }
.home .ticker .tc { color:var(--faint); font-variant-numeric:tabular-nums; }
.home .ticker b { font-weight:600; margin-right:2px; }
.home .ticker b.host { color:var(--host-soft); } .home .ticker b.guest { color:var(--guest-soft); }
@keyframes tickin { from { transform:translateY(-8px); opacity:0; } }

/* ---- numbers ---- */
.home .stats { display:grid; grid-template-columns:repeat(4,1fr); margin:110px 0 0;
  border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.home .stat { padding:34px 26px; border-left:1px solid var(--line); }
.home .stat:first-child { border-left:0; }
.home .stat b { display:block; font:800 clamp(30px,3.6vw,46px)/1 var(--display); letter-spacing:-.03em;
  background:linear-gradient(180deg,#fff,#9aa3b8); -webkit-background-clip:text; background-clip:text; color:transparent; }
.home .stat span { display:block; margin-top:12px; font-size:13px; color:var(--dim); }

/* ---- section heads ---- */
.home .block { margin:150px 0 0; }
.home .kicker { display:flex; align-items:center; gap:12px; margin:0 0 16px; font:600 12px/1 var(--mono);
  letter-spacing:.14em; color:var(--host-soft); }
.home .kicker::before { content:""; width:28px; height:1px; background:linear-gradient(90deg,var(--host),transparent); }
.home h2 { margin:0; font-size:clamp(32px,4.6vw,56px); line-height:1.1; font-weight:800; letter-spacing:-.04em; color:#f3f5fb; }

/* ---- bento ---- */
.home .bento { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-top:52px; }
.home .cell { position:relative; overflow:hidden; padding:28px 26px; border-radius:22px;
  background:var(--glass); border:1px solid var(--line); transition:border-color .3s, transform .3s; }
.home .cell::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity .3s;
  background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%), rgba(140,160,255,.13), transparent 45%); }
.home .cell:hover { border-color:rgba(255,255,255,.16); }
.home .cell:hover::before { opacity:1; }
.home .cell.wide { grid-column:span 2; display:grid; grid-template-columns:1fr 1fr; gap:26px; align-items:center; }
.home .ico { display:grid; place-items:center; width:40px; height:40px; border-radius:12px;
  color:var(--host-soft); background:rgba(91,140,255,.12); border:1px solid rgba(91,140,255,.28); }
.home .ico.amber { color:var(--guest-soft); background:rgba(255,176,74,.1); border-color:rgba(255,176,74,.28); }
.home .cell h3 { margin:20px 0 8px; font-size:17.5px; letter-spacing:-.01em; color:#f0f2f8; }
.home .cell p { margin:0; font-size:14px; line-height:1.8; color:var(--dim); }
.home .duo { position:relative; display:flex; flex-direction:column; gap:18px; padding:24px 0; }
.home .duo-row { position:relative; height:6px; border-radius:99px; background:rgba(255,255,255,.08); }
.home .duo-row span { position:absolute; left:0; top:0; bottom:0; width:64%; border-radius:99px; }
.home .duo-row.host span { background:linear-gradient(90deg,transparent,var(--host)); box-shadow:0 0 14px var(--host); }
.home .duo-row.guest span { background:linear-gradient(90deg,transparent,var(--guest)); box-shadow:0 0 14px var(--guest);
  animation:duo 5s cubic-bezier(.6,0,.2,1) infinite; }
@keyframes duo { 0%, 15% { width:28%; } 35%, 100% { width:64%; } }
.home .duo-head { position:absolute; left:64%; top:6px; bottom:6px; width:0; border-left:1px dashed rgba(255,255,255,.35); }
.home .duo-head b { position:absolute; top:-8px; left:8px; font:600 11px/1 var(--mono); color:#dfe5f3; }
.home .crew { display:flex; flex-direction:column; gap:10px; }
.home .mate { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:12px;
  background:rgba(255,255,255,.04); border:1px solid var(--line); font-size:13px; color:#cfd5e3; }
.home .mate em { margin-left:auto; font-size:11.5px; background:none; color:var(--faint); }
.home .av { display:grid; place-items:center; width:24px; height:24px; border-radius:50%; font-size:11px; font-weight:700;
  color:#0b1024; background:var(--host-soft); }
.home .mate.slow { border-color:rgba(255,176,74,.35); background:rgba(255,176,74,.06); }
.home .mate.slow .av { background:var(--guest-soft); position:relative; }
.home .mate.slow .av::after { content:""; position:absolute; inset:-4px; border-radius:50%;
  border:2px solid transparent; border-top-color:var(--guest); animation:spin 1s linear infinite; }
.home .mate.slow em { color:var(--guest-soft); }

/* ---- steps: big outlined numerals carry the order ---- */
.home .steps { list-style:none; margin:40px 0 0; padding:0; counter-reset:step; }
.home #install-steps { scroll-margin-top:86px; }
.home .steps > li { counter-increment:step; display:grid; grid-template-columns:130px minmax(0,1fr) minmax(0,380px);
  gap:36px; align-items:center; padding:44px 0; border-top:1px solid var(--line); }
.home .steps > li:last-child { border-bottom:1px solid var(--line); }
.home .steps > li::before { content:counter(step,decimal-leading-zero); align-self:start;
  font:800 76px/.9 var(--display); letter-spacing:-.05em; color:transparent;
  -webkit-text-stroke:1px rgba(255,255,255,.22); transition:color .4s, -webkit-text-stroke-color .4s; }
.home .steps > li:hover::before { color:rgba(91,140,255,.16); -webkit-text-stroke-color:var(--host-soft); }
.home .steps h3 { margin:0 0 12px; font-size:22px; letter-spacing:-.02em; color:#f0f2f8; }
.home .steps p { margin:0; font-size:14.5px; line-height:1.85; color:var(--dim); }
.home .steps p.note { margin:14px 0 0; max-width:none; font-size:13px; color:var(--faint); }
.home .demo { position:relative; display:flex; align-items:center; justify-content:center; gap:16px;
  min-height:180px; padding:26px 20px; border-radius:18px; border:1px solid var(--line);
  background:radial-gradient(120% 100% at 50% 0%, rgba(91,140,255,.10), transparent 60%), rgba(255,255,255,.025); }
.home .demo.stores { flex-direction:column; align-items:stretch; gap:10px; }
.home .store { display:flex; align-items:center; justify-content:space-between; padding:13px 18px; border-radius:12px;
  font-size:14px; font-weight:600; text-decoration:none; color:var(--ink);
  background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1); transition:background .2s, border-color .2s; }
.home .store i { font-style:normal; color:var(--faint); transition:transform .2s, color .2s; }
.home .store:hover { background:rgba(91,140,255,.12); border-color:rgba(91,140,255,.45); }
.home .store:hover i { color:var(--host-soft); transform:translate(2px,-2px); }
.home .mini-script { margin:0; width:100%; padding:18px 20px; border-radius:12px; background:#0b0d16;
  border:1px solid rgba(255,255,255,.08); font:12.5px/1.9 var(--mono); color:#d7dcea; white-space:pre; overflow:hidden; }
.home .mini-script .k { color:#7f8aa6; }
.home .mini-script .v { color:var(--guest-soft); }
.home .caret { display:inline-block; width:7px; height:14px; margin-left:4px; vertical-align:-2px;
  background:var(--host-soft); animation:blink 1.1s steps(1) infinite; }
@keyframes blink { 50% { opacity:0; } }

/* the miniatures keep the real interface's own colours, so they read as
   pictures of the product rather than decoration */
.home .browser { display:flex; flex-direction:column; align-items:stretch; gap:9px; width:264px; }
.home .addressbar { display:flex; align-items:center; gap:8px; padding:8px 12px;
  border-radius:99px; background:#f1f3f8; border:1px solid #e2e7f0; }
.home .ab-lock { flex:0 0 auto; }
.home .ab-url { flex:1 1 auto; font-size:11.5px; color:#3c4658; }
.home .ab-exts { flex:0 0 auto; display:flex; align-items:center; gap:5px; }
.home .ab-tm { position:relative; flex:0 0 auto; display:grid; place-items:center; width:22px; height:22px;
  border-radius:50%; background:#fff; border:1px solid #dfe4ee;
  box-shadow:0 0 0 2px rgba(91,140,255,.55); animation:hint 2.4s ease-in-out infinite; }
.home .ab-tm::after { content:""; position:absolute; left:50%; top:calc(100% + 1px); width:2px; height:8px;
  margin-left:-1px; border-radius:2px; background:rgba(91,140,255,.55); }
.home .ab-ext { flex:0 0 auto; display:grid; place-items:center; width:20px; height:20px;
  color:#9aa3b5; background:none; }
.home .menu { width:240px; background:#fff; border-radius:12px; padding:5px;
  box-shadow:0 24px 50px -12px rgba(0,0,0,.7); }
.home .menu-head { display:flex; align-items:center; gap:8px; padding:5px 9px 7px; border-bottom:1px solid #f0f3f8; margin-bottom:4px; }
.home .menu-name { flex:1 1 auto; font-size:11px; font-weight:600; color:#1b2130; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.home .menu-switch { position:relative; flex:0 0 auto; width:22px; height:12px; border-radius:99px; background:#2b6cff; }
.home .menu-switch::after { content:""; position:absolute; right:2px; top:2px; width:8px; height:8px; border-radius:50%; background:#fff; }
.home .menu-row { display:flex; align-items:center; gap:7px; padding:6px 9px; border-radius:7px; font-size:11px; color:#5b6472; white-space:nowrap; overflow:hidden; }
.home .menu-row svg { flex:0 0 auto; color:#98a3b5; }
.home .menu-row span { overflow:hidden; text-overflow:ellipsis; }
.home .menu-row.on { background:#e9f0ff; color:#1c3fae; font-weight:600; box-shadow:0 0 0 2px rgba(91,140,255,.55); animation:hint 2.4s ease-in-out infinite; }
.home .menu-row.on svg { color:#1c3fae; }
@keyframes hint { 50% { box-shadow:0 0 0 5px rgba(91,140,255,.18); } }
.home .mini-panel { width:196px; background:#fff; border-radius:14px; padding:11px 12px; box-shadow:0 24px 50px -12px rgba(0,0,0,.7); }
.home .mini-title { margin:0 0 7px; font-size:11.5px; font-weight:700; color:#1b2130; }
.home .mini-input { font-size:10.5px; color:#9aa4b5; background:#f5f7fb; border:1px solid #e7ebf2; border-radius:7px; padding:6px 8px; }
.home .mini-btn { margin:7px 0; font-size:10.5px; font-weight:600; color:#fff; text-align:center; background:#2b6cff; border-radius:8px; padding:7px 8px; }
.home .mini-join { display:flex; gap:6px; }
.home .mini-input.sm { flex:1 1 auto; }
.home .mini-ghost { flex:0 0 auto; font-size:10.5px; color:#4a5568; background:#f5f7fb; border:1px solid #e3e8f0; border-radius:8px; padding:6px 10px; }
.home .mini-fab { flex:0 0 auto; display:flex; align-items:center; justify-content:center; width:46px; height:46px; border-radius:50%;
  color:#fff; background:linear-gradient(150deg,#6d8bff,#2b6cff);
  box-shadow:0 10px 30px rgba(43,108,255,.55), inset 0 1px 0 rgba(255,255,255,.38); }
.home .mini-code { display:flex; gap:6px; }
.home .mini-code span { display:grid; place-items:center; width:30px; height:40px; border-radius:9px;
  font:700 18px/1 var(--mono); color:#fff; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.14);
  animation:digit 3.6s ease-in-out infinite; }
.home .mini-code span:nth-child(2) { animation-delay:.1s; } .home .mini-code span:nth-child(3) { animation-delay:.2s; }
.home .mini-code span:nth-child(4) { animation-delay:.3s; } .home .mini-code span:nth-child(5) { animation-delay:.4s; }
.home .mini-code span:nth-child(6) { animation-delay:.5s; }
@keyframes digit { 0%, 70%, 100% { border-color:rgba(255,255,255,.14); } 80% { border-color:var(--host-soft); box-shadow:0 0 16px rgba(91,140,255,.5); } }
.home .mini-people { display:flex; flex-direction:column; gap:8px; font-size:12.5px; color:var(--dim); }
.home .mini-people > div { display:flex; align-items:center; gap:8px; }
.home .mini-people b { font:600 12.5px/1 var(--mono); font-variant-numeric:tabular-nums; color:var(--ink); }
.home .dot { flex:0 0 auto; width:7px; height:7px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; }

/* ---- FAQ ---- */
.home .faq { margin-top:40px; border-top:1px solid var(--line); }
.home .faq details { border-bottom:1px solid var(--line); }
.home .faq summary { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:24px 4px;
  cursor:pointer; list-style:none; font-size:17px; font-weight:600; color:#e9ecf4; transition:color .2s; }
.home .faq summary::-webkit-details-marker { display:none; }
.home .faq summary::after { content:"+"; flex:0 0 auto; display:grid; place-items:center; width:30px; height:30px;
  border-radius:50%; border:1px solid rgba(255,255,255,.14); font:400 18px/1 var(--mono); color:var(--dim);
  transition:transform .3s, border-color .3s, color .3s; }
.home .faq summary:hover { color:#fff; }
.home .faq details[open] summary::after { transform:rotate(45deg); color:var(--host-soft); border-color:rgba(91,140,255,.5); }
.home .faq details p { margin:0; padding:0 60px 26px 4px; font-size:14.5px; line-height:1.85; color:var(--dim); }

/* ---- finale: a projector beam from above ---- */
.home .finale { position:relative; margin:160px 0 90px; padding:120px 24px 70px; text-align:center;
  border-radius:32px; overflow:hidden; border:1px solid var(--line);
  background:
    radial-gradient(60% 55% at 50% 0%, rgba(150,140,255,.28), transparent 70%),
    linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0)); }
.home .finale::before { content:""; position:absolute; z-index:-1; left:50%; top:-40px; width:900px; height:560px;
  transform:translateX(-50%); pointer-events:none; opacity:.55;
  background:conic-gradient(from 180deg at 50% 0%, transparent 160deg, rgba(190,180,255,.35) 172deg,
    rgba(255,210,160,.28) 188deg, transparent 200deg);
  filter:blur(18px); }
.home .finale h2 { font-size:clamp(40px,7vw,84px); }
.home .finale > p { margin:22px auto 0; font-size:16.5px; color:var(--dim); }
.home .finale .actions { margin-top:36px; }
.home .finale .tail { margin-top:34px; font-size:13px; color:var(--faint); }
.home .tail a { color:var(--dim); }
.home .tail a:hover { color:var(--ink); }

/* ---- scroll reveal (only once the script has opted the page in) ---- */
.js .home .reveal { opacity:0; transform:translateY(28px); transition:opacity .9s cubic-bezier(.2,.8,.2,1), transform .9s cubic-bezier(.2,.8,.2,1); }
.js .home .reveal.in { opacity:1; transform:none; }
.js .home .bento .reveal:nth-child(2), .js .home .bento .reveal:nth-child(5) { transition-delay:.08s; }
.js .home .bento .reveal:nth-child(3), .js .home .bento .reveal:nth-child(6) { transition-delay:.16s; }

@media (max-width: 960px) {
  .home .stage { grid-template-columns:1fr; max-width:520px; padding:0; }
  .home .screen.host, .home .screen.guest { transform:none; }
  .home .link { height:96px; }
  .home .beam { width:2px; height:48px; background:linear-gradient(180deg,var(--host),#b39bff,var(--guest)); }
  .home .beam i { left:50%; top:0; width:4px; height:18px; margin:-9px 0 0 -2px; }
  .home .stage.send .beam i { animation-name:travel-v; }
  .home .link { flex-direction:row-reverse; gap:18px; }
  .home .bento { grid-template-columns:repeat(2,1fr); }
  .home .steps > li { grid-template-columns:90px minmax(0,1fr); }
  .home .steps > li::before { font-size:56px; grid-row:span 2; }
  .home .demo { grid-column:2; }
}
@keyframes travel-v { 0% { top:0; opacity:0; } 15% { opacity:1; } 85% { opacity:1; } 100% { top:100%; opacity:0; } }
@media (max-width: 640px) {
  .home .hero { padding-top:64px; }
  .home .lede { font-size:15.5px; }
  .home .stage { margin-top:52px; }
  .home .stats { grid-template-columns:repeat(2,1fr); }
  .home .stat { padding:24px 18px; }
  .home .stat:nth-child(3) { border-left:0; }
  .home .stat:nth-child(n+3) { border-top:1px solid var(--line); }
  .home .block { margin-top:110px; }
  .home .bento { grid-template-columns:1fr; }
  .home .cell.wide { grid-column:auto; grid-template-columns:1fr; }
  .home .steps > li { grid-template-columns:1fr; gap:18px; padding:34px 0; }
  .home .steps > li::before { font-size:48px; grid-row:auto; }
  .home .demo { grid-column:auto; }
  .home .faq details p { padding-right:4px; }
  .home .finale { margin:110px 0 60px; padding:80px 18px 50px; border-radius:24px; }
}
@media (prefers-reduced-motion: reduce) {
  .home *, .home *::before, .home *::after { animation:none !important; transition:none !important; }
  .js .home .reveal { opacity:1; transform:none; }
}

/* ---- theme toggle (landing page header only) ---- */
.theme { display:grid; place-items:center; width:32px; height:32px; padding:0; cursor:pointer;
  border-radius:50%; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05); color:var(--dim);
  transition:color .2s, background .2s, border-color .2s, transform .4s cubic-bezier(.2,.8,.2,1); }
.theme:hover { color:var(--ink); transform:rotate(-20deg); }
.theme .sun, [data-theme="light"] .theme .moon { display:none; }
[data-theme="light"] .theme .sun { display:block; }
.theme-anim .page, .theme-anim .page * { transition:background-color .45s, color .45s, border-color .45s, box-shadow .45s !important; }

/* ---- light theme: 日场 ---------------------------------------------------
   Same room with the lights up. The two colours keep their meaning; their
   "soft" variants become the readable, darker inks, since they are used as
   text on the page background.
   -------------------------------------------------------------------------- */
[data-theme="light"] .page-home {
  --bg:#f5f6fa; --ink:#141a2b; --dim:#4f586d; --faint:#737b8e;
  --line:rgba(20,30,60,.09); --glass:rgba(255,255,255,.72);
  --host:#3d6df2; --host-soft:#2f57d4; --guest:#f0932b; --guest-soft:#b8640a;
  --sync:linear-gradient(92deg,#3563f0 0%,#8b54f0 48%,#ef8420 100%);
  color-scheme:light;
}
[data-theme="light"] .page-home::after { opacity:.035; }
[data-theme="light"] .page-home header.bar { background:rgba(245,246,250,.75); }
[data-theme="light"] .page-home .tab:hover { background:rgba(20,30,60,.05); }
[data-theme="light"] .page-home .tab.on { background:rgba(20,30,60,.08); }
[data-theme="light"] .page-home .ver { background:rgba(20,30,60,.06); }
[data-theme="light"] .theme { border-color:var(--line); background:#fff; }
[data-theme="light"] .page-home ::selection { background:rgba(61,109,242,.25); color:var(--ink); }

[data-theme="light"] .home .hero::before { opacity:.75; }
[data-theme="light"] .home .eyebrow { color:var(--dim); border-color:var(--line); background:rgba(255,255,255,.7);
  box-shadow:0 2px 10px rgba(20,30,60,.05); }
[data-theme="light"] .home .live, [data-theme="light"] .home .dot { background:#16a34a; box-shadow:none; }
[data-theme="light"] .home .live::after { border-color:#16a34a; }
[data-theme="light"] .home .hero h1 .l1 { background:linear-gradient(180deg, rgba(20,26,43,.46), rgba(20,26,43,.14));
  -webkit-background-clip:text; background-clip:text; }
[data-theme="light"] .home .hero h1,
[data-theme="light"] .home h2,
[data-theme="light"] .home .cell h3,
[data-theme="light"] .home .steps h3 { color:var(--ink); }

[data-theme="light"] .home .btn:not(.primary) { background:#fff; border-color:rgba(20,30,60,.12); box-shadow:0 2px 8px rgba(20,30,60,.05); }
[data-theme="light"] .home .btn:not(.primary):hover { background:#fff; border-color:rgba(20,30,60,.25); }
[data-theme="light"] .home .btn.primary { border-color:transparent;
  background:linear-gradient(135deg,#3f6ef5,#2c4fdc 55%,#4a34d6);
  box-shadow:0 0 0 1px rgba(80,120,255,.35) inset, 0 14px 34px -12px rgba(61,109,242,.75); }
[data-theme="light"] .home .btn.ok { color:#fff; }
[data-theme="light"] .home .note code { background:rgba(20,30,60,.05); }

/* the screens become light bezels; the film inside stays a film */
[data-theme="light"] .home .screen { background:linear-gradient(180deg,#fff,rgba(255,255,255,.75));
  border-color:rgba(20,30,60,.1); box-shadow:0 40px 80px -36px rgba(30,40,90,.35), inset 0 1px 0 #fff; }
[data-theme="light"] .home .screen::after { opacity:.28; }
[data-theme="light"] .home .chrome > i { background:rgba(20,30,60,.13); }
[data-theme="light"] .home .tag { color:var(--dim); }
[data-theme="light"] .home .scrub { background:rgba(20,30,60,.1); }
[data-theme="light"] .home .delta { color:var(--ink); background:#fff; border-color:var(--line);
  box-shadow:0 6px 20px rgba(80,70,200,.15); }
[data-theme="light"] .home .beam { opacity:.7; box-shadow:none; }
[data-theme="light"] .home .beam i { background:#fff; box-shadow:0 0 0 1.5px #8b54f0, 0 0 12px 2px rgba(139,84,240,.6); }

[data-theme="light"] .home .stat b { background:linear-gradient(180deg,#141a2b,#5b6479);
  -webkit-background-clip:text; background-clip:text; }

[data-theme="light"] .home .cell { box-shadow:0 1px 2px rgba(20,30,60,.04), 0 12px 32px -18px rgba(20,30,60,.18); }
[data-theme="light"] .home .cell::before { background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%), rgba(61,109,242,.08), transparent 45%); }
[data-theme="light"] .home .cell:hover { border-color:rgba(61,109,242,.25); }
[data-theme="light"] .home .ico { background:rgba(61,109,242,.08); border-color:rgba(61,109,242,.2); }
[data-theme="light"] .home .ico.amber { background:rgba(240,147,43,.1); border-color:rgba(240,147,43,.28); }
[data-theme="light"] .home .duo-row { background:rgba(20,30,60,.08); }
[data-theme="light"] .home .duo-row.host span, [data-theme="light"] .home .duo-row.guest span { box-shadow:none; }
[data-theme="light"] .home .duo-head { border-left-color:rgba(20,30,60,.3); }
[data-theme="light"] .home .duo-head b { color:var(--ink); }
[data-theme="light"] .home .mate { color:var(--ink); background:#fff; }
[data-theme="light"] .home .mate.slow { background:#fff8ee; }
[data-theme="light"] .home .av { color:#fff; }

[data-theme="light"] .home .steps > li::before { -webkit-text-stroke-color:rgba(20,30,60,.2); }
[data-theme="light"] .home .steps > li:hover::before { color:rgba(61,109,242,.08); }
[data-theme="light"] .home .demo { background:radial-gradient(120% 100% at 50% 0%, rgba(61,109,242,.07), transparent 60%), rgba(255,255,255,.65); }
[data-theme="light"] .home .store { background:#fff; border-color:var(--line); }
[data-theme="light"] .home .store:hover { background:#f0f4ff; border-color:rgba(61,109,242,.4); }
[data-theme="light"] .home .mini-script { box-shadow:0 18px 40px -20px rgba(20,30,60,.5); }
[data-theme="light"] .home .caret { background:#8fb0ff; }
[data-theme="light"] .home .menu, [data-theme="light"] .home .mini-panel { box-shadow:0 18px 40px -14px rgba(20,30,60,.28); }
[data-theme="light"] .home .mini-code span { color:var(--ink); background:#fff; border-color:rgba(20,30,60,.12); }

[data-theme="light"] .home .faq summary { color:var(--ink); }
[data-theme="light"] .home .faq summary:hover { color:var(--host-soft); }
[data-theme="light"] .home .faq summary::after { border-color:rgba(20,30,60,.14); }

[data-theme="light"] .home .finale { background:
    radial-gradient(60% 55% at 50% 0%, rgba(139,84,240,.14), transparent 70%),
    linear-gradient(180deg,#fff,rgba(255,255,255,.4));
  box-shadow:0 30px 70px -40px rgba(30,40,90,.3); }
[data-theme="light"] .home .finale::before { opacity:.35; }

/* ---- page: guide — 日场 / 夜场同一套阅读界面 -----------------------------
   The tutorial is a long read, so it keeps the landing page's voice — same
   type scale, same corners, same two accents — but drops the theatre: one
   quiet surface, generous leading, and a table of contents that follows along.
   Dark is the default, matching the landing page; the toggle switches it.
   -------------------------------------------------------------------------- */
.page-guide {
  --bg:#0a0c14; --ink:#e9ecf6; --dim:#a3acc2; --faint:#7c859c;
  --line:rgba(255,255,255,.10); --glass:rgba(255,255,255,.035);
  --blue:#6d8bff; --amber:#ffb04a; --code:#0b0e1a;
  background:var(--bg); color:var(--ink);
}
.page-guide::before { content:""; position:fixed; z-index:-1; inset:0; pointer-events:none;
  background:
    radial-gradient(38% 26% at 12% 0%, rgba(91,140,255,.16), transparent 70%),
    radial-gradient(34% 24% at 88% 14%, rgba(255,176,74,.10), transparent 70%); }
.page-guide header.bar { background:rgba(10,12,20,.78); border-bottom-color:var(--line); }
.page-guide header.bar .wrap { max-width:1140px; }
.page-guide .logo { color:var(--ink); }
.page-guide .tab { color:var(--dim); }
.page-guide .tab:hover { color:var(--blue); background:rgba(255,255,255,.06); }
.page-guide .tab.on { color:var(--blue); background:rgba(109,139,255,.14); font-weight:600; }
.page-guide .ver { color:var(--dim); background:rgba(255,255,255,.06); }
.page-guide .card.install { background:var(--glass); border-color:var(--line);
  box-shadow:0 20px 50px -30px rgba(0,0,0,.9); }
.page-guide .install h1 { color:var(--ink); }
.page-guide .btn { background:rgba(255,255,255,.05); border-color:var(--line); color:var(--ink); }
.page-guide .btn:hover { background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.2); }
.page-guide .btn.primary { background:linear-gradient(135deg,#5b8cff,#2b6cff); border-color:transparent; color:#fff; }
.page-guide .note { color:var(--dim); }
.page-guide footer { color:var(--faint); }
.page-guide footer a { color:var(--dim); }

/* the reading grid: contents on the left, the text on the right.
   The contents column is bought with width, not taken from the prose — hence
   the wider shell, so the measure still lands near 45 CJK characters. */
.page-guide main.wrap { max-width:1140px; }
.page-guide .page { display:grid; grid-template-columns:200px minmax(0,1fr); gap:40px; align-items:start; }
.doc-nav { position:sticky; top:78px; display:flex; flex-direction:column; gap:2px; padding:4px 0 0; }
.doc-nav .toc-h { margin:0 0 10px; font-size:11.5px; font-weight:700; letter-spacing:.14em;
  text-transform:uppercase; color:var(--faint); }
.doc-nav .toc { display:block; padding:7px 12px; border-radius:9px; border-left:2px solid transparent;
  font-size:13px; line-height:1.5; color:var(--dim); text-decoration:none;
  transition:color .18s, background .18s, border-color .18s; }
.doc-nav .toc:hover { color:var(--ink); background:rgba(255,255,255,.05); }
.doc-nav .toc.l3 { padding-left:22px; font-size:12.5px; color:var(--faint); }
.doc-nav .toc.on { color:var(--blue); background:rgba(109,139,255,.1); border-left-color:var(--blue); font-weight:600; }

article.doc { background:var(--glass); border:1px solid var(--line); border-radius:22px;
  padding:40px 42px 46px; box-shadow:0 24px 60px -34px rgba(0,0,0,.9); }
article.doc h1 { margin:0 0 18px; font-size:clamp(24px,3.2vw,31px); line-height:1.25; letter-spacing:-.02em;
  font-weight:800; color:var(--ink); }
article.doc h2 { margin:44px 0 14px; padding-top:26px; font-size:20px; letter-spacing:-.01em;
  border-top:1px solid var(--line); color:var(--ink); scroll-margin-top:86px; }
article.doc h2:first-of-type { border-top:0; padding-top:0; }
article.doc h3 { margin:30px 0 10px; font-size:16.5px; color:var(--ink); scroll-margin-top:86px; }
article.doc p { margin:12px 0; line-height:1.9; color:var(--dim); }
article.doc strong { color:var(--ink); font-weight:600; }
article.doc a { color:var(--blue); text-decoration:none; border-bottom:1px solid rgba(109,139,255,.35); }
article.doc a:hover { border-bottom-color:var(--blue); }
article.doc ul, article.doc ol { margin:12px 0; padding-left:22px; color:var(--dim); }
article.doc li { margin:8px 0; line-height:1.85; }
article.doc li::marker { color:var(--faint); }
article.doc code { background:rgba(255,255,255,.07); border:1px solid var(--line); border-radius:6px;
  padding:1px 6px; font-size:.88em; color:var(--amber);
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; }
article.doc pre { background:var(--code); border:1px solid var(--line); border-radius:12px;
  padding:15px 17px; overflow-x:auto; margin:16px 0; }
article.doc pre code { background:none; border:0; padding:0; color:#dfe5f3; font-size:13px; line-height:1.7; }
article.doc blockquote { margin:18px 0; padding:14px 18px; background:rgba(109,139,255,.09);
  border-left:3px solid var(--blue); border-radius:0 12px 12px 0; color:var(--ink); }
article.doc blockquote p { margin:5px 0; color:var(--ink); }
article.doc hr { border:0; border-top:1px solid var(--line); margin:38px 0; }
article.doc .tw { overflow-x:auto; margin:18px 0; }
article.doc table { border-collapse:collapse; width:100%; font-size:14px; }
article.doc th, article.doc td { border:1px solid var(--line); padding:9px 13px; text-align:left; color:var(--dim); }
article.doc th { background:rgba(255,255,255,.04); color:var(--ink); font-weight:600; }

[data-theme="light"] .page-guide {
  --bg:#f5f6fa; --ink:#141a2b; --dim:#4f586d; --faint:#737b8e;
  --line:rgba(20,30,60,.10); --glass:#fff; --blue:#2b6cff; --amber:#b8640a; --code:#0f172a;
}
[data-theme="light"] .page-guide::before { opacity:.5; }
[data-theme="light"] .page-guide header.bar { background:rgba(245,246,250,.82); }
[data-theme="light"] .page-guide .tab:hover { background:rgba(20,30,60,.05); }
[data-theme="light"] .page-guide .tab.on { background:rgba(43,108,255,.1); }
[data-theme="light"] .page-guide .ver { background:rgba(20,30,60,.06); }
[data-theme="light"] .page-guide .card.install { box-shadow:0 18px 44px -26px rgba(30,40,90,.25); }
[data-theme="light"] .page-guide .btn:not(.primary) { background:#fff; border-color:rgba(20,30,60,.12); }
[data-theme="light"] .page-guide .btn:not(.primary):hover { background:#fff; border-color:rgba(20,30,60,.24); }
[data-theme="light"] article.doc { box-shadow:0 18px 44px -26px rgba(30,40,90,.22); }
[data-theme="light"] article.doc code { background:rgba(20,30,60,.05); }
[data-theme="light"] article.doc blockquote { background:#f2f6ff; border-left-color:#8fb0ff; }
[data-theme="light"] article.doc th { background:#f7f9fc; }
[data-theme="light"] .doc-nav .toc:hover { background:rgba(20,30,60,.05); }
[data-theme="light"] .doc-nav .toc.on { background:rgba(43,108,255,.09); border-left-color:var(--blue); }

@media (max-width: 900px) {
  .page-guide .page { grid-template-columns:1fr; gap:22px; }
  .doc-nav { position:static; flex-direction:row; flex-wrap:wrap; gap:7px; padding:16px 18px;
    border:1px solid var(--line); border-radius:16px; background:var(--glass); }
  .doc-nav .toc-h { width:100%; margin:0 0 2px; }
  .doc-nav .toc { padding:5px 11px; border-left:0; border-radius:99px; background:rgba(255,255,255,.05); }
  .doc-nav .toc.l3 { padding-left:11px; }
  .doc-nav .toc.on { border-left:0; }
  article.doc { padding:26px 20px 32px; border-radius:18px; }
}
@media (prefers-reduced-motion: reduce) { .page-guide { scroll-behavior:auto; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior:auto; } }
</style>
</head>
<body class="page-${activeTab === "home" ? "home" : "guide"}">
<header class="bar">
  <div class="wrap">
    <span class="logo">▶ 一起看</span>
<nav class="tabs">
${renderTabs(activeTab)}
</nav>
${THEME_TOGGLE}    <span class="ver">v{{VERSION}}</span>
  </div>
</header>

<main class="wrap">
${actionsAbove}  <div class="page">
${body}
  </div>
</main>

<footer>
  「一起看」是一个油猴脚本。源码见 <a href="${GITHUB_URL}">GitHub</a>。
</footer>

<script>
(function () {
  // Theme — the toggle ships on both pages, so this runs on both.
  var THEME_KEY = "wp-theme", root = document.documentElement;
  var toggle = document.getElementById("theme");
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (toggle) {
    function applyTheme(t, animate) {
      if (animate && !still) {
        root.classList.add("theme-anim");
        setTimeout(function () { root.classList.remove("theme-anim"); }, 500);
      }
      root.setAttribute("data-theme", t);
      toggle.setAttribute("aria-label", t === "light" ? "切换到深色模式" : "切换到浅色模式");
    }
    function savedTheme() {
      try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
    }
    applyTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark");
    toggle.addEventListener("click", function () {
      var t = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode: still switch */ }
      applyTheme(t, true);
    });
    // Until someone picks a theme by hand, keep following the system.
    var scheme = window.matchMedia && matchMedia("(prefers-color-scheme: light)");
    var follow = function (e) { if (!savedTheme()) applyTheme(e.matches ? "light" : "dark", true); };
    if (scheme && scheme.addEventListener) scheme.addEventListener("change", follow);
    else if (scheme && scheme.addListener) scheme.addListener(follow);
  }
})();

(function () {
  // Landing page only: scroll reveal, card spotlight and the two-screen demo.
  var stage = document.getElementById("stage");
  if (!stage) return;
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var reveals = document.querySelectorAll(".reveal");
  if (!still && "IntersectionObserver" in window) {
    document.documentElement.classList.add("js");
    var seen = false;
    var io = new IntersectionObserver(function (entries) {
      seen = true;
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
    // an observer that never reports must not leave the page blank
    setTimeout(function () { if (!seen) reveals.forEach(function (el) { el.classList.add("in"); }); }, 1500);
  }

  document.querySelectorAll(".home .cell").forEach(function (c) {
    c.addEventListener("pointermove", function (e) {
      var r = c.getBoundingClientRect();
      c.style.setProperty("--mx", e.clientX - r.left + "px");
      c.style.setProperty("--my", e.clientY - r.top + "px");
    });
  });

  // Each screen's picture is a pure function of its own timecode, so the two
  // frames match exactly when — and only when — the timelines agree.
  var DURATION = 1440, PAN = 640, SPEED = 16;
  function screen(role) {
    var el = stage.querySelector(".screen." + role);
    return { el: el, t: 754, playing: true, layers: el.querySelectorAll("[data-k]"),
      fill: el.querySelector(".scrub-fill"), tc: el.querySelector(".tc") };
  }
  var host = screen("host"), guest = screen("guest");
  var delta = stage.querySelector(".delta b");
  var log = document.getElementById("ticker");

  function fmt(t) {
    t = Math.max(0, t);
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function paint(s) {
    for (var i = 0; i < s.layers.length; i++) {
      var k = Number(s.layers[i].getAttribute("data-k"));
      var x = (s.t * SPEED * k) % PAN;
      s.layers[i].setAttribute("transform", "translate(" + (-x).toFixed(2) + " 0)");
    }
    s.fill.style.width = (s.t / DURATION) * 100 + "%";
    s.tc.textContent = fmt(s.t);
  }
  function frame() {
    var d = Math.abs(host.t - guest.t);
    stage.classList.toggle("apart", d > 1);
    delta.textContent = d > 1 ? "对齐中…" : "Δ " + Math.max(d, 0.02).toFixed(2) + "s";
    paint(host);
    paint(guest);
  }
  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function setState(s, paused, buffering) {
    s.playing = !paused && !buffering;
    s.el.classList.toggle("paused", !!paused);
    s.el.classList.toggle("buffering", !!buffering);
  }
  var NAMES = { host: "阿凯", guest: "小林" };
  function say(who, text) {
    var li = document.createElement("li");
    var tc = document.createElement("span");
    tc.className = "tc";
    tc.textContent = fmt(host.t);
    li.appendChild(tc);
    var line = document.createElement("span");
    if (who) {
      var b = document.createElement("b");
      b.className = who;
      b.textContent = NAMES[who];
      line.appendChild(b);
    }
    line.appendChild(document.createTextNode(text));
    li.appendChild(line);
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 3) log.removeChild(log.lastChild);
  }

  frame();
  if (still) return;

  var SCRIPT = [
    [2600, function () {
      var to = host.t + 196;
      if (to > DURATION - 40) to = 420;
      host.t = to;
      restart(host.el, "synced");
      restart(stage, "send");
      say("host", " 拖动进度到 " + fmt(to));
    }],
    [3250, function () {
      guest.t = host.t - 0.21;
      restart(guest.el, "synced");
      say("guest", " 已跳转对齐 · 误差 0.21s");
    }],
    [6200, function () { setState(host, true); restart(stage, "send"); say("host", " 暂停了"); }],
    [6650, function () { setState(guest, true); guest.t = host.t; say("guest", " 跟随暂停"); }],
    [8400, function () { setState(host, false); restart(stage, "send"); say("host", " 继续播放"); }],
    [8800, function () { setState(guest, false); guest.t = host.t - 0.06; say("guest", " 跟随播放"); }],
    [11200, function () { setState(guest, false, true); say("guest", " 缓冲中…"); }],
    [11600, function () { setState(host, true); restart(stage, "send"); say("", "全房间暂停，等待小林"); }],
    [13600, function () {
      guest.t = host.t;
      setState(guest, false);
      setState(host, false);
      restart(guest.el, "synced");
      say("", "缓冲完成，一起继续");
    }],
  ];
  var LOOP = 16000;
  function run() {
    SCRIPT.forEach(function (step) { setTimeout(function () { step[1](); frame(); }, step[0]); });
    setTimeout(run, LOOP);
  }
  run();

  var last = performance.now();
  function tick(now) {
    var dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (host.playing) host.t += dt;
    if (guest.playing) {
      guest.t += dt;
      // the rate nudge that pulls a small lag back in without a visible seek
      if (host.playing && Math.abs(host.t - guest.t) < 1) guest.t += (host.t - guest.t) * 0.015;
    }
    frame();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

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

(function () {
  // Table of contents: mark the section you are reading. No observer games —
  // one pass over the headings on scroll is enough and never gets stuck.
  var nav = document.querySelector(".doc-nav");
  if (!nav) return;
  var links = [].slice.call(nav.querySelectorAll(".toc"));
  var targets = [];
  links.forEach(function (a) {
    var el = document.getElementById(a.getAttribute("href").slice(1));
    targets.push({ link: a, el: el });
  });
  targets = targets.filter(function (t) { return t.el; });
  if (!targets.length) return;

  var pending = false;
  function update() {
    pending = false;
    var line = 140, current = targets[0];
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].el.getBoundingClientRect().top <= line) current = targets[i];
    }
    // At the very bottom the last section wins, even if it is short.
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 40) {
      current = targets[targets.length - 1];
    }
    for (var j = 0; j < targets.length; j++) {
      targets[j].link.classList.toggle("on", targets[j] === current);
    }
  }
  function onScroll() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();
})();
</script>
</body>
</html>
`;
}
