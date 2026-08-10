// The refine-first click policy, with locate as the fallback.
//
// Three real traces shape this, all measured on committed frames:
//
// 1. Why refine leads. On the "How old are recent newlyweds" dashboard, asked for
//    "the 'Advanced degree' option", locate returned ny=0.398 and refine returned
//    ny=0.425. Rows there are 23px apart - 2.8% of frame height - and Advanced
//    degree sits at 0.429, Bachelor's at 0.400. locate was exactly one row high
//    every time, which showed up as the agent selecting Bachelor's degree five
//    times and hitting max_steps. refine sees the same rows at 2.4x magnification,
//    57px apart, and picks correctly.
//
// 2. Why locate stays as the fallback. On the same dashboard, asked for the
//    "Region dropdown", refine returned NOT FOUND: REFINE_WINDOW is 22% of the
//    frame, so a 422px crop centred on a 625px-wide combobox excludes the label at
//    its left edge and shows an unidentifiable grey bar. locate found it on 4/4
//    phrasings. refine's reach is only +/-11% of the frame; locate's is the whole
//    frame, so they are not interchangeable.
//
// 3. Why nothing may veto. The model named "the Type dropdown" while emitting
//    (0.68,0.46) for a control at (0.07,0.04). refine cannot reach that far, so its
//    not-found must ESCALATE to locate rather than reject - and a rejection must
//    never be cached, which is what previously turned one bad verdict into a run
//    that could only be stopped.
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

test("refine leads: a confirmed aim is used, and locate is never called", async () => {
  // Fixed values, not arithmetic on the aim: 0.68 + 0.01 is 0.6900000000000001,
  // and float noise in a fixture proves nothing about the policy.
  const refine = spy(async () => ({ nx: 0.69, ny: 0.48 }));
  const locate = spy(async () => ({ ...TRUTH }));

  const out = await resolveClickPoint({ aim: AIM, target: "a row", locate, refine });

  assert.deepEqual(out, { nx: 0.69, ny: 0.48, source: "aim+refined" });
  assert.deepEqual(refine.calls, [[AIM.nx, AIM.ny]], "the crop is centred on the model's aim");
  assert.equal(locate.calls.length, 0, "no need to search the whole frame");
});

test("the happy path costs exactly ONE verification call", async () => {
  const refine = spy(async (nx, ny) => ({ nx, ny }));
  const locate = spy(async () => ({ ...TRUTH }));

  await resolveClickPoint({ aim: AIM, target: "a row", locate, refine });

  assert.equal(refine.calls.length + locate.calls.length, 1);
});

test("no target name spends no call at all and clicks the aim", async () => {
  const refine = spy(async (nx, ny) => ({ nx, ny }));
  const locate = spy(async () => ({ ...TRUTH }));

  const out = await resolveClickPoint({ aim: AIM, target: null, locate, refine });

  assert.deepEqual(out, { nx: AIM.nx, ny: AIM.ny, source: "aim" });
  assert.equal(refine.calls.length + locate.calls.length, 0);
});

test("refine not finding it ESCALATES to locate rather than rejecting", async () => {
  // refine reaches only +/-11% of the frame, so its not-found says nothing about
  // the rest of the screen. This is the veto that used to deadlock runs.
  const refine = spy(async () => ({ notFound: true }));
  const locate = spy(async () => ({ ...TRUTH }));

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: TRUTH.nx, ny: TRUTH.ny, source: "located" });
  assert.equal(locate.calls.length, 1);
});

test("a refine OUTAGE also escalates - a dead call is not a verdict", async () => {
  const refine = async () => null;
  const locate = spy(async () => ({ ...TRUTH }));

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: TRUTH.nx, ny: TRUTH.ny, source: "located" });
  assert.equal(locate.calls.length, 1);
});

test("both passes declining rejects, and records that the frame was searched", async () => {
  const refine = async () => ({ notFound: true });
  const locate = async () => ({ notFound: true });

  const out = await resolveClickPoint({ aim: AIM, target: "the '100' option", locate, refine });

  assert.deepEqual(out, { rejected: true, searched: true });
});

test("a locate OUTAGE after refine declines still clicks - an outage must never block", async () => {
  // Neither pass returned a verdict about absence, so falling back to the model's
  // own aim is better than refusing to act.
  const refine = async () => ({ notFound: true });
  const locate = async () => null;

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: AIM.nx, ny: AIM.ny, source: "aim" });
});

test("REGRESSION: refine picks the right ROW where locate is one row high", async () => {
  // Measured on step_10 of the newlyweds run: locate 0.398 (Bachelor's degree),
  // refine 0.425 (Advanced degree), true row centre 0.429.
  const rowAim = { nx: 0.74, ny: 0.399 };
  const refine = spy(async () => ({ nx: 0.692, ny: 0.425 }));
  const locate = spy(async () => ({ nx: 0.732, ny: 0.398 }));

  const out = await resolveClickPoint({ aim: rowAim, target: "the 'Advanced degree' option", locate, refine });

  assert.equal(out.ny, 0.425, "refine's row must win - locate's is one row high");
  assert.equal(locate.calls.length, 0);
});

test("REGRESSION: a wide control refine cannot identify is still clicked, via locate", async () => {
  // The Region combobox: refine's crop excludes the label, locate finds it.
  // Neither may reject, and the correct aim must not be cached as wrong.
  const refine = spy(async () => ({ notFound: true }));
  const locate = spy(async () => ({ nx: 0.178, ny: 0.192 }));

  const out = await resolveClickPoint({ aim: { nx: 0.18, ny: 0.198 }, target: "Region dropdown", locate, refine });

  assert.equal(out.rejected, undefined);
  assert.deepEqual(out, { nx: 0.178, ny: 0.192, source: "located" });
});
