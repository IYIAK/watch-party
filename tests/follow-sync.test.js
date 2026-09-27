import { test } from "node:test";
import assert from "node:assert/strict";

// The userscript ships as a single Tampermonkey IIFE, so the follow math cannot
// be imported directly. This file pins the *contract* of hostPositionAt /
// reportAgeSec / needsAlign / nextFetchDelayMs with reference implementations
// kept in sync with the `syncEngine` module in userscript/watch-party.user.js.
// If you change the module, update this copy and these expectations together.

const CONFIG = {
  fetchIntervalIdleMs: 5000,
  fetchIntervalActiveMs: 1500,
  fetchIntervalSoloMs: 10000,
  reportIntervalMs: 5000,
  reportIntervalSoloMs: 30000,
  driftThresholdSec: 2,
  resumeAlignSec: 1,
  reportAgeMaxSec: 20
};

// Where the host is right now, given how stale their report is.
function hostPositionAt(state, ageSec) {
  const t = state && typeof state.currentTime === "number" ? state.currentTime : NaN;
  if (!Number.isFinite(t)) return null;
  if (state.paused || state.buffering) return t;
  const age = Number.isFinite(ageSec) && ageSec > 0 ? Math.min(ageSec, CONFIG.reportAgeMaxSec) : 0;
  return t + age;
}

// Age of a report, measured on server timestamps only.
function reportAgeSec(roomState, participant, maxSec) {
  const serverNow = Date.parse((roomState && roomState.serverTime) || "");
  const reportedAt = Date.parse((participant && participant.updatedAt) || "");
  if (!Number.isFinite(serverNow) || !Number.isFinite(reportedAt)) return 0;
  const age = (serverNow - reportedAt) / 1000;
  return age > 0 ? Math.min(age, maxSec) : 0;
}

// Does the local player have to move?
function needsAlign(target, localTime, toleranceSec, protectedSeek) {
  if (protectedSeek) return false;
  if (!Number.isFinite(target) || !Number.isFinite(localTime)) return false;
  return Math.abs(target - localTime) > toleranceSec;
}

// Mirrors nextFetchDelayMs + reportDelayMs in the userscript.
function nextFetchDelayMs(ctx) {
  if (!ctx.inRoom) return CONFIG.fetchIntervalIdleMs;
  if (ctx.solo) return CONFIG.fetchIntervalSoloMs;
  return ctx.following ? CONFIG.fetchIntervalActiveMs : CONFIG.fetchIntervalIdleMs;
}

function reportDelayMs(ctx) {
  if (ctx.solo) return CONFIG.reportIntervalSoloMs;
  return CONFIG.reportIntervalMs;
}

// Which participant (if anyone) the room should be waiting for.
function waitingParticipant(roomState, selfId, skipWait, freshSec) {
  if (skipWait || !roomState || !Array.isArray(roomState.participants)) return null;
  let best = null;
  for (const p of roomState.participants) {
    if (p.participantId === selfId) continue;
    if (!p.state || !p.state.buffering) continue;
    if (reportAgeSec(roomState, p, freshSec) >= freshSec) continue;
    if (!best || Date.parse(p.updatedAt) > Date.parse(best.updatedAt)) best = p;
  }
  return best ? { participantId: best.participantId, name: best.displayName || "朋友" } : null;
}

// Is a drag far enough from the host to be worth interrupting them for?
function worthRequesting(hostTarget, localTime, minDriftSec) {
  if (!Number.isFinite(hostTarget) || !Number.isFinite(localTime)) return false;
  return Math.abs(hostTarget - localTime) >= minDriftSec;
}

const T0 = "2026-06-30T12:00:00.000Z";
const at = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

// ---------------------------------------------------------------------------
// The bug this was written for
// ---------------------------------------------------------------------------

test("a late follower is pulled to where the host really is", () => {
  // Host pressed play at 20s and reported immediately; the follower only polls
  // six seconds later.
  const host = { state: { currentTime: 20, paused: false }, updatedAt: T0 };
  const roomState = { serverTime: at(T0, 6) };

  const age = reportAgeSec(roomState, host, CONFIG.reportAgeMaxSec);
  assert.equal(age, 6);

  const target = hostPositionAt(host.state, age);
  assert.equal(target, 26);

  // The follower is still parked at 20s, so it must align before resuming.
  assert.equal(needsAlign(target, 20, CONFIG.resumeAlignSec, false), true);

  // The old code compared against the *reported* position and saw no drift at
  // all — that is why the offset used to be permanent.
  assert.equal(needsAlign(host.state.currentTime, 20, CONFIG.resumeAlignSec, false), false);
});

