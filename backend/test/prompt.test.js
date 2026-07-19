import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const inventory = { sheets: [], filters: [], parameters: [] };

test("api mode prompt does not mention clicking", () => {
  const { systemText } = _internal.buildPrompt({ question: "q", inventory, history: [], mode: "api" });
  assert.ok(/set_filter/.test(systemText));
  assert.ok(!/"type":"click"/.test(systemText));
});

test("pixel mode prompt instructs coordinate clicks", () => {
  const { systemText } = _internal.buildPrompt({ question: "q", inventory, history: [], mode: "pixel" });
  assert.ok(/"type":"click"/.test(systemText));
  assert.ok(/nx/.test(systemText) && /ny/.test(systemText));
});
