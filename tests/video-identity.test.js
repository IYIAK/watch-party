import { test } from "node:test";
import assert from "node:assert/strict";

// The userscript ships as a single Tampermonkey IIFE, so videoIdentity cannot
// be imported directly. This file pins the *contract* of computeVideoKey /
// isSameVideo with a reference implementation kept byte-for-byte in sync with
// the `videoIdentity` module in userscript/watch-party.user.js. If you change
// the module, update this copy and these expectations together.

function biliKey(href) {
  const bv = href.match(/BV[0-9A-Za-z]+/);
  if (bv) {
    const part = href.match(/[?&]p=(\d+)/);
    return `bili:${bv[0]}${part ? "#p" + part[1] : ""}`;
  }
  const ep = href.match(/\/play\/(ep\d+)/) || href.match(/[?&](?:ep_id|epid)=(\d+)/);
  if (ep) return `bili:ep${String(ep[1]).replace(/^ep/, "")}`;
  const ss = href.match(/\/play\/(ss\d+)/);
  if (ss) return `bili:${ss[1]}`;
  return "";
}

function genericKey(href) {
  try {
    const u = new URL(href);
    if (!u.hostname) return "";
    const path = u.pathname.replace(/\/+$/, "");
    return `url:${u.hostname}${path}`;
  } catch {
    return "";
  }
}

function featKey(state) {
  const dur = state && Number.isFinite(state.duration) ? Math.round(state.duration) : 0;
  const title = (state && state.title ? state.title : "").slice(0, 40);
  if (!dur && !title) return "";
  return `feat:${dur}:${title}`;
}

function computeVideoKey(href, state) {
  const h = String(href || "");
  let key = "";
  if (/bilibili\.com/.test(h)) key = biliKey(h);
  if (!key) key = genericKey(h);
  if (!key) key = featKey(state);
  return key;
}

function isFeatKey(key) {
  return typeof key === "string" && key.startsWith("feat:");
}

function isSameVideo(localState, hostState) {
  if (!hostState) return true;
  const localKey = localState && localState.videoKey;
  const hostKey = hostState.videoKey;
  if (!hostKey) return true;

  if (localKey && hostKey && !isFeatKey(localKey) && !isFeatKey(hostKey)) {
    return localKey === hostKey;
  }

  const ld = localState && Number.isFinite(localState.duration) ? localState.duration : null;
  const hd = Number.isFinite(hostState.duration) ? hostState.duration : null;
  if (ld == null || hd == null) return true;
  const sameDur = Math.abs(ld - hd) <= 2;
  const sameTitle = (localState.title || "") === (hostState.title || "");
  return sameDur && sameTitle;
}

test("same BV with different tracking params yields the same key", () => {
  const a = computeVideoKey("https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.1", {});
  const b = computeVideoKey("https://www.bilibili.com/video/BV1xx411c7mD?vd_source=abc&t=10", {});
  assert.equal(a, "bili:BV1xx411c7mD");
  assert.equal(a, b);
});

test("different multi-part (?p=) yields different keys", () => {
  const p1 = computeVideoKey("https://www.bilibili.com/video/BV1xx411c7mD?p=1", {});
  const p2 = computeVideoKey("https://www.bilibili.com/video/BV1xx411c7mD?p=2", {});
  assert.notEqual(p1, p2);
});

test("bangumi ep id is captured", () => {
  const k = computeVideoKey("https://www.bilibili.com/bangumi/play/ep123456", {});
  assert.equal(k, "bili:ep123456");
});

test("generic site normalizes to host+pathname, ignoring query/hash", () => {
  const a = computeVideoKey("https://www.agedm.org/play/123?ep=4#x", {});
  const b = computeVideoKey("https://www.agedm.org/play/123/", {});
  assert.equal(a, "url:www.agedm.org/play/123");
  assert.equal(a, b);
});

test("falls back to a feat: key when no URL identity is available", () => {
  const k = computeVideoKey("about:blank", { duration: 1234.6, title: "My Movie" });
  assert.equal(k, "feat:1235:My Movie");
});

test("isSameVideo compares real keys exactly", () => {
  assert.equal(
    isSameVideo({ videoKey: "bili:BV1" }, { videoKey: "bili:BV1" }),
    true
  );
  assert.equal(
    isSameVideo({ videoKey: "bili:BV1" }, { videoKey: "bili:BV2" }),
    false
  );
});

test("isSameVideo uses duration±2s + title when a feat key is involved", () => {
  const local = { videoKey: "feat:100:Movie", duration: 100, title: "Movie" };
  assert.equal(isSameVideo(local, { videoKey: "feat:101:Movie", duration: 101, title: "Movie" }), true);
  assert.equal(isSameVideo(local, { videoKey: "feat:120:Movie", duration: 120, title: "Movie" }), false);
  assert.equal(isSameVideo(local, { videoKey: "feat:100:Other", duration: 100, title: "Other" }), false);
});

test("isSameVideo errs toward true when host info is insufficient", () => {
  assert.equal(isSameVideo({ videoKey: "bili:BV1" }, { videoKey: "" }), true);
  assert.equal(isSameVideo({ videoKey: "bili:BV1" }, null), true);
});
