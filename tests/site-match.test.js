import { test } from "node:test";
import assert from "node:assert/strict";

// The userscript ships as a single Tampermonkey IIFE, so siteMatch cannot be
// imported directly. This file pins the *contract* of host matching with a
// reference implementation kept in sync with the `siteMatch` module in
// userscript/watch-party.user.js. The one deliberate difference: the module
// reads the user list from `settings`, while this copy takes it as an argument.
// If you change the module, update this copy and these expectations together.

const BUILTIN_SITES = [
  "bilibili.com",
  "xifanapp.com",
  "ciyuanapp.com",
  "agedm.org",
  "localhost",
  "127.0.0.1"
];
const BUILTIN_PATTERNS = [/(^|\.)agefans\.[a-z]{2,}(\.[a-z]{2,})?$/];
const SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
}

function entryMatches(host, entry) {
  const h = normalizeHost(host);
  const e = normalizeHost(entry);
  if (!h || !e) return false;
  return h === e || h.endsWith("." + e);
}

function matchEntry(host, userSites = []) {
  const h = normalizeHost(host);
  if (!h) return "";
  const candidates = [...BUILTIN_SITES, ...userSites].filter((e) => entryMatches(h, e));
  if (BUILTIN_PATTERNS.some((re) => re.test(h))) candidates.push(h);
  if (!candidates.length) return "";
  return candidates.sort((a, b) => b.length - a.length)[0];
}

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

// ---------------------------------------------------------------------------
// normalizeHost
// ---------------------------------------------------------------------------

test("normalizeHost lowercases, drops ports and trailing dots", () => {
  assert.equal(normalizeHost("WWW.Example.COM"), "www.example.com");
  assert.equal(normalizeHost("example.com:8443"), "example.com");
  assert.equal(normalizeHost("  example.com.  "), "example.com");
  assert.equal(normalizeHost("example.com.."), "example.com");
});

test("normalizeHost is empty-safe", () => {
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost(null), "");
  assert.equal(normalizeHost(undefined), "");
});

// ---------------------------------------------------------------------------
// entryMatches
// ---------------------------------------------------------------------------

test("an entry covers itself and its subdomains", () => {
  assert.equal(entryMatches("agedm.org", "agedm.org"), true);
  assert.equal(entryMatches("www.agedm.org", "agedm.org"), true);
  assert.equal(entryMatches("a.b.agedm.org", "agedm.org"), true);
});

test("matching a subdomain does not cover its parent", () => {
  assert.equal(entryMatches("agedm.org", "www.agedm.org"), false);
  assert.equal(entryMatches("m.agedm.org", "www.agedm.org"), false);
});

test("lookalike hosts never match", () => {
  // The classic suffix attack: the entry must sit on a label boundary.
  assert.equal(entryMatches("agedm.org.evil.com", "agedm.org"), false);
  assert.equal(entryMatches("xagedm.org", "agedm.org"), false);
  assert.equal(entryMatches("agedm.orgx", "agedm.org"), false);
});

test("entry matching is case-insensitive", () => {
  assert.equal(entryMatches("WWW.Agedm.ORG", "agedm.org"), true);
});

// ---------------------------------------------------------------------------
// matchEntry (built-in sites + user list)
// ---------------------------------------------------------------------------

test("built-in sites stay matched with no user list", () => {
  assert.equal(matchEntry("www.bilibili.com"), "bilibili.com");
  assert.equal(matchEntry("bilibili.com"), "bilibili.com");
  assert.equal(matchEntry("m.ciyuanapp.com"), "ciyuanapp.com");
  assert.equal(matchEntry("www.agedm.org"), "agedm.org");
  assert.equal(matchEntry("www.xifanapp.com"), "xifanapp.com");
});

test("localhost and loopback are matched so local previews keep working", () => {
  assert.equal(matchEntry("localhost"), "localhost");
  assert.equal(matchEntry("localhost:5500"), "localhost");
  assert.equal(matchEntry("127.0.0.1"), "127.0.0.1");
  assert.equal(matchEntry("127.0.0.1:8787"), "127.0.0.1");
});

test("agefans matches rotating TLDs but not lookalikes", () => {
  assert.equal(matchEntry("www.agefans.cc"), "www.agefans.cc");
  assert.equal(matchEntry("agefans.to"), "agefans.to");
  assert.equal(matchEntry("agefans.co.uk"), "agefans.co.uk");
  assert.equal(matchEntry("notagefans.com"), "");
  assert.equal(matchEntry("www.agefans.cc.evil.com"), "");
});

test("unlisted domains are not matched by default", () => {
  assert.equal(matchEntry("www.youtube.com"), "");
  assert.equal(matchEntry("example.com"), "");
  assert.equal(matchEntry(""), "");
});

test("user entries activate a domain and its subdomains", () => {
  assert.equal(matchEntry("www.example.com", ["example.com"]), "example.com");
  assert.equal(matchEntry("example.com", ["example.com"]), "example.com");
  assert.equal(matchEntry("www.example.com", ["www.example.com"]), "www.example.com");
});

test("the most specific entry wins", () => {
  assert.equal(matchEntry("www.bilibili.com", ["www.bilibili.com"]), "www.bilibili.com");
  assert.equal(matchEntry("live.bilibili.com", ["www.bilibili.com"]), "bilibili.com");
});

test("user entries cannot widen a lookalike into a match", () => {
  assert.equal(matchEntry("agedm.org.evil.com", ["agedm.org"]), "");
});

// ---------------------------------------------------------------------------
// parentOf (the "match the parent domain too" menu entry)
// ---------------------------------------------------------------------------

test("parentOf walks up one level when it is useful", () => {
  assert.equal(parentOf("www.agedm.org"), "agedm.org");
  assert.equal(parentOf("www.example.com"), "example.com");
  assert.equal(parentOf("a.b.c.example.com"), "example.com");
});

test("parentOf keeps multi-part suffixes intact", () => {
  assert.equal(parentOf("a.b.example.co.uk"), "example.co.uk");
  assert.equal(parentOf("www.example.com.cn"), "example.com.cn");
});

test("parentOf stays empty when there is nothing to offer", () => {
  assert.equal(parentOf("agedm.org"), "");
  assert.equal(parentOf("example.com"), "");
  assert.equal(parentOf("localhost"), "");
  assert.equal(parentOf("127.0.0.1"), "");
});
