import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoomService, HttpError } from "../worker/src/room-service.js";
import { createMemoryDb } from "./helpers/memory-db.js";

function makeService(overrides = {}) {
  const db = overrides.db || createMemoryDb();
  let counter = 0;
  const options = {
    // Deterministic "random" bytes so room IDs and tokens are stable in tests.
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        counter = (counter + 7) % 251;
        bytes[i] = counter;
      }
      return bytes;
    },
    tokenHasher: async (value) => `hash(${value})`,
    now: () => "2026-06-30T12:00:00.000Z",
    ...overrides.options
  };
  return { service: createRoomService(db, options), db };
}

test("createRoom returns a host token and persists host participant", async () => {
  const { service, db } = makeService();
  const result = await service.createRoom({ displayName: "Alice" });

  assert.match(result.roomId, /^[A-Z0-9]{6}$/);
  assert.ok(result.participantId.startsWith("p_"));
  assert.ok(result.hostToken.startsWith("h_"));
  assert.equal(result.role, "host");

  const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(result.roomId).first();
  assert.equal(room.host_participant_id, result.participantId);
  assert.equal(room.host_token_hash, `hash(${result.hostToken})`);
});

test("a null currentTime means \"position unknown\" and keeps the last known one", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });

  await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: 1800, duration: 3600, paused: false }
  });

  // The player was swapped mid-episode, so the client cannot report a position.
  // Sending 0 here used to overwrite the row and drag the whole room back to the
  // start of the video.
  await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: null, duration: 3600, paused: false }
  });

  const state = await service.getState(host.roomId);
  assert.equal(state.participants[0].state.currentTime, 1800);

  // ...and the real position still wins once the player can report again.
  await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: 5, duration: 3600, paused: false }
  });
  const after = await service.getState(host.roomId);
  assert.equal(after.participants[0].state.currentTime, 5);
});

test("a null currentTime with nothing to preserve leaves the position absent", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });

  // A participant that has never reported a position: the panel must be able to
  // tell "unknown" (rendered as —) from a real 0:00.
  await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: null, duration: 0, paused: true }
  });

  const state = await service.getState(host.roomId);
  assert.equal("currentTime" in state.participants[0].state, false);
});

test("joinRoom adds a participant whose state appears in getState", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  assert.equal(guest.role, "participant");

  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: { currentTime: 42, duration: 100, paused: false, url: "https://x/v", adapter: "generic-video" }
  });

  const state = await service.getState(host.roomId);
  const bob = state.participants.find((p) => p.participantId === guest.participantId);
  assert.ok(bob);
  assert.equal(bob.displayName, "Bob");
  assert.equal(bob.state.currentTime, 42);
});

test("updateState accepts and echoes a videoKey on the state", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: {
      currentTime: 5,
      duration: 100,
      paused: true,
      url: "https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333",
      videoKey: "bili:BV1xx411c7mD"
    }
  });

  const state = await service.getState(host.roomId);
  const bob = state.participants.find((p) => p.participantId === guest.participantId);
  assert.equal(bob.state.videoKey, "bili:BV1xx411c7mD");
});

test("updateState rejects a host update with a wrong token", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });

  await assert.rejects(
    () =>
      service.updateState(host.roomId, {
        participantId: host.participantId,
        hostToken: "h_wrong",
        state: { currentTime: 1, duration: 2, paused: true }
      }),
    (error) => error instanceof HttpError && error.status === 403
  );
});

test("updateState accepts a host update with the correct token", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });

  const result = await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: 10, duration: 60, paused: false }
  });
  assert.deepEqual(result, { ok: true });
});

test("getState lists host first with multiple participants", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  await service.joinRoom(host.roomId, { displayName: "Bob" });
  await service.joinRoom(host.roomId, { displayName: "Carol" });

  const state = await service.getState(host.roomId);
  assert.equal(state.participants.length, 3);
  assert.equal(state.participants[0].role, "host");
  assert.equal(state.hostParticipantId, host.participantId);
});

