# Watch Party Userscript Design

Date: 2026-06-30

## Goal

Build a first working version of a remote watch-party tool for bilibili and smaller video sites such as Xifan Anime, Ciyuancheng, and agefans-like sites. The first version should be a Tampermonkey userscript backed by a small hosted Cloudflare Worker service, with a later migration path to a Chrome extension.

The MVP should make it easy for two or more friends to see one another's video progress and optionally follow the room host. It should avoid being visually noisy while watching.

## Non-Goals

- No Chrome extension in the first version.
- No self-hosted VPS requirement.
- No account system or user login.
- No real-time WebSocket requirement in the first version.
- No guaranteed support for every custom video player.
- No attempt to sync danmaku, subtitles, quality, playback rate, or selected episode in the first version.
- No persistent chat feature.

## Recommended Approach

Use a monorepo with:

- `userscript/watch-party.user.js`: Tampermonkey userscript.
- `worker/`: Cloudflare Worker backend.
- `worker/schema.sql`: Cloudflare D1 schema.
- `docs/`: setup, deployment, and adapter notes.
- `fixtures/`: local test pages for normal and iframe video detection.

The userscript detects the current video, renders a quiet floating control, reports local playback state to the Worker, fetches room state on a short interval, and optionally follows the host.

The Worker stores room and participant state in D1. It is intentionally small: create rooms, join rooms, receive state updates, and return room state.

## Product Behavior

### Room Model

The person who creates a room is the host. Other participants join by entering the room code. The first version does not support host transfer or competing hosts.

Each browser stores a local participant identity and, for hosts, a local `hostToken`. Only requests with the valid `hostToken` can update the host state.

### Default Sync Behavior

The default mode is passive:

- Participants can see each other's progress.
- Nobody is automatically seeked.
- Nobody's play or pause state is controlled.

Users can enable two independent controls:

- Auto-follow host progress: if local time differs from host time by more than 5 seconds, seek to the host.
- Follow host play/pause: if the host pauses or plays, apply the same state locally.

Manual local seeking gets an 8 second protection window where auto-follow is suspended, so a user is not immediately pulled back after dragging the timeline.

### Polling Cadence

The MVP uses HTTP polling:

- Report local playback state every 5 seconds while in a room.
- Fetch room state every 5 seconds while in a room.
- Send immediate reports after important events when practical: play, pause, seeked, and source change.

This is simple enough for Cloudflare Workers/D1 free-tier usage and can later be replaced by WebSocket or Durable Objects if smoother real-time syncing is needed.

## User Interface

The UI should be intentionally quiet.

### Idle State

When the user is not in a room, show only a small floating button on the right side of the page. The button opens the panel with create and join actions.

### In-Room Collapsed State

When the user is in a room and the panel is collapsed, show only a low-visibility button or compact status pill. It can show minimal state such as "in room", a connection color, or an offset from the host.

### Expanded Panel

The expanded panel should include:

- Current room code and copy action.
- Current identity: host or participant.
- Local detected video status.
- Participant list with progress, paused/playing state, and last-seen freshness.
- Manual "jump to host" action.
- Toggle for auto-follow host progress.
- Toggle for following host play/pause.
- Optional display mode: quiet, status pill, or pinned panel.
- Leave room action.

The panel should auto-collapse after about 10 seconds of no interaction unless pinned. Errors such as sync failure, host offline, or large drift should appear as short-lived notices rather than permanent large UI.

### Fullscreen Behavior

In fullscreen playback, hide all watch-party UI by default. The first version should not force custom controls into video player chrome because each site has different DOM and fullscreen behavior. Site-specific embedded controls can be a later enhancement.

## Video Detection and Control

### Adapter Strategy

Use a layered adapter approach:

1. Generic page video adapter: find the best `<video>` element in the current document.
2. Generic iframe adapter: inject detection into accessible same-origin or userscript-matched frames and forward video state with `postMessage`.
3. Bilibili adapter: prefer real page video element and avoid touching danmaku, login, account, or quality controls.
4. Agefans-like adapter: follow the same general idea as Agefans Enhance, where inner frame playback events are posted to the outer page.

Adapters should expose the same interface:

- `detect()`: return whether a controllable video is present.
- `getState()`: return current time, duration, paused, source, title, URL, and adapter name.
- `seek(time)`: set playback position.
- `play()`: start playback if allowed by browser policies.
- `pause()`: pause playback.
- `onChange(callback)`: emit meaningful local changes.

### Video Selection

If several videos exist, select the most likely main video:

- Prefer visible videos.
- Prefer videos with non-zero duration.
- Prefer the largest rendered area.
- Ignore tiny preview or ad videos where possible.

If no controllable video is found, the UI should say that the player was not detected instead of silently failing.

## Backend API

