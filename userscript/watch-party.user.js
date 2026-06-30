// ==UserScript==
// @name         Watch Party Sync
// @namespace    https://github.com/video-sync/watch-party
// @version      0.1.0
// @description  Quietly share video progress with friends and optionally follow the room host. Works on bilibili and many smaller video sites.
// @author       video-sync
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.xifanapp.com/*
// @match        https://*.ciyuanapp.com/*
// @match        https://www.agedm.org/*
// @match        https://*.agefans.*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
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
    workerUrlLocal: "http://127.0.0.1:8787",
    workerUrlRemote: "https://video-sync-watch-party.example.workers.dev",
    useLocalWorker: false,

    reportIntervalMs: 5000,
    fetchIntervalMs: 5000,
    driftThresholdSec: 5,
    manualSeekProtectionMs: 8000,
    hostOfflineMs: 20000,
    participantStaleMs: 60000,
    panelAutoCollapseMs: 10000,

    storageKey: "watch-party-state-v1",
    settingsKey: "watch-party-settings-v1"
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
      autoFollowProgress: false,
      followPlayPause: false,
      displayMode: "quiet", // quiet | pill | pinned
      displayName: ""
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
    async function request(method, path, body) {
      const url = workerBaseUrl() + path;
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(url, init);
      } catch (networkError) {
        const error = new Error("sync-unavailable");
        error.kind = "network";
        throw error;
      }
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        const error = new Error(data.error || `HTTP ${res.status}`);
        error.kind = "http";
        error.status = res.status;
        throw error;
      }
      return data;
    }

    return {
      createRoom: (displayName) => request("POST", "/rooms", { displayName }),
      joinRoom: (roomId, displayName) =>
        request("POST", `/rooms/${encodeURIComponent(roomId)}/join`, { displayName }),
      reportState: (roomId, payload) =>
        request("POST", `/rooms/${encodeURIComponent(roomId)}/state`, payload),
      fetchState: (roomId) => request("GET", `/rooms/${encodeURIComponent(roomId)}/state`)
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

      function bind(video) {
        if (el === video) return;
        unbind();
        el = video;
        if (!el) return;
        for (const type of CHANGE_EVENTS) {
          const fn = () => changeCb && changeCb();
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
          return {
            currentTime: Number(el.currentTime) || 0,
            duration: Number.isFinite(el.duration) ? el.duration : 0,
            paused: Boolean(el.paused),
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

  // If we are inside a frame, only run the lightweight reporter and stop.
  if (!IS_TOP) {
    videoAdapters.startFrameReporter();
    return;
  }

  // ===========================================================================
  // Module: syncEngine
  // ===========================================================================
  const syncEngine = (() => {
    const adapter = videoAdapters.resolveTopAdapter();
    let reportTimer = null;
    let fetchTimer = null;
    let lastManualSeekAt = 0;
    let lastRoomState = null;
    let lastReportSig = "";
    let onUpdate = () => {};
    let onError = () => {};

    function localState() {
      adapter.detect();
      return adapter.getState();
    }

    function watchManualSeeks() {
      // Treat a local "seeked" while we are not the one applying it as manual.
      adapter.onChange(() => {
        reportNow().catch(() => {});
      });
      // We can't perfectly distinguish manual vs programmatic seeks across all
      // players, so we mark a protection window whenever the user-facing
      // document gets a seeked event that we did not initiate.
    }

    function markManualSeek() {
      lastManualSeekAt = Date.now();
    }

    function inSeekProtection() {
      return Date.now() - lastManualSeekAt < CONFIG.manualSeekProtectionMs;
    }

    async function reportNow() {
      const room = roomStore.get();
      if (!room) return;
      const state = localState();
      if (!state) return;
      const payload = { participantId: room.participantId, state };
      if (room.role === "host" && room.hostToken) payload.hostToken = room.hostToken;
      const sig = JSON.stringify(state);
      lastReportSig = sig;
      await apiClient.reportState(room.roomId, payload).catch((err) => {
        onError(err.message === "sync-unavailable" ? "sync-unavailable" : err.message);
      });
    }

    async function fetchNow() {
      const room = roomStore.get();
      if (!room) return;
      try {
        const data = await apiClient.fetchState(room.roomId);
        lastRoomState = data;
        applyFollow(data);
        onUpdate(data);
      } catch (err) {
        onError(err.message === "sync-unavailable" ? "sync-unavailable" : err.message);
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

    function applyFollow(roomState) {
      const room = roomStore.get();
      if (!room || room.role === "host") return; // host never follows itself
      const cfg = settings.get();
      const host = hostEntry(roomState);
      if (!host || !host.state || typeof host.state.currentTime !== "number") return;

      const hostFresh = Date.now() - new Date(host.updatedAt).getTime() < CONFIG.hostOfflineMs;
      if (!hostFresh) {
        onError("host-offline");
        return;
      }

      const local = localState();
      if (!local) return;

      // Follow play/pause.
      if (cfg.followPlayPause && typeof host.state.paused === "boolean") {
        if (host.state.paused && !local.paused) adapter.pause();
        else if (!host.state.paused && local.paused) adapter.play();
      }

      // Follow progress with drift threshold + manual-seek protection.
      if (cfg.autoFollowProgress && !inSeekProtection()) {
        const drift = Math.abs(host.state.currentTime - local.currentTime);
        if (drift > CONFIG.driftThresholdSec) {
          adapter.seek(host.state.currentTime);
        }
      }
    }

    function start() {
      stop();
      watchManualSeeks();
      reportTimer = setInterval(() => reportNow().catch(() => {}), CONFIG.reportIntervalMs);
      fetchTimer = setInterval(() => fetchNow().catch(() => {}), CONFIG.fetchIntervalMs);
      reportNow().catch(() => {});
      fetchNow().catch(() => {});
    }

    function stop() {
      if (reportTimer) clearInterval(reportTimer);
      if (fetchTimer) clearInterval(fetchTimer);
      reportTimer = fetchTimer = null;
    }

    return {
      start,
      stop,
      reportNow,
      fetchNow,
      markManualSeek,
      jumpToHost() {
        const host = hostEntry(lastRoomState);
        if (host && host.state && typeof host.state.currentTime === "number") {
          adapter.seek(host.state.currentTime);
          markManualSeek();
        }
      },
      detectVideo: () => adapter.detect(),
      getLocalState: localState,
      getRoomState: () => lastRoomState,
      set onUpdate(fn) {
        onUpdate = fn;
      },
      set onError(fn) {
        onError = fn;
      }
    };
  })();

  // ===========================================================================
  // Module: panelUi
  // ===========================================================================
  const panelUi = (() => {
    const css = `
      #wp-root { position: fixed; right: 16px; bottom: 96px; z-index: 2147483600;
        font: 13px/1.4 -apple-system, system-ui, "PingFang SC", sans-serif; color: #e7e9ee; }
      #wp-root * { box-sizing: border-box; }
      #wp-fab { width: 40px; height: 40px; border-radius: 50%; background: #2b6cff;
        color: #fff; border: none; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.3);
        opacity: .55; transition: opacity .2s; display: flex; align-items: center;
        justify-content: center; font-size: 18px; }
      #wp-fab:hover { opacity: 1; }
      #wp-fab.in-room { background: #1f9e57; }
      #wp-fab.error { background: #c0392b; }
      #wp-panel { position: absolute; right: 0; bottom: 48px; width: 280px;
        background: rgba(24,26,32,.97); border: 1px solid #353a45; border-radius: 12px;
        padding: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45); display: none; }
      #wp-panel.open { display: block; }
      #wp-panel h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
      #wp-panel .row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
      #wp-panel button.action { background: #2b6cff; color: #fff; border: none;
        border-radius: 7px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
      #wp-panel button.ghost { background: transparent; color: #9aa3b2; border: 1px solid #3a4150;
        border-radius: 7px; padding: 5px 9px; cursor: pointer; font-size: 12px; }
      #wp-panel input { background: #11131a; border: 1px solid #353a45; color: #e7e9ee;
        border-radius: 7px; padding: 6px 8px; width: 100%; font-size: 12px; }
      #wp-code { font-family: ui-monospace, monospace; font-size: 15px; letter-spacing: 2px; }
      #wp-list { margin: 6px 0 2px; max-height: 180px; overflow: auto; }
      .wp-p { display: flex; align-items: center; gap: 6px; padding: 4px 0;
        border-top: 1px solid #262b34; font-size: 12px; }
      .wp-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
      .wp-dot.fresh { background: #1f9e57; } .wp-dot.stale { background: #7a7f8a; }
      .wp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wp-time { color: #9aa3b2; font-variant-numeric: tabular-nums; }
      .wp-host-tag { color: #ffcf5c; font-size: 10px; }
      #wp-notice { margin-top: 8px; font-size: 11px; color: #ffb454; min-height: 14px; }
      .wp-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c8cdd6; }
      #wp-pill { position: absolute; right: 0; bottom: 48px; background: rgba(24,26,32,.9);
        border: 1px solid #353a45; border-radius: 999px; padding: 4px 10px; font-size: 11px;
        display: none; }
      #wp-pill.show { display: block; }
    `;
    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const style = document.createElement("style");
      style.textContent = css;
      document.documentElement.appendChild(style);
    }

    const root = document.createElement("div");
    root.id = "wp-root";
    root.innerHTML = `
      <div id="wp-pill"></div>
      <div id="wp-panel">
        <div id="wp-body"></div>
        <div id="wp-notice"></div>
      </div>
      <button id="wp-fab" title="Watch Party">◐</button>
    `;
    document.body.appendChild(root);

    const fab = root.querySelector("#wp-fab");
    const panel = root.querySelector("#wp-panel");
    const body = root.querySelector("#wp-body");
    const notice = root.querySelector("#wp-notice");
    const pill = root.querySelector("#wp-pill");

    let collapseTimer = null;
    let noticeTimer = null;
    let handlers = {};

    function open() {
      panel.classList.add("open");
      render();
      scheduleCollapse();
    }
    function close() {
      panel.classList.remove("open");
    }
    function toggle() {
      panel.classList.contains("open") ? close() : open();
    }
    function scheduleCollapse() {
      if (collapseTimer) clearTimeout(collapseTimer);
      if (settings.get().displayMode === "pinned") return;
      collapseTimer = setTimeout(close, CONFIG.panelAutoCollapseMs);
    }

    fab.addEventListener("click", toggle);
    root.addEventListener("mousemove", scheduleCollapse);

    function fmt(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      const h = Math.floor(m / 60);
      const mm = String(m % 60).padStart(2, "0");
      const ss = String(s).padStart(2, "0");
      return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
    }

    function setNotice(text, persist) {
      notice.textContent = text || "";
      if (noticeTimer) clearTimeout(noticeTimer);
      if (text && !persist) noticeTimer = setTimeout(() => (notice.textContent = ""), 4000);
    }

    function setFabState(kind) {
      fab.classList.toggle("in-room", kind === "in-room");
      fab.classList.toggle("error", kind === "error");
    }

    function updatePill(roomState) {
      const mode = settings.get().displayMode;
      if (mode !== "pill" || !roomStore.inRoom()) {
        pill.classList.remove("show");
        return;
      }
      const count = roomState ? roomState.participants.length : 1;
      pill.textContent = `▶ ${count}`;
      pill.classList.add("show");
    }

    function renderIdle() {
      const cfg = settings.get();
      body.innerHTML = `
        <h4>Watch Party</h4>
        <div class="row"><input id="wp-name" placeholder="Your name" value="${escapeHtml(cfg.displayName)}"></div>
        <div class="row">
          <button class="action" id="wp-create">Create room</button>
        </div>
        <div class="row">
          <input id="wp-join-code" placeholder="Room code" maxlength="12" style="text-transform:uppercase">
          <button class="ghost" id="wp-join">Join</button>
        </div>
      `;
      body.querySelector("#wp-name").addEventListener("input", (e) =>
        settings.update({ displayName: e.target.value })
      );
      body.querySelector("#wp-create").addEventListener("click", () => handlers.create());
      body.querySelector("#wp-join").addEventListener("click", () => {
        const code = body.querySelector("#wp-join-code").value.trim().toUpperCase();
        if (code) handlers.join(code);
      });
    }

    function renderInRoom(roomState) {
      const room = roomStore.get();
      const cfg = settings.get();
      const detected = handlers.isVideoDetected();
      const participants = (roomState && roomState.participants) || [];

      const list = participants
        .map((p) => {
          const age = Date.now() - new Date(p.updatedAt || 0).getTime();
          const fresh = age < CONFIG.participantStaleMs;
          const st = p.state || {};
          const playing = st.paused === false ? "▶" : "⏸";
          return `<div class="wp-p">
            <span class="wp-dot ${fresh ? "fresh" : "stale"}"></span>
            <span class="wp-name">${escapeHtml(p.displayName || "Friend")}${
            p.role === "host" ? ' <span class="wp-host-tag">HOST</span>' : ""
          }</span>
            <span class="wp-time">${playing} ${fmt(st.currentTime)}</span>
          </div>`;
        })
        .join("");

      body.innerHTML = `
        <h4>Room <span id="wp-code">${escapeHtml(room.roomId)}</span>
          <button class="ghost" id="wp-copy" style="float:right">Copy</button></h4>
        <div class="row" style="color:#9aa3b2">${room.role === "host" ? "You are host" : "Participant"} ·
          ${detected ? "video detected" : "player not detected"}</div>
        <div id="wp-list">${list || '<div style="color:#7a7f8a">No participants yet</div>'}</div>
        <div class="row"><button class="ghost" id="wp-jump">Jump to host</button></div>
        <label class="wp-toggle row"><input type="checkbox" id="wp-follow-progress" ${
          cfg.autoFollowProgress ? "checked" : ""
        }> Auto-follow host progress</label>
        <label class="wp-toggle row"><input type="checkbox" id="wp-follow-pp" ${
          cfg.followPlayPause ? "checked" : ""
        }> Follow host play/pause</label>
        <div class="row">
          <select id="wp-mode" style="flex:1;background:#11131a;color:#e7e9ee;border:1px solid #353a45;border-radius:7px;padding:5px">
            <option value="quiet" ${cfg.displayMode === "quiet" ? "selected" : ""}>Quiet</option>
            <option value="pill" ${cfg.displayMode === "pill" ? "selected" : ""}>Status pill</option>
            <option value="pinned" ${cfg.displayMode === "pinned" ? "selected" : ""}>Pinned</option>
          </select>
          <button class="ghost" id="wp-leave">Leave</button>
        </div>
      `;
      body.querySelector("#wp-copy").addEventListener("click", () => {
        navigator.clipboard && navigator.clipboard.writeText(room.roomId);
        setNotice("Room code copied");
      });
      body.querySelector("#wp-jump").addEventListener("click", () => handlers.jumpToHost());
      body.querySelector("#wp-follow-progress").addEventListener("change", (e) =>
        settings.update({ autoFollowProgress: e.target.checked })
      );
      body.querySelector("#wp-follow-pp").addEventListener("change", (e) =>
        settings.update({ followPlayPause: e.target.checked })
      );
      body.querySelector("#wp-mode").addEventListener("change", (e) => {
        settings.update({ displayMode: e.target.value });
        scheduleCollapse();
        updatePill(handlers.getRoomState());
      });
      body.querySelector("#wp-leave").addEventListener("click", () => handlers.leave());
    }

    function render() {
      if (roomStore.inRoom()) renderInRoom(handlers.getRoomState());
      else renderIdle();
    }

    return {
      mount(h) {
        handlers = h;
        render();
      },
      render,
      open,
      close,
      setNotice,
      setFabState,
      onRoomUpdate(roomState) {
        setFabState(roomStore.inRoom() ? "in-room" : "idle");
        if (panel.classList.contains("open")) render();
        updatePill(roomState);
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
  // Fullscreen behavior: hide all UI in fullscreen.
  // ===========================================================================
  function watchFullscreen() {
    const root = document.getElementById("wp-root");
    function apply() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (root) root.style.display = fs ? "none" : "";
    }
    document.addEventListener("fullscreenchange", apply);
    document.addEventListener("webkitfullscreenchange", apply);
    apply();
  }

  // ===========================================================================
  // Wiring
  // ===========================================================================
  function noticeForError(kind) {
    switch (kind) {
      case "sync-unavailable":
        return "Sync unavailable";
      case "host-offline":
        return "Host offline";
      default:
        return kind;
    }
  }

  panelUi.mount({
    isVideoDetected: () => syncEngine.detectVideo(),
    getRoomState: () => syncEngine.getRoomState(),
    async create() {
      try {
        const name = settings.get().displayName || "Friend";
        const res = await apiClient.createRoom(name);
        roomStore.save({
          roomId: res.roomId,
          participantId: res.participantId,
          role: "host",
          hostToken: res.hostToken
        });
        syncEngine.start();
        panelUi.setNotice("");
        panelUi.render();
        panelUi.setFabState("in-room");
      } catch (err) {
        panelUi.setNotice(noticeForError(err.message));
      }
    },
    async join(code) {
      try {
        const name = settings.get().displayName || "Friend";
        const res = await apiClient.joinRoom(code, name);
        roomStore.save({ roomId: res.roomId, participantId: res.participantId, role: "participant" });
        syncEngine.start();
        panelUi.setNotice("");
        panelUi.render();
        panelUi.setFabState("in-room");
      } catch (err) {
        panelUi.setNotice(err.status === 404 ? "Room not found" : noticeForError(err.message));
      }
    },
    leave() {
      syncEngine.stop();
      roomStore.clear();
      panelUi.render();
      panelUi.setFabState("idle");
    },
    jumpToHost() {
      syncEngine.jumpToHost();
      panelUi.setNotice("Jumped to host");
    }
  });

  syncEngine.onUpdate = (roomState) => panelUi.onRoomUpdate(roomState);
  syncEngine.onError = (kind) => {
    panelUi.setNotice(noticeForError(kind));
    if (kind === "sync-unavailable") panelUi.setFabState("error");
  };

  watchFullscreen();

  // Resume an existing room across reloads / SPA navigations.
  if (roomStore.inRoom()) {
    panelUi.setFabState("in-room");
    syncEngine.start();
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Open Watch Party", () => panelUi.open());
    GM_registerMenuCommand("Leave room", () => {
      syncEngine.stop();
      roomStore.clear();
      panelUi.render();
      panelUi.setFabState("idle");
    });
  }
})();