test("drift correction also aims at the extrapolated position", () => {
  const host = { state: { currentTime: 100, paused: false }, updatedAt: T0 };
  const roomState = { serverTime: at(T0, 4) };
  const target = hostPositionAt(host.state, reportAgeSec(roomState, host, CONFIG.reportAgeMaxSec));
  assert.equal(target, 104);
  // 103s locally is 1s behind the real position: inside the 2s drift tolerance,
  // so no seek is issued.
  assert.equal(needsAlign(target, 103, CONFIG.driftThresholdSec, false), false);
  // 95s locally is 9s behind: correct it.
  assert.equal(needsAlign(target, 95, CONFIG.driftThresholdSec, false), true);
});

// ---------------------------------------------------------------------------
// hostPositionAt
// ---------------------------------------------------------------------------

test("a paused or buffering host does not move while the report ages", () => {
  assert.equal(hostPositionAt({ currentTime: 30, paused: true }, 7), 30);
  assert.equal(hostPositionAt({ currentTime: 30, paused: false }, 7), 37);
  assert.equal(hostPositionAt({ currentTime: 30, paused: false, buffering: true }, 7), 30);
});

test("hostPositionAt clamps the age and ignores nonsense", () => {
  assert.equal(hostPositionAt({ currentTime: 10, paused: false }, 999), 10 + CONFIG.reportAgeMaxSec);
  assert.equal(hostPositionAt({ currentTime: 10, paused: false }, -5), 10);
  assert.equal(hostPositionAt({ currentTime: 10, paused: false }, NaN), 10);
  assert.equal(hostPositionAt({ currentTime: 10, paused: false }, undefined), 10);
});

test("hostPositionAt returns null when there is no usable position", () => {
  assert.equal(hostPositionAt({ paused: false }, 5), null);
  assert.equal(hostPositionAt({ currentTime: "abc", paused: false }, 5), null);
  assert.equal(hostPositionAt({ currentTime: null, paused: false }, 5), null);
  assert.equal(hostPositionAt(null, 5), null);
  assert.equal(hostPositionAt(undefined, 5), null);
});

// ---------------------------------------------------------------------------
// reportAgeSec
// ---------------------------------------------------------------------------

test("reportAgeSec uses server timestamps only", () => {
  const participant = { updatedAt: T0 };
  assert.equal(reportAgeSec({ serverTime: at(T0, 7) }, participant, 20), 7);
  assert.equal(reportAgeSec({ serverTime: at(T0, 0.5) }, participant, 20), 0.5);
});

test("reportAgeSec never guesses from a local clock", () => {
  const participant = { updatedAt: T0 };
  // No serverTime at all (older Worker), or unparseable values: treat as fresh
  // rather than subtracting a local clock that may be minutes off.
  assert.equal(reportAgeSec({}, participant, 20), 0);
  assert.equal(reportAgeSec({ serverTime: "not-a-date" }, participant, 20), 0);
  assert.equal(reportAgeSec({ serverTime: at(T0, 7) }, {}, 20), 0);
  assert.equal(reportAgeSec(null, participant, 20), 0);
});

test("reportAgeSec clamps to the caller's cap and never goes negative", () => {
  const participant = { updatedAt: T0 };
  assert.equal(reportAgeSec({ serverTime: at(T0, 600) }, participant, 20), 20);
  assert.equal(reportAgeSec({ serverTime: at(T0, 600) }, participant, 60), 60);
  // A report stamped in the future is bogus; treat it as fresh, not negative.
  assert.equal(reportAgeSec({ serverTime: at(T0, -3) }, participant, 20), 0);
});

// ---------------------------------------------------------------------------
// needsAlign
// ---------------------------------------------------------------------------

test("needsAlign respects tolerance and manual seeks", () => {
  assert.equal(needsAlign(10, 10.5, 1, false), false); // within tolerance
  assert.equal(needsAlign(10, 11.5, 1, false), true); // outside tolerance
  assert.equal(needsAlign(10, 20, 1, true), false); // user just dragged the bar
  assert.equal(needsAlign(null, 10, 1, false), false);
  assert.equal(needsAlign(10, NaN, 1, false), false);
});