test("state carries the coop fields: buffering, skipWait and seekRequest", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: {
      currentTime: 42,
      duration: 600,
      paused: false,
      buffering: true,
      skipWait: false,
      seekRequest: { id: "req-1", time: 1234.5 }
    }
  });

  const state = await service.getState(host.roomId);
  const bob = state.participants.find((p) => p.participantId === guest.participantId);
  assert.equal(bob.state.buffering, true);
  assert.equal(bob.state.skipWait, false);
  assert.deepEqual(bob.state.seekRequest, { id: "req-1", time: 1234.5 });

  // The host can raise the "stop waiting" flag and announce a timeline jump.
  await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: 10, duration: 600, paused: false, skipWait: true, hostJump: { id: "jump-1" } }
  });
  const after = await service.getState(host.roomId);
  const hostRow = after.participants.find((p) => p.role === "host");
  assert.equal(hostRow.state.skipWait, true);
  assert.deepEqual(hostRow.state.hostJump, { id: "jump-1" });

  // A member can declare that they are following across a different video page.
  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: { currentTime: 42, duration: 600, paused: false, forceSync: true }
  });
  const forced = await service.getState(host.roomId);
  const guestRow = forced.participants.find((p) => p.participantId === guest.participantId);
  assert.equal(guestRow.state.forceSync, true);
  assert.equal(guestRow.state.buffering, false); // absent flags default to false

  // The reporting tab announces itself, and the room keeps the newest tabId.
  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: { currentTime: 43, duration: 600, paused: false }
  });
  const withTab = await service.getState(host.roomId);
  const tabRow = withTab.participants.find((p) => p.participantId === guest.participantId);
  assert.equal(tabRow.state.currentTime, 43);
});

test("a malformed seekRequest is dropped, never rejecting the whole report", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: {
      currentTime: 7,
      duration: 600,
      paused: true,
      seekRequest: { id: "", time: "abc" },
      hostJump: { id: "bad id!" }
    }
  });

  const state = await service.getState(host.roomId);
  const bob = state.participants.find((p) => p.participantId === guest.participantId);
  // The position still lands; only the unusable co-op fields are thrown away.
  assert.equal(bob.state.currentTime, 7);
  assert.equal(bob.state.seekRequest, undefined);
  assert.equal(bob.state.hostJump, undefined);
});

test("seekRequest time is clamped to a sane range", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: { currentTime: 1, duration: 600, paused: true, seekRequest: { id: "r", time: -99 } }
  });

  const state = await service.getState(host.roomId);
  const bob = state.participants.find((p) => p.participantId === guest.participantId);
  assert.equal(bob.state.seekRequest.time, 0);
});

test("getState reports the server clock so clients can extrapolate the host", async () => {
  let clock = "2026-06-30T12:00:00.000Z";
  const { service } = makeService({ options: { now: () => clock } });
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  await service.updateState(host.roomId, {
    participantId: guest.participantId,
    state: { currentTime: 20, duration: 600, paused: false }
  });

  // Seven seconds pass between the report and the next poll.
  clock = "2026-06-30T12:00:07.000Z";
  const state = await service.getState(host.roomId);

  assert.equal(state.serverTime, "2026-06-30T12:00:07.000Z");
  const bob = state.participants.find((p) => p.participantId === guest.participantId);
  assert.equal(bob.updatedAt, "2026-06-30T12:00:00.000Z");
  // Both timestamps come from the server clock, so the client can trust the
  // difference even when its own clock is wrong.
  assert.equal(new Date(state.serverTime) - new Date(bob.updatedAt), 7000);
});

test("updateState rejects malformed state payloads", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  const guest = await service.joinRoom(host.roomId, { displayName: "Bob" });

  await assert.rejects(
    () => service.updateState(host.roomId, { participantId: guest.participantId, state: "not-an-object" }),
    (error) => error instanceof HttpError && error.status === 400
  );

  await assert.rejects(
    () =>
      service.updateState(host.roomId, {
        participantId: guest.participantId,
        state: { currentTime: "abc", duration: 1, paused: false }
      }),
    (error) => error instanceof HttpError && error.status === 400
  );
});

test("overlong descriptive fields are truncated, not rejected", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  // A page with an absurd URL or a data: source must still be able to report.
  const state = await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: 1, duration: 2, paused: true, url: `https://x/${"a".repeat(2000)}` }
  });
  assert.deepEqual(state, { ok: true });
  const read = await service.getState(host.roomId);
  assert.equal(read.participants[0].state.currentTime, 1);
  assert.ok(read.participants[0].state.url.length <= 800);
});

test("unknown room returns 404", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.getState("ZZZZZZ"),
    (error) => error instanceof HttpError && error.status === 404
  );
});

test("number fields are clamped to safe ranges", async () => {
  const { service } = makeService();
  const host = await service.createRoom({ displayName: "Alice" });
  await service.updateState(host.roomId, {
    participantId: host.participantId,
    hostToken: host.hostToken,
    state: { currentTime: -5, duration: 999999999, paused: true }
  });
  const state = await service.getState(host.roomId);
  const me = state.participants[0];
  assert.equal(me.state.currentTime, 0);
  assert.equal(me.state.duration, 60 * 60 * 24);
});
