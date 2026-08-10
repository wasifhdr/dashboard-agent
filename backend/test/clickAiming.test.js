// The locate-only click policy.
//
// Two real traces shape this. The first is why locate exists at all: the model
// names "the Type dropdown" correctly and emits (0.68,0.46) for a control at
// (0.07,0.04), so anchoring anything to that aim can never find it - the answer
// has to come from a whole-frame search.
//
// The second is why the zoom-refine pass is no longer in this path. On the
// "How old are recent newlyweds" dashboard the model aimed at (0.18,0.198) for a
// Region combobox whose true centre is (0.169,0.200) - accurate to ~2% - and was
// rejected four times running. locate found the control on 4/4 phrasings; refine
// denied it, because a 22%-wide crop centred on a 625px-wide control excludes the
// label at its left edge and so shows an unidentifiable grey bar. The pass with
// LESS evidence held the veto, and the rejection was then cached, making a
// correct reading permanently unusable. See docs + CLAUDE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClickPoint } from "../src/clickAiming.js";

const AIM = { nx: 0.68, ny: 0.46 }; // the model's habitual wrong guess
const TRUTH = { nx: 0.07, ny: 0.04 }; // where the Type dropdown actually is

function spy(impl) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

test("locate supplies the click point, replacing the model's aim", async () => {
  const locate = spy(async () => ({ ...TRUTH }));

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate });

  assert.deepEqual(out, { nx: TRUTH.nx, ny: TRUTH.ny, source: "located" });
  assert.equal(locate.calls.length, 1);
});

test("the happy path costs exactly ONE verification call", async () => {
  // The point of the restructure: a click step was up to 4 VLM calls
  // (main + locate + refine + refine again). It is now main + locate.
  const locate = spy(async () => ({ ...TRUTH }));

  await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate });

  assert.equal(locate.calls.length, 1);
});

test("no target name spends no call at all and clicks the aim", async () => {
  const locate = spy(async () => ({ ...TRUTH }));

  const out = await resolveClickPoint({ aim: AIM, target: null, locate });

  assert.deepEqual(out, { nx: AIM.nx, ny: AIM.ny, source: "aim" });
  assert.equal(locate.calls.length, 0, "nothing to search for - do not spend a call");
});

test("a locate OUTAGE never blocks the agent - it clicks the aim", async () => {
  // null is a dead call, not a verdict. The long-standing rule: degrade to the
  // model's own aim rather than stopping the agent from acting.
  const locate = async () => null;

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate });

  assert.deepEqual(out, { nx: AIM.nx, ny: AIM.ny, source: "aim" });
});

test("locate reporting the element absent rejects, and says the search happened", async () => {
  // A whole-frame search that comes back empty is a real verdict, and the one
  // case where NOT clicking is right: firing at a point where the named target
  // demonstrably is not selects whatever else is there, which changes the
  // dashboard and reads as success. `searched` lets the caller say "not on
  // screen - scroll to it" instead of "your aim was wrong".
  const locate = async () => ({ notFound: true });

  const out = await resolveClickPoint({ aim: AIM, target: "the '100' option", locate });

  assert.deepEqual(out, { rejected: true, searched: true });
});

test("REGRESSION: an accurate aim is never rejected on a wide control", async () => {
  // The newlyweds Region combobox. Under the old policy refine's notFound vetoed
  // locate's correct answer and the aim was cached as proven-wrong, deadlocking
  // the run. With refine out of the path there is no veto to apply.
  const locate = spy(async () => ({ nx: 0.178, ny: 0.192 }));

  const out = await resolveClickPoint({ aim: { nx: 0.18, ny: 0.198 }, target: "Region dropdown", locate });

  assert.equal(out.rejected, undefined, "a located control must never be rejected");
  assert.deepEqual(out, { nx: 0.178, ny: 0.192, source: "located" });
});

test("refine is not consulted, even when one is passed in", async () => {
  // refineClickPoint is retained in vlmClient for a possible precision pass
  // later, but it must not re-enter this policy by accident.
  const locate = spy(async () => ({ ...TRUTH }));
  const refine = spy(async (nx, ny) => ({ nx, ny }));

  await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.equal(refine.calls.length, 0);
});
