import test from "node:test";
import assert from "node:assert/strict";
import { isNearDeadPoint } from "../src/pixelGuard.js";

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
