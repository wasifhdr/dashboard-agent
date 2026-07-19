import test from "node:test";
import assert from "node:assert/strict";
import { ActionSchema, StepResponseSchema } from "../src/actionSchema.js";

test("valid click parses", () => {
  const r = ActionSchema.safeParse({ type: "click", nx: 0.5, ny: 0.25, target: "ZRI tab" });
  assert.ok(r.success);
});

test("click without optional target parses", () => {
  const r = ActionSchema.safeParse({ type: "click", nx: 0, ny: 1 });
  assert.ok(r.success);
});

test("out-of-range coordinate is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "click", nx: 1.4, ny: 0.2 }).success, false);
  assert.equal(ActionSchema.safeParse({ type: "click", nx: 0.2, ny: -0.1 }).success, false);
});

test("existing api-mode actions still parse (regression)", () => {
  assert.ok(ActionSchema.safeParse({ type: "set_filter", target_id: "F1", values: ["Asia"] }).success);
  assert.ok(ActionSchema.safeParse({ type: "switch_sheet", target_id: "S2" }).success);
  assert.ok(StepResponseSchema.safeParse({ thought: "x", action: { type: "answer", answer: "42" } }).success);
});
