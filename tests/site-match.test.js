import { test } from "node:test";
import assert from "node:assert/strict";

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

function isBlocked(host, blockedSites = []) {
  const h = normalizeHost(host);
  return blockedSites.some((entry) => entryMatches(h, entry));
}

function block(host, blockedSites = []) {
  const entry = normalizeHost(host);
  if (!entry || isBlocked(entry, blockedSites)) return blockedSites;
  return [...blockedSites, entry];
}

test("normalizeHost lowercases, drops ports and trailing dots", () => {
  assert.equal(normalizeHost("WWW.Example.COM"), "www.example.com");
  assert.equal(normalizeHost("example.com:8443"), "example.com");
  assert.equal(normalizeHost("  example.com.  "), "example.com");
});

test("normalizeHost is empty-safe", () => {
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost(null), "");
  assert.equal(normalizeHost(undefined), "");
});

test("a blocked domain covers itself and its subdomains", () => {
  assert.equal(isBlocked("example.com", ["example.com"]), true);
  assert.equal(isBlocked("www.example.com", ["example.com"]), true);
  assert.equal(isBlocked("a.b.example.com", ["example.com"]), true);
});

test("blocked domains do not match lookalikes or parent domains", () => {
  assert.equal(isBlocked("example.com.evil.com", ["example.com"]), false);
  assert.equal(isBlocked("xexample.com", ["example.com"]), false);
  assert.equal(isBlocked("example.com", ["www.example.com"]), false);
});

test("unblocked domains stay eligible for automatic video detection", () => {
  assert.equal(isBlocked("www.youtube.com"), false);
  assert.equal(isBlocked("bilibili.com"), false);
});

test("blocking a domain is idempotent and normalizes the host", () => {
  assert.deepEqual(block("WWW.Example.COM:443", []), ["www.example.com"]);
  assert.deepEqual(block("www.example.com", ["example.com"]), ["example.com"]);
});
