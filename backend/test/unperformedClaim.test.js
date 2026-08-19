import test from "node:test";
import assert from "node:assert/strict";

import { claimsUnperformedAction } from "../src/discoveries.js";

// The executed history of session 07d5fcc0 up to its final step: a Type
// dropdown click, a 'TV Show' row click, a Title dropdown click, a search for
// "13 Reasons Why", and a click on its row. Nothing here touches American
// Horror Story.
const REAL_HISTORY = [
  { idx: 1, type: "click", status: "ok", target: "the Type dropdown" },
  { idx: 2, type: "click", status: "ok", target: "the 'TV Show' row in the open Type list" },
  { idx: 3, type: "search", status: "error", text: "13 reasons why" },
  { idx: 4, type: "click", status: "ok", target: "the Title filter dropdown" },
  { idx: 5, type: "search", status: "ok", text: "13 Reasons Why" },
  { idx: 6, type: "click", status: "ok", target: "the '13 Reasons Why' row in the Title dropdown" },
  { idx: 7, type: "click", status: "ok", target: "Title filter dropdown" },
];

test("REGRESSION: the fabricated search of session 07d5fcc0 is caught", () => {
  // The model asserted this at step 8 and answered with confidence 1.0. No
  // search for American Horror Story exists anywhere in the run.
  const claim = claimsUnperformedAction(
    "I searched for American Horror Story in the title filter and read its duration as 9 Seasons.",
    REAL_HISTORY,
  );
  assert.ok(claim, "expected the unperformed search to be reported");
  assert.equal(claim.verb, "searched");
  assert.match(claim.object, /American Horror Story/i);
});

test("a search the agent really ran is not reported", () => {
  assert.equal(
    claimsUnperformedAction("I searched for 13 Reasons Why and its duration is 3 Seasons.", REAL_HISTORY),
    null,
  );
});

test("a click is backed by the target text of an executed click", () => {
  assert.equal(
    claimsUnperformedAction("I clicked the Type dropdown and the list opened.", REAL_HISTORY),
    null,
  );
});

test("stating an INTENTION is never a claim of having acted", () => {
  // Every one of these appears in real trajectories. Firing on them would
  // reject the step that is about to do the right thing.
  const intents = [
    "I will search for American Horror Story next.",
    "I need to click American Horror Story in the Title list.",
    "Let's search for American Horror Story.",
    "I am searching for American Horror Story.",
    "Now let's check American Horror Story.",
    "I should select American Horror Story from the dropdown.",
  ];
  for (const t of intents) {
    assert.equal(claimsUnperformedAction(t, REAL_HISTORY), null, `fired on: ${t}`);
  }
});

test("a thought with no first-person action verb is not a claim", () => {
  assert.equal(
    claimsUnperformedAction("The Title filter dropdown is open. American Horror Story is a TV show.", REAL_HISTORY),
    null,
  );
});

test("a claim naming nothing distinctive cannot be checked, so it passes", () => {
  // "the row in the dropdown" is all positional vocabulary - there is no
  // identity to look for, and guessing would reject a legitimate step.
  assert.equal(claimsUnperformedAction("I clicked the row in the dropdown.", REAL_HISTORY), null);
});

test("an action that ERRORED is not evidence that it happened", () => {
  const history = [{ idx: 3, type: "search", status: "error", text: "American Horror Story" }];
  const claim = claimsUnperformedAction("I searched for American Horror Story.", history);
  assert.ok(claim, "an errored search must not vouch for the claim");
});

test("a rejected click is not evidence that it happened", () => {
  const history = [{ idx: 3, type: "click", status: "rejected_target", target: "the American Horror Story row" }];
  assert.ok(claimsUnperformedAction("I clicked the American Horror Story row.", history));
});

test("a plural/singular difference still counts as evidence", () => {
  // The model paraphrases its own actions constantly. "TV Shows" against a
  // recorded "TV Show" must not read as a different thing.
  assert.equal(
    claimsUnperformedAction("I clicked the TV Shows row.", REAL_HISTORY),
    null,
  );
});

