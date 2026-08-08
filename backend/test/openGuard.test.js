import test from "node:test";
import assert from "node:assert/strict";

import { withTimeout, openGuardDecision } from "../src/openGuard.js";

const STALE = 195000; // OPEN_TIMEOUT + PREV_CLOSE_TIMEOUT + slack, as in server.js

test("no open in flight - proceed", () => {
  assert.equal(openGuardDecision({ opening: false, openingSince: 0, now: 10_000, staleMs: STALE }), "proceed");
});

test("an open genuinely in flight is rejected, not raced", () => {
  // Two overlapping opens would each create a Playwright context and one would
  // be orphaned - this is the guard's original purpose and must still hold.
  assert.equal(openGuardDecision({ opening: true, openingSince: 1_000, now: 5_000, staleMs: STALE }), "reject");
});

test("still rejects right up to the stale threshold", () => {
  assert.equal(openGuardDecision({ opening: true, openingSince: 0, now: STALE - 1, staleMs: STALE }), "reject");
});

test("REGRESSION: a latched flag is overridden instead of locking the user out forever", () => {
  // The reported bug: the flag stayed true for the life of the process, so the
  // UI showed "already being opened" on every retry with no way out.
  assert.equal(openGuardDecision({ opening: true, openingSince: 0, now: STALE, staleMs: STALE }), "override");
  assert.equal(openGuardDecision({ opening: true, openingSince: 0, now: 60 * 60_000, staleMs: STALE }), "override");
});

test("withTimeout passes through a value that arrives in time", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 1000, "x"), "ok");
});

test("withTimeout propagates the original rejection, not a timeout", async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("real failure")), 1000, "x"),
    /real failure/,
  );
});

test("withTimeout rejects with a 504 when the promise never settles", async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(never, 30, "Opening the dashboard"),
    (e) => e.statusCode === 504 && /Opening the dashboard timed out/.test(e.message),
  );
});

test("withTimeout clears its timer so a settled call cannot hold the process open", async () => {
  // If the timer leaked, node would stay alive past the await; asserting the
  // handle count is the cheap proxy for that.
  const before = process._getActiveHandles().length;
  await withTimeout(Promise.resolve(1), 60_000, "x");
  assert.ok(process._getActiveHandles().length <= before);
});
