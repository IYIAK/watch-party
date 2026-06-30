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
