// Grid anchoring: locate names the 3x3 cell before it writes decimals, and the
// decimals are checked against that cell.
//
// The measurement behind it (committed Netflix frames, 6 samples per cell,
// 2026-08-17). Asked for a corner control with the old flat prompt, locate scored
// 0/12 across two corner targets - every answer mid-frame. Asked to name the cell
// first, it named "left/top" 12/12 while its decimals landed outside that cell in
// 7 of the 12. The classification is the reliable output; these helpers are what
// let the code act on it instead of on the number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellConsistency, cellCenter } from "../src/vlmClient.js";

// 2/3 + 1/6 is 0.8333333333333333 while 5/6 is 0.8333333333333334. A tenth of a
// trillionth of a frame is not a click point, so compare with a tolerance rather
// than contorting the production code to produce exact decimals (same reasoning
// as assertClose in clickCoordRescale.test.js).
function assertPoint(actual, nx, ny) {
  assert.ok(Math.abs(actual.nx - nx) < 1e-9, `${actual.nx} ≉ ${nx}`);
  assert.ok(Math.abs(actual.ny - ny) < 1e-9, `${actual.ny} ≉ ${ny}`);
}

test("a cell centre is the middle of its third", () => {
  assertPoint(cellCenter("left", "top"), 1 / 6, 1 / 6);
  assertPoint(cellCenter("center", "middle"), 0.5, 0.5);
  assertPoint(cellCenter("right", "bottom"), 5 / 6, 5 / 6);
});

test("an unknown cell name has no centre", () => {
  assert.equal(cellCenter("topleft", "top"), null);
  assert.equal(cellCenter("left", "upper"), null);
});

test("decimals inside the named cell agree", () => {
  const out = cellConsistency({ col: "left", row: "top" }, 0.069, 0.043);
  assert.deepEqual(out, { col: "left", row: "top", agrees: true });
});

test("THE BUG: a mid-frame decimal under a left/top classification disagrees", () => {
  // The exact reply that kept clicking the bubble chart: cell correct, number not.
  const out = cellConsistency({ col: "left", row: "top" }, 0.68, 0.44);
  assert.equal(out.agrees, false);
});

test("one axis being wrong is enough to disagree", () => {
  // Measured: anchoring fixed nx on 6/6 samples for the 'TV Show' row while ny
  // still came back at 0.81 on three of them.
  assert.equal(cellConsistency({ col: "left", row: "top" }, 0.043, 0.81).agrees, false);
  assert.equal(cellConsistency({ col: "left", row: "top" }, 0.81, 0.043).agrees, false);
});

test("a whisker past a band boundary still agrees - no repair call wasted", () => {
  // The Movie bubble: true centre ny=0.405, just past the 0.333 line. The model
  // said "top" and answered 0.395, which is a good coordinate. A strict band
  // check would have called that a contradiction and paid for a repair.
  const out = cellConsistency({ col: "right", row: "top" }, 0.8, 0.395);
  assert.equal(out.agrees, true, "0.395 is within the slop of the top/middle boundary");
});

test("the slop does not stretch across a whole band", () => {
  // Tolerance is a boundary allowance, not a licence for the centre-biased
  // answer this whole mechanism exists to catch.
  assert.equal(cellConsistency({ col: "left", row: "top" }, 0.5, 0.5).agrees, false);
});

test("case and padding in the model's cell names are tolerated", () => {
  assert.equal(cellConsistency({ col: " Left ", row: "TOP" }, 0.069, 0.043).agrees, true);
});

test("no cell named means nothing to check, NOT a contradiction", () => {
  // Distinct from `agrees: false`: the caller must keep the decimals rather than
  // paying for a repair it has no evidence it needs.
  assert.equal(cellConsistency({ nx: 0.5, ny: 0.5 }, 0.5, 0.5), null);
  assert.equal(cellConsistency({ col: "leftish", row: "top" }, 0.1, 0.1), null);
  assert.equal(cellConsistency(null, 0.1, 0.1), null);
});
