import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { formatHistoryLine, buildPrompt } = _internal;

test("ok click with no change renders coords + 'no change'", () => {
  assert.equal(
    formatHistoryLine({ idx: 3, type: "click", status: "ok", nx: 0.42, ny: 0.13, changed: false }),
    "#3 click (0.42,0.13) -> no change",
  );
});

test("ok click that changed the view renders coords + 'changed'", () => {
  assert.equal(
    formatHistoryLine({ idx: 7, type: "click", status: "ok", nx: 0.58, ny: 0.13, changed: true }),
    "#7 click (0.58,0.13) -> changed",
  );
});

test("rejected click renders coords + its status", () => {
  assert.equal(
    formatHistoryLine({ idx: 5, type: "click", status: "rejected_loop", nx: 0.42, ny: 0.13, changed: false }),
    "#5 click (0.42,0.13) -> rejected_loop",
  );
});

test("api-action history is unchanged (regression)", () => {
  assert.equal(formatHistoryLine({ idx: 3, type: "set_filter", status: "ok" }), "#3 set_filter -> ok");
  assert.equal(formatHistoryLine({ idx: 4, type: "wait", status: "ok" }), "#4 wait -> ok");
});

test("pixel prompt carries the strengthened no-change rule", () => {
  const { systemText } = buildPrompt({
    question: "q",
    inventory: { sheets: [], filters: [], parameters: [] },
    history: [],
    mode: "pixel",
  });
  assert.match(systemText, /NEVER repeat the same or a nearby click/);
});
