import { test } from "node:test";
import assert from "node:assert/strict";

// The userscript ships as a single Tampermonkey IIFE, so the bubble logic cannot
// be imported directly. This file pins the contract of `toastFor` with a
// reference implementation kept in sync with the panelUi module in
// userscript/watch-party.user.js. If you change the module, update this copy and
// these expectations together.
//
// The bubble is the only piece of UI that is visible when the panel is collapsed
// or the page is fullscreen, so what it chooses to show (and which buttons it
// carries) is worth pinning down.

function toastFor(input) {
  const candidates = [];
  if (input.waitingName) {
    candidates.push({
      key: `wait:${input.waitingName}`,
      text: `等待 ${input.waitingName} 缓冲…`,
      tone: "warn",
      actions: input.isHost ? ["skip"] : []
    });
  }
  if (input.request) {
    candidates.push({
      key: `req:${input.request.id}`,
      text: `${input.request.fromName} 想跳到 ${input.request.label}`,
      tone: "warn",
      actions: input.isHost ? ["accept", "ignore"] : []
    });
  }
  if (input.mismatchKey || input.mismatchUrl) {
    candidates.push(
      input.forceSync
        ? {
            key: `mm:${input.mismatchKey || input.mismatchUrl}`,
            text: "已强制同步（与房主不同页面）",
            tone: "info",
            actions: ["unforce"]
          }
        : {
            key: `mm:${input.mismatchKey || input.mismatchUrl}`,
            text: "你和大家不在同一个视频",
            tone: "warn",
            actions: ["jump", "force"]
          }
    );
  }
  if (input.noticeText) {
    candidates.push({
      key: `note:${input.noticeText}`,
      text: input.noticeText,
      tone: input.noticeTone || "info",
      actions: []
    });
  }
  for (const view of candidates) {
    // Mirrors the userscript: the panel already carries these buttons as bars,
    // so an action bubble would be a duplicate while the panel is open. The
    // lower-priority candidates are still considered.
    if (input.panelOpen && view.actions.length) continue;
    return view;
  }
  return null;
}

const base = { waitingName: "", request: null, mismatchUrl: "", mismatchKey: "", noticeText: "", noticeTone: "info", forceSync: false, isHost: false, panelOpen: false };
const request = { id: "r1", fromName: "小林", label: "12:34" };

test("nothing active means no bubble", () => {
  assert.equal(toastFor(base), null);
  assert.equal(toastFor({ ...base, isHost: true }), null);
});

test("a plain notice is a bubble without buttons", () => {
  const view = toastFor({ ...base, noticeText: "已跳到房主位置" });
  assert.equal(view.text, "已跳到房主位置");
  assert.deepEqual(view.actions, []);
  assert.equal(view.tone, "info");
  assert.equal(toastFor({ ...base, noticeText: "同步不可用", noticeTone: "error" }).tone, "error");
});

test("a different video offers jump and force-sync to everyone", () => {
  const view = toastFor({ ...base, mismatchUrl: "https://x/v" });
  assert.equal(view.text, "你和大家不在同一个视频");
  assert.deepEqual(view.actions, ["jump", "force"]);
});

test("forcing sync turns the warning into a calm status, with an undo", () => {
  const view = toastFor({ ...base, mismatchUrl: "https://x/v", forceSync: true });
  assert.equal(view.text, "已强制同步（与房主不同页面）");
  assert.equal(view.tone, "info");
  assert.deepEqual(view.actions, ["unforce"]);
  // Same page key, so the bubble does not pop again just because sync was forced.
  assert.equal(view.key, toastFor({ ...base, mismatchUrl: "https://x/v" }).key);
});

test("a jump request is actionable for the host only", () => {
  const host = toastFor({ ...base, request, isHost: true });
  assert.equal(host.text, "小林 想跳到 12:34");
  assert.deepEqual(host.actions, ["accept", "ignore"]);

  const member = toastFor({ ...base, request, isHost: false });
  assert.deepEqual(member.actions, []);
});

