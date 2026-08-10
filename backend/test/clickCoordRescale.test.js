// Right-digits/wrong-magnitude click coordinates (see normalizeClickAction).
// The concrete values below are the ones gemini-flash-lite actually produced on
// the Spotify dashboard for "What are the songs by Bruno Mars?", which cost a
// whole session (9 rejected model calls) before the rescue existed.
import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";
import { StepResponseSchema } from "../src/actionSchema.js";

const { rescalePair, normalizeClickAction } = _internal;
const FRAME = { width: 1920, height: 1200 };

// Dividing by a power of ten leaves float noise (4.195/10 is
// 0.41950000000000004). Meaningless for a click point — a millionth of a frame
// is a fraction of a pixel — so compare with a tolerance rather than contorting
// the production code to produce exact decimals.
function assertClose(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `${actual} ≉ ${expected}`);
}

test("already-normalized pairs are left exactly alone", () => {
  for (const [nx, ny] of [
    [0, 0],
    [0.42, 0.08],
    [1, 1],
  ]) {
    assert.deepEqual(rescalePair(nx, ny, FRAME), { nx, ny });
  }
});

test("a pair out of range shares one scale, taken from the larger coordinate", () => {
  // The real failure. 424 fixes the space at 0-1000, so 62 is 0.062 — near the
  // top edge, where that dropdown is. Scaling 62 on its own would read it as a
  // percentage and aim at 0.62, most of the way down the frame.
  const { nx, ny } = rescalePair(424, 62, FRAME);
  assertClose(nx, 0.424);
  assertClose(ny, 0.062);
});

test("percentage pairs collapse on the same shared-scale rule", () => {
  const { nx, ny } = rescalePair(42, 6, FRAME);
  assertClose(nx, 0.42);
  assertClose(ny, 0.06);
});

test("when only one axis is out of range, the valid one is untouched", () => {
  const { nx, ny } = rescalePair(4.195, 0.08, FRAME);
  assertClose(nx, 0.4195);
  assert.equal(ny, 0.08);
});

test("past 1000 only real pixels are plausible, so each axis uses its own dimension", () => {
  const { nx, ny } = rescalePair(1500, 900, FRAME);
  assertClose(nx, 1500 / 1920);
  assertClose(ny, 900 / 1200);
});

test("with no frame dimensions it still degrades to a shared decade rescale", () => {
  const { nx, ny } = rescalePair(1500, 900, { width: 0, height: 0 });
  assertClose(nx, 0.15);
  assertClose(ny, 0.09);
});

test("the rescued actions now pass the schema that rejected them", () => {
  const observed = [
    { nx: 4.195, ny: 0.08 },
    { nx: 424, ny: 62 },
    { nx: 425.0, ny: 80.0 },
  ];
  for (const { nx, ny } of observed) {
    const raw = { thought: "Click the Artists dropdown.", action: { type: "click", nx, ny, target: "dropdown" } };
    assert.equal(StepResponseSchema.safeParse(raw).success, false, `${nx},${ny} should have been rejected before`);

    raw.action = normalizeClickAction(raw.action, FRAME);
    const result = StepResponseSchema.safeParse(raw);
    assert.equal(result.success, true, `${nx},${ny} should be rescued`);
    assert.equal(raw.action.target, "dropdown", "the rest of the action survives");
  }
});

test("in-range clicks are returned by identity, not copied", () => {
  const action = { type: "click", nx: 0.42, ny: 0.06 };
  assert.equal(normalizeClickAction(action, FRAME), action);
});

test("non-click actions and non-numeric coords are left for zod to judge", () => {
  const answer = { type: "answer", answer: "Nintendo", confidence: 0.9 };
  assert.equal(normalizeClickAction(answer, FRAME), answer);

  const missing = { type: "click", target: "dropdown" };
  assert.equal(normalizeClickAction(missing, FRAME), missing);

  const notANumber = { type: "click", nx: "left edge", ny: 0.5 };
  assert.equal(normalizeClickAction(notANumber, FRAME), notANumber);
});

test("negative coordinates are not rescued into validity", () => {
  const action = { type: "click", nx: -0.2, ny: 400 };
  assert.equal(normalizeClickAction(action, FRAME), action);
  assert.equal(StepResponseSchema.safeParse({ thought: "t", action }).success, false);
});

// ---- scroll shares the click coordinate space, so it shares the rescue -----

test("a scroll's coordinates are rescued exactly as a click's are", () => {
  const raw = { type: "scroll", nx: 83, ny: 49, direction: "down", target: "the pie stack" };
  const fixed = normalizeClickAction(raw, FRAME);
  assertClose(fixed.nx, 0.83);
  assertClose(fixed.ny, 0.49);
  assert.equal(fixed.direction, "down", "the rest of the action survives");
  assert.equal(fixed.target, "the pie stack");
  assert.ok(StepResponseSchema.safeParse({ thought: "scroll down", action: fixed }).success);
});

test("an in-range scroll is returned by identity, not copied", () => {
  const action = { type: "scroll", nx: 0.83, ny: 0.49, direction: "down" };
  assert.equal(normalizeClickAction(action, FRAME), action);
});