// ---------------------------------------------------------------------------
// nextFetchDelayMs
// ---------------------------------------------------------------------------

test("only a tab that can actually be moved polls fast", () => {
  // A following member has to notice the host's play/pause within ~1.5s.
  assert.equal(
    nextFetchDelayMs({ inRoom: true, solo: false, following: true }),
    CONFIG.fetchIntervalActiveMs
  );
  // The host never follows itself, and a member who is not following (different
  // video, auto-follow off) cannot be pulled anywhere — the fast rate would be
  // pure traffic. This is what keeps an idle room from burning the free quota.
  assert.equal(
    nextFetchDelayMs({ inRoom: true, solo: false, following: false }),
    CONFIG.fetchIntervalIdleMs
  );
  assert.equal(nextFetchDelayMs({ inRoom: true, solo: true, following: false }), CONFIG.fetchIntervalSoloMs);
  assert.equal(nextFetchDelayMs({ inRoom: false, solo: false, following: false }), CONFIG.fetchIntervalIdleMs);
});

test("solo heartbeat drops but a populated room keeps the 5s beat", () => {
  assert.equal(reportDelayMs({ solo: true }), CONFIG.reportIntervalSoloMs);
  assert.equal(reportDelayMs({ solo: false }), CONFIG.reportIntervalMs);
});

test("a day in a room stays inside the free request quota", () => {
  const day = 24 * 60 * 60 * 1000;
  const requestsPerDay = (reportMs, fetchMs) => day / reportMs + day / fetchMs;
  // Alone: ~11.5k/day (was ~26k with the flat 5s + 10s cadence).
  const solo = requestsPerDay(CONFIG.reportIntervalSoloMs, CONFIG.fetchIntervalSoloMs);
  assert.ok(solo < 15000, `solo day should be cheap, got ${Math.round(solo)}`);
  // Present but not syncing: no fast polling, so ~34.5k/day (was ~75k).
  const idle = requestsPerDay(CONFIG.reportIntervalMs, CONFIG.fetchIntervalIdleMs);
  assert.ok(idle < 40000, `idle day should stay under 40k, got ${Math.round(idle)}`);
});

// ---------------------------------------------------------------------------
// Cross-tab: which tab may report
// ---------------------------------------------------------------------------
// Sync ownership is now an explicit, user-clicked record; nothing takes the job
// over on a timer, because a timer cannot tell "that tab is closed" from "that
// tab is backgrounded and Chrome throttled it". The mirrors below pin down the
// two rules that replaced the old watchdog.

const OWNER_STALE_MS = 180000; // CONFIG.ownerStaleMs

// Mirrors syncOwner.looksAbandoned (userscript). Only ever used to *hint*; the
// threshold is minutes on purpose, because hidden tabs are throttled to about one
// timer per minute.
function ownerLooksAbandoned(rec, now) {
  if (!rec || !rec.ownerTabId) return false;
  return now - (Number(rec.at) || 0) > OWNER_STALE_MS;
}

// Mirrors syncOwner.isOwner / takeHandoff: ownership is per room and per tab id,
// and a brand-new tab (fresh sessionStorage id) is never the owner.
function isOwner(rec, roomId, tabId) {
  return Boolean(rec && rec.roomId === roomId && rec.ownerTabId === tabId);
}

test("only the explicitly chosen tab is the owner", () => {
  const rec = { roomId: "ABC123", ownerTabId: "tab-a", at: 1000 };
  assert.equal(isOwner(rec, "ABC123", "tab-a"), true);
  // A different tab — including one that just opened — never inherits the job.
  assert.equal(isOwner(rec, "ABC123", "tab-b"), false);
  // Nor does a record for another room.
  assert.equal(isOwner(rec, "ZZZ999", "tab-a"), false);
  // After leaving, nobody owns it.
  assert.equal(isOwner({ roomId: "ABC123", ownerTabId: null }, "ABC123", "tab-a"), false);
});