All API responses are JSON. The Worker must send permissive CORS headers for the userscript origins.
Room codes are four letters or digits.

### `POST /rooms`

Create a room.

Request body:

```json
{
  "displayName": "Alice"
}
```

Response:

```json
{
  "roomId": "AB12",
  "participantId": "p_...",
  "hostToken": "h_..."
}
```

### `POST /rooms/:roomId/join`

Join an existing room.

Request body:

```json
{
  "displayName": "Bob"
}
```

Response:

```json
{
  "roomId": "AB12",
  "participantId": "p_...",
  "role": "participant"
}
```

### `POST /rooms/:roomId/state`

Report local participant state. Hosts include `hostToken`.

Request body:

```json
{
  "participantId": "p_...",
  "hostToken": "h_...",
  "state": {
    "currentTime": 123.4,
    "duration": 1440,
    "paused": false,
    "url": "https://example.com/video",
    "title": "Episode 1",
    "source": "video-src-or-page-id",
    "adapter": "generic-video"
  }
}
```

Response:

```json
{
  "ok": true
}
```

### `GET /rooms/:roomId/state`

Fetch room state.

Response:

```json
{
  "roomId": "AB12",
  "hostParticipantId": "p_...",
  "participants": [
    {
      "participantId": "p_...",
      "displayName": "Alice",
      "role": "host",
      "state": {
        "currentTime": 123.4,
        "duration": 1440,
        "paused": false,
        "url": "https://example.com/video",
        "title": "Episode 1",
        "source": "video-src-or-page-id",
        "adapter": "generic-video"
      },
      "updatedAt": "2026-06-30T12:00:00.000Z"
    }
  ]
}
```

## Data Model

Use Cloudflare D1.

### `rooms`

- `id`: room code, primary key.
- `host_participant_id`: participant ID of creator.
- `host_token_hash`: hash of host token.
- `created_at`: ISO timestamp.
- `updated_at`: ISO timestamp.

### `participants`

- `id`: participant ID, primary key.
- `room_id`: room code.
- `display_name`: display name.
- `role`: `host` or `participant`.
- `state_json`: latest playback state.
- `created_at`: ISO timestamp.
- `updated_at`: ISO timestamp.

Participants that have not updated for several minutes are considered offline in the UI. Cleanup can be a later scheduled task or opportunistic deletion in API handlers.

## Error Handling

Userscript:

- Show "player not detected" when no adapter can control a video.
- Show "sync unavailable" when the Worker cannot be reached.
- Show "host offline" when the host has not updated recently.
- Never repeatedly seek if the same correction fails.
- Apply a cooldown after local manual seeking.

Worker:

- Return `404` for unknown rooms.
- Return `403` when an invalid host token tries to update host state.
- Return `400` for invalid payloads.
- Limit accepted string lengths for room IDs, display names, titles, URLs, sources, and adapters.
- Store only watch-party state, not account credentials or cookies.

## Security and Privacy

The userscript should not collect cookies, account tokens, danmaku data, or page HTML. It should only send playback metadata needed for sync:

- room ID
- participant ID
- display name
- current time
- duration
- paused state
- page URL
- page/video title
- source identifier
- adapter name

The room code should be random and hard enough to avoid casual guessing. Host token must never be displayed in the UI and should be stored only locally.

## Migration Path to Chrome Extension

Keep the userscript organized into modules even if bundled into one `.user.js` file:

- `apiClient`
- `roomStore`
- `videoAdapters`
- `syncEngine`
- `panelUi`
- `settings`

This keeps most logic portable to a Chrome extension later. The extension can replace Tampermonkey storage and menu APIs with Chrome storage, popup, and content scripts while reusing the Worker API and sync rules.

## Test Plan

Backend:

- Create a room and verify host token is returned.
- Join a room and verify participant state appears.
- Reject host updates with a wrong token.
- Fetch state with multiple participants.
- Reject malformed state payloads.

Userscript local fixtures:

- Detect and control a direct `<video>`.
- Detect and control an iframe `<video>` where accessible.
- Show player-not-detected state when no video exists.
- Auto-follow only when enabled and drift exceeds 5 seconds.
- Follow play/pause only when enabled.
- Respect the manual seek protection window.
- Hide UI in fullscreen.

Manual site validation:

- Bilibili direct playback page.
- One ordinary small site with a visible `<video>`.
- One agefans-like iframe site such as Xifan Anime or Ciyuancheng.

## Open Implementation Notes

- The exact `@match` list should start narrow and grow as sites are validated.
- Polling interval and drift threshold should be constants near the top of the userscript.
- A local Worker URL and deployed Worker URL should both be configurable.
- If Cloudflare D1 setup is not ready during local development, an in-memory Worker store can be used for early UI and API testing, but D1 remains the target backend.
