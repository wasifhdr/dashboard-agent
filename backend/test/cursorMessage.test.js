import test from "node:test";
import assert from "node:assert/strict";
import { cursorMessage } from "../src/conversationRuntime.js";

test("cursorMessage builds the WS payload", () => {
  assert.deepEqual(cursorMessage(0.25, 0.75, "move"), { type: "cursor", nx: 0.25, ny: 0.75, phase: "move" });
  assert.deepEqual(cursorMessage(0.5, 0.5, "click"), { type: "cursor", nx: 0.5, ny: 0.5, phase: "click" });
});
