import test from "node:test";
import assert from "node:assert/strict";
import { isNearDeadPoint, isNearDeadScroll, clearStaleGuards } from "../src/pixelGuard.js";

test("empty dead-point list is never near", () => {
  assert.equal(isNearDeadPoint({ nx: 0.5, ny: 0.5 }, [], 0.05), false);
});

test("a point within the radius is near", () => {
  assert.equal(isNearDeadPoint({ nx: 0.42, ny: 0.13 }, [{ nx: 0.43, ny: 0.13 }], 0.05), true);
});

test("a point outside the radius is not near", () => {
  assert.equal(isNearDeadPoint({ nx: 0.42, ny: 0.13 }, [{ nx: 0.60, ny: 0.60 }], 0.05), false);
});

test("matches when any of several dead points is near", () => {
  const dead = [{ nx: 0.10, ny: 0.90 }, { nx: 0.43, ny: 0.14 }];
  assert.equal(isNearDeadPoint({ nx: 0.42, ny: 0.13 }, dead, 0.05), true);
});

// ---- dead-scroll guard -----------------------------------------------------

test("a dead scroll blocks the same point in the same direction", () => {
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.84, ny: 0.50, direction: "down" }, dead, 0.10), true);
});

test("a dead scroll does NOT block the opposite direction", () => {
  // A pane at its end reports no change exactly like a pane with nothing
  // scrollable in it, so the point gets recorded as dead - but scrolling back UP
  // must stay possible, or an over-scroll can never be undone.
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.83, ny: 0.49, direction: "up" }, dead, 0.10), false);
});

test("a dead scroll does not block a clearly different pane", () => {
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.30, ny: 0.20, direction: "down" }, dead, 0.10), false);
});

test("an empty dead-scroll list is never near", () => {
  assert.equal(isNearDeadScroll({ nx: 0.5, ny: 0.5, direction: "down" }, [], 0.10), false);
});

test("the scroll radius is pane-sized, so nibbling inside one dead pane is still blocked", () => {
  // The measured pie pane is 186x364 of a 1920x600 frame: ~0.10 wide, ~0.61
  // tall. At the click guard's 0.05 the model can evade the guard by shifting
  // its aim a few percent while staying inside the same dead pane.
  const dead = [{ nx: 0.83, ny: 0.49, direction: "down" }];
  assert.equal(isNearDeadScroll({ nx: 0.88, ny: 0.55, direction: "down" }, dead, 0.10), true);
  assert.equal(isNearDeadScroll({ nx: 0.88, ny: 0.55, direction: "down" }, dead, 0.05), false);
});

// ---- stale guard clearing --------------------------------------------------

test("clearStaleGuards empties all three lists in place", () => {
  const guards = {
    deadClickPoints: [{ nx: 0.1, ny: 0.1 }],
    rejectedAimPoints: [{ nx: 0.2, ny: 0.2 }],
    deadScrollPoints: [{ nx: 0.3, ny: 0.3, direction: "down" }],
  };
  const originals = [guards.deadClickPoints, guards.rejectedAimPoints, guards.deadScrollPoints];
  clearStaleGuards(guards);
  assert.deepEqual(guards.deadClickPoints, []);
  assert.deepEqual(guards.rejectedAimPoints, []);
  assert.deepEqual(guards.deadScrollPoints, []);
  // Identity matters: the orchestrator closes over these arrays for the life of
  // the run, so replacing them instead of emptying them would silently keep the
  // stale ones alive.
  assert.equal(guards.deadClickPoints, originals[0]);
  assert.equal(guards.rejectedAimPoints, originals[1]);
  assert.equal(guards.deadScrollPoints, originals[2]);
});

test("clearStaleGuards tolerates a missing list", () => {
  const guards = { deadClickPoints: [{ nx: 0.1, ny: 0.1 }] };
  clearStaleGuards(guards);
  assert.deepEqual(guards.deadClickPoints, []);
});
