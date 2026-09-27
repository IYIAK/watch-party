# Setup & Deployment

> 零基础用户请看中文的 [`安装教程.md`](./安装教程.md)（不需要自己搭后端）。
> This file is the developer-oriented setup guide (own Cloudflare account, wrangler, D1).

## 1. Cloudflare Worker + D1

### Prerequisites

- A Cloudflare account (free tier is enough).
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) installed:
  ```bash
  npm install -g wrangler
  wrangler login
  ```

### Create the D1 database

```bash
cd worker
cp wrangler.toml.example wrangler.toml
wrangler d1 create watch_party
```

Copy the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`.

### Apply the schema

```bash
# Local (for `wrangler dev`):
wrangler d1 execute watch_party --local --file=./schema.sql
# Remote (production):
wrangler d1 execute watch_party --remote --file=./schema.sql
```

### Run locally

```bash
wrangler dev
```

This serves the Worker at `http://127.0.0.1:8787`. Set
`useLocalWorker = true` near the top of the userscript to point at it.

### Deploy

```bash
wrangler deploy
```

Note the deployed URL (e.g.
`https://watch-party.<account>.workers.dev`) and put it in the
userscript's `workerUrlRemote`.

## 2. Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in `userscript/watch-party.user.js`.
3. Edit the `CONFIG` block at the top:
   - `workerUrlRemote`: your deployed Worker URL.
   - `workerUrlLocal`: usually `http://127.0.0.1:8787`.
   - `useLocalWorker`: `true` during local development, `false` in normal use.
4. Save. Open a supported page (see the `@match` list at the top of the file).

The script installs with `@match *://*/*` so sites can be added at runtime, but
nothing happens on a domain until you match it (see §3). `localhost` and
`127.0.0.1` are matched out of the box so the local fixtures work without any
setup. When a site serves the player inside an iframe, the frame reporter
handles it as long as the outer page's domain is matched (`@noframes false` is
*not* set).

## 3. Using it

### Matching a site

Everything runs only on matched domains. An unmatched domain stays completely
untouched — no button, no injected CSS, no requests, no timers.

- **Built in:** `bilibili.com`, `xifanapp.com`, `ciyuanapp.com`, `agedm.org`,
  `*.agefans.*`, plus `localhost` / `127.0.0.1` for local testing.
- **Add a site:** open the page, then **Tampermonkey menu → 匹配当前域名**. The
  panel opens right away and the domain keeps working on every later visit —
  no reload, no editing the script. When the host has a parent domain, a second
  entry like **匹配上级域名（example.com，含所有子域）** is offered too.
- **Remove a site:** **Tampermonkey menu → 取消匹配当前域名**. Built-in sites
  cannot be removed.
- **Review the list:** **Tampermonkey menu → 查看已匹配域名**.
- Matching is exact-or-subdomain: matching `example.com` covers
  `www.example.com`; matching `www.example.com` covers only that host.
  Lookalikes such as `agedm.org.evil.com` never match.

### Day to day

- By default the page is left completely untouched — there is **no floating
  button or icon** until you start a session.
- Open the **Tampermonkey menu → "Open Watch Party"** to bring up the panel.
- **Create room** → you become the host; a 6-character room code is shown. Once
  you're in a room, the floating button appears (translucent until you hover)
  and stays until you leave.
- A friend opens the panel the same way, clicks **Join**, enters the code, and
  joins as a participant.
- Only one tab per browser syncs a room, and **opening a new tab does not steal
  the room**: it stays on standby (the panel shows 「同步正在另一个标签进行」 plus
  a 「在此标签同步」 button) until you ask it to take over. This coordination runs
  over Tampermonkey's shared storage, so it also works between tabs on
  **different sites** (one on bilibili, one on a 番剧 站) — verified in practice.
  - The cross-tab channel is the *only* mechanism deciding who reports (instant,
    no extra state). Standby tabs still poll every 5s for the panel's data, and
    if the reporting tab stops updating (crash, discard, …) one of them takes
    over after ~12s.
- If your current page isn't the same video as the host, following is paused and
  the panel (or its bubble) shows a **"跳转到一起看的视频"** button that opens the
  host's video in a new tab; the current tab hands the sync lock over and the new
  tab takes over as the reporting one.
  - If that site has not been matched yet, the jump **matches its domain for you**
    (otherwise the script would not run there at all and nothing could sync), and
    the notice says so.
  - If the new page never takes over (failed load, …), the old tab reclaims the
    job from its standby watchdog after ~15s.
  - **Watching the same show on a different site?** The page URLs differ, so the
    script calls it a different video. 〔**强制同步**〕 makes it follow the host's
    timeline anyway (progress, play/pause and drift correction). The bar then
    turns into a status line with 〔取消强制同步〕, the host's list shows
    「强制同步」 for you, and your drag requests still count. Leaving the room
    switches it off again.
  - Caveat: if the two sources are not frame-aligned (different intros, cuts),
    forcing sync means repeated corrections — jumping to the host's video is
    nicer in that case.