test("waiting on a stall comes first, and only the host can end it", () => {
  const input = { ...base, waitingName: "小林", request, mismatchUrl: "https://x/v", noticeText: "同步不可用", isHost: true };
  const view = toastFor(input);
  assert.equal(view.text, "等待 小林 缓冲…");
  assert.deepEqual(view.actions, ["skip"]);
  assert.equal(toastFor({ ...input, isHost: false }).actions.length, 0);
  // A waiting member still hears about it (it explains why playback stopped).
  assert.equal(toastFor({ ...input, isHost: false }).text, "等待 小林 缓冲…");
});

test("priority order is waiting > request > different video > notice", () => {
  assert.equal(toastFor({ ...base, waitingName: "小林", request, mismatchUrl: "u", noticeText: "n" }).key, "wait:小林");
  assert.equal(toastFor({ ...base, request, mismatchUrl: "u", noticeText: "n" }).key, "req:r1");
  assert.equal(toastFor({ ...base, mismatchUrl: "u", noticeText: "n" }).key, "mm:u");
  assert.equal(toastFor({ ...base, noticeText: "n" }).key, "note:n");
});

test("with the panel open, action bubbles stand down (the panel has the buttons)", () => {
  // Different video (member): the panel shows 跳到房主位置 / 强制同步.
  assert.equal(toastFor({ ...base, mismatchUrl: "u", panelOpen: true }), null);
  assert.equal(toastFor({ ...base, mismatchUrl: "u", forceSync: true, panelOpen: true }), null);
  // Waiting, as the host: the panel shows 不等了，继续播放.
  assert.equal(toastFor({ ...base, waitingName: "小林", isHost: true, panelOpen: true }), null);
  // Jump request, as the host: the panel shows 跟随 TA / 忽略.
  assert.equal(toastFor({ ...base, request, isHost: true, panelOpen: true }), null);
  // A member seeing the waiting bubble has no buttons in it, so nothing is
  // duplicated: it keeps showing.
  assert.equal(toastFor({ ...base, waitingName: "小林", isHost: false, panelOpen: true }).key, "wait:小林");
  // A plain notice has no counterpart in the panel either.
  assert.equal(toastFor({ ...base, noticeText: "已更新进度", panelOpen: true }).key, "note:已更新进度");
  // And it is not collateral damage: a suppressed action bubble must not take the
  // notice down with it (notices are bubble-only now).
  assert.equal(
    toastFor({ ...base, mismatchUrl: "u", noticeText: "连不上同步服务", panelOpen: true }).key,
    "note:连不上同步服务"
  );
  // Closed panel: the bubble is the only way to reach those actions.
  assert.deepEqual(toastFor({ ...base, mismatchUrl: "u" }).actions, ["jump", "force"]);
});

test("the mismatch bubble is keyed on the video, not its URL", () => {
  // A page whose query string churns between reports must not re-fire the same
  // warning.
  const a = toastFor({ ...base, mismatchUrl: "https://x/v?t=1", mismatchKey: "url:x/v" });
  const b = toastFor({ ...base, mismatchUrl: "https://x/v?t=2", mismatchKey: "url:x/v" });
  assert.equal(a.key, b.key);
  // A genuinely different video is a new bubble.
  const c = toastFor({ ...base, mismatchUrl: "https://x/w", mismatchKey: "url:x/w" });
  assert.notEqual(a.key, c.key);
  // Without a key we still fall back to the URL (an older room row).
  assert.equal(toastFor({ ...base, mismatchUrl: "https://x/v" }).key, "mm:https://x/v");
});

test("the key is stable for the same item and changes with the item", () => {  // Stable: the bubble is shown once per item, not once per poll.
  assert.equal(toastFor({ ...base, mismatchUrl: "u" }).key, toastFor({ ...base, mismatchUrl: "u" }).key);
  assert.equal(toastFor({ ...base, request }).key, toastFor({ ...base, request }).key);
  // A new request or a new URL is a new bubble.
  assert.notEqual(toastFor({ ...base, request }).key, toastFor({ ...base, request: { ...request, id: "r2" } }).key);
  assert.notEqual(toastFor({ ...base, mismatchUrl: "u" }).key, toastFor({ ...base, mismatchUrl: "v" }).key);
});
