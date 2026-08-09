import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/vlmClient.js";

const { buildPrompt } = _internal;

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

// ---- discoveries memory (Task 4) -------------------------------------------

const INV = {
  activeSheet: "Dash",
  sheets: [{ id: "S1", name: "Dash", type: "dashboard", active: true }],
  filters: [],
  parameters: [],
};

const BASE = { question: "Which is highest?", inventory: INV, history: [], mode: "pixel" };

test("the discoveries block is omitted entirely when there are none", () => {
  const { userText } = buildPrompt({ ...BASE, discoveries: "" });
  assert.ok(!userText.includes("CONFIRMED DISCOVERIES"));
});

test("the discoveries block is rendered verbatim when present", () => {
  const block = "CONFIRMED DISCOVERIES (x):\n[T1#3] House avg beds = 3.3";
  const { userText } = buildPrompt({ ...BASE, discoveries: block });
  assert.ok(userText.includes("[T1#3] House avg beds = 3.3"));
});

test("discoveries sit after HISTORY and before FEEDBACK", () => {
  const { userText } = buildPrompt({
    ...BASE,
    discoveries: "CONFIRMED DISCOVERIES (x):\n[#1] a = 1",
    correctiveFeedback: "Try again.",
  });
  const h = userText.indexOf("HISTORY:");
  const d = userText.indexOf("CONFIRMED DISCOVERIES");
  const f = userText.indexOf("FEEDBACK ON YOUR LAST RESPONSE:");
  assert.ok(h < d, "HISTORY must come before CONFIRMED DISCOVERIES");
  assert.ok(d < f, "CONFIRMED DISCOVERIES must come before FEEDBACK");
});

test("both system templates document the discovery field", () => {
  for (const mode of ["pixel", "api"]) {
    const { systemText } = buildPrompt({ ...BASE, mode, discoveries: "" });
    assert.ok(systemText.includes('"discovery"'), `${mode} template must document the field`);
    assert.ok(systemText.includes("RECORDING DISCOVERIES"), `${mode} template must carry the rules block`);
    assert.ok(
      systemText.includes("CONFIRMED DISCOVERIES"),
      `${mode} template must tell the model where the facts come back`,
    );
  }
});

test("REGRESSION: both templates tell the model discoveries can complete an answer", () => {
  // Without this the model holding four remembered numbers still will not
  // answer, because the old rule 3 told it to wait for ONE screenshot to show
  // everything - which for a comparison question never happens.
  for (const mode of ["pixel", "api"]) {
    const { systemText } = buildPrompt({ ...BASE, mode, discoveries: "" });
    assert.ok(
      /CONFIRMED DISCOVERIES plus the/.test(systemText),
      `${mode} template must amend the answer-early rule`,
    );
  }
});
