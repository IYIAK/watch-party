const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_LENGTH = 6;
const PARTICIPANT_PREFIX = "p_";
const HOST_TOKEN_PREFIX = "h_";

const LIMITS = Object.freeze({
  displayName: 32,
  roomId: 12,
  participantId: 80,
  token: 160,
  title: 160,
  url: 800,
  source: 800,
  adapter: 80,
  videoKey: 200,
  seekRequestId: 64
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

    const cleanState = normalizePlaybackState(input.state);
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

    const participants = (result.results || []).map((row) => ({
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
    getState
  };
}

function normalizeDisplayName(value) {
  const name = normalizeOptionalString(value, "displayName", LIMITS.displayName) || "Friend";
  return name;
}

function normalizeRoomId(value) {
  return normalizeId(String(value || "").toUpperCase(), "roomId", LIMITS.roomId);
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
  if (text.length > maxLength) {
    // Descriptive fields (a long URL, a data: source, a signed video link) are
    // better cut short than rejected: one overlong value must never stop a
    // participant from reporting at all.
    if (truncate) return text.slice(0, maxLength);
    throw new HttpError(400, `${fieldName} is too long`);
  }
  return text;
}

function normalizePlaybackState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "state must be an object");
  }

  const state = {
    currentTime: normalizeFiniteNumber(value.currentTime, "currentTime", 0, 60 * 60 * 24),
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
