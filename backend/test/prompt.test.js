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

// ---- scroll (pixel mode only) ----------------------------------------------

test("pixel mode prompt offers the scroll action", () => {
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/"type":"scroll"/.test(systemText));
  assert.ok(/direction/.test(systemText));
});

test("api mode prompt never mentions scrolling", () => {
  // The api arm is the comparison arm for the two grounding strategies; its
  // prompt must not drift, or the comparison stops meaning anything.
  const { systemText } = buildPrompt({ ...BASE, mode: "api", discoveries: "" });
  assert.ok(!/"type":"scroll"/.test(systemText));
  assert.ok(!/scroll/i.test(systemText));
});

test("the pixel prompt warns that scrolling loses what is on screen", () => {
  // Without this the model scrolls away the value it needed: the prompt carries
  // only the CURRENT frame, so a discovery is the only thing that survives.
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/SAME turn that you scroll/.test(systemText));
});

test("REGRESSION: the pixel prompt teaches scrolling UP, not just down", () => {
  // World Government Summit dashboard, 2026-08-10: the countries dropdown opens
  // scrolled to the current selection (Russia), so Brazil/China/India were ABOVE
  // the visible window. The agent scrolled DOWN twice, away from all three, and
  // every country click was then correctly rejected as not-on-screen. The prompt
  // only ever demonstrated "down" and rule 7 described only bottom-edge clipping.
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(/"direction":"up"/.test(systemText), "an explicit up example must be shown");
  assert.ok(
    /above|earlier in the list|alphabetically/i.test(systemText),
    "the prompt must say content can sit ABOVE the visible window",
  );
});

test("REGRESSION: the pixel prompt forbids answering from remembered knowledge", () => {
  // The same session recorded plausible real-world figures for three countries
  // it never selected, then answered from them. Grounding has to be stated.
  const { systemText } = buildPrompt({ ...BASE, mode: "pixel", discoveries: "" });
  assert.ok(
    /never (state|report|give|use) a (number|value|figure)[^.]*not[^.]*(seen|visible)/i.test(systemText),
    "the prompt must forbid stating unseen values",
  );
});

test("a scroll renders in the history with its direction and outcome", () => {
  const line = _internal.formatHistoryLine({
    idx: 3, type: "scroll", direction: "down", nx: 0.83, ny: 0.49, status: "ok", changed: true,
  });
  assert.equal(line, "#3 scroll down (0.83,0.49) -> changed");
});

test("a scroll that moved nothing says so, rather than reporting ok", () => {
  const line = _internal.formatHistoryLine({
    idx: 4, type: "scroll", direction: "down", nx: 0.83, ny: 0.49, status: "ok", changed: false,
  });
  assert.equal(line, "#4 scroll down (0.83,0.49) -> no change");
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
