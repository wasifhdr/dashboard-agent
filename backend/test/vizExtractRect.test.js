import test from "node:test";
import assert from "node:assert/strict";
import { vizExtractRect } from "../src/perception.js";

const VP = { width: 1920, height: 1200 };

test("a viz inside the viewport becomes an integer crop", () => {
  // Netflix's real measured geometry.
  assert.deepEqual(vizExtractRect({ x: 0, y: 0, width: 1720, height: 1060 }, VP), {
    left: 0,
    top: 0,
    width: 1720,
    height: 1060,
  });
});

test("sub-pixel layout positions are rounded, not rejected", () => {
  assert.deepEqual(vizExtractRect({ x: 0.4, y: 0.6, width: 1195.2, height: 592.4 }, VP), {
    left: 0,
    top: 1,
    width: 1195,
    height: 592,
  });
});

test("a viz larger than the viewport falls back (null)", () => {
  // A viewport screenshot cannot contain it, so cropping would silently
  // truncate what the model reads - the caller must clip instead.
  assert.equal(vizExtractRect({ x: 0, y: 0, width: 1920, height: 1400 }, VP), null);
  assert.equal(vizExtractRect({ x: 0, y: 0, width: 2200, height: 800 }, VP), null);
});

test("a viz scrolled partly out of view falls back (null)", () => {
  assert.equal(vizExtractRect({ x: 0, y: -40, width: 1200, height: 900 }, VP), null);
  assert.equal(vizExtractRect({ x: 900, y: 0, width: 1200, height: 900 }, VP), null);
});

test("an exactly viewport-sized viz still crops", () => {
  assert.deepEqual(vizExtractRect({ x: 0, y: 0, width: 1920, height: 1200 }, VP), {
    left: 0,
    top: 0,
    width: 1920,
    height: 1200,
  });
});

test("the crop never runs past the viewport edge", () => {
  const r = vizExtractRect({ x: 1919.6, y: 0, width: 0.4, height: 1200 }, VP);
  assert.ok(r.left + r.width <= VP.width);
  assert.ok(r.top + r.height <= VP.height);
});

test("missing or degenerate geometry falls back rather than throwing", () => {
  assert.equal(vizExtractRect(null, VP), null);
  assert.equal(vizExtractRect({ x: 0, y: 0, width: 100, height: 100 }, null), null);
  assert.equal(vizExtractRect({ x: 0, y: 0, width: 0, height: 0 }, VP), null);
});
