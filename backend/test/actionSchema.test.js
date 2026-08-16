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

// ---- scroll ---------------------------------------------------------------

test("valid scroll parses", () => {
  const r = ActionSchema.safeParse({ type: "scroll", nx: 0.83, ny: 0.49, direction: "down", target: "the pie stack" });
  assert.ok(r.success);
});

test("scroll without optional target parses", () => {
  assert.ok(ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5, direction: "up" }).success);
});

test("scroll direction outside the enum is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5, direction: "sideways" }).success, false);
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5 }).success, false);
});

test("out-of-range scroll coordinates are rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 1.4, ny: 0.2, direction: "down" }).success, false);
  assert.equal(ActionSchema.safeParse({ type: "scroll", nx: 0.2, ny: -0.1, direction: "down" }).success, false);
});

test("a scroll magnitude is not part of the contract", () => {
  // The actuator owns the notch size; a model-supplied dy has no [0,1] range
  // check to catch a decade slip, which is the documented failure mode.
  const r = ActionSchema.safeParse({ type: "scroll", nx: 0.5, ny: 0.5, direction: "down", dy: 900 });
  assert.ok(r.success, "an extra key is stripped, not fatal");
  assert.equal(r.data.dy, undefined, "dy must not survive into the validated action");
});

// ---- search ---------------------------------------------------------------

test("valid search parses", () => {
  const r = ActionSchema.safeParse({
    type: "search", text: "American Horror Story", target: "the Title filter search box",
  });
  assert.ok(r.success);
});

test("search without optional target parses", () => {
  assert.ok(ActionSchema.safeParse({ type: "search", text: "Ed Sheeran" }).success);
});

test("empty search text is rejected", () => {
  assert.equal(ActionSchema.safeParse({ type: "search", text: "" }).success, false);
});

test("over-long search text is rejected", () => {
  // The cap is a timeout budget: typing runs at 250ms/char, so 60 chars is 15s
  // against actionTimeoutMs's 30000.
  assert.ok(ActionSchema.safeParse({ type: "search", text: "a".repeat(60) }).success);
  assert.equal(ActionSchema.safeParse({ type: "search", text: "a".repeat(61) }).success, false);
});

test("a search carries no coordinates", () => {
  // Deliberate: the box auto-focuses, and a click 2% below its centre was
  // measured selecting a title and filtering the dashboard silently.
  const r = ActionSchema.safeParse({ type: "search", text: "x", nx: 0.5, ny: 0.5 });
  assert.ok(r.success, "an extra key is stripped, not fatal");
  assert.equal(r.data.nx, undefined, "nx must not survive into the validated action");
});