test("partial evidence is enough - the guard only fires on NO trace at all", () => {
  // Deliberately reluctant: a false positive rejects a correct answer, which
  // is worse than missing a fabrication that a later guard can still catch.
  assert.equal(
    claimsUnperformedAction("I clicked the '13 Reasons Why' row in the Title dropdown.", REAL_HISTORY),
    null,
  );
});

test("empty and malformed inputs are not claims", () => {
  assert.equal(claimsUnperformedAction("", REAL_HISTORY), null);
  assert.equal(claimsUnperformedAction(null, REAL_HISTORY), null);
  assert.equal(claimsUnperformedAction("I searched for American Horror Story.", null), null);
});

test("with an empty history, any identified action claim is unperformed", () => {
  const claim = claimsUnperformedAction("I clicked the Electronic Arts bar.", []);
  assert.ok(claim);
  assert.equal(claim.verb, "clicked");
});

// --- false positives found by replaying 493 recorded sessions --------------
// Each of these is a real thought from data/agent.sqlite that the first draft
// rejected. All three are honest steps; none is a fabrication.

test("REGRESSION (14c45bc5 #7): narrating THIS step's own action in past tense", () => {
  // The model routinely writes "I clicked X" in the same breath as emitting the
  // click on X. The tense is sloppy, the action is correct, and rejecting it
  // throws away a good step. The action under consideration is evidence for
  // itself.
  const history = [
    { idx: 1, type: "click", status: "ok", target: "Select Country dropdown" },
    { idx: 6, type: "scroll", status: "ok", direction: "up", target: "the open country dropdown list" },
  ];
  const action = { type: "click", nx: 0.099, ny: 0.262, target: "India in the country list" };
  assert.equal(
    claimsUnperformedAction(
      "I clicked India in the open country dropdown list. Now I can read India's unemployment.",
      history,
      action,
    ),
    null,
  );
});

test("REGRESSION (3635d6b5 #3): a scroll's DIRECTION is part of what it did", () => {
  // "I scrolled down" names the direction, not a target, so the recorded
  // direction has to count as evidence or every truthful scroll claim fires.
  const history = [
    { idx: 1, type: "scroll", status: "ok", direction: "down", target: "the Percent Remote Roles chart" },
    { idx: 2, type: "scroll", status: "ok", direction: "down", target: "Percent Remote Roles chart" },
  ];
  const claim = claimsUnperformedAction(
    "I scrolled down to Remote Ratio 100 in the pie chart.",
    history,
    { type: "answer", answer: "M", confidence: 1 },
  );
  assert.equal(claim, null);
});

test("REGRESSION (adeb4734 #4): an untargeted click makes absence unprovable", () => {
  // `target` is optional in the schema, and the model does omit it. A click
  // with no target could have hit anything, so a run containing one cannot
  // support "there is no trace of X" - the guard must abstain rather than
  // accuse an agent that really did select House at an earlier step.
  const history = [
    { idx: 1, type: "click", status: "ok", target: "Property Type dropdown" },
    { idx: 2, type: "click", status: "ok" }, // no target - this is the House click
    { idx: 3, type: "click", status: "ok", target: "Property Type dropdown" },
  ];
  assert.equal(
    claimsUnperformedAction(
      "I have selected 'House' from the Property Type dropdown. Now I need to record the average beds.",
      history,
      { type: "click", nx: 0.232, ny: 0.655 },
    ),
    null,
  );
});

test("the AHS fabrication survives all three exemptions", () => {
  // The answer action carries no target or text of its own, every executed step
  // is identified, and no scroll direction is involved - so nothing above
  // rescues it. This is the case the guard exists for.
  const claim = claimsUnperformedAction(
    "I searched for American Horror Story in the title filter and read its duration as 9 Seasons.",
    REAL_HISTORY,
    { type: "answer", answer: "…", confidence: 1 },
  );
  assert.ok(claim);
  assert.equal(claim.verb, "searched");
});