- Following is **on by default**; participants can turn either half off:
  - **Auto-follow host progress** — seek to the host when drift > 2s. The host's
    position is extrapolated to "now" using server timestamps, so polling lag
    never turns into a permanent offset.
  - **Follow host play/pause** — mirror the host's play/pause, aligning the
    position before playback resumes.
- **A member dragging the timeline is a request, not a command.** Their own
  position is protected for 10s, and the host's panel shows a bubble
  ("小林 wants to jump to 12:34") with **跟随 TA** / **忽略**. The host can tick
  **自动接受成员拖动** to skip the asking.
- **If anybody stalls, the room waits.** A participant that is not paused but
  whose position has stopped moving reports `buffering`, everyone else pauses and
  shows "等待 XX 缓冲…", and playback resumes (aligned) once they recover. The
  host's panel offers **不等了，继续播放** to end the wait early for everyone.
- A background tab realigns to the host the moment you switch back to it.
- The panel auto-collapses after ~10s unless **Pinned** mode is selected; the
  default display mode is the **status pill**.
- **Bubbles** are the only way messages reach you (the panel has no separate
  notice line): bottom-right when the panel is collapsed, **above the panel** when
  it is open, top-right in fullscreen, with the action attached
  (跟随 TA / 忽略 / 不等了，继续播放 / 跳转到一起看的视频). Each bubble hugs its
  text (up to 304px), stacks its buttons one per line, sits above the status pill,
  and hides itself after a few seconds.
  - Fullscreen caveat: browsers only paint the fullscreen element's own subtree,
    so the script moves its UI *into* that element. If a site fullscreens a bare
    `<video>` or an iframe, no overlay can be shown there — a browser limit.
- A host dragging the timeline sees 「已更新进度，成员将会同步」, and members see
  「房主调整了进度」 so a jump is never a mystery.
- In fullscreen, everything except the bubble is hidden.
- **Leave** (or the menu's "Leave room") removes all UI and returns the page to
  its original clean state.

## 4. API reference

| Method & path | Purpose |
| --- | --- |
| `POST /rooms` | Create a room. Returns `roomId`, `participantId`, `hostToken`. |
| `POST /rooms/:roomId/join` | Join. Returns `roomId`, `participantId`, `role`. |
| `POST /rooms/:roomId/state` | Report local state. Host includes `hostToken`. |
| `GET /rooms/:roomId/state` | Fetch all participants' state, plus `serverTime`. |

The reported `state` carries the playback position plus the co-op fields:
`buffering` (my playback is stuck), `skipWait` (host: stop waiting for me) and
`seekRequest: {id, time}` (a member asking the host to move the room). All are
optional; a malformed `seekRequest` is dropped rather than rejected.

Errors: `400` invalid payload, `403` bad host token, `404` unknown room.

## 5. Adapter notes

The userscript uses a layered adapter strategy, all exposing the same
interface (`detect`, `getState`, `seek`, `play`, `pause`, `onChange`):

- **Generic page video** — picks the most likely main `<video>` (visible,
  non-zero duration, largest area; tiny ad/preview videos are ignored).
- **iframe aggregator (top window)** — listens for video state posted up from
  frames and can broadcast seek/play/pause commands down to them.
- **Frame reporter (inside frames)** — detects the inner `<video>` and posts
  its state to the top window; applies commands received from the top.
- **Bilibili** — prefers the main player container's video and avoids touching
  danmaku/login/quality controls.

Agefans-like sites work through the iframe path, mirroring the
"Agefans Enhance" pattern where inner-frame playback events are forwarded to
the outer page.

If no controllable video is found, the panel shows **"player not detected"**
instead of failing silently.

## 6. Local fixture testing

Serve the repo root over HTTP (file:// blocks some APIs):

```bash
npx http-server -p 5500 .
```

Then open:

- `http://127.0.0.1:5500/fixtures/direct-video.html` — direct `<video>`.
- `http://127.0.0.1:5500/fixtures/iframe-video.html` — same-origin iframe video.
- `http://127.0.0.1:5500/fixtures/no-video.html` — player-not-detected case.

`localhost` and `127.0.0.1` are matched out of the box, so these fixtures work
with no setup. To exercise the "unmatched domain" path, serve the repo from
another loopback alias (e.g. `http://127.0.0.2:5501/`) — it stays completely
inert until you match it from the Tampermonkey menu.

## 7. Migration path to a Chrome extension

The userscript is organized into modules (`apiClient`, `roomStore`,
`videoAdapters`, `syncEngine`, `panelUi`, `settings`, `siteMatch`) even though
it ships as one file. A future Chrome extension can reuse the Worker API and sync rules,
replacing Tampermonkey storage/menu APIs with Chrome storage, popup, and
content scripts.