test("an abandoned owner is only ever a hint", () => {
  const now = 1000000;
  assert.equal(ownerLooksAbandoned({ ownerTabId: "tab-a", at: now - 1000 }, now), false);
  assert.equal(ownerLooksAbandoned({ ownerTabId: "tab-a", at: now - 60000 }, now), false);
  // A backgrounded tab that still ticks once a minute stays "alive" here.
  assert.equal(ownerLooksAbandoned({ ownerTabId: "tab-a", at: now - 70000 }, now), false);
  // Four minutes of silence: say so in the panel (the user still clicks).
  assert.equal(ownerLooksAbandoned({ ownerTabId: "tab-a", at: now - 240000 }, now), true);
  assert.equal(ownerLooksAbandoned(null, now), false);
});

// ---------------------------------------------------------------------------
// Cross-tab: a duplicated tab must not inherit the job
// ---------------------------------------------------------------------------
// A duplicated tab ("duplicate tab", a same-origin ctrl+click, window.open) gets a
// *copy* of sessionStorage, so it would believe it is the chosen tab and report as
// well. syncOwner asks the other tabs; these mirrors pin down who may answer and
// what a heard answer means.

function shouldAnswer(msg, selfId, settled, leaving) {
  if (!msg || msg.tabId !== selfId) return false;
  return msg.type === "who-has" && settled && !leaving;
}

// Mirrors syncOwner.confirmTabIdentity's verdict.
function identityAfter(answered) {
  return answered ? "copy" : "mine";
}

test("only a settled, still-loaded tab answers the identity probe", () => {
  const probe = { type: "who-has", tabId: "t1" };
  assert.equal(shouldAnswer(probe, "t1", true, false), true);
  // Still asking itself: it has not really taken this id yet.
  assert.equal(shouldAnswer(probe, "t1", false, false), false);
  // Unloading: its own reload must not look like a duplicate.
  assert.equal(shouldAnswer(probe, "t1", true, true), false);
  // Somebody else's id, or not a probe.
  assert.equal(shouldAnswer(probe, "t2", true, false), false);
  assert.equal(shouldAnswer({ type: "have", tabId: "t1" }, "t1", true, true), false);
  assert.equal(shouldAnswer(null, "t1", true, false), false);
});

test("a heard answer means this page is the copy", () => {
  // Copy: replace the id (which also makes it passive) and let the original run.
  assert.equal(identityAfter(true), "copy");
  // Nothing answered: a plain reload of the chosen tab keeps syncing.
  assert.equal(identityAfter(false), "mine");
});

// ---------------------------------------------------------------------------
// Co-op: waiting for a stalled participant
// ---------------------------------------------------------------------------

const STALL_FRESH = 10;

function participant(id, stateOver = {}, updatedAt = T0) {
  return {
    participantId: id,
    displayName: id,
    updatedAt,
    state: { currentTime: 10, paused: false, buffering: false, ...stateOver }
  };
}
function room(participants, serverOffsetSec) {
  return { serverTime: at(T0, serverOffsetSec), participants };
}

test("nobody is waited for while everybody is playing", () => {
  const state = room([participant("p_host"), participant("p_me")], 1);
  assert.equal(waitingParticipant(state, "p_me", false, STALL_FRESH), null);
  assert.equal(waitingParticipant(state, "p_me", true, STALL_FRESH), null);
  assert.equal(waitingParticipant(null, "p_me", false, STALL_FRESH), null);
});

test("a stuck participant makes the room wait for them", () => {
  const state = room([participant("p_host", { buffering: true }), participant("p_me")], 1);
  assert.deepEqual(waitingParticipant(state, "p_me", false, STALL_FRESH), {
    participantId: "p_host",
    name: "p_host"
  });
});

test("you never wait for yourself", () => {
  const state = room([participant("p_host"), participant("p_me", { buffering: true })], 1);
  assert.equal(waitingParticipant(state, "p_me", false, STALL_FRESH), null);
});

test("a stale stall signal is ignored so a closed tab cannot freeze the room", () => {
  // The report is 30s old: that tab is probably gone, not buffering.
  const stale = room([participant("p_host", { buffering: true })], 30);
  assert.equal(waitingParticipant(stale, "p_me", false, STALL_FRESH), null);
  // One second short of the cutoff is still honoured.
  const fresh = room([participant("p_host", { buffering: true })], STALL_FRESH - 1);
  assert.ok(waitingParticipant(fresh, "p_me", false, STALL_FRESH));
});

test("skipWait ends the wait for everyone", () => {
  const state = room([participant("p_host", { buffering: true })], 1);
  assert.equal(waitingParticipant(state, "p_me", true, STALL_FRESH), null);
});

