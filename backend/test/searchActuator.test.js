import test from "node:test";
import assert from "node:assert/strict";
import { findFocusedTextEntry, executeActionWithTimeout, describeAction } from "../src/actuator.js";

// A fake page is enough: the browser-side work is one evaluate() per frame, so
// the canned return value stands in for whatever the real page would report.
const pageWith = (frameResults, keyboard) => ({
  frames: () => frameResults.map((r) => ({
    evaluate: async () => { if (r instanceof Error) throw r; return r; },
  })),
  keyboard,
  waitForTimeout: async (ms) => keyboard.log.push(`wait:${ms}`),
});
const spyKeyboard = () => {
  const log = [];
  return {
    log,
    press: async (k) => log.push(k),
    type: async (t, o) => log.push(`type:${t}:delay=${o?.delay}`),
  };
};

test("no focused text entry anywhere reports null", async () => {
  assert.equal(await findFocusedTextEntry(pageWith([null, null], spyKeyboard())), null);
});

test("a detached frame does not abort the search for the focused box", async () => {
  // The Tableau iframe detaches and reattaches during load; one bad frame must
  // not hide a good one.
  const page = pageWith([new Error("Frame has been detached"), { tag: "textarea", cls: "QueryBox", value: "" }], spyKeyboard());
  const found = await findFocusedTextEntry(page);
  assert.equal(found.cls, "QueryBox");
});

test("a search with nothing focused dispatches NO keystrokes", async () => {
  // The whole point of the focus check: keystrokes sent at an unfocused page go
  // to Tableau's own keyboard shortcuts, with no way to tell where they landed.
  const kb = spyKeyboard();
  const res = await executeActionWithTimeout(pageWith([null], kb), null, { type: "search", text: "x" }, 1000);
  assert.equal(res.ok, false);
  assert.match(res.error, /open the filter dropdown first/i);
  assert.deepEqual(kb.log, []);
});

test("a search selects all, types SLOWLY, waits, then presses Enter", async () => {
  // Order and pacing are both load-bearing. Control+a so a second search
  // REPLACES the previous term rather than appending ("American" + "Horror" ->
  // "AmericanHorror"). The 250ms/char delay and the 1500ms wait ARE the feature:
  // at 40ms/char with Enter pressed immediately this succeeds 2 times in 8;
  // paced like this, 7 times in 8. Three different key-delivery mechanisms all
  // sat at 25%, so it is wall-clock pacing that matters, not the event type.
  const kb = spyKeyboard();
  const page = pageWith([{ tag: "textarea", cls: "QueryBox", value: "American" }], kb);
  const res = await executeActionWithTimeout(
    page, null, { type: "search", text: "American" }, 30000, { typeDelayMs: 250, syncMs: 1500 },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(kb.log, ["Control+a", "type:American:delay=250", "wait:1500", "Enter"]);
});

test("search pacing falls back to the measured defaults when opts are absent", async () => {
  // A caller that forgets to pass pacing must not silently get the 25% path.
  const kb = spyKeyboard();
  const page = pageWith([{ tag: "textarea", cls: "QueryBox", value: "x" }], kb);
  await executeActionWithTimeout(page, null, { type: "search", text: "x" }, 30000);
  assert.deepEqual(kb.log, ["Control+a", "type:x:delay=250", "wait:1500", "Enter"]);
});

test("describeAction labels a search with its text", () => {
  assert.equal(describeAction({ type: "search", text: "American Horror Story" }, null),
               'Search: "American Horror Story"');
});
