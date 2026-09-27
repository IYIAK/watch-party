// ==UserScript==
// @name         一起看 · 视频同步
// @namespace    https://github.com/video-sync/watch-party
// @version      0.9.8
// @description  安静地和朋友同步播放进度，并可选择跟随房主。内置 bilibili 及稀饭动漫、次元城、agefans 等站点，其他站点可在 Tampermonkey 菜单里一键匹配当前域名。
// @author       video-sync
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      your-worker.example.workers.dev
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config (tunable constants near the top, per design)
  // ---------------------------------------------------------------------------
  const CONFIG = {
    // Two URLs so a local Worker can be used during development.
    // `site/build.mjs` substitutes the published copy with the real host, so the
    // repository itself never carries anyone's deployment address.
    workerUrlLocal: "http://127.0.0.1:8787",
    workerUrlRemote: "https://your-worker.example.workers.dev",
    useLocalWorker: false,

    reportIntervalMs: 5000,
    // Alone in the room there is nobody to keep in sync, so the heartbeat drops
    // to this. Someone joining forces an immediate report (see fetchNow), so the
    // slow beat costs nothing in freshness.
    reportIntervalSoloMs: 30000,
    // Polling is adaptive: only a follower that can actually be pulled
    // somewhere polls fast, everyone else stays cheap (see nextFetchDelayMs).
    fetchIntervalIdleMs: 5000, // nothing to follow (or not following)
    fetchIntervalActiveMs: 1500, // following a host: notice play/pause quickly
    fetchIntervalSoloMs: 10000, // alone in the room, nothing can change
    driftThresholdSec: 2,
    resumeAlignSec: 1,
    reportAgeMaxSec: 20, // cap on extrapolation, guards against bad timestamps
    manualSeekProtectionMs: 10000, // a member's own drag is not overridden for this long
    manualSeekGraceMs: 600, // a seeked event this soon after ours is ours, not the user's
    seekRequestTtlMs: 20000, // how long a "please jump us here" request stays meaningful
    seekRequestMatchSec: 1, // the host counts as "accepted" when this close to the request
    seekRequestMinDriftSec: 5, // smaller drags are not worth the host's attention
    stallMs: 2500, // not paused, but the position has not moved for this long
    stallSampleMs: 1000, // how often we check our own playback for a stall
    stallAdvanceSec: 0.25, // position movement that counts as "still playing"
    stallFreshSec: 10, // a stall signal older than this is ignored (tab may be gone)
    // Cross-tab lock: a reporting tab announces itself on a heartbeat so a tab
    // that loads later (or missed a takeover) never reports at the same time.
    lockHeartbeatMs: 3000,
    lockClaimWaitMs: 1000, // how long a new tab waits for an existing reporter to answer
    lockClaimJitterMs: 800, // random extra wait, so two tabs opened together do not both claim
    lockHandoffJitterMs: 500, // settle time before taking over from a closed tab
    lockHandoffRetryMs: 3000, // if nobody claimed after a hand-off, take it back
    standbyWatchdogMs: 5000, // a stood-down tab still polls to keep its panel alive
    standbyTakeoverMs: 12000, // a standby tab takes over if the row stops updating
    peerSilenceMs: 15000, // ...and only when no other tab has been heard from
    mismatchSteadyPolls: 2, // polls that must agree before the mismatch UI changes
    toastMs: 5000, // how long a bubble stays before it hides itself
    hostJumpFreshMs: 8000, // a "the host jumped" notice older than this is ignored
    hostOfflineMs: 20000,
    participantStaleMs: 60000,
    panelAutoCollapseMs: 10000,

    storageKey: "watch-party-state-v1",
    settingsKey: "watch-party-settings-v1",
    // A room id that will never exist: the warm-up request is a cheap 404 that
    // still does the expensive part (connect to the edge, reach the Worker).
    warmupRoomId: "WARMUP"
  };

  function workerBaseUrl() {
    return CONFIG.useLocalWorker ? CONFIG.workerUrlLocal : CONFIG.workerUrlRemote;
  }

  // Frames forward video state to the top window via postMessage instead of
  // running the full UI. The top window owns the room, sync, and panel.
  const IS_TOP = window.top === window.self;

  // ===========================================================================
  // Module: storage shims (Tampermonkey GM_* with graceful fallback)
  // ===========================================================================
  const storage = (() => {
    const hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
    function get(key, fallback) {
      try {
        if (hasGM) {
          const raw = GM_getValue(key, null);
          return raw == null ? fallback : JSON.parse(raw);
        }
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    }
    function set(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (hasGM) GM_setValue(key, raw);
        else localStorage.setItem(key, raw);
      } catch {
        /* ignore quota / privacy-mode errors */
      }
    }
    function del(key) {
      try {
        if (hasGM && typeof GM_deleteValue === "function") GM_deleteValue(key);
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    return { get, set, del };
  })();

  // ===========================================================================
  // Module: settings
  // ===========================================================================
  const settings = (() => {
    const defaults = {
      autoFollowProgress: true,
      followPlayPause: true,
      displayMode: "pill", // quiet | pill | pinned
      displayName: "",
      seekRequestAutoAccept: false, // host: accept member drags without asking
      forceSync: false, // member: follow the host even on a different video page
      matchedSites: [] // extra domains matched from the Tampermonkey menu
    };
    let current = { ...defaults, ...storage.get(CONFIG.settingsKey, {}) };

    return {
      get: () => ({ ...current }),
      update(patch) {
        current = { ...current, ...patch };
        storage.set(CONFIG.settingsKey, current);
        return { ...current };
      }
    };
  })();

  // ===========================================================================
  // Module: siteMatch (which domains this script is allowed to act on)
  // ---------------------------------------------------------------------------
  // The script installs with `@match *://*/*` so a domain can be added at
  // runtime, but a domain only becomes active once the user matches it from the
  // Tampermonkey menu. An unmatched domain stays completely inert: no DOM, no
  // requests, no timers.
  // ===========================================================================
  const siteMatch = (() => {
    // Sites that worked before runtime matching existed. Always on, never
    // removable from the menu.
    const BUILTIN_SITES = [
      "bilibili.com",
      "xifanapp.com",
      "ciyuanapp.com",
      "agedm.org",
      "localhost",
      "127.0.0.1"
    ];
    // agefans rotates its TLD, so it stays a pattern. Deliberately tight: the
    // old @match `*.agefans.*` would also have accepted agefans.cc.evil.com.
    const BUILTIN_PATTERNS = [/(^|\.)agefans\.[a-z]{2,}(\.[a-z]{2,})?$/];
    // Enough of a public-suffix idea to turn a.b.example.co.uk into
    // example.co.uk (instead of the useless co.uk).
    const SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

    function normalizeHost(host) {
      return String(host || "")
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, "")
        .replace(/\.+$/, "");
    }

    // An entry covers itself and every subdomain of it, and nothing else:
    // "agedm.org" matches "www.agedm.org", never "agedm.org.evil.com".
    function entryMatches(host, entry) {
      const h = normalizeHost(host);
      const e = normalizeHost(entry);
      if (!h || !e) return false;
      return h === e || h.endsWith("." + e);
    }

    function userSites() {
      const list = settings.get().matchedSites;
      return Array.isArray(list) ? list.map(normalizeHost).filter(Boolean) : [];
    }

    function isBuiltin(entry) {
      const e = normalizeHost(entry);
      return BUILTIN_SITES.includes(e) || BUILTIN_PATTERNS.some((re) => re.test(e));
    }

    // Which entry makes this host active — the most specific one wins.
    function matchEntry(host) {
      const h = normalizeHost(host);
      if (!h) return "";
      const candidates = [...BUILTIN_SITES, ...userSites()].filter((e) => entryMatches(h, e));
      if (BUILTIN_PATTERNS.some((re) => re.test(h))) candidates.push(h);
      if (!candidates.length) return "";
      return candidates.sort((a, b) => b.length - a.length)[0];
    }

    function currentHost() {
      return normalizeHost(location.hostname);
    }
    function isMatched(host) {
      return Boolean(matchEntry(host || currentHost()));
    }
    function add(entry) {
      const e = normalizeHost(entry);
      if (!e || isMatched(e)) return false;
      settings.update({ matchedSites: [...userSites(), e] });
      return true;
    }
    function remove(entry) {
      const e = normalizeHost(entry);
      const list = userSites();
      const next = list.filter((h) => h !== e);
      if (next.length === list.length) return false;
      settings.update({ matchedSites: next });
      return true;
    }
    // The domain one level up (www.agedm.org -> agedm.org), offered as its own
    // menu entry so matching subdomains is an explicit choice, never a guess.
    function parentOf(host) {
      const h = normalizeHost(host);
      const labels = h.split(".");
      if (labels.length < 3) return "";
      // IP literals have no useful parent.
      if (labels.every((l) => /^\d+$/.test(l))) return "";
      const take = labels.length >= 4 && SECOND_LEVELS.has(labels[labels.length - 2]) ? 3 : 2;
      const candidate = labels.slice(-take).join(".");
      return candidate === h ? "" : candidate;
    }
    function parentCandidate() {
      const candidate = parentOf(currentHost());
      return candidate && !isMatched(candidate) ? candidate : "";
    }
    function referrerHost() {
      try {
        return document.referrer ? normalizeHost(new URL(document.referrer).hostname) : "";
      } catch {
        return "";
      }
    }
    function listAll() {
      return { builtin: [...BUILTIN_SITES, "*.agefans.*"], user: userSites() };
    }

    return {
      normalizeHost,
      entryMatches,
      matchEntry,
      isBuiltin,
      userSites,
      listAll,
      currentHost,
      isMatched,
      add,
      remove,
      parentOf,
      parentCandidate,
      // A frame only forwards video state when it belongs to a matched site —
      // its own host, or the page that embedded it. Unrelated pages therefore
      // stay quiet inside their iframes too.
      frameShouldReport() {
        if (isMatched(currentHost())) return true;
        const ref = referrerHost();
        return Boolean(ref && isMatched(ref));
      }
    };
  })();

  // Age of a participant's report, measured on server timestamps only — both
  // `serverTime` and `updatedAt` come from the Worker, so a client clock that
  // is minutes off can never leak in. Anything unparseable (or an older Worker
  // without `serverTime`) falls back to 0, i.e. "fresh", which is also the safe
  // direction: it disables extrapolation instead of producing a wild guess.
  function reportAgeSec(roomState, participant, maxSec) {
    const serverNow = Date.parse((roomState && roomState.serverTime) || "");
    const reportedAt = Date.parse((participant && participant.updatedAt) || "");
    if (!Number.isFinite(serverNow) || !Number.isFinite(reportedAt)) return 0;
    const age = (serverNow - reportedAt) / 1000;
    return age > 0 ? Math.min(age, maxSec) : 0;
  }

  // ===========================================================================
  // Module: roomStore (local participant identity + room membership)
  // ===========================================================================
  const roomStore = (() => {
    let state = storage.get(CONFIG.storageKey, null); // {roomId, participantId, role, hostToken?}

    return {
      get: () => (state ? { ...state } : null),
      inRoom: () => Boolean(state && state.roomId && state.participantId),
      save(next) {
        state = next ? { ...next } : null;
        if (state) storage.set(CONFIG.storageKey, state);
        else storage.del(CONFIG.storageKey);
        return state ? { ...state } : null;
      },
      clear() {
        state = null;
        storage.del(CONFIG.storageKey);
      }
    };
  })();

  // ===========================================================================
  // Module: apiClient
  // ===========================================================================
  const apiClient = (() => {
    let lastWarnAt = 0;
    let warned = false;
    // One console line per failure burst: when sync goes unavailable, this is the
    // only place that shows *why* (blocked by CSP, refused by the manager, DNS,
    // timeout, HTTP status — plus which transport was used and how long it took).
    function warn(detail, url) {
      warned = true;
      const now = Date.now();
      if (now - lastWarnAt < 5000) return;
      lastWarnAt = now;
      try {
        console.warn("[一起看] 同步请求失败:", detail, "→", url);
      } catch {
        /* ignore */
      }
    }

    function networkError(url, reason, silent) {
      if (!silent) warn(reason || "network", url);
      const error = new Error("sync-unavailable");
      error.kind = "network";
      return error;
    }

    function gmRequest(url, init) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: init.method,
          url,
          headers: init.headers,
          data: init.body,
          timeout: 15000,
          onload: (r) =>
            resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || "" }),
          onerror: () => reject(new Error("onerror")),
          ontimeout: () => reject(new Error("timeout"))
        });
      });
    }

    // ---- transport selection -------------------------------------------------
    // Chrome gives the *page* a warm connection pool and Happy Eyeballs. A
    // userscript manager's own HTTP stack gets neither, so on a flaky route
    // GM_xmlhttpRequest can spend a minute on an unreachable address while the
    // very same URL opens instantly from the address bar. So both paths are
    // tried once and the first one that answers wins — a working `fetch` is
    // adopted within a few hundred ms even if the manager's stack hangs.
    let transport = typeof GM_xmlhttpRequest === "function" ? "gm" : "fetch";
    let transportSettled = false;
    // Consecutive failures per transport. The preference only moves after two in
    // a row, so a single flaky request cannot cost us the fast path.
    const failStreak = { gm: 0, fetch: 0 };

    function measureTransports() {
      if (transportSettled || typeof GM_xmlhttpRequest !== "function") return;
      const url = workerBaseUrl() + `/rooms/${CONFIG.warmupRoomId}/state`;
      const init = { method: "GET", headers: {} };
      const settle = (name, ms, ok) => {
        if (!ok || transportSettled) return;
        transportSettled = true;
        transport = name;
        try {
          console.info(
            `[一起看] 通道测速：${name === "fetch" ? "fetch" : "GM_xmlhttpRequest"} 先通（${ms}ms），采用它` +
              (name === "fetch" ? "（GM 通道在你这台机器上很慢）" : "")
          );
        } catch {
          /* ignore */
        }
      };
      const a = Date.now();
      gmRequest(url, init).then(
        () => settle("gm", Date.now() - a, true),
        () => settle("gm", Date.now() - a, false)
      );
      const b = Date.now();
      fetch(url, init).then(
        () => settle("fetch", Date.now() - b, true),
        () => settle("fetch", Date.now() - b, false)
      );
    }

    async function request(method, path, body, opts) {
      const silent = Boolean(opts && opts.silent);
      const started = Date.now();
      const url = workerBaseUrl() + path;
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      // Try the chosen transport first, then the other one. Between them one
      // works on essentially any site: `fetch` rides the page's own (fast, warm)
      // connection pool but is governed by the site's `connect-src` CSP, while
      // the manager's stack ignores CSP but can sit for a minute on a dead
      // address. A transport has to fail twice in a row before the preference
      // moves, so one transient hiccup does not give up the fast path.
      const gmAvailable = typeof GM_xmlhttpRequest === "function";
      const gmFirst = transport === "gm";
      const order = gmFirst || !gmAvailable ? ["gm", "fetch"] : ["fetch", "gm"];
      let res = null;
      let used = transport;
      let lastFail = null;
      for (const t of order) {
        if (t === "gm" && !gmAvailable) continue;
        const t0 = Date.now();
        try {
          if (t === "gm") {
            res = await gmRequest(url, init);
          } else {
            const raw = await fetch(url, init);
            res = { ok: raw.ok, status: raw.status, text: await raw.text() };
          }
          used = t;
          failStreak[t] = 0;
          break;
        } catch (err) {
          res = null;
          lastFail = { t, ms: Date.now() - t0, err };
          failStreak[t] = (failStreak[t] || 0) + 1;
        }
      }
      if (!res) {
        const other = used === "gm" ? "fetch" : "gm";
        if (failStreak[used] >= 2 && (other !== "gm" || gmAvailable)) transport = other;
        const detail = lastFail
          ? `${lastFail.t === "gm" ? "GM_xmlhttpRequest" : "fetch"} 失败（${lastFail.ms}ms: ${
              (lastFail.err && lastFail.err.message) || lastFail.err
            }）`
          : "没有可用的请求通道";
        throw networkError(url, detail, silent);
      }
      // A fallback is worth a line: it explains a sudden change in speed.
      if (used !== transport) {
        if (!silent) {
          warn(
            `${transport === "gm" ? "GM_xmlhttpRequest" : "fetch"} 失败，本次改用 ${
              used === "gm" ? "GM_xmlhttpRequest" : "fetch"
            }`,
            url
          );
        }
        if (failStreak[transport] >= 2) transport = used;
      }
      // A slow request is the whole story behind "creating a room takes ten
      // seconds", and it is invisible otherwise: the request succeeds, just late.
      const elapsed = Date.now() - started;
      if (elapsed > 1500) {
        const label = (opts && opts.tag) || `${method} ${path}`;
        try {
          console.info(`[一起看] ${label} 用了 ${elapsed}ms（${used === "gm" ? "GM_xmlhttpRequest" : "fetch"}）`);
        } catch {
          /* ignore */
        }
      }
      let data = {};
      try {
        data = res.text ? JSON.parse(res.text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        const error = new Error(data.error || `HTTP ${res.status}`);
        error.kind = "http";
        error.status = res.status;
        if (!silent) warn(`HTTP ${res.status} ${data.error || ""}`.trim(), url);
        throw error;
      }
      if (warned) {
        warned = false;
        try {
          console.info("[一起看] 同步已恢复:", url);
        } catch {
          /* ignore */
        }
      }
      return data;
    }

    return {
      createRoom: (displayName) => request("POST", "/rooms", { displayName }),
      joinRoom: (roomId, displayName) =>
        request("POST", `/rooms/${encodeURIComponent(roomId)}/join`, { displayName }),
      reportState: (roomId, payload) =>
        request("POST", `/rooms/${encodeURIComponent(roomId)}/state`, payload),
      fetchState: (roomId) => request("GET", `/rooms/${encodeURIComponent(roomId)}/state`),
      // Fire-and-forget: measures both transports and warms the winner, so the
      // user's first click does not pay for a cold connection.
      warmup: () => {
        measureTransports();
      }
    };
  })();

  // ===========================================================================
  // Module: videoIdentity
  // Decides whether two participants are watching the "same video", using URL
  // normalization first and a duration+title fingerprint as a fallback.
  // computeVideoKey returns either a stable "real" key (e.g. bili:BV...) or a
  // "feat:" fallback key when no reliable URL identity can be derived.
  // ===========================================================================
  const videoIdentity = (() => {
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

    // Normalize host+pathname for generic sites (drop query/hash + trailing /).
    // Returns "" for hostless URLs (about:blank, blob:, file:) so callers fall
    // back to the duration+title fingerprint instead of a meaningless key.
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

    // Compare local vs host. Returns true when we believe it's the same video,
    // and intentionally errs toward true when host info is insufficient so we
    // never wrongly stop following.
    function isSameVideo(localState, hostState) {
      if (!hostState) return true;
      const localKey = localState && localState.videoKey;
      const hostKey = hostState.videoKey;
      if (!hostKey) return true; // host gave us nothing to compare against

      if (localKey && hostKey && !isFeatKey(localKey) && !isFeatKey(hostKey)) {
        return localKey === hostKey;
      }

      // Fallback: duration (±2s) + exact title.
      const ld = localState && Number.isFinite(localState.duration) ? localState.duration : null;
      const hd = Number.isFinite(hostState.duration) ? hostState.duration : null;
      if (ld == null || hd == null) return true;
      const sameDur = Math.abs(ld - hd) <= 2;
      const sameTitle = (localState.title || "") === (hostState.title || "");
      return sameDur && sameTitle;
    }

    return { computeVideoKey, isSameVideo, isFeatKey };
  })();

  // ===========================================================================
  // Module: tabLock
  // Ensures only one tab in this browser is the "active" syncing tab for a room.
  // Uses BroadcastChannel (falls back to localStorage storage events). The
  // newest tab to claim wins (1a "later claimer takes over"); the previous
  // active tab yields to standby. participantId is shared across tabs (2a).
  // ===========================================================================
  const tabLock = (() => {
    const CHANNEL = "watch-party-lock-v1";
    const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let mode = "standby"; // "active" | "standby"
    let claimAt = 0; // when we last claimed, used to break ties between tabs
    let serial = 0; // makes every message unique, so identical ones still fire
    let claimTimer = null; // pending "claim only if nobody else is reporting"
    let heartbeatTimer = null;
    let onYield = () => {};
    let onPeerReleased = () => {};

    // Every mode change is logged with its reason: when the panel shows the
    // standby hint unexpectedly, this says exactly who decided it.
    function switchMode(next, why) {
      if (mode === next) return;
      mode = next;
      try {
        console.info(next === "active" ? `[一起看] 我接管了同步（${why}）` : `[一起看] 我让出同步（${why}）`);
      } catch {
        /* ignore */
      }
    }

    // Tampermonkey's storage is shared by *every* tab of this script, including
    // tabs on completely different sites — which is the only transport that
    // works when the room's videos live on different origins. BroadcastChannel
    // and localStorage are per-origin, so they stay as fallbacks for
    // non-Tampermonkey environments (same-site tabs then still coordinate).
    const gmChannel =
      typeof GM_addValueChangeListener === "function" && typeof GM_setValue === "function";
    const channel = (() => {
      if (typeof BroadcastChannel === "function") {
        try {
          return new BroadcastChannel(CHANNEL);
        } catch {
          /* fall through to localStorage */
        }
      }
      return null;
    })();

    function post(msg) {
      const payload = { ...msg, tabId, serial: serial++ };
      if (gmChannel) {
        try {
          GM_setValue(CHANNEL, JSON.stringify(payload));
          return;
        } catch {
          /* fall through */
        }
      }
      if (channel) {
        try {
          channel.postMessage(payload);
          return;
        } catch {
          /* fall through */
        }
      }
      try {
        // storage event fires in *other* tabs; include a nonce so repeated
        // identical messages still trigger.
        localStorage.setItem(CHANNEL, JSON.stringify({ ...payload, n: Math.random() }));
      } catch {
        /* ignore */
      }
    }

    // Whoever claimed most recently owns the lock. The tab id only breaks exact
    // ties, so two tabs that claim in the same millisecond still converge on one
    // winner instead of both stepping down.
    function losesTo(msg) {
      const theirClaim = Number(msg.claimedAt) || 0;
      if (theirClaim !== claimAt) return theirClaim > claimAt;
      return String(msg.tabId) > tabId;
    }

    function startHeartbeat() {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        if (mode === "active") post({ type: "active", claimedAt: claimAt });
      }, CONFIG.lockHeartbeatMs);
    }

    function stopHeartbeat() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    function becomeActive() {
      switchMode("active", "只有我在上报");
      claimAt = Date.now();
      post({ type: "claim", claimedAt: claimAt });
      startHeartbeat();
    }

    function handle(msg) {
      if (!msg || msg.tabId === tabId) return;
      if (msg.type === "probe") {
        // A tab is asking whether anybody is already reporting. Answering is
        // event-driven, so it works even while this tab is throttled in the
        // background — which is why the claim decision uses this instead of
        // waiting for the next heartbeat.
        if (mode === "active") post({ type: "active", claimedAt: claimAt });
        return;
      }
      if (msg.type === "claim" || msg.type === "active") {
        // Remember that a sibling tab is alive: a tab that stepped down must not
        // fight it later just because *its own* row (a different participant id,
        // e.g. after joining the same room twice) stopped being updated.
        lastPeerSeenAt = Date.now();
        // Somebody else is (or is about to be) the reporting tab: drop any
        // pending takeover of ours, and step down if we thought we owned it.
        if (claimTimer) {
          clearTimeout(claimTimer);
          claimTimer = null;
          try {
            console.info(`[一起看] 放弃接管（收到另一个标签的 ${msg.type}）`);
          } catch {
            /* ignore */
          }
          // We are not the reporting tab after all — let the panel say so.
          onYield();
        }
        if (mode === "active" && losesTo(msg)) {
          switchMode("standby", "另一个标签声明得更晚");
          stopHeartbeat();
          onYield();
        }
      } else if (msg.type === "release") {
        // That tab is going away, so nothing is reporting for this browser any
        // more — let the watchdog take over without waiting out the silence.
        lastPeerSeenAt = 0;
        onPeerReleased();
      }
    }

    if (gmChannel) {
      try {
        // Fires in other tabs (including other origins) whenever this script
        // writes the lock value. `remote` filters out our own writes.
        GM_addValueChangeListener(CHANNEL, (_name, _oldValue, newValue, remote) => {
          if (!remote || !newValue) return;
          try {
            handle(JSON.parse(newValue));
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    } else if (channel) {
      channel.addEventListener("message", (ev) => handle(ev.data));
    } else {
      window.addEventListener("storage", (ev) => {
        if (ev.key !== CHANNEL || !ev.newValue) return;
        try {
          handle(JSON.parse(ev.newValue));
        } catch {
          /* ignore */
        }
      });
    }

    window.addEventListener("pagehide", (ev) => {
      // Parked in the back/forward cache: the page is frozen, not gone. Standing
      // down here (and telling everyone) made the tab flash "synced in another
      // tab" the moment it came back, so keep our state instead — pageshow
      // re-probes, and a real unfreeze/takeover is handled by the watchdog.
      if (ev && ev.persisted) return;
      // Leaving for real: stop announcing ourselves. If this page is restored
      // later it re-probes via pageshow, so it can never come back as a second
      // reporter.
      stopHeartbeat();
      if (claimTimer) {
        clearTimeout(claimTimer);
        claimTimer = null;
      }
      const wasActive = mode === "active";
      switchMode("standby", "页面即将离开");
      if (wasActive) post({ type: "release" });
    });

    return {
      // "I am reporting, or I am about to" — a pending claim counts, so the
      // panel does not flash the standby hint while a takeover is being decided.
      isActive: () => mode === "active" || Boolean(claimTimer),
      claim() {
        if (claimTimer) {
          clearTimeout(claimTimer);
          claimTimer = null;
        }
        becomeActive();
      },
      // Take over only if nobody in this browser is already reporting: ask, and
      // let an existing reporter answer before we claim. The random extra wait
      // keeps two tabs opened at the same instant from claiming together.
      claimWhenFree(delayMs, onClaimed) {
        if (mode === "active") {
          if (onClaimed) onClaimed();
          return;
        }
        if (claimTimer) clearTimeout(claimTimer);
        post({ type: "probe" });
        const wait = delayMs + Math.floor(Math.random() * CONFIG.lockClaimJitterMs);
        claimTimer = setTimeout(() => {
          claimTimer = null;
          if (mode === "active") return;
          becomeActive();
          if (onClaimed) onClaimed();
        }, wait);
      },
      // Stand down and tell the other tabs, so one of them can pick it up.
      yieldActive() {
        if (claimTimer) {
          clearTimeout(claimTimer);
          claimTimer = null;
        }
        if (mode === "active") {
          switchMode("standby", "主动让位（离开房间）");
          stopHeartbeat();
          post({ type: "release" });
        }
      },
      // Stand down silently: used when another tab is already opening (the
      // "jump to the shared video" flow), so only that new tab takes over.
      suspend() {
        if (claimTimer) {
          clearTimeout(claimTimer);
          claimTimer = null;
        }
        switchMode("standby", "让位给新打开的视频页");
        stopHeartbeat();
      },
      set onYield(fn) {
        onYield = fn;
      },
      set onPeerReleased(fn) {
        onPeerReleased = fn;
      }
    };
  })();

  // ===========================================================================
  // Module: videoAdapters
  // Each adapter exposes: detect, getState, seek, play, pause, onChange, name.
  // ===========================================================================
  const videoAdapters = (() => {
    const CHANGE_EVENTS = ["play", "pause", "seeked", "loadedmetadata", "emptied"];

    // Pick the most likely "main" video element in this document.
    function pickMainVideo() {
      const videos = [...document.querySelectorAll("video")];
      if (!videos.length) return null;
      const scored = videos
        .map((v) => ({ v, score: scoreVideo(v) }))
        .filter((x) => x.score > -Infinity)
        .sort((a, b) => b.score - a.score);
      return scored.length ? scored[0].v : null;
    }

    function scoreVideo(v) {
      const rect = v.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        getComputedStyle(v).visibility !== "hidden" &&
        getComputedStyle(v).display !== "none";
      const area = rect.width * rect.height;
      const hasDuration = Number.isFinite(v.duration) && v.duration > 0;
      // Ignore tiny preview/ad players.
      if (area < 60 * 40 && !hasDuration) return -Infinity;
      let score = area;
      if (visible) score += 1_000_000;
      if (hasDuration) score += 500_000;
      return score;
    }

    function sourceId(v) {
      return v.currentSrc || v.src || location.pathname || "video";
    }

    // ---- Generic <video> adapter ----
    function genericVideoAdapter(name) {
      let el = null;
      let changeCb = null;
      const listeners = [];
      let lastTime = null;
      let lastAdvanceAt = Date.now();

      function bind(video) {
        if (el === video) return;
        unbind();
        el = video;
        lastTime = null;
        lastAdvanceAt = Date.now();
        if (!el) return;
        for (const type of CHANGE_EVENTS) {
          // The event type lets listeners tell "the user dragged the bar" from
          // "playback started".
          const fn = (ev) => changeCb && changeCb(ev && ev.type);
          el.addEventListener(type, fn);
          listeners.push([type, fn]);
        }
      }
      function unbind() {
        if (el) {
          for (const [type, fn] of listeners) el.removeEventListener(type, fn);
        }
        listeners.length = 0;
      }

      // "Not paused, but the position stopped moving" is what a stall looks like
      // from the outside. It is measured instead of event-driven on purpose:
      // every seek also fires a `waiting` event, so a flag would cry wolf.
      function noteAdvance() {
        if (!el || !Number.isFinite(el.currentTime)) return;
        if (lastTime === null || Math.abs(el.currentTime - lastTime) >= CONFIG.stallAdvanceSec) {
          lastAdvanceAt = Date.now();
        }
        lastTime = el.currentTime;
      }
      function isBuffering() {
        if (!el || el.paused) return false;
        return Date.now() - lastAdvanceAt > CONFIG.stallMs;
      }

      return {
        name: name || "generic-video",
        detect() {
          const found = pickMainVideo();
          if (found) bind(found);
          return Boolean(found);
        },
        getState() {
          if (!el || !el.isConnected) {
            const refreshed = pickMainVideo();
            if (refreshed) bind(refreshed);
          }
          if (!el) return null;
          noteAdvance();
          return {
            currentTime: Number(el.currentTime) || 0,
            duration: Number.isFinite(el.duration) ? el.duration : 0,
            paused: Boolean(el.paused),
            buffering: isBuffering(),
            url: location.href,
            title: (document.title || "").slice(0, 160),
            source: sourceId(el),
            adapter: this.name
          };
        },
        seek(time) {
          if (el && Number.isFinite(time)) {
            try {
              el.currentTime = time;
            } catch {
              /* some players block direct seeks */
            }
          }
        },
        play() {
          if (el) {
            const p = el.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
          }
        },
        pause() {
          if (el) el.pause();
        },
        onChange(cb) {
          changeCb = cb;
        }
      };
    }

    // ---- Bilibili adapter: same controls, just a distinct name + selector hint.
    function bilibiliAdapter() {
      const base = genericVideoAdapter("bilibili");
      const originalDetect = base.detect.bind(base);
      base.detect = () => {
        // Prefer the main player container's video; fall back to generic pick.
        const inPlayer = document.querySelector(
          ".bpx-player-video-wrap video, #bilibiliPlayer video, .bilibili-player-video video"
        );
        if (inPlayer) {
          // Reuse generic binding by temporarily exposing it.
          base.getState(); // ensures lazy bind path is harmless
        }
        return originalDetect();
      };
      return base;
    }

    // ---- iframe handling ----
    // In a frame: forward state to top. In top: collect best frame state.
    const FRAME_MSG = "watch-party-frame-v1";

    function startFrameReporter() {
      const adapter = genericVideoAdapter("iframe-video");
      function report() {
        if (!adapter.detect()) return;
        const s = adapter.getState();
        if (!s) return;
        try {
          window.top.postMessage({ __wp: FRAME_MSG, dir: "up", state: s }, "*");
        } catch {
          /* cross-origin top — nothing we can do */
        }
      }
      // Respond to control commands from the top window.
      window.addEventListener("message", (ev) => {
        const d = ev.data;
        if (!d || d.__wp !== FRAME_MSG || d.dir !== "down") return;
        // Only the page that embeds this frame may drive it.
        if (ev.source !== window.parent) return;
        if (!adapter.detect()) return;
        if (d.cmd === "seek") adapter.seek(d.time);
        else if (d.cmd === "play") adapter.play();
        else if (d.cmd === "pause") adapter.pause();
      });
      adapter.onChange(report);
      setInterval(report, 2000);
      report();
    }

    function iframeAggregatorAdapter() {
      let latest = null; // {state, at}
      let changeCb = null;

      window.addEventListener("message", (ev) => {
        const d = ev.data;
        if (!d || d.__wp !== FRAME_MSG || d.dir !== "up" || !d.state) return;
        latest = { state: d.state, at: Date.now() };
        if (changeCb) changeCb();
      });

      function fresh() {
        return latest && Date.now() - latest.at < 6000 ? latest.state : null;
      }
      function broadcast(cmd, time) {
        for (const frame of document.querySelectorAll("iframe")) {
          try {
            frame.contentWindow &&
              frame.contentWindow.postMessage({ __wp: FRAME_MSG, dir: "down", cmd, time }, "*");
          } catch {
            /* ignore */
          }
        }
      }

      return {
        name: "iframe-video",
        detect: () => Boolean(fresh()),
        getState() {
          const s = fresh();
          if (!s) return null;
          return { ...s, url: location.href, title: document.title.slice(0, 160), adapter: this.name };
        },
        seek: (time) => broadcast("seek", time),
        play: () => broadcast("play"),
        pause: () => broadcast("pause"),
        onChange: (cb) => {
          changeCb = cb;
        }
      };
    }

    // Choose the active adapter for the top window: prefer a direct page video,
    // otherwise fall back to whatever the iframes report.
    function resolveTopAdapter() {
      const host = location.hostname;
      const pageAdapter = host.includes("bilibili.com") ? bilibiliAdapter() : genericVideoAdapter();
      const frameAdapter = iframeAggregatorAdapter();

      return {
        name: "auto",
        _active: null,
        detect() {
          if (pageAdapter.detect()) {
            this._active = pageAdapter;
            return true;
          }
          if (frameAdapter.detect()) {
            this._active = frameAdapter;
            return true;
          }
          this._active = null;
          return false;
        },
        getState() {
          return this._active ? this._active.getState() : null;
        },
        seek(t) {
          pageAdapter.seek(t);
          frameAdapter.seek(t);
        },
        play() {
          pageAdapter.play();
          frameAdapter.play();
        },
        pause() {
          pageAdapter.pause();
          frameAdapter.pause();
        },
        onChange(cb) {
          pageAdapter.onChange(cb);
          frameAdapter.onChange(cb);
        }
      };
    }

    return { resolveTopAdapter, startFrameReporter };
  })();

  // Inside a frame: only the lightweight reporter runs, and only when this
  // frame belongs to a matched site (its own host, or the embedding page).
  // Everything below this point is top-window only.
  if (!IS_TOP) {
    if (siteMatch.frameShouldReport()) videoAdapters.startFrameReporter();
    return;
  }

  // ===========================================================================
  // Module: syncEngine
  // ===========================================================================
  const syncEngine = (() => {
    const adapter = videoAdapters.resolveTopAdapter();
    let reportTimer = null;
    let fetchTimer = null; // setTimeout handle: polling re-schedules itself each round
    let stallTimer = null;
    let standbyTimer = null; // watchdog while we have stood down for another tab
    let running = false;
    let lastManualSeekAt = 0;
    let lastProgrammaticSeekAt = 0;
    let lastRoomState = null;
    let lastReportSig = "";
    let mismatchHost = null; // host state when local video differs, else null
    let mismatchVotes = { same: 0, diff: 0 }; // hysteresis for the mismatch verdict
    // Co-op state: a member's pending "jump us here" ask, the requests the host
    // already answered, who the room is currently waiting for, and the host's
    // "stop waiting" override.
    let pendingRequest = null;
    let handledRequestIds = new Set();
    let announcedRequestId = "";
    let waitingFor = null;
    let pausedForWait = false;
    let skipWaitActive = false;
    let lastBuffering = false;
    let fetchSeq = 0; // guards against a slow earlier fetch overwriting a newer one
    let lastParticipantCount = 0; // used to notice someone joining (see fetchNow)
    let pendingJumpId = ""; // host: "I moved the timeline", announced once
    let lastHostJumpId = ""; // member: the last host jump we told the user about
    let lastPeerSeenAt = 0; // last time another tab of this browser spoke to us
    let onUpdate = () => {};
    let onError = () => {};
    let onMismatch = () => {};
    let onSeekRequest = () => {};
    let onNotice = () => {};
    let visibilityHandler = null;

    function localState() {
      adapter.detect();
      const state = adapter.getState();
      if (state) state.videoKey = videoIdentity.computeVideoKey(location.href, state);
      return state;
    }

    function watchManualSeeks() {
      adapter.onChange((type) => {
        // A "seeked" event we did not start is the user dragging the timeline.
        if (type === "seeked" && Date.now() - lastProgrammaticSeekAt > CONFIG.manualSeekGraceMs) {
          markManualSeek();
          const room = roomStore.get();
          if (room && room.role === "host") {
            // The host is the timeline: their drag is the new truth, so just
            // announce it (and let the co-op field below tell the members).
            pendingJumpId = newRequestId();
            onNotice("已更新进度，成员将会同步", "info");
          } else {
            requestHostSeek();
          }
        }
        reportNow().catch(() => {});
      });
    }

    // Every seek we issue ourselves goes through here, so that a later "seeked"
    // event can be attributed to us instead of to the user.
    function seekTo(time) {
      if (!Number.isFinite(time)) return;
      lastProgrammaticSeekAt = Date.now();
      adapter.seek(time);
    }

    function markManualSeek() {
      lastManualSeekAt = Date.now();
    }

    function inSeekProtection() {
      return Date.now() - lastManualSeekAt < CONFIG.manualSeekProtectionMs;
    }

    function newRequestId() {
      return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    // Is a drag far enough from the host to be worth interrupting them for?
    function worthRequesting(hostTarget, localTime, minDriftSec) {
      if (!Number.isFinite(hostTarget) || !Number.isFinite(localTime)) return false;
      return Math.abs(hostTarget - localTime) >= minDriftSec;
    }

    // A member's drag is a request, not a fact: the host owns the timeline, so
    // the room only moves when the host says so. Tiny nudges are not worth
    // interrupting them for — and if we are on a different video entirely, our
    // timestamp means nothing to them, so we do not ask at all.
    function requestHostSeek() {
      const room = roomStore.get();
      if (!room || room.role === "host") return;
      const local = localState();
      if (!local || !Number.isFinite(local.currentTime)) return;
      const host = hostEntry(lastRoomState);
      if (!host || !host.state) return;
      // Cross-video asks are meaningless — unless the member forced sync, in
      // which case they are explicitly treating the two pages as one video.
      if (!settings.get().forceSync && !videoIdentity.isSameVideo(local, host.state)) return;
      const target = hostPositionAt(host.state, reportAgeSec(lastRoomState, host, CONFIG.reportAgeMaxSec));
      if (!worthRequesting(target, local.currentTime, CONFIG.seekRequestMinDriftSec)) return;
      pendingRequest = { id: newRequestId(), time: local.currentTime, at: Date.now() };
    }

    // Guards against piling up requests: when the link is slow, a fixed polling
    // interval would start a new request every few seconds while the old ones are
    // still in flight, and the whole room drowns. One at a time, always.
    let reportInFlight = false;
    let reportDirty = false;

    async function reportNow() {
      if (reportInFlight) {
        reportDirty = true; // remembered: state changed while a report was on its way
        return;
      }
      const room = roomStore.get();
      if (!room) return;
      // Only the tab that owns the lock reports. Without this, a tab that stepped
      // down (or is on standby) would still overwrite the room's row whenever its
      // video fired play/pause/seeked — which is what made the room's video (and
      // so the "different video" indicator) flip back and forth.
      if (!running) return;
      const state = localState();
      if (!state) return;
      // Co-op fields ride along with the normal report.
      if (pendingRequest && Date.now() - pendingRequest.at < CONFIG.seekRequestTtlMs) {
        state.seekRequest = { id: pendingRequest.id, time: pendingRequest.time };
      }
      if (room.role === "host" && skipWaitActive) state.skipWait = true;
      // Members can declare that they are following across a different page, so
      // the host can honour their jump requests and say why they are following.
      if (room.role !== "host" && settings.get().forceSync) state.forceSync = true;
      // One-shot: the members get told about a host drag exactly once.
      if (room.role === "host" && pendingJumpId) state.hostJump = { id: pendingJumpId };
      const payload = { participantId: room.participantId, state };
      if (room.role === "host" && room.hostToken) payload.hostToken = room.hostToken;
      lastReportSig = JSON.stringify(state);
      reportInFlight = true;
      try {
        await apiClient.reportState(room.roomId, payload);
        if (state.hostJump) pendingJumpId = "";
      } catch (err) {
        onError(err.message === "sync-unavailable" ? "sync-unavailable" : err.message);
      } finally {
        reportInFlight = false;
        if (reportDirty) {
          reportDirty = false;
          reportNow().catch(() => {});
        }
      }
    }

    // Members get yanked when the host moves the timeline; say why.
    function noticeHostJump(roomState) {
      const room = roomStore.get();
      if (!room || room.role === "host") return;
      const host = hostEntry(roomState);
      const jump = host && host.state ? host.state.hostJump : null;
      if (!jump || !jump.id || jump.id === lastHostJumpId) return;
      // A jump from minutes ago must not pop up now — and must not be remembered
      // as "already told" either, or the real jump would be swallowed.
      if (reportAgeSec(roomState, host, CONFIG.reportAgeMaxSec) * 1000 > CONFIG.hostJumpFreshMs) return;
      lastHostJumpId = jump.id;
      onNotice("房主调整了进度", "info");
    }

    // The room is *not* used to decide who reports — the cross-tab channel does
    // that (it is instant, and the diagnostics proved it reaches tabs on other
    // sites too). This function is purely the standby watchdog: keep the panel's
    // data fresh, and take the job back if the reporting tab stopped updating
    // (crashed, discarded, navigated away …). It needs no extra state fields,
    // just the row's own timestamp.
    // A stood-down tab only takes the job back when *both* are true: its own row
    // has gone quiet, and no sibling tab has been heard from for a while. The
    // second condition matters because two tabs can hold *different* participant
    // ids (e.g. after joining the same room twice) — then each one's own row goes
    // stale while the other keeps reporting, and a row-only rule would make the
    // two of them fight forever. Pure, mirrored in tests/follow-sync.test.js.
    function shouldReclaim(rowStaleMs, peerSilentMs) {
      return rowStaleMs >= CONFIG.standbyTakeoverMs && peerSilentMs >= CONFIG.peerSilenceMs;
    }

    function standbyWatchdogTick(roomState) {
      const room = roomStore.get();
      if (!room || !roomState) return true;
      if (!standbyTimer) return true; // only a stood-down tab runs this
      const mine = roomState.participants.find((p) => p.participantId === room.participantId);
      if (!mine || !mine.state) return true;
      const rowStaleMs = reportAgeSec(roomState, mine, CONFIG.standbyTakeoverMs / 1000) * 1000;
      const peerSilentMs = Date.now() - lastPeerSeenAt;
      if (shouldReclaim(rowStaleMs, peerSilentMs)) {
        activate(); // nobody is reporting for us any more: take over
        return false;
      }
      onUpdate(roomState); // still somebody else's job: just refresh the panel
      return false;
    }

    function startStandbyWatchdog() {
      if (standbyTimer) return;
      // Fetch once straight away so a standby tab's panel shows the participants
      // without waiting for the first tick.
      fetchNow().catch(() => {});
      standbyTimer = setInterval(() => {
        fetchNow().catch(() => {});
      }, CONFIG.standbyWatchdogMs);
    }

    function stopStandbyWatchdog() {
      if (standbyTimer) clearInterval(standbyTimer);
      standbyTimer = null;
    }

    let fetchInFlight = false;

    async function fetchNow() {
      // A slow response is already on its way; stacking another one on top would
      // only make the backlog worse (and a newer result does not exist yet).
      if (fetchInFlight) return;
      const room = roomStore.get();
      if (!room) return;
      fetchInFlight = true;
      const seq = ++fetchSeq;
      try {
        const data = await apiClient.fetchState(room.roomId);
        // A slow earlier response must not overwrite a newer one: several callers
        // (the poll loop, visibilitychange, the standby watchdog) can overlap.
        if (seq !== fetchSeq) return;
        lastRoomState = data;
        // Someone just joined: push a fresh position immediately instead of
        // letting them align to a stale one (and possibly call us offline).
        const count = (data.participants || []).length;
        if (count > lastParticipantCount) reportNow().catch(() => {});
        lastParticipantCount = count;
        if (!standbyWatchdogTick(data)) return;
        // Waiting on a stall is everyone's business (the host included);
        // following the host is only what members do.
        applyRoomWait(data);
        applyFollow(data);
        handleSeekRequests(data);
        noticeHostJump(data);
        onUpdate(data);
      } catch (err) {
        onError(err.message === "sync-unavailable" ? "sync-unavailable" : err.message);
      } finally {
        fetchInFlight = false;
      }
    }

    function hostEntry(roomState) {
      if (!roomState) return null;
      return (
        roomState.participants.find((p) => p.participantId === roomState.hostParticipantId) ||
        roomState.participants.find((p) => p.role === "host") ||
        null
      );
    }

    // ---- follow math (pure helpers, mirrored in tests/follow-sync.test.js) ----

    // Where the host is right now, given how stale their report is. Neither a
    // paused nor a buffering host is moving, so the age must not be added then.
    function hostPositionAt(state, ageSec) {
      const t = state && typeof state.currentTime === "number" ? state.currentTime : NaN;
      if (!Number.isFinite(t)) return null;
      if (state.paused || state.buffering) return t;
      const age = Number.isFinite(ageSec) && ageSec > 0 ? Math.min(ageSec, CONFIG.reportAgeMaxSec) : 0;
      return t + age;
    }

    // Does the local player have to move? A manual seek is never overridden and
    // drift inside the tolerance is left alone.
    function needsAlign(target, localTime, toleranceSec, protectedSeek) {
      if (protectedSeek) return false;
      if (!Number.isFinite(target) || !Number.isFinite(localTime)) return false;
      return Math.abs(target - localTime) > toleranceSec;
    }

    // How soon the next poll should happen. Everyone in a room with somebody
    // else polls fast: a member has to follow the host, and the host has to
    // notice a stalled member (or a jump request) quickly.
    function nextFetchDelayMs(ctx) {
      if (!ctx.inRoom) return CONFIG.fetchIntervalIdleMs;
      if (ctx.solo) return CONFIG.fetchIntervalSoloMs;
      // Fast polling only pays for itself when a host position can actually pull
      // us somewhere. The host never follows itself, and a member who is not
      // following (different video, auto-follow off) cannot be moved by a reply —
      // polling them at 1.5s is pure traffic for nothing.
      return ctx.following ? CONFIG.fetchIntervalActiveMs : CONFIG.fetchIntervalIdleMs;
    }

    // Hysteresis for the mismatch verdict: the panel only reacts to a verdict
    // that held for `steady` polls in a row, so a signal flapping between "same"
    // and "different" can never make the warning flicker. Mirrored in the tests.
    function nextMismatchState(showing, votes, sameVideo, steady) {
      const next = sameVideo
        ? { same: votes.same + 1, diff: 0 }
        : { same: 0, diff: votes.diff + 1 };
      if (showing) return { showing: next.same < steady, votes: next };
      return { showing: next.diff >= steady, votes: next };
    }

    function applyFollow(roomState) {
      const room = roomStore.get();
      if (!room || room.role === "host") return; // host never follows itself
      const cfg = settings.get();
      const host = hostEntry(roomState);
      if (!host || !host.state || typeof host.state.currentTime !== "number") return;

      const ageSec = reportAgeSec(roomState, host, CONFIG.reportAgeMaxSec);
      // The server clock is authoritative when available; the local-clock
      // comparison stays only as a fallback for an older Worker.
      const hostFresh = roomState.serverTime
        ? ageSec * 1000 < CONFIG.hostOfflineMs
        : Date.now() - new Date(host.updatedAt).getTime() < CONFIG.hostOfflineMs;
      if (!hostFresh) {
        onError("host-offline");
        return;
      }

      const local = localState();
      if (!local) return;

      // Same-video gate. The *UI* verdict is debounced so a flapping signal
      // cannot make the panel flicker, but whether we follow is decided by the
      // immediate answer — a stray follow must never slip through just because
      // the warning had not been confirmed yet.
      const sameVideo = videoIdentity.isSameVideo(local, host.state);
      const verdict = nextMismatchState(
        Boolean(mismatchHost),
        mismatchVotes,
        sameVideo,
        CONFIG.mismatchSteadyPolls
      );
      mismatchVotes = verdict.votes;
      if (verdict.showing) {
        // Keep the newest host state so the jump button follows the current URL.
        mismatchHost = host.state;
        if (verdict.votes.diff === CONFIG.mismatchSteadyPolls) onMismatch(host.state);
      } else if (mismatchHost) {
        // Confirmed back on the same video: tell the panel to drop the warning.
        mismatchHost = null;
        onMismatch(null);
      }
      // A different video normally means "do not follow at all" — unless the
      // member pressed 强制同步, i.e. declared that the two pages are the same
      // video and the timeline should be followed anyway.
      if (!sameVideo && !settings.get().forceSync) return;

      // Where the host is *now*, not where they were when they last reported.
      // Comparing against the stale position is what used to hide a permanent
      // few-second offset: a follower that started late looked perfectly in
      // sync, so the drift check never fired.
      const target = hostPositionAt(host.state, ageSec);
      if (target === null) return;

      // The host accepted our own request: stop protecting the drag right away
      // instead of waiting out the whole window.
      if (pendingRequest && Math.abs(target - pendingRequest.time) <= CONFIG.seekRequestMatchSec) {
        pendingRequest = null;
        lastManualSeekAt = 0;
      }
      const protectedSeek = inSeekProtection();

      // Follow play/pause — but never resume playback while the room is waiting
      // on somebody else's stall.
      if (!waitingFor && cfg.followPlayPause && typeof host.state.paused === "boolean") {
        if (host.state.paused) {
          if (!local.paused) {
            adapter.pause();
            // Align to where the host stopped, otherwise the seconds spent
            // waiting for this poll stay in the offset forever.
            if (needsAlign(target, local.currentTime, CONFIG.resumeAlignSec, protectedSeek)) {
              seekTo(target);
            }
          }
        } else if (local.paused) {
          // Align *before* resuming, for the same reason.
          if (needsAlign(target, local.currentTime, CONFIG.resumeAlignSec, protectedSeek)) {
            seekTo(target);
          }
          adapter.play();
        }
      }

      // Follow progress with drift threshold + manual-seek protection.
      if (cfg.autoFollowProgress && needsAlign(target, local.currentTime, CONFIG.driftThresholdSec, protectedSeek)) {
        seekTo(target);
      }
    }

    // ---- co-op: waiting on stalls, and the host's "jump us here" decisions ----

    // The host can end a wait early; everyone honours the flag they broadcast.
    function hostSaysSkipWait(roomState) {
      const host = hostEntry(roomState);
      return Boolean(host && host.state && host.state.skipWait);
    }

    // Which participant (if anyone) the room should be waiting for. Pure, so it
    // is mirrored in the tests.
    function waitingParticipant(roomState, selfId, skipWait, freshSec) {
      if (skipWait || !roomState || !Array.isArray(roomState.participants)) return null;
      let best = null;
      for (const p of roomState.participants) {
        if (p.participantId === selfId) continue;
        if (!p.state || !p.state.buffering) continue;
        // A stale stall signal (that tab may be gone) must not freeze the room.
        if (reportAgeSec(roomState, p, freshSec) >= freshSec) continue;
        if (!best || Date.parse(p.updatedAt) > Date.parse(best.updatedAt)) best = p;
      }
      return best ? { participantId: best.participantId, name: best.displayName || "朋友" } : null;
    }

    // Everyone waits for a stalled participant — that is the point of watching
    // together. Only a pause we applied ourselves is ever undone.
    function applyRoomWait(roomState) {
      const room = roomStore.get();
      if (!room) return;
      const skip = skipWaitActive || hostSaysSkipWait(roomState);
      const waiting = waitingParticipant(roomState, room.participantId, skip, CONFIG.stallFreshSec);
      const local = adapter.getState();
      if (!local) return;
      waitingFor = waiting;
      if (waiting) {
        if (!local.paused) {
          adapter.pause();
          pausedForWait = true;
        }
        return;
      }
      if (pausedForWait) {
        pausedForWait = false;
        adapter.play();
      }
      // The host's override has done its job only once nobody is *actually*
      // stalled. Deciding it from the `skip`-aware check above would clear it on
      // the very next poll, and everyone would pause again one tick later.
      if (
        room.role === "host" &&
        skipWaitActive &&
        !waitingParticipant(roomState, room.participantId, false, CONFIG.stallFreshSec)
      ) {
        skipWaitActive = false;
        reportNow().catch(() => {});
      }
    }

    function rememberRequest(id) {
      handledRequestIds.add(id);
      if (handledRequestIds.size > 50) {
        handledRequestIds = new Set([...handledRequestIds].slice(-25));
      }
    }

    // The freshest unhandled request from another participant. Only the host owns
    // this: a member must never be offered someone else's "jump us here" ask.
    function findSeekRequest(roomState) {
      const room = roomStore.get();
      if (!room || room.role !== "host") return null;
      if (!roomState || !Array.isArray(roomState.participants)) return null;
      const self = hostEntry(roomState);
      let best = null;
      for (const p of roomState.participants) {
        if (p.participantId === room.participantId) continue;
        const req = p.state && p.state.seekRequest;
        if (!req || !req.id || !Number.isFinite(Number(req.time))) continue;
        if (handledRequestIds.has(req.id)) continue;
        // Requests go stale: a drag from five minutes ago must not pop up now.
        if (reportAgeSec(roomState, p, CONFIG.seekRequestTtlMs / 1000) * 1000 >= CONFIG.seekRequestTtlMs) continue;
        // Also ignore requests from someone who is watching a different video:
        // their timeline has nothing to do with ours, so "jump to their 12:34"
        // would be meaningless. A participant who forced sync has declared the
        // two pages to be the same video, so their requests still count.
        const forced = Boolean(p.state.forceSync);
        if (!forced && self && self.state && !videoIdentity.isSameVideo(p.state, self.state)) continue;
        if (!best || Date.parse(p.updatedAt) > Date.parse(best.updatedAt)) {
          best = { id: req.id, time: Number(req.time), fromName: p.displayName || "朋友" };
        }
      }
      return best;
    }

    function handleSeekRequests(roomState) {
      const room = roomStore.get();
      if (!room || room.role !== "host") return;
      const req = findSeekRequest(roomState);
      if (!req) return;
      if (settings.get().seekRequestAutoAccept) {
        acceptSeekRequest(req.id, true);
        return;
      }
      if (req.id !== announcedRequestId) {
        announcedRequestId = req.id;
        onSeekRequest(req);
      }
    }

    function acceptSeekRequest(id, auto) {
      const req = findSeekRequest(lastRoomState);
      if (!req || (id && req.id !== id)) return false;
      rememberRequest(req.id);
      announcedRequestId = "";
      seekTo(req.time);
      reportNow().catch(() => {});
      onSeekRequest({ ...req, accepted: true, auto: Boolean(auto) });
      return true;
    }

    function ignoreSeekRequest(id) {
      const req = findSeekRequest(lastRoomState);
      if (!req || (id && req.id !== id)) return false;
      rememberRequest(req.id);
      announcedRequestId = "";
      onSeekRequest({ ...req, ignored: true });
      return true;
    }

    // Host only: stop waiting for whoever is stuck and carry on.
    function skipWait() {
      skipWaitActive = true;
      if (waitingFor) {
        pausedForWait = false;
        adapter.play();
      }
      waitingFor = null;
      // Refresh the bar right away instead of waiting for the next poll.
      onUpdate(lastRoomState);
      reportNow().catch(() => {});
    }

    function fetchDelayContext() {
      const room = roomStore.get();
      const participants = (lastRoomState && Array.isArray(lastRoomState.participants) && lastRoomState.participants) || [];
      const solo = Boolean(lastRoomState) && participants.length <= 1;
      // "Following" = this tab would actually be moved by the host's next report.
      // `mismatchHost` is set when the host is on a different video, which is
      // exactly when following is suspended.
      const following =
        Boolean(room) && room.role !== "host" && settings.get().autoFollowProgress && !mismatchHost;
      return { inRoom: Boolean(room), solo, following };
    }

    function reportDelayMs() {
      const participants = (lastRoomState && lastRoomState.participants) || [];
      // Alone in the room, nobody can be pulled by our position, so the 5s
      // heartbeat is pure cost. A slow beat still keeps the row alive for the
      // next person who joins (and joining itself forces a fresh report).
      if (participants.length <= 1) return CONFIG.reportIntervalSoloMs;
      return CONFIG.reportIntervalMs;
    }

    // Self-rescheduling so each round can pick its own delay (see reportDelayMs).
    // Media events still report immediately; this is only the heartbeat.
    function scheduleReport() {
      if (!running) return;
      if (reportTimer) clearTimeout(reportTimer);
      reportTimer = setTimeout(async () => {
        reportTimer = null;
        if (!running) return;
        await reportNow().catch(() => {});
        scheduleReport();
      }, reportDelayMs());
    }

    // One poll at a time; each round decides how long to wait before the next.
    // A follower polls fast so a play/pause is noticed within ~1.5s, while a
    // host (or someone who is not following) stays on the cheap idle rate.
    function scheduleFetch() {
      if (!running) return;
      if (fetchTimer) clearTimeout(fetchTimer);
      fetchTimer = setTimeout(async () => {
        fetchTimer = null;
        if (!running) return;
        await fetchNow().catch(() => {});
        scheduleFetch();
      }, nextFetchDelayMs(fetchDelayContext()));
    }

    function start() {
      stop();
      watchManualSeeks();
      running = true;
      lastBuffering = false;
      lastParticipantCount = 0;
      scheduleReport();
      scheduleFetch();
      // Watch our own playback for a stall. A *change* is reported at once
      // instead of waiting for the heartbeat, so the rest of the room can pause
      // within a second or two.
      stallTimer = setInterval(() => {
        const st = adapter.getState();
        if (!st) return;
        const buffering = Boolean(st.buffering);
        if (buffering !== lastBuffering) {
          lastBuffering = buffering;
          reportNow().catch(() => {});
        }
      }, CONFIG.stallSampleMs);
      // Background tabs throttle timers heavily; realign the moment we come back
      // to the foreground.
      visibilityHandler = () => {
        if (document.visibilityState === "visible" && tabLock.isActive()) {
          fetchNow().catch(() => {});
        }
      };
      document.addEventListener("visibilitychange", visibilityHandler);
      reportNow().catch(() => {});
      fetchNow().catch(() => {});
    }

    function stop() {
      running = false;
      // Drop the media-event hook too: a tab that is not reporting must never
      // react to its own play/pause/seek events. start() registers it again.
      adapter.onChange(() => {});
      if (reportTimer) clearInterval(reportTimer);
      if (fetchTimer) clearTimeout(fetchTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (standbyTimer) clearInterval(standbyTimer);
      reportTimer = fetchTimer = stallTimer = standbyTimer = null;
      waitingFor = null;
      pausedForWait = false;
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
      }
    }

    // Become the active syncing tab (claims the cross-tab lock, evicting any
    // other active tab), then start reporting/following.
    function activate() {
      tabLock.claim();
      start();
    }

    // On load we do not grab the lock: if another tab of this browser is already
    // reporting, its heartbeat arrives while we wait and we stay standby. Use
    // the panel's 「在此标签同步」 button to take over on purpose.
    //
    // The watchdog is started either way: if we do claim, start() clears it, and
    // if we do not, it is what keeps a standby tab's panel populated (participant
    // list, member positions) instead of showing "no participants".
    function activateOnLoad() {
      startStandbyWatchdog();
      tabLock.claimWhenFree(CONFIG.lockClaimWaitMs, () => {
        start();
        onUpdate(lastRoomState);
      });
    }

    // Hand the lock to a tab that is about to open (the jump flow). The stand
    // down is silent so only that new tab claims it, and from then on the standby
    // watchdog decides: it sees the new tab's fresh id and stays down, or takes
    // the job back if the target page never took over (e.g. its domain is not
    // matched, so the script does not run there at all).
    function releaseForHandoff() {
      tabLock.suspend();
      stop();
      startStandbyWatchdog();
      onUpdate(lastRoomState);
    }

    // Stop reporting/following but keep room membership so the tab can be
    // re-activated later. Triggered when another tab claims the lock.
    // A tab that steps out of the room must also let go of the cross-tab lock,
    // otherwise its heartbeat keeps telling other tabs "somebody is reporting"
    // and the room is left without one.
    function leaveRoom() {
      tabLock.yieldActive();
      stop();
      pendingRequest = null;
      skipWaitActive = false;
      announcedRequestId = "";
      handledRequestIds = new Set();
      waitingFor = null;
    }

    function deactivate() {
      stop();
      // A standby tab is not following anybody, so "not the same video, follow
      // paused" would be misleading. It is recomputed when we take over again.
      mismatchVotes = { same: 0, diff: 0 };
      if (mismatchHost) {
        mismatchHost = null;
        onMismatch(null);
      }
    }

    tabLock.onYield = () => {
      deactivate();
      // A yielded tab is a standby tab: it still shows the panel, so keep the
      // watchdog running (deactivate/stop clears it).
      startStandbyWatchdog();
      onUpdate(lastRoomState);
    };

    // Restored from the back/forward cache: re-probe for the lock instead of
    // assuming we are still the reporter (another tab may have taken over while
    // this page was parked).
    window.addEventListener("pageshow", (ev) => {
      if (!ev.persisted || !roomStore.get()) return;
      activateOnLoad();
    });

    // The reporting tab went away (closed or navigated). Give the others a
    // moment to sort it out via the heartbeat, then take over if nobody did.
    tabLock.onPeerReleased = () => {
      if (!roomStore.get()) return;
      tabLock.claimWhenFree(CONFIG.lockHandoffJitterMs, () => {
        start();
        onUpdate(lastRoomState);
      });
    };

    return {
      start,
      stop,
      activate,
      activateOnLoad,
      releaseForHandoff,
      leaveRoom,
      deactivate,
      isActive: () => tabLock.isActive(),
      reportNow,
      fetchNow,
      markManualSeek,
      pauseLocal() {
        adapter.pause();
      },
      getMismatchHost: () => mismatchHost,
      jumpToHost() {
        const host = hostEntry(lastRoomState);
        if (host && host.state && typeof host.state.currentTime === "number") {
          seekTo(host.state.currentTime);
          markManualSeek();
        }
      },
      // Host-side: the pending "jump us here" request, and what to do with it.
      getSeekRequest: () => findSeekRequest(lastRoomState),
      acceptSeekRequest: (id) => acceptSeekRequest(id, false),
      ignoreSeekRequest,
      // Everyone: who the room is waiting on, and the host's override.
      getWaitingFor: () => waitingFor,
      skipWait,
      detectVideo: () => adapter.detect(),
      getLocalState: localState,
      getRoomState: () => lastRoomState,
      set onUpdate(fn) {
        onUpdate = fn;
      },
      set onError(fn) {
        onError = fn;
      },
      set onMismatch(fn) {
        onMismatch = fn;
      },
      set onSeekRequest(fn) {
        onSeekRequest = fn;
      },
      set onNotice(fn) {
        onNotice = fn;
      }
    };
  })();

  // ===========================================================================
  // Module: panelUi
  // ===========================================================================
  const panelUi = (() => {
    const css = `
      #wp-root { position: fixed; right: 16px; bottom: 96px; z-index: 2147483647;
        font: 13px/1.45 -apple-system, system-ui, "PingFang SC", "Microsoft YaHei",
          "Segoe UI", sans-serif; color: #1b2130; }
      #wp-root * { box-sizing: border-box; }

      /* ---- surfaces: solid white, so the panel reads correctly on light pages ---- */
      .wp-glass {
        background: #fff;
        border: 1px solid rgba(15,23,42,.08);
        box-shadow: 0 18px 44px rgba(15,23,42,.16), 0 2px 8px rgba(15,23,42,.06);
      }

      /* ---- bubbles: the panel is optional, these are not ---- */
      /* Width hugs the text (max-content), capped so long messages still wrap. */
      #wp-toast { position: absolute; right: 0; bottom: 54px; width: max-content;
        max-width: min(304px, calc(100vw - 32px));
        display: none; flex-direction: column; gap: 4px; padding: 10px 12px;
        border-radius: 14px; font-size: 12.5px; color: #1b2130; }
      #wp-toast.show { display: flex; }
      #wp-toast.tone-warn { background: #fffaef; border-color: rgba(217,119,6,.34); }
      #wp-toast.tone-error { background: #fff5f5; border-color: rgba(220,38,38,.30); }
      /* One button per line: the bubble is narrow, so stacking reads better. */
      .wp-toast-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
      .wp-toast-actions button { font-family: inherit; line-height: 1.45; white-space: nowrap;
        width: 100%; border-radius: 9px; cursor: pointer; font-size: 12px; padding: 6px 10px;
        background: #f5f7fb; color: #4a5568; border: 1px solid #e3e8f0;
        transition: background .15s, color .15s, border-color .15s; }
      .wp-toast-actions button:hover { background: #eef2f8; border-color: #d5dde9; color: #171c26; }
      .wp-toast-actions button.primary { background: linear-gradient(150deg, #6d8bff, #2b6cff);
        color: #fff; border-color: rgba(43,108,255,.30); font-weight: 600; }
      .wp-toast-actions button.primary:hover { filter: brightness(1.07); }

      /* ---- floating action button ---- */
      #wp-fab { width: 44px; height: 44px; border-radius: 50%; color: #fff;
        border: 1px solid rgba(255,255,255,.20); cursor: pointer;
        background: linear-gradient(150deg, #6d8bff, #2b6cff);
        box-shadow: 0 10px 28px rgba(43,108,255,.42), inset 0 1px 0 rgba(255,255,255,.38);
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        opacity: .66; transition: opacity .18s, transform .18s, box-shadow .18s,
          visibility .18s;
        display: flex; align-items: center; justify-content: center; font-size: 19px; }
      #wp-fab:hover { opacity: 1; transform: translateY(-2px); }
      #wp-fab svg { display: block; flex: 0 0 auto; margin-top: -1px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
      #wp-fab.in-room { background: linear-gradient(150deg, #45e39d, #1f9e57);
        box-shadow: 0 10px 28px rgba(31,158,87,.44), inset 0 1px 0 rgba(255,255,255,.34); }
      #wp-fab.error { background: linear-gradient(150deg, #ff7d6d, #c0392b);
        box-shadow: 0 10px 28px rgba(192,57,43,.44), inset 0 1px 0 rgba(255,255,255,.34); }
      /* The mode menu opens downward and lands on the FAB's spot — tuck the
         button away so the two never stack half-on-half. */
      #wp-fab.tucked { opacity: 0; visibility: hidden; }

      /* ---- panel shell ---- */
      #wp-panel { position: absolute; right: 0; bottom: 54px; width: 304px;
        border-radius: 18px; overflow: hidden; padding: 0; display: none; }
      #wp-panel.open { display: block; }
      #wp-panel::before { content: ""; position: absolute; top: -66px; left: -54px;
        width: 210px; height: 190px; border-radius: 50%; pointer-events: none;
        background: radial-gradient(closest-side, rgba(43,108,255,.10), rgba(43,108,255,0)); }
      #wp-body { position: relative; z-index: 1; padding: 15px 15px 16px; }
      #wp-panel h4 { margin: 0 0 4px; font-size: 13.5px; font-weight: 650;
        display: flex; align-items: center; gap: 8px; }
      #wp-panel h4 .wp-h-actions { margin-left: auto; display: flex; gap: 6px; }
      #wp-panel .wp-sub { color: #5b6472; font-size: 11.5px; margin: 0 0 6px; }
      #wp-panel .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }

      /* ---- inputs ---- */
      #wp-panel input[type="text"], #wp-panel input:not([type]) {
        background: #f5f7fb; border: 1px solid #e3e8f0;
        color: #1b2130; border-radius: 10px; padding: 8px 10px; width: 100%;
        flex: 1 1 auto; min-width: 0;
        font-size: 12.5px; font-family: inherit; transition: border-color .15s, box-shadow .15s; }
      #wp-panel input::placeholder { color: #9aa4b5; }
      #wp-panel input[type="text"]:focus, #wp-panel input:not([type]):focus {
        outline: none; border-color: #2b6cff; background: #fff;
        box-shadow: 0 0 0 3px rgba(43,108,255,.16); }

      /* ---- buttons ---- */
      #wp-panel button { font-family: inherit; line-height: 1.45; white-space: nowrap;
        flex: 0 0 auto; }
      #wp-panel button.action { background: linear-gradient(150deg, #6d8bff, #2b6cff);
        color: #fff; border: 1px solid rgba(43,108,255,.30); border-radius: 10px;
        padding: 8px 13px; cursor: pointer; font-size: 12.5px; font-weight: 600;
        box-shadow: 0 6px 16px rgba(43,108,255,.28), inset 0 1px 0 rgba(255,255,255,.32);
        transition: filter .15s, transform .15s; }
      #wp-panel button.action:hover { filter: brightness(1.07); transform: translateY(-1px); }
      #wp-panel button.action:active { transform: translateY(0); }
      #wp-panel button.ghost { background: #f5f7fb; color: #4a5568;
        border: 1px solid #e3e8f0; border-radius: 10px;
        padding: 7px 12px; cursor: pointer; font-size: 12.5px;
        transition: background .15s, color .15s, border-color .15s; }
      #wp-panel button.ghost:hover { background: #eef2f8; border-color: #d5dde9; color: #171c26; }
      /* Leaving the room: full-width at the bottom, deliberately separated from
         the settings row it used to share. */
      #wp-panel #wp-leave { width: 100%; margin-top: 10px; padding: 9px 16px;
        color: #c93b23; border-color: #ffd8d0; background: #fff6f4; }
      #wp-panel #wp-leave:hover { background: #ffebe6; border-color: #ffc2b6; color: #ad2f16; }

      /* ---- room code ---- */
      #wp-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13.5px; letter-spacing: 1.5px; color: #2158d8;
        background: rgba(43,108,255,.08); border: 1px solid rgba(43,108,255,.22);
        border-radius: 7px; padding: 2px 8px; }
      #wp-copy { font-size: 11.5px !important; padding: 4px 9px !important; }

      /* ---- participant list ---- */
      #wp-list { margin: 8px 0 2px; max-height: 196px; overflow: auto; }
      #wp-list::-webkit-scrollbar { width: 6px; }
      #wp-list::-webkit-scrollbar-thumb { background: rgba(15,23,42,.16); border-radius: 3px; }
      #wp-list::-webkit-scrollbar-track { background: transparent; }
      .wp-p { display: grid; grid-template-columns: auto minmax(0,1fr) auto;
        align-items: center; gap: 8px; padding: 7px 3px; font-size: 12.5px;
        border-top: 1px solid rgba(15,23,42,.07); border-radius: 8px;
        transition: background .15s; }
      .wp-p:first-child { border-top: none; }
      .wp-p:hover { background: rgba(43,108,255,.05); }
      .wp-dot { width: 7px; height: 7px; border-radius: 50%; }
      .wp-dot.fresh { background: #22c07a; box-shadow: 0 0 7px rgba(34,192,122,.55); }
      .wp-dot.stale { background: #c3c9d4; }
      .wp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wp-name.wp-mismatch { color: #c2410c; }
      .wp-mismatch-tag { color: #c2410c; font-size: 10.5px; margin-left: 5px; }
      .wp-time { color: #6b7280; font-variant-numeric: tabular-nums;
        text-align: right; min-width: 58px; letter-spacing: .2px; }
      .wp-host-tag { color: #241a00; background: linear-gradient(150deg, #ffd873, #ffbe2e);
        border-radius: 6px; font-size: 10px; font-weight: 700; padding: 1px 6px;
        margin-left: 6px; letter-spacing: .3px; }
      .wp-empty { color: #6b7280; font-size: 12px; padding: 8px 3px; }

      /* ---- banners ---- */
      #wp-standby { background: rgba(43,108,255,.07); border: 1px solid rgba(43,108,255,.22);
        border-radius: 12px; padding: 10px; margin: 8px 0 10px; font-size: 12px;
        color: #2c4bbf; }
      #wp-standby button { margin-top: 8px; width: 100%; }
      #wp-mismatch-bar { background: rgba(255,138,92,.10); border: 1px solid rgba(255,138,92,.35);
        border-radius: 12px; padding: 10px; margin: 10px 0; font-size: 12px; color: #c2410c; }
      #wp-mismatch-bar button { margin-top: 8px; width: 100%;
        background: linear-gradient(150deg, #ffb27a, #ff8a5c); color: #2a1810;
        border: 1px solid rgba(255,255,255,.24); border-radius: 10px; padding: 8px;
        cursor: pointer; font-size: 12.5px; font-weight: 600; }
      #wp-mismatch-bar button:hover { filter: brightness(1.06); }
      /* Forced sync: the same slot, but as a calm status note. */
      #wp-mismatch-bar.info { background: rgba(43,108,255,.07); border-color: rgba(43,108,255,.22);
        color: #2c4bbf; }
      .wp-mismatch-tag.wp-forced { color: #2b6cff; }

      /* ---- co-op bars: waiting on a stall, and a member's jump request ---- */
      #wp-seek-req { background: rgba(43,108,255,.07); border: 1px solid rgba(43,108,255,.22);
        border-radius: 12px; padding: 10px; margin: 8px 0 10px; font-size: 12px; color: #2c4bbf; }
      #wp-seek-req b { font-weight: 650; }
      #wp-seek-req .row { margin: 8px 0 0; }
      #wp-wait-bar { background: rgba(245,158,11,.12); border: 1px solid rgba(217,119,6,.28);
        border-radius: 12px; padding: 10px; margin: 8px 0 10px; font-size: 12px; color: #8a5a08; }
      #wp-wait-bar button { margin-top: 8px; width: 100%; }

      /* ---- toggles (custom checkbox) ---- */
      .wp-toggle { position: relative; display: flex; align-items: center; gap: 9px;
        margin: 9px 0; font-size: 12.5px; color: #3f4859; cursor: pointer; }
      .wp-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
      .wp-toggle .wp-box { position: relative; flex: 0 0 17px; width: 17px; height: 17px;
        border-radius: 5px; background: #fff;
        border: 1.5px solid #c9d1dd; transition: background .15s, border-color .15s; }
      .wp-toggle:hover .wp-box { border-color: #a7b2c2; }
      .wp-toggle input:checked + .wp-box {
        background: linear-gradient(150deg, #6d8bff, #2b6cff); border-color: transparent;
        box-shadow: 0 3px 10px rgba(43,108,255,.32); }
      .wp-toggle input:checked + .wp-box::after { content: "\\2713"; position: absolute;
        inset: 0; display: flex; align-items: center; justify-content: center;
        color: #fff; font-size: 12px; font-weight: 700; line-height: 1; }
      .wp-toggle input:focus-visible + .wp-box { outline: 2px solid rgba(43,108,255,.55);
        outline-offset: 2px; }
      .wp-toggle .wp-hint { color: #6b7280; font-size: 11px; margin-left: auto; }

      /* ---- field label ---- */
      .wp-field-label { margin: 11px 0 3px; font-size: 11.5px; color: #4b5563;
        letter-spacing: .2px; }
      .wp-field-hint { margin: 0 0 7px; font-size: 10.5px; line-height: 1.5;
        color: #6b7280; }

      /* ---- mode dropdown (custom, so the popup matches the panel) ---- */
      .wp-select { position: relative; flex: 1 1 auto; min-width: 0; }
      .wp-select-trigger { width: 100%; display: flex; align-items: center; gap: 8px;
        background: #f5f7fb; border: 1px solid #e3e8f0; color: #1b2130;
        border-radius: 10px; padding: 8px 11px; font-size: 12.5px; line-height: 1.45;
        cursor: pointer; text-align: left; white-space: nowrap;
        transition: border-color .15s, background .15s, box-shadow .15s; }
      .wp-select-trigger:hover { background: #eef2f8; border-color: #d5dde9; }
      .wp-select-trigger[aria-expanded="true"] {
        background: #fff; border-color: #2b6cff;
        box-shadow: 0 0 0 3px rgba(43,108,255,.16); }
      .wp-select-trigger:focus-visible { outline: none; border-color: #2b6cff;
        box-shadow: 0 0 0 3px rgba(43,108,255,.20); }
      .wp-chev { margin-left: auto; font-size: 9px; line-height: 1; color: #6b7280;
        transition: transform .16s ease; }
      .wp-select-trigger[aria-expanded="true"] .wp-chev { transform: rotate(180deg); }
      /* The panel is overflow:hidden (rounded corners), so the menu cannot live
         inside it — it is a sibling on #wp-root and JS positions it fixed from
         the trigger's viewport rect. */
      .wp-listbox { position: fixed; z-index: 3; min-width: 150px;
        display: none; padding: 5px; border-radius: 13px; max-height: 146px; overflow: auto;
        background: #fff;
        border: 1px solid rgba(15,23,42,.09);
        box-shadow: 0 18px 42px rgba(15,23,42,.20), 0 2px 8px rgba(15,23,42,.08); }
      .wp-listbox.open { display: block; }
      .wp-listbox::-webkit-scrollbar { width: 6px; }
      .wp-listbox::-webkit-scrollbar-thumb { background: rgba(15,23,42,.16); border-radius: 3px; }
      .wp-opt { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        border-radius: 9px; font-size: 12.5px; color: #3f4859; cursor: pointer;
        transition: background .12s, color .12s; }
      .wp-opt:hover { background: #f2f5fb; color: #171c26; }
      .wp-opt[aria-selected="true"] { color: #1f5ae0;
        background: rgba(43,108,255,.10); }
      .wp-opt .wp-tick { margin-left: auto; font-size: 11px; font-weight: 700;
        color: #1f5ae0; opacity: 0; transition: opacity .12s; }
      .wp-opt[aria-selected="true"] .wp-tick { opacity: 1; }

      /* ---- status pill ---- */
      #wp-pill { position: absolute; right: 0; bottom: 54px; border-radius: 999px;
        padding: 6px 13px; font-size: 11.5px; letter-spacing: .4px; white-space: nowrap;
        color: #1b2130; font-weight: 600; display: none; }
      #wp-pill.show { display: block; }

      /* Last in the sheet on purpose: these must beat the "#wp-pill.show" rule.
         Fullscreen keeps only the bubble — no panel, no pill, no button. */
      .wp-fs #wp-panel, .wp-fs #wp-pill, .wp-fs #wp-fab { display: none; }
      .wp-fs #wp-toast { position: fixed; top: 16px; right: 16px; bottom: auto; }
    `;
    // Styles are injected lazily, so a domain that has not been matched yet
    // never touches the page — not even with a <style> tag.
    let stylesInjected = false;
    function ensureStyles() {
      if (stylesInjected) return;
      stylesInjected = true;
      if (typeof GM_addStyle === "function") GM_addStyle(css);
      else {
        const style = document.createElement("style");
        style.textContent = css;
        document.documentElement.appendChild(style);
      }
    }

    // DOM is created lazily: until the user has a room (or explicitly opens the
    // panel), nothing is rendered on the page — not even the FAB. ensureMounted
    // builds the UI on first need; unmount tears it back down to a clean page.
    let root = null;
    let fab = null;
    let panel = null;
    let body = null;
    let pill = null;
    let modeList = null;
    let toast = null;
    let toastText = null;
    let toastActions = null;
    let toastTimer = null;
    let toastShownKey = "";
    let noticeText = "";
    let noticeTone = "info";

    let collapseTimer = null;
    let noticeTimer = null;
    let handlers = {};

    function ensureMounted() {
      if (root) return;
      // Reinstalling the script a few times easily leaves two copies installed.
      // Both render a panel at the same spot and the top one swallows every
      // click — a "clicking does nothing" report that has nothing to do with
      // this code. Shout about it rather than debug it silently.
      const copies = document.querySelectorAll("#wp-root").length;
      if (copies > 0) {
        console.warn(
          `[一起看] 页面上已有 ${copies} 个「一起看」面板，说明装了多个脚本副本——` +
            "请到油猴管理面板删掉多余的，只保留一个再刷新"
        );
      }
      ensureStyles();
      root = document.createElement("div");
      root.id = "wp-root";
      root.innerHTML = `
        <div id="wp-pill" class="wp-glass"></div>
        <div id="wp-panel" class="wp-glass">
          <div id="wp-body"></div>
        </div>
        <button id="wp-fab" title="一起看 · 房间" aria-label="一起看 · 房间">
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9.5" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16.5 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </button>
        <div id="wp-toast" class="wp-glass" role="status" aria-live="polite">
          <span id="wp-toast-text"></span>
          <div class="wp-toast-actions" id="wp-toast-actions"></div>
        </div>
        <div id="wp-modelist" class="wp-listbox" role="listbox" aria-label="面板显示方式">
          <div class="wp-opt" role="option" data-value="quiet" aria-selected="true">
            安静模式<span class="wp-tick">✓</span>
          </div>
          <div class="wp-opt" role="option" data-value="pill" aria-selected="false">
            状态条<span class="wp-tick">✓</span>
          </div>
          <div class="wp-opt" role="option" data-value="pinned" aria-selected="false">
            固定不收起<span class="wp-tick">✓</span>
          </div>
        </div>
      `;
      document.body.appendChild(root);

      fab = root.querySelector("#wp-fab");
      panel = root.querySelector("#wp-panel");
      body = root.querySelector("#wp-body");
      pill = root.querySelector("#wp-pill");
      modeList = root.querySelector("#wp-modelist");
      toast = root.querySelector("#wp-toast");
      toastText = root.querySelector("#wp-toast-text");
      toastActions = root.querySelector("#wp-toast-actions");

      // The menu options are static, so they are wired once per mount instead
      // of on every render.
      modeList.querySelectorAll(".wp-opt").forEach((opt) =>
        opt.addEventListener("click", (e) => {
          e.stopPropagation();
          settings.update({ displayMode: opt.dataset.value });
          paintMode(opt.dataset.value);
          closeModeMenu();
          scheduleCollapse();
          updatePill(handlers.getRoomState());
        })
      );

      fab.addEventListener("click", toggle);
      root.addEventListener("mousemove", scheduleCollapse);
      // Close the mode dropdown when clicking anywhere else (or pressing Esc).
      root.addEventListener("click", (ev) => {
        if (ev.target.closest && ev.target.closest(".wp-select, .wp-listbox")) return;
        closeModeMenu();
      });
      root.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") closeModeMenu();
      });
      applyFullscreen();
    }

    const MODE_NAMES = { quiet: "安静模式", pill: "状态条", pinned: "固定不收起" };

    function modeTrigger() {
      return body && body.querySelector(".wp-select-trigger");
    }
    function paintMode(value) {
      const v = MODE_NAMES[value] ? value : "quiet";
      if (modeList) {
        modeList.querySelectorAll(".wp-opt").forEach((o) =>
          o.setAttribute("aria-selected", String(o.dataset.value === v))
        );
      }
      const trig = modeTrigger();
      if (trig) trig.querySelector(".wp-select-value").textContent = MODE_NAMES[v];
    }
    // Anchors the menu to the trigger: downward (its natural direction), flipping
    // above only when the window bottom is too close. Re-run on open, on resize
    // and after a re-render.
    function placeModeMenu() {
      if (!modeList || !modeList.classList.contains("open")) return false;
      const trig = modeTrigger();
      if (!trig || !document.contains(trig)) {
        closeModeMenu();
        return false;
      }
      const t = trig.getBoundingClientRect();
      const h = modeList.offsetHeight;
      const fitsDown = t.bottom + 7 + h <= window.innerHeight - 8;
      const fitsUp = t.top - h - 7 >= 8;
      const top = fitsDown
        ? t.bottom + 7
        : fitsUp
          ? t.top - h - 7
          : Math.max(8, Math.min(window.innerHeight - h - 8, t.bottom + 7));
      modeList.style.left = Math.round(t.left) + "px";
      modeList.style.width = Math.round(t.width) + "px";
      modeList.style.top = Math.round(top) + "px";
      trig.setAttribute("aria-expanded", "true");
      return true;
    }
    function openModeMenu() {
      if (!modeList) return;
      paintMode(settings.get().displayMode);
      modeList.classList.add("open");
      placeModeMenu();
      if (fab) fab.classList.add("tucked");
      scheduleCollapse();
    }
    function closeModeMenu() {
      if (modeList) modeList.classList.remove("open");
      if (fab) fab.classList.remove("tucked");
      const trig = modeTrigger();
      if (trig) trig.setAttribute("aria-expanded", "false");
    }
    function toggleModeMenu() {
      if (modeList && modeList.classList.contains("open")) closeModeMenu();
      else openModeMenu();
    }
    window.addEventListener("resize", placeModeMenu);

    function unmount() {
      if (collapseTimer) clearTimeout(collapseTimer);
      if (noticeTimer) clearTimeout(noticeTimer);
      if (toastTimer) clearTimeout(toastTimer);
      collapseTimer = noticeTimer = toastTimer = null;
      toastShownKey = "";
      noticeText = "";
      closeModeMenu();
      if (root) root.remove();
      root = fab = panel = body = pill = modeList = null;
      toast = toastText = toastActions = null;
    }

    function open() {
      ensureMounted();
      panel.classList.add("open");
      if (pill) pill.classList.remove("show");
      render();
      placeToast();
      renderToast();
      scheduleCollapse();
      probeClickable();
    }

    // Some video sites cover the whole page with a transparent click-catcher
    // (`elementFromPoint` finds it, but the panel still *looks* fine). That would
    // swallow every click without a single error, so it is worth a console line.
    function probeClickable() {
      setTimeout(() => {
        try {
          if (!panel || !panel.classList.contains("open") || !body) return;
          const btn = body.querySelector("#wp-create") || body.querySelector("#wp-leave");
          if (!btn) return;
          const r = btn.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const mid = () => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const describe = (el) => {
            const tag = el.tagName + (el.id ? "#" + el.id : "");
            const cls =
              typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/)[0] : "";
            return `${tag}${cls} (z-index ${getComputedStyle(el).zIndex})`;
          };
          let el = mid();
          if (el && !el.closest("#wp-root")) {
            const blocker = describe(el);
            // Something transparent is lying on top of us. Being the last child
            // of <body> wins a z-index tie, which is the usual shape of this bug.
            if (!root.classList.contains("wp-fs")) {
              try {
                document.body.appendChild(root);
              } catch {
                /* ignore */
              }
              el = mid();
            }
            if (el && !el.closest("#wp-root")) {
              console.warn(`[一起看] 面板被页面元素挡住，点不动：${blocker}`);
            } else {
              console.info(`[一起看] 面板曾被 ${blocker} 遮挡，已提升层级 ✓`);
            }
          } else {
            console.info("[一起看] 面板可点击 ✓（按钮未被遮挡）");
          }
        } catch {
          /* ignore */
        }
      }, 400);
    }
    function close() {
      closeModeMenu();
      if (panel) panel.classList.remove("open");
      // The panel is gone, so important news now has to arrive as a bubble.
      placeToast();
      renderToast();
      // When closed with no room, return the page to a fully clean state.
      if (!roomStore.inRoom()) unmount();
      else updatePill(handlers.getRoomState());
    }
    function toggle() {
      if (panel && panel.classList.contains("open")) close();
      else open();
    }
    function scheduleCollapse() {
      if (collapseTimer) clearTimeout(collapseTimer);
      if (settings.get().displayMode === "pinned") return;
      // The create/join panel is a form — auto-closing it (and unmounting the
      // whole UI with it) would yank the button out from under a click. It stays
      // until the user closes it; only the in-room panel gets out of the way.
      if (!roomStore.inRoom()) return;
      collapseTimer = setTimeout(() => {
        console.info("[一起看] 面板自动收起（10 秒无操作）");
        close();
      }, CONFIG.panelAutoCollapseMs);
    }

    // Fullscreen keeps only the bubble: the panel, pill and button all step
    // aside. Critically, fullscreen only paints the fullscreen element's own
    // subtree, so the root has to move *into* that element while it lasts —
    // otherwise nothing we render would be visible at all.
    function applyFullscreen() {
      if (!root) return;
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      const fs = Boolean(fsEl);
      root.classList.toggle("wp-fs", fs);
      if (fs) {
        if (root.parentElement !== fsEl) {
          try {
            fsEl.appendChild(root);
          } catch {
            /* some elements refuse children; nothing we can do */
          }
        }
      } else if (root.parentElement !== document.body) {
        document.body.appendChild(root);
      }
      placeToast();
      renderToast();
    }
    document.addEventListener("fullscreenchange", applyFullscreen);
    document.addEventListener("webkitfullscreenchange", applyFullscreen);

    function fmt(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      const h = Math.floor(m / 60);
      const mm = String(m % 60).padStart(2, "0");
      const ss = String(s).padStart(2, "0");
      return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
    }

    // Pure: which bubble deserves the screen right now. Priority is waiting >
    // jump request > different video > plain notice, and only one shows at a
    // time. Mirrored in tests/toast.test.js.
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
      if (input.mismatchUrl) {
        candidates.push(
          input.forceSync
            ? {
                key: `mm:${input.mismatchUrl}`,
                text: "已强制同步（与房主不同页面）",
                tone: "info",
                actions: ["unforce"]
              }
            : {
                key: `mm:${input.mismatchUrl}`,
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
        // With the panel open, every action bubble has the same buttons sitting
        // in the panel right above it (different-video / waiting / request bars),
        // so the bubble would just be a duplicate — and one that steals the click.
        // Skipping a candidate rather than the whole bubble matters: a plain
        // notice has no counterpart in the panel, so it still has to get through.
        if (input.panelOpen && view.actions.length) continue;
        return view;
      }
      return null;
    }

    const TOAST_BUTTONS = {
      accept: { label: "跟随 TA", primary: true, run: () => handlers.acceptSeekRequest() },
      ignore: { label: "忽略", primary: false, run: () => handlers.ignoreSeekRequest() },
      skip: { label: "不等了，继续播放", primary: false, run: () => handlers.skipWait() },
      jump: { label: "跳转到一起看的视频", primary: true, run: () => handlers.jumpToHostVideo() },
      force: { label: "强制同步", primary: false, run: () => setForceSync(true) },
      unforce: { label: "取消强制同步", primary: false, run: () => setForceSync(false) }
    };

    // "These two pages are the same video, follow anyway" — a per-member choice
    // that also tells the room (so their jump requests still count).
    function setForceSync(value) {
      settings.update({ forceSync: value });
      toastShownKey = ""; // the bubble should reflect the new state right away
      render();
      renderToast();
    }

    function hideToast() {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = null;
      if (toast) toast.classList.remove("show");
      updatePill(handlers.getRoomState());
    }

    // The bubble shares the corner with the panel and the pill, so it stacks
    // above them instead of covering them.
    function placeToast() {
      if (!toast || !root) return;
      if (root.classList.contains("wp-fs")) {
        toast.style.bottom = ""; // fullscreen: CSS pins it to the top-right
        return;
      }
      let lift = 0;
      if (panel && panel.classList.contains("open")) {
        lift += Math.round(panel.getBoundingClientRect().height) + 12;
      }
      if (pill && pill.classList.contains("show")) {
        lift += Math.round(pill.getBoundingClientRect().height) + 8;
      }
      // Clamp so a tall panel cannot push the bubble off the top of the screen.
      const h = toast.offsetHeight || 40;
      const maxBottom = Math.max(8, window.innerHeight - h - 8);
      toast.style.bottom = `${Math.min(54 + lift, maxBottom)}px`;
    }

    // Every bubble shows once and then hides itself — it is a heads-up, not
    // something the user has to dismiss. The panel keeps the full detail.
    function renderToast() {
      if (!toast || !root) return;
      const room = roomStore.get();
      const waiting = handlers.getWaitingFor ? handlers.getWaitingFor() : null;
      const request = handlers.getSeekRequest ? handlers.getSeekRequest() : null;
      const mismatch = handlers.getMismatchHost ? handlers.getMismatchHost() : null;
      const view = toastFor({
        waitingName: waiting ? waiting.name : "",
        request: request ? { id: request.id, fromName: request.fromName, label: fmt(request.time) } : null,
        mismatchUrl: mismatch && mismatch.url ? mismatch.url : "",
        noticeText: noticeText,
        noticeTone: noticeTone,
        forceSync: Boolean(settings.get().forceSync),
        isHost: Boolean(room && room.role === "host"),
        panelOpen: Boolean(panel && panel.classList.contains("open"))
      });

      if (!view) {
        hideToast();
        toastShownKey = "";
        return;
      }
      if (view.key === toastShownKey) return; // it already had its moment
      toastShownKey = view.key;
      toastText.textContent = view.text;
      toastActions.innerHTML = "";
      for (const id of view.actions) {
        const spec = TOAST_BUTTONS[id];
        if (!spec) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = spec.label;
        if (spec.primary) btn.className = "primary";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          hideToast();
          spec.run();
        });
        toastActions.appendChild(btn);
      }
      toastActions.style.display = view.actions.length ? "flex" : "none";
      toast.className = `wp-glass tone-${view.tone} show`;
      // Settle the pill first, then stack the bubble above it.
      updatePill(handlers.getRoomState());
      placeToast();
      toastTimer = setTimeout(() => {
        toastTimer = null;
        if (toast) toast.classList.remove("show");
        // The pill shares this corner, so give it its spot back.
        updatePill(handlers.getRoomState());
      }, CONFIG.toastMs);
    }

    // There is no separate notice line any more: every message becomes a bubble.
    // `setNotice` therefore just records the text/tone and re-renders the bubble.
    function setNotice(text, persist, tone, force) {
      noticeText = text || "";
      noticeTone = tone || "info";
      // Event-like notices (a host drag, someone else's jump) should bubble every
      // time they happen, even though the text is identical: forget the "already
      // shown" marker so this one gets its own bubble.
      if (force && noticeText) toastShownKey = "";
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = null;
      if (noticeText && !persist) {
        // Forget a transient message after a few seconds, so it cannot bubble
        // again later on.
        noticeTimer = setTimeout(() => {
          noticeTimer = null;
          noticeText = "";
          renderToast();
        }, 4000);
      }
      renderToast();
    }

    function setFabState(kind) {
      if (!fab) return;
      fab.classList.toggle("in-room", kind === "in-room");
      fab.classList.toggle("error", kind === "error");
    }

    function updatePill(roomState) {
      if (!pill) return;
      const mode = settings.get().displayMode;
      // The pill and the panel share the same corner — while the panel is open
      // the pill would only show up as a blurry smudge behind the glass. A
      // bubble does not suppress it: the bubble stacks above it instead.
      const panelOpen = Boolean(panel && panel.classList.contains("open"));
      if (mode !== "pill" || !roomStore.inRoom() || panelOpen) {
        pill.classList.remove("show");
        return;
      }
      const count = roomState ? roomState.participants.length : 1;
      pill.textContent = `▶ ${count} 人`;
      pill.classList.add("show");
    }

    // A slow request must not look like a dead button: the label changes until
    // the flow finishes (success re-renders the panel, failure re-renders it too).
    function setBusy(btn, label) {
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = label;
    }

    function renderIdle() {
      const cfg = settings.get();
      body.innerHTML = `
        <h4>一起看</h4>
        <div class="wp-sub">创建房间或输入房间码，和朋友同步进度</div>
        <div class="row"><input id="wp-name" placeholder="你的昵称" value="${escapeHtml(cfg.displayName)}"></div>
        <div class="row">
          <button class="action" id="wp-create" style="width:100%">创建房间</button>
        </div>
        <div class="row">
          <input id="wp-join-code" placeholder="房间码" maxlength="12" style="text-transform:uppercase">
          <button class="ghost" id="wp-join">加入</button>
        </div>
      `;
      body.querySelector("#wp-name").addEventListener("input", (e) =>
        settings.update({ displayName: e.target.value })
      );
      // Proof that the click actually reached the button. If the user reports
      // "clicking does nothing" and this never appears, something is covering the
      // panel (see the overlay probe in open()) — not a logic bug.
      body.querySelector("#wp-create").addEventListener("click", (ev) => {
        console.info("[一起看] 已点击「创建房间」");
        setBusy(ev.currentTarget, "创建中…");
        handlers.create();
      });
      body.querySelector("#wp-join").addEventListener("click", (ev) => {
        const code = body.querySelector("#wp-join-code").value.trim().toUpperCase();
        console.info("[一起看] 已点击「加入」，房间码:", code);
        if (!code) return;
        setBusy(ev.currentTarget, "加入中…");
        handlers.join(code);
      });
    }

    function renderInRoom(roomState) {
      const room = roomStore.get();
      const cfg = settings.get();
      const detected = handlers.isVideoDetected();
      const active = handlers.isActive();
      const participants = (roomState && roomState.participants) || [];
      const hostKey = (() => {
        const h =
          participants.find((p) => p.participantId === (roomState && roomState.hostParticipantId)) ||
          participants.find((p) => p.role === "host");
        return h && h.state ? h.state.videoKey : null;
      })();

      const list = participants
        .map((p) => {
          // Measured on the server clock when available; a local clock that is
          // minutes off would otherwise mark everyone as stale.
          const age = reportAgeSec(roomState, p, CONFIG.participantStaleMs / 1000) * 1000;
          const fresh = age < CONFIG.participantStaleMs;
          const st = p.state || {};
          const playing = st.paused === false ? "▶" : "⏸";
          // Same page as the host? Unknown keys count as "same" (never warn on
          // missing information). A member who forced sync is following anyway,
          // so say that instead of warning about a different video.
          const differs = Boolean(hostKey && st.videoKey && st.videoKey !== hostKey);
          const forced = differs && Boolean(st.forceSync);
          const mismatch = p.role !== "host" && differs && !forced;
          const tag = forced
            ? '<span class="wp-mismatch-tag wp-forced">强制同步</span>'
            : mismatch
              ? '<span class="wp-mismatch-tag">不在同一视频</span>'
              : "";
          return `<div class="wp-p">
            <span class="wp-dot ${fresh ? "fresh" : "stale"}"></span>
            <span class="wp-name${mismatch ? " wp-mismatch" : ""}">${escapeHtml(p.displayName || "朋友")}${
            p.role === "host" ? '<span class="wp-host-tag">房主</span>' : ""
          }${tag}</span>
            <span class="wp-time">${playing} ${fmt(st.currentTime)}</span>
          </div>`;
        })
        .join("");

      const standbyBlock = active
        ? ""
        : `<div id="wp-standby">同步正在另一个标签进行。
            <button class="action" id="wp-activate">在此标签同步</button></div>`;

      const mismatchHost = handlers.getMismatchHost();
      // Two states: a warning that following is paused, or — once the member
      // declared the pages to be the same video — a note that it is following
      // across different pages.
      const mismatchBar =
        active && mismatchHost && mismatchHost.url
          ? cfg.forceSync
            ? `<div id="wp-mismatch-bar" class="info">已强制同步：你和房主不在同一页面，进度仍会跟随。
                <button class="ghost" id="wp-unforce">取消强制同步</button></div>`
            : `<div id="wp-mismatch-bar">你和大家不在同一个视频，已暂停跟随。
                <button id="wp-goto">跳转到一起看的视频</button>
                <button class="ghost" id="wp-force">强制同步</button></div>`
          : "";

      // Host only: somebody dragged their bar and wants the room to follow.
      const seekReq = handlers.getSeekRequest();
      const requestBar = seekReq
        ? `<div id="wp-seek-req"><b>${escapeHtml(seekReq.fromName)}</b> 想跳到 ${fmt(seekReq.time)}
            <div class="row">
              <button class="action" id="wp-req-accept">跟随 TA</button>
              <button class="ghost" id="wp-req-ignore">忽略</button>
            </div></div>`
        : "";

      // Everyone: somebody's playback is stuck, so we all wait for them.
      const waiting = handlers.getWaitingFor();
      const waitBar = waiting
        ? `<div id="wp-wait-bar">等待 ${escapeHtml(waiting.name)} 缓冲…${
            room.role === "host" ? '<button class="ghost" id="wp-skip-wait">不等了，继续播放</button>' : ""
          }</div>`
        : "";

      body.innerHTML = `
        <h4>
          <span>房间</span> <span id="wp-code">${escapeHtml(room.roomId)}</span>
          <span class="wp-h-actions"><button class="ghost" id="wp-copy">复制</button></span>
        </h4>
        <div class="wp-sub">${room.role === "host" ? "你是房主" : "参与者"} ·
          ${detected ? "已检测到播放器" : "未检测到播放器"}</div>
        ${standbyBlock}
        ${waitBar}
        ${requestBar}
        <div id="wp-list">${list || '<div class="wp-empty">暂无参与者</div>'}</div>
        ${mismatchBar}
        <div class="row"><button class="ghost" id="wp-jump" style="width:100%">跳到房主位置</button></div>
        <label class="wp-toggle"><input type="checkbox" id="wp-follow-progress" ${
          cfg.autoFollowProgress ? "checked" : ""
        }><span class="wp-box"></span><span>自动跟随房主进度</span>
          <span class="wp-hint">漂移 &gt; ${CONFIG.driftThresholdSec} 秒</span></label>
        <label class="wp-toggle"><input type="checkbox" id="wp-follow-pp" ${
          cfg.followPlayPause ? "checked" : ""
        }><span class="wp-box"></span><span>跟随房主播放/暂停</span></label>
        ${
          room.role === "host"
            ? `<label class="wp-toggle"><input type="checkbox" id="wp-auto-accept" ${
                cfg.seekRequestAutoAccept ? "checked" : ""
              }><span class="wp-box"></span><span>自动接受成员拖动</span>
                <span class="wp-hint">不再逐次询问</span></label>`
            : ""
        }
        <div class="wp-field-label">面板显示方式</div>
        <div class="wp-field-hint">决定面板的显示与收起方式，只影响界面，不影响同步。</div>
        <div class="row">
          <div class="wp-select">
            <button type="button" class="wp-select-trigger" aria-haspopup="listbox"
                    aria-expanded="false" aria-label="面板显示方式">
              <span class="wp-select-value">安静模式</span><span class="wp-chev">▾</span>
            </button>
          </div>
        </div>
        <button class="ghost" id="wp-leave">离开房间</button>
      `;
      const activateBtn = body.querySelector("#wp-activate");
      if (activateBtn) activateBtn.addEventListener("click", () => handlers.activate());
      const gotoBtn = body.querySelector("#wp-goto");
      if (gotoBtn) gotoBtn.addEventListener("click", () => handlers.jumpToHostVideo());
      const forceBtn = body.querySelector("#wp-force");
      if (forceBtn) forceBtn.addEventListener("click", () => setForceSync(true));
      const unforceBtn = body.querySelector("#wp-unforce");
      if (unforceBtn) unforceBtn.addEventListener("click", () => setForceSync(false));
      body.querySelector("#wp-copy").addEventListener("click", () => {
        navigator.clipboard && navigator.clipboard.writeText(room.roomId);
        setNotice("房间码已复制");
      });
      body.querySelector("#wp-jump").addEventListener("click", () => handlers.jumpToHost());
      body.querySelector("#wp-follow-progress").addEventListener("change", (e) =>
        settings.update({ autoFollowProgress: e.target.checked })
      );
      body.querySelector("#wp-follow-pp").addEventListener("change", (e) =>
        settings.update({ followPlayPause: e.target.checked })
      );
      const autoAcceptBox = body.querySelector("#wp-auto-accept");
      if (autoAcceptBox) {
        autoAcceptBox.addEventListener("change", (e) =>
          settings.update({ seekRequestAutoAccept: e.target.checked })
        );
      }
      // The co-op bars only exist while they are relevant.
      const acceptReq = body.querySelector("#wp-req-accept");
      if (acceptReq) {
        acceptReq.addEventListener("click", () => handlers.acceptSeekRequest(seekReq && seekReq.id));
      }
      const ignoreReq = body.querySelector("#wp-req-ignore");
      if (ignoreReq) {
        ignoreReq.addEventListener("click", () => handlers.ignoreSeekRequest(seekReq && seekReq.id));
      }
      const skipWaitBtn = body.querySelector("#wp-skip-wait");
      if (skipWaitBtn) skipWaitBtn.addEventListener("click", () => handlers.skipWait());
      // Only the trigger lives in the panel; the menu itself sits on #wp-root so
      // the panel's overflow:hidden cannot clip it (see placeModeMenu).
      paintMode(cfg.displayMode);
      body.querySelector(".wp-select-trigger").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleModeMenu();
      });
      body.querySelector("#wp-leave").addEventListener("click", () => handlers.leave());
    }

    function render() {
      if (!body) return;
      if (roomStore.inRoom()) renderInRoom(handlers.getRoomState());
      else renderIdle();
      // body was rebuilt — keep an open menu re-anchored to its new trigger.
      placeModeMenu();
    }

    return {
      // Register handlers without rendering anything (page stays clean).
      mount(h) {
        handlers = h;
      },
      // Show the panel because the user is in a room (FAB visible, panel open).
      showForRoom() {
        ensureMounted();
        setFabState("in-room");
        open();
      },
      // Open the create/join panel on demand (e.g. from the userscript menu).
      open,
      close,
      render,
      unmount,
      setNotice,
      setFabState,
      onRoomUpdate(roomState) {
        if (!root) return; // nothing mounted -> nothing to update
        setFabState(roomStore.inRoom() ? "in-room" : "idle");
        if (panel.classList.contains("open")) render();
        updatePill(roomState);
        renderToast();
      }
    };
  })();

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ===========================================================================
  // Wiring
  // ===========================================================================
  function noticeForError(kind) {
    switch (kind) {
      case "sync-unavailable":
        return "连不上同步服务（检查网络/代理）";
      case "host-offline":
        return "房主已离线";
      case "Room not found":
        return "房间不存在";
      case "Participant not found":
        return "参与者不存在";
      case "Invalid host token":
      case "Host token required":
        return "房主凭证无效";
      default:
        // Server errors arrive as English text or a bare "HTTP 500".
        if (typeof kind === "string" && /^HTTP \d+$/.test(kind)) {
          const status = Number(kind.slice(5));
          return status >= 500 ? `同步服务异常（${kind}）` : `请求被拒绝（${kind}）`;
        }
        return kind || "";
    }
  }

  panelUi.mount({
    isVideoDetected: () => syncEngine.detectVideo(),
    getRoomState: () => syncEngine.getRoomState(),
    isActive: () => syncEngine.isActive(),
    getMismatchHost: () => syncEngine.getMismatchHost(),
    getSeekRequest: () => syncEngine.getSeekRequest(),
    acceptSeekRequest: (id) => syncEngine.acceptSeekRequest(id),
    ignoreSeekRequest: (id) => syncEngine.ignoreSeekRequest(id),
    getWaitingFor: () => syncEngine.getWaitingFor(),
    skipWait: () => syncEngine.skipWait(),
    activate() {
      syncEngine.activate();
      panelUi.setNotice("已在此标签同步");
      panelUi.render();
      panelUi.setFabState("in-room");
    },
    jumpToHostVideo() {
      const host = syncEngine.getMismatchHost();
      if (!host || !host.url) return;
      // The target page can only take over if the script runs there, so match its
      // domain for the user — they just asked to move the room to it.
      let matchedNow = false;
      try {
        const targetHost = new URL(host.url).hostname;
        if (targetHost && !siteMatch.isMatched(targetHost)) matchedNow = siteMatch.add(targetHost);
      } catch {
        /* unusual URL: just open it and let the user match manually */
      }
      // Pause the current (unrelated) video, hand the lock over, then open the
      // shared video in a new tab: that tab claims the lock on load and starts
      // reporting the right video.
      syncEngine.pauseLocal();
      syncEngine.releaseForHandoff();
      window.open(host.url, "_blank");
      panelUi.setNotice(matchedNow ? "已在新标签打开，并自动匹配了该站点" : "已在新标签打开一起看的视频");
    },
    // Each step of the flow logs, so a "click did nothing" report can be pinned
    // down: no log at all = the click never reached the button (something is
    // lying on top of the panel); a log that stops halfway = the culprit is the
    // step after it.
    async create() {
      try {
        console.info("[一起看] 创建房间：1/4 开始");
        const name = settings.get().displayName || "Friend";
        const res = await apiClient.createRoom(name);
        console.info("[一起看] 创建房间：2/4 服务端已返回", res);
        roomStore.save({
          roomId: res.roomId,
          participantId: res.participantId,
          role: "host",
          hostToken: res.hostToken
        });
        console.info("[一起看] 创建房间：3/4 已保存房间", roomStore.get());
        syncEngine.activate();
        panelUi.setNotice("");
        panelUi.showForRoom();
        console.info("[一起看] 创建房间：4/4 完成，房间码", res.roomId);
      } catch (err) {
        console.error("[一起看] 创建房间失败:", err);
        // `true` forces the bubble: otherwise the same error text would be
        // swallowed as "already shown" and the user would see nothing at all.
        panelUi.setNotice(noticeForError(err.message), false, "error", true);
        // Put the button back (it still says 创建中…).
        panelUi.render();
      }
    },
    async join(code) {
      try {
        console.info("[一起看] 加入房间：1/4 开始，房间码", code);
        const name = settings.get().displayName || "Friend";
        const res = await apiClient.joinRoom(code, name);
        console.info("[一起看] 加入房间：2/4 服务端已返回", res);
        roomStore.save({ roomId: res.roomId, participantId: res.participantId, role: "participant" });
        console.info("[一起看] 加入房间：3/4 已保存房间", roomStore.get());
        syncEngine.activate();
        panelUi.setNotice("");
        panelUi.showForRoom();
        console.info("[一起看] 加入房间：4/4 完成");
      } catch (err) {
        console.error("[一起看] 加入房间失败:", err);
        panelUi.setNotice(noticeForError(err.message), false, "error", true);
        panelUi.render();
      }
    },
    leave() {
      // Also releases the cross-tab lock, so another tab can take over cleanly.
      syncEngine.leaveRoom();
      roomStore.clear();
      // Forcing sync is a decision about *this* room's videos, so it does not
      // follow you into the next one.
      settings.update({ forceSync: false });
      // Leaving returns the page to a fully clean state (no FAB, no panel).
      panelUi.unmount();
    },
    jumpToHost() {
      syncEngine.jumpToHost();
      panelUi.setNotice("已跳到房主位置");
    }
  });

  syncEngine.onUpdate = (roomState) => panelUi.onRoomUpdate(roomState);
  syncEngine.onError = (kind) => {
    panelUi.setNotice(noticeForError(kind), false, "error");
    if (kind === "sync-unavailable") panelUi.setFabState("error");
  };
  syncEngine.onMismatch = () => {
    // The panel's own bar already carries this message *and* the button, so it is
    // not repeated anywhere else; every message is a bubble now.
    panelUi.render();
  };
  syncEngine.onNotice = (text, tone) => panelUi.setNotice(text, false, tone, true);
  syncEngine.onSeekRequest = (req) => {
    if (req.accepted) {
      panelUi.setNotice(req.auto ? `已自动跟随「${req.fromName}」的进度` : `已跟随「${req.fromName}」的进度`);
      panelUi.render();
      return;
    }
    if (req.ignored) {
      panelUi.setNotice(`已忽略「${req.fromName}」的跳转请求`);
      panelUi.render();
      return;
    }
    // A fresh request: the bubble carries the buttons, so the panel does not
    // need to jump open. It re-renders in case it happens to be open already.
    panelUi.render();
  };

  // Everything that touches the page or the network happens only on a matched
  // site. It runs on load for matched domains, and can also be started on the
  // fly right after the user matches the current domain from the menu.
  let started = false;
  function startMatchedSite() {
    if (started) return;
    started = true;
    // One line that says exactly which build is running, where it is talking and
    // how. Checking this in the console first tells us whether the browser is
    // even running the copy we think it is.
    try {
      const version =
        (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "dev";
      console.info(`[一起看] v${version} 后端 ${workerBaseUrl()}，正在测速选择请求通道…`);
    } catch {
      /* ignore */
    }

    // Establish the connection now, so the user's first click does not pay for
    // it. This runs before any room exists, so it stays completely silent.
    apiClient.warmup();

    // Resume an existing room across reloads / SPA navigations. The lock is only
    // taken if no other tab of this browser is already reporting, so opening a
    // second tab on a different video cannot silently move the room. Taking over
    // on purpose is the panel's 「在此标签同步」 button; the jump flow hands the
    // lock to the new tab explicitly. When not in a room nothing is shown — the
    // user opens the panel from the userscript menu.
    if (roomStore.inRoom()) {
      panelUi.showForRoom();
      syncEngine.activateOnLoad();
    }
    registerMenuCommands();
  }

  // Menu actions always surface their result as a bubble.
  function notifyAndOpen(text) {
    panelUi.open();
    panelUi.setNotice(text);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;
    const host = siteMatch.currentHost();
    const entry = siteMatch.matchEntry(host) || host;

    GM_registerMenuCommand("打开一起看", () => panelUi.open());
    GM_registerMenuCommand("离开房间", () => {
      syncEngine.leaveRoom();
      roomStore.clear();
      settings.update({ forceSync: false });
      panelUi.unmount();
    });
    GM_registerMenuCommand(`取消匹配当前域名（${host}）`, () => {
      if (siteMatch.isBuiltin(entry) && !siteMatch.userSites().includes(entry)) {
        notifyAndOpen(`「${entry}」是内置站点，不能取消`);
        return;
      }
      notifyAndOpen(
        siteMatch.remove(entry)
          ? `已取消匹配 ${entry}，刷新页面后不再自动生效`
          : `当前站点由「${entry}」匹配，请到该域名下取消`
      );
    });
    GM_registerMenuCommand("查看已匹配域名", () => {
      const { builtin, user } = siteMatch.listAll();
      const parts = builtin.slice();
      if (user.length) parts.push(...user.map((h) => `${h}（自建）`));
      notifyAndOpen(`已匹配域名：${parts.join("、")}`);
    });
  }

  // A domain that is not matched yet gets exactly one thing: the command that
  // matches it. Nothing else is registered, so the page stays untouched.
  function registerMatchMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;
    const host = siteMatch.currentHost();
    GM_registerMenuCommand(`匹配当前域名（${host}）`, () => {
      const added = siteMatch.add(host);
      startMatchedSite();
      notifyAndOpen(added ? `已匹配 ${host}，下次打开该域名会自动生效` : `${host} 已经匹配过了`);
    });
    const parent = siteMatch.parentCandidate();
    if (parent) {
      GM_registerMenuCommand(`匹配上级域名（${parent}，含所有子域）`, () => {
        const added = siteMatch.add(parent);
        startMatchedSite();
        notifyAndOpen(added ? `已匹配 ${parent} 及其所有子域` : `${parent} 已经匹配过了`);
      });
    }
  }

  if (siteMatch.isMatched()) startMatchedSite();
  else registerMatchMenu();
})();