test("when several people are stuck the most recent one is named", () => {
  const older = participant("p_a", { buffering: true }, at(T0, -8));
  const newer = participant("p_b", { buffering: true }, at(T0, -2));
  const state = room([older, newer, participant("p_me")], 1);
  assert.equal(waitingParticipant(state, "p_me", false, STALL_FRESH).participantId, "p_b");
});

// ---------------------------------------------------------------------------
// Co-op: the mismatch verdict is debounced so it cannot flicker
// ---------------------------------------------------------------------------

function nextMismatchState(showing, votes, sameVideo, steady) {
  const next = sameVideo
    ? { same: votes.same + 1, diff: 0 }
    : { same: 0, diff: votes.diff + 1 };
  if (showing) return { showing: next.same < steady, votes: next };
  return { showing: next.diff >= steady, votes: next };
}

// Mirrors videoIdentity.reliableComparison + the `steady` choice in applyFollow.
// Two URL-derived keys cannot flap, so they must not wait for a second poll — that
// wait is what made the jump button appear ~10s late on the slow poll rate.
function reliableComparison(local, host) {
  const lk = local && local.videoKey;
  const hk = host && host.videoKey;
  const isFeat = (k) => typeof k === "string" && k.startsWith("feat:");
  return Boolean(lk && hk && !isFeat(lk) && !isFeat(hk));
}

function steadyPolls(local, host, configured) {
  return reliableComparison(local, host) ? 1 : configured;
}

test("a mismatch between two real video keys shows on the first poll", () => {
  const local = { videoKey: "url:site/a" };
  const host = { videoKey: "url:site/b" };
  const steady = steadyPolls(local, host, 2);
  assert.equal(steady, 1);
  const state = nextMismatchState(false, { same: 0, diff: 0 }, false, steady);
  assert.equal(state.showing, true);
});

test("the weak fingerprint fallback keeps its two-poll debounce", () => {
  // No key on one side: only duration+title are comparable, and those arrive late.
  assert.equal(steadyPolls({ videoKey: "" }, { videoKey: "url:site/b" }, 2), 2);
  assert.equal(steadyPolls({ videoKey: "feat:100:T" }, { videoKey: "url:site/b" }, 2), 2);
  const first = nextMismatchState(false, { same: 0, diff: 0 }, false, 2);
  assert.equal(first.showing, false);
});

test("one disagreement is not enough to warn about a different video", () => {
  let state = nextMismatchState(false, { same: 0, diff: 0 }, false, 2);
  assert.equal(state.showing, false);
  state = nextMismatchState(state.showing, state.votes, false, 2);
  assert.equal(state.showing, true);
});

test("leaving a mismatch also needs two agreeing polls", () => {
  let state = nextMismatchState(true, { same: 0, diff: 2 }, true, 2);
  assert.equal(state.showing, true); // a single match is not enough
  state = nextMismatchState(state.showing, state.votes, true, 2);
  assert.equal(state.showing, false);
});

test("a flapping signal can never flicker the warning", () => {
  // diff/same/diff/same... never lands two samples in a row, so the panel never
  // changes state: that is the whole point of the hysteresis.
  let showing = false;
  let votes = { same: 0, diff: 0 };
  for (let i = 0; i < 6; i += 1) {
    const r = nextMismatchState(showing, votes, i % 2 === 1, 2);
    ({ showing, votes } = r);
    assert.equal(showing, false);
  }
  showing = true;
  votes = { same: 0, diff: 2 };
  for (let i = 0; i < 6; i += 1) {
    const r = nextMismatchState(showing, votes, i % 2 === 1, 2);
    ({ showing, votes } = r);
    assert.equal(showing, true);
  }
});

// ---------------------------------------------------------------------------
// Co-op: a member's drag is only a request
// ---------------------------------------------------------------------------

test("only a meaningful drag is sent to the host", () => {
  assert.equal(worthRequesting(100, 96, 5), false); // 4s: not worth asking
  assert.equal(worthRequesting(100, 95, 5), true); // exactly 5s counts
  assert.equal(worthRequesting(100, 40, 5), true);
  assert.equal(worthRequesting(null, 40, 5), false);
  assert.equal(worthRequesting(100, NaN, 5), false);
});
