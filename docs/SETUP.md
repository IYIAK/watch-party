# Setup & Deployment

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
wrangler d1 create video_sync_watch_party
```

Copy the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`.

### Apply the schema

```bash
# Local (for `wrangler dev`):
wrangler d1 execute video_sync_watch_party --local --file=./schema.sql
# Remote (production):
wrangler d1 execute video_sync_watch_party --remote --file=./schema.sql
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
`https://video-sync-watch-party.<account>.workers.dev`) and put it in the
userscript's `workerUrlRemote`.

## 2. Userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in `userscript/watch-party.user.js`.
3. Edit the `CONFIG` block at the top:
   - `workerUrlRemote`: your deployed Worker URL.
   - `workerUrlLocal`: usually `http://127.0.0.1:8787`.
   - `useLocalWorker`: `true` during local development, `false` in normal use.
4. Save. Open a supported page (see the `@match` list at the top of the file).

The `@match` list starts narrow on purpose. Add hosts as you validate sites.
When you add a host that serves the player inside an iframe, the script already
runs in frames (`@noframes false` is *not* set; the frame reporter handles it).

## 3. Using it

- A small floating button appears on the right edge. It's translucent until you
  hover.
- **Create room** → you become the host; a 6-character room code is shown.
- A friend clicks **Join**, enters the code, and joins as a participant.
- By default everyone just *sees* each other's progress. Participants can opt in
  to:
  - **Auto-follow host progress** — seek to the host when drift > 5s.
  - **Follow host play/pause** — mirror the host's play/pause.
- After you drag your own timeline, auto-follow is suspended for 8 seconds so
  you aren't yanked back immediately.
- The panel auto-collapses after ~10s unless **Pinned** mode is selected.
- In fullscreen, all watch-party UI is hidden.

## 4. API reference

| Method & path | Purpose |
| --- | --- |
| `POST /rooms` | Create a room. Returns `roomId`, `participantId`, `hostToken`. |
| `POST /rooms/:roomId/join` | Join. Returns `roomId`, `participantId`, `role`. |
| `POST /rooms/:roomId/state` | Report local state. Host includes `hostToken`. |
| `GET /rooms/:roomId/state` | Fetch all participants' state. |

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

Add a matching `@match` (e.g. `http://127.0.0.1:5500/*`) to the userscript
while testing locally.

## 7. Migration path to a Chrome extension

The userscript is organized into modules (`apiClient`, `roomStore`,
`videoAdapters`, `syncEngine`, `panelUi`, `settings`) even though it ships as
one file. A future Chrome extension can reuse the Worker API and sync rules,
replacing Tampermonkey storage/menu APIs with Chrome storage, popup, and
content scripts.
