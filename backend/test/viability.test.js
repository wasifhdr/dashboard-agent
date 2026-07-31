import test from "node:test";
import assert from "node:assert/strict";
import { deriveVerdict } from "../src/viability.js";

function inventory(overrides = {}) {
  return {
    isDashboard: true,
    sheets: [{ name: "D", index: 0, isActive: true, isHidden: false, sheetType: "dashboard" }],
    filters: [{ operable: true }, { operable: true }],
    parameters: [],
    ...overrides,
  };
}

test("a healthy dashboard is good", () => {
  const out = deriveVerdict({ activeSheetType: "dashboard", inventory: inventory(), blankFrame: false });
  assert.equal(out.verdict, "good");
  assert.deepEqual(out.reasons, []);
});

test("a story is unusable - the agent has no action that advances story points", () => {
  const out = deriveVerdict({ activeSheetType: "story", inventory: null, blankFrame: false });
  assert.equal(out.verdict, "unusable");
  assert.deepEqual(out.reasons, ["story"]);
});

test("a blank frame is unusable and outranks everything else", () => {
  const out = deriveVerdict({ activeSheetType: "dashboard", inventory: inventory(), blankFrame: true });
  assert.equal(out.verdict, "unusable");
  assert.deepEqual(out.reasons, ["blank_frame"]);
});

test("a bare worksheet is still good - it is readable and clickable", () => {
  const out = deriveVerdict({
    activeSheetType: "worksheet",
    inventory: inventory({ isDashboard: false }),
    blankFrame: false,
  });
  assert.equal(out.verdict, "good");
});

test("zero bridge-visible controls is still good - pixel mode clicks marks", () => {
  const out = deriveVerdict({
    activeSheetType: "dashboard",
    inventory: inventory({ filters: [{ operable: false }], parameters: [] }),
    blankFrame: false,
  });
  assert.equal(out.verdict, "good");
  assert.equal(out.facts.operableControlCount, 0, "still reported as a fact");
});

test("a missing inventory on a non-story is unknown, not a guess", () => {
  const out = deriveVerdict({ activeSheetType: "dashboard", inventory: null, blankFrame: false });
  assert.equal(out.verdict, "unknown");
});

test("facts report what was observed", () => {
  const out = deriveVerdict({
    activeSheetType: "dashboard",
    inventory: inventory({ sheets: [{ isActive: true, sheetType: "dashboard" }, { sheetType: "dashboard" }] }),
    blankFrame: false,
  });
  assert.equal(out.facts.sheetCount, 2);
  assert.equal(out.facts.operableControlCount, 2);
  assert.equal(out.facts.isDashboard, true);
  assert.equal(out.facts.activeSheetType, "dashboard");
});
