const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_LENGTH = 4;
const PARTICIPANT_PREFIX = "p_";
const HOST_TOKEN_PREFIX = "h_";

const LIMITS = Object.freeze({
  displayName: 20,
  roomId: 4,
  participantId: 80,
  token: 160,
  title: 160,
  url: 800,
  source: 800,
  adapter: 80,
  videoKey: 200,
  seekRequestId: 64,
  sampledAt: 40
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function createRoomService(db, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const randomBytes = options.randomBytes || defaultRandomBytes;
  const tokenHasher = options.tokenHasher || sha256Hex;

  async function createRoom(input = {}) {
    const displayName = normalizeDisplayName(input.displayName);
    let roomId = "";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      roomId = randomRoomId(randomBytes);
      const existing = await getRoom(roomId);
      if (!existing) break;
      roomId = "";
    }

    if (!roomId) {
      throw new HttpError(503, "Could not allocate a room ID");
    }

    const participantId = PARTICIPANT_PREFIX + randomToken(randomBytes, 18);
    const hostToken = HOST_TOKEN_PREFIX + randomToken(randomBytes, 32);
    const hostTokenHash = await tokenHasher(hostToken);
    const timestamp = now();

    await db
      .prepare(
        `INSERT INTO rooms (id, host_participant_id, host_token_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(roomId, participantId, hostTokenHash, timestamp, timestamp)
      .run();

    await db
      .prepare(
        `INSERT INTO participants (id, room_id, display_name, role, state_json, created_at, updated_at)
         VALUES (?, ?, ?, 'host', '{}', ?, ?)`
      )
      .bind(participantId, roomId, displayName, timestamp, timestamp)
      .run();

    return {
      roomId,
      participantId,
      hostToken,
      role: "host"
    };
  }

  async function joinRoom(roomId, input = {}) {
    const cleanRoomId = normalizeRoomId(roomId);
    const room = await requireRoom(cleanRoomId);
    const displayName = normalizeDisplayName(input.displayName);
    const participantId = PARTICIPANT_PREFIX + randomToken(randomBytes, 18);
    const timestamp = now();

    await db
      .prepare(
        `INSERT INTO participants (id, room_id, display_name, role, state_json, created_at, updated_at)
         VALUES (?, ?, ?, 'participant', '{}', ?, ?)`
      )
      .bind(participantId, room.id, displayName, timestamp, timestamp)
      .run();

    await touchRoom(room.id, timestamp);

    return {
      roomId: room.id,
      participantId,
      role: "participant"
    };
  }

  async function updateState(roomId, input = {}) {
    const cleanRoomId = normalizeRoomId(roomId);
    const room = await requireRoom(cleanRoomId);
    const participantId = normalizeId(input.participantId, "participantId", LIMITS.participantId);
    const participant = await getParticipant(room.id, participantId);

    if (!participant) {
      throw new HttpError(404, "Participant not found");
    }

    if (participant.role === "host") {
      const providedToken = normalizeOptionalString(input.hostToken, "hostToken", LIMITS.token);
      if (!providedToken) {
        throw new HttpError(403, "Host token required");
      }
      const providedHash = await tokenHasher(providedToken);
      if (providedHash !== room.host_token_hash) {
        throw new HttpError(403, "Invalid host token");
      }
    }

    // An explicit `null` means "this client cannot tell where it is right now"
    // (a player swap, a <video> that has not loaded). Keep the last position we
    // were told instead of overwriting it with 0, which used to drag the whole
    // room back to the start of the video.
    const previous = parseState(participant.state_json);
    const cleanState = normalizePlaybackState(input.state, previous);
    // A tab handoff changes the owner generation. Requests from the previous
    // tab can arrive after the new tab has already reported; never let that old
    // in-flight write roll the room back to an earlier video or position.
    const previousEpoch = Number(previous.ownerEpoch);
    const incomingEpoch = Number(cleanState.ownerEpoch);
    if (
      Number.isFinite(previousEpoch) &&
      (!Number.isFinite(incomingEpoch) || incomingEpoch < previousEpoch)
    ) {
      return { ok: true, ignored: true };
    }
    const timestamp = now();

    await db
      .prepare(
        `UPDATE participants
         SET state_json = ?, updated_at = ?
         WHERE id = ? AND room_id = ?`
      )
      .bind(JSON.stringify(cleanState), timestamp, participant.id, room.id)
      .run();

    await touchRoom(room.id, timestamp);

    return { ok: true };
  }

  // Leaving is explicit and best-effort. Closing a tab cannot reliably report it —
  // and pretending it could would make a plain reload look like a departure — so
  // getState also drops participants that have been silent for a long time.
  async function leaveRoom(roomId, input = {}) {
    const cleanRoomId = normalizeRoomId(roomId);
    const room = await requireRoom(cleanRoomId);
    const participantId = normalizeId(input.participantId, "participantId", LIMITS.participantId);
    const participant = await getParticipant(room.id, participantId);
    // Leaving twice is not an error, and neither is leaving a room we are no longer
    // in: the client should not have to care.
    if (!participant) return { ok: true };

    // The host participant id is visible in room state, so it is not a
    // credential. Require the private host token before allowing that row to be
    // deleted. Guest leave remains idempotent as before.
    if (participant.role === "host") {
      const providedToken = normalizeOptionalString(input.hostToken, "hostToken", LIMITS.token);
      if (!providedToken || (await tokenHasher(providedToken)) !== room.host_token_hash) {
        throw new HttpError(403, "Invalid host token");
      }
    }

    await db
      .prepare("DELETE FROM participants WHERE id = ? AND room_id = ?")
      .bind(participant.id, room.id)
      .run();

    await touchRoom(room.id, now());

    return { ok: true };
  }

  async function getState(roomId) {
    const cleanRoomId = normalizeRoomId(roomId);
    const room = await requireRoom(cleanRoomId);
    const result = await db
      .prepare(
        `SELECT id, display_name, role, state_json, updated_at
         FROM participants
         WHERE room_id = ?
         ORDER BY role = 'host' DESC, updated_at DESC`
      )
      .bind(room.id)
      .all();

    // A participant that has been silent for a long stretch is gone (tab closed,
    // browser crashed, laptop asleep). Dropping them here keeps the roster free of
    // "offline ghosts" without needing a cleanup job. Leaving a room explicitly
    // removes the row outright; this is the safety net for everything else.
    const cutoff = Date.parse(now()) - PARTICIPANT_TTL_MS;
    const participants = (result.results || [])
      .filter((row) => {
        const seen = Date.parse(row.updated_at);
        // An unparseable timestamp is kept: better a stale row than a hidden member.
        return Number.isNaN(seen) || seen >= cutoff;
      })
      .map((row) => ({
        participantId: row.id,
        displayName: row.display_name,
        role: row.role,
        state: parseState(row.state_json),
        updatedAt: row.updated_at
      }));

    return {
      roomId: room.id,
      hostParticipantId: room.host_participant_id,
      participants,
      // Server clock, same source as every participant's updatedAt. Clients
      // subtract the two to learn how stale a report is without trusting their
      // own clock, then extrapolate where the host is now.
      serverTime: now()
    };
  }

  async function getRoom(roomId) {
    return db.prepare("SELECT * FROM rooms WHERE id = ?").bind(roomId).first();
  }

  async function requireRoom(roomId) {
    const room = await getRoom(roomId);
    if (!room) {
      throw new HttpError(404, "Room not found");
    }
    return room;
  }

  async function getParticipant(roomId, participantId) {
    return db
      .prepare("SELECT * FROM participants WHERE room_id = ? AND id = ?")
      .bind(roomId, participantId)
      .first();
  }

  async function touchRoom(roomId, timestamp) {
    await db
      .prepare("UPDATE rooms SET updated_at = ? WHERE id = ?")
      .bind(timestamp, roomId)
      .run();
  }

  return {
    createRoom,
    joinRoom,
    updateState,
    leaveRoom,
    getState
  };
}

function normalizeDisplayName(value) {
  const name = normalizeOptionalString(value, "displayName", LIMITS.displayName);
  if (!name) throw new HttpError(400, "displayName is required");
  return name;
}

function normalizeRoomId(value) {
  const roomId = normalizeId(String(value || "").toUpperCase(), "roomId", LIMITS.roomId);
  if (roomId.length !== ROOM_ID_LENGTH) {
    throw new HttpError(400, `roomId must be ${ROOM_ID_LENGTH} characters`);
  }
  return roomId;
}

function normalizeId(value, fieldName, maxLength) {
  const text = normalizeOptionalString(value, fieldName, maxLength);
  if (!text) {
    throw new HttpError(400, `${fieldName} is required`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new HttpError(400, `${fieldName} contains invalid characters`);
  }
  return text;
}

function normalizeOptionalString(value, fieldName, maxLength, truncate) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) {
    // Descriptive fields (a long URL, a data: source, a signed video link) are
    // better cut short than rejected: one overlong value must never stop a
    // participant from reporting at all.
    if (truncate) return Array.from(text).slice(0, maxLength).join("");
    throw new HttpError(400, `${fieldName} is too long`);
  }
  return text;
}

const PARTICIPANT_TTL_MS = 5 * 60 * 1000; // see getState

function normalizePlaybackState(value, previous) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "state must be an object");
  }

  const state = {
    duration: normalizeFiniteNumber(value.duration, "duration", 0, 60 * 60 * 24),
    paused: Boolean(value.paused),
    url: normalizeOptionalString(value.url, "url", LIMITS.url, true),
    title: normalizeOptionalString(value.title, "title", LIMITS.title, true),
    source: normalizeOptionalString(value.source, "source", LIMITS.source, true),
    adapter: normalizeOptionalString(value.adapter, "adapter", LIMITS.adapter, true),
    videoKey: normalizeOptionalString(value.videoKey, "videoKey", LIMITS.videoKey, true),
    // Co-op flags: "my playback is stuck" and the host's "stop waiting for me".
    buffering: Boolean(value.buffering),
    skipWait: Boolean(value.skipWait),
    // A member explicitly following the host across a *different* video page
    // (same show, two sites). The room needs to know so their jump requests are
    // still honoured and the panel can say why they are following.
    forceSync: Boolean(value.forceSync)
  };

  const ownerEpoch = Number(value.ownerEpoch);
  if (Number.isFinite(ownerEpoch) && ownerEpoch >= 0) state.ownerEpoch = ownerEpoch;

  const sampledAt = normalizeOptionalString(value.sampledAt, "sampledAt", LIMITS.sampledAt);
  if (sampledAt && Number.isFinite(Date.parse(sampledAt))) state.sampledAt = sampledAt;

  const time = normalizeCurrentTime(value.currentTime, previous);
  if (time !== null) state.currentTime = time;

  const hostJump = normalizeHostJump(value.hostJump);
  if (hostJump) state.hostJump = hostJump;

  const seekRequest = normalizeSeekRequest(value.seekRequest);
  if (seekRequest) state.seekRequest = seekRequest;
  return state;
}

// A one-shot "the host moved the timeline" marker. Members use the id to tell a
// new jump from the same one being reported again, so the bubble shows once.
function normalizeHostJump(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = normalizeOptionalString(value.id, "hostJump.id", LIMITS.seekRequestId);
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  return { id };
}

// A member asking the host to jump the whole room to a position. A malformed
// request is dropped rather than rejected: a stale client must never be able to
// block that participant's normal position updates.
function normalizeSeekRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = normalizeOptionalString(value.id, "seekRequest.id", LIMITS.seekRequestId);
  if (!id || !/^[A-Za-z0-9_.-]+$/.test(id)) return null;
  const time = Number(value.time);
  if (!Number.isFinite(time)) return null;
  return { id, time: Math.min(60 * 60 * 24, Math.max(0, time)) };
}

function normalizeFiniteNumber(value, fieldName, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new HttpError(400, `${fieldName} must be a finite number`);
  }
  return Math.min(max, Math.max(min, number));
}

// `currentTime` is the one field a client is allowed to be unsure about: it sends
// `null` when the player cannot report a position yet (a swap mid-episode). The
// last known value is kept in that case — see the note in updateState. Anything
// else non-finite is still treated as a client bug.
function normalizeCurrentTime(value, previous) {
  const MAX_SEC = 60 * 60 * 24;
  if (value === null) {
    const last = previous && previous.currentTime;
    if (typeof last === "number" && Number.isFinite(last)) {
      return Math.min(MAX_SEC, Math.max(0, last));
    }
    return null;
  }
  return normalizeFiniteNumber(value, "currentTime", 0, MAX_SEC);
}

function parseState(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function randomRoomId(randomBytes) {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let roomId = "";
  for (const byte of bytes) {
    roomId += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length];
  }
  return roomId;
}

function randomToken(randomBytes, size) {
  const bytes = randomBytes(size);
  return base64Url(bytes);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function defaultRandomBytes(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
