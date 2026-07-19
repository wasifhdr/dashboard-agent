import test from "node:test";
import assert from "node:assert/strict";
import { vizPointToPagePixels } from "../src/actuator.js";

test("maps normalized point into the viz bounding box", () => {
  const box = { x: 100, y: 50, width: 800, height: 400 };
  assert.deepEqual(vizPointToPagePixels(box, 0, 0), { px: 100, py: 50 });
  assert.deepEqual(vizPointToPagePixels(box, 1, 1), { px: 900, py: 450 });
  assert.deepEqual(vizPointToPagePixels(box, 0.5, 0.5), { px: 500, py: 250 });
});
