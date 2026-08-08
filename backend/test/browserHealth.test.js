import test from "node:test";
import assert from "node:assert/strict";

import { probeBrowser, ensureHealthyBrowser } from "../src/browserHealth.js";

// A browser stub whose newContext() behaviour we control.
function fakeBrowser({ newContext, connected = true, close } = {}) {
  const calls = { newContext: 0, close: 0, contextClosed: 0 };
  return {
    calls,
    isConnected: () => connected,
    close: close ?? (async () => { calls.close += 1; }),
    newContext: async (...args) => {
      calls.newContext += 1;
      if (newContext) return newContext(...args);
      return { close: async () => { calls.contextClosed += 1; } };
    },
  };
}

test("no browser at all is not healthy", async () => {
  assert.equal(await probeBrowser(null, 50), false);
});

test("a browser that reports itself disconnected fails without a round-trip", async () => {
  const b = fakeBrowser({ connected: false });
  assert.equal(await probeBrowser(b, 50), false);
  assert.equal(b.calls.newContext, 0, "must not try to use a known-dead browser");
});

test("REGRESSION: a wedged browser that still reports connected is caught by the bounded probe", async () => {
  // The field failure: the headless process was alive, idle, and burning zero
  // CPU, isConnected() was true, and newContext() simply never resolved - so
  // every dashboard open hung until the outer 150s guard fired, forever, until
  // the backend was restarted by hand.
  const b = fakeBrowser({ newContext: () => new Promise(() => {}) });
  const startedAt = Date.now();
  assert.equal(await probeBrowser(b, 60), false);
  assert.ok(Date.now() - startedAt < 2000, "probe must be bounded, not hang with the browser");
});

test("a browser whose newContext rejects is not healthy", async () => {
  const b = fakeBrowser({ newContext: async () => { throw new Error("Target closed"); } });
  assert.equal(await probeBrowser(b, 50), false);
});

test("a healthy browser passes and the probe context is closed again", async () => {
  const b = fakeBrowser();
  assert.equal(await probeBrowser(b, 1000), true);
  assert.equal(b.calls.contextClosed, 1, "probe must not leak the context it opened");
});

test("a healthy browser is reused, never relaunched", async () => {
  const b = fakeBrowser();
  let launches = 0;
  const out = await ensureHealthyBrowser({
    browser: b,
    probe: async () => true,
    launch: async () => { launches += 1; return fakeBrowser(); },
  });
  assert.equal(out.browser, b);
  assert.equal(out.relaunched, false);
  assert.equal(launches, 0);
});

test("an unhealthy browser is replaced by a fresh one", async () => {
  const dead = fakeBrowser();
  const fresh = fakeBrowser();
  const out = await ensureHealthyBrowser({
    browser: dead,
    probe: async () => false,
    launch: async () => fresh,
  });
  assert.equal(out.browser, fresh);
  assert.equal(out.relaunched, true);
});

test("a first-ever launch (no browser yet) works without a dead browser to discard", async () => {
  const fresh = fakeBrowser();
  const out = await ensureHealthyBrowser({ browser: null, probe: async () => false, launch: async () => fresh });
  assert.equal(out.browser, fresh);
});

test("REGRESSION: tearing down the dead browser must not be awaited", async () => {
  // close() on the wedged browser is exactly as likely to hang as newContext()
  // was; awaiting it here would just move the 150s stall one line down.
  const dead = fakeBrowser({ close: () => new Promise(() => {}) });
  const fresh = fakeBrowser();
  const startedAt = Date.now();
  const out = await ensureHealthyBrowser({ browser: dead, probe: async () => false, launch: async () => fresh });
  assert.equal(out.browser, fresh);
  assert.ok(Date.now() - startedAt < 2000, "must not block on the dead browser's close");
});

test("a close that throws while being discarded does not break the relaunch", async () => {
  const dead = fakeBrowser({ close: async () => { throw new Error("already gone"); } });
  const fresh = fakeBrowser();
  const out = await ensureHealthyBrowser({ browser: dead, probe: async () => false, launch: async () => fresh });
  assert.equal(out.browser, fresh);
});
