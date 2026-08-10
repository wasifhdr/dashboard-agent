// The locate-first click policy. The case that motivated it, from real traces:
// the model names "the Type dropdown" correctly and emits (0.68,0.46) for a
// control at (0.07,0.04), so anchoring the zoom check to that aim can never
// find it - the answer has to come from a whole-frame search instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClickPoint } from "../src/clickAiming.js";

const AIM = { nx: 0.68, ny: 0.46 }; // the model's habitual wrong guess
const TRUTH = { nx: 0.07, ny: 0.04 }; // where the Type dropdown actually is

// Records the order and arguments of the injected passes, so a test can assert
// not just the result but that the aim was never used as an anchor.
function spy(impl) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

test("locate anchors the click; the model's wrong aim is never refined against", async () => {
  const locate = spy(async () => ({ ...TRUTH }));
  // Stands in for the zoom pass nudging a roughly-right point onto the control.
  const refine = spy(async () => ({ nx: 0.0692, ny: 0.0429 }));

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: 0.0692, ny: 0.0429, source: "located+refined" });
  // The whole point: the zoom crop is centred on the LOCATED point, not the aim.
  assert.deepEqual(refine.calls, [[TRUTH.nx, TRUTH.ny]]);
});

test("no target name degrades to the original aim-anchored path, with no locate call", async () => {
  const locate = spy(async () => ({ ...TRUTH }));
  const refine = spy(async (nx, ny) => ({ nx, ny }));

  const out = await resolveClickPoint({ aim: AIM, target: null, locate, refine });

  assert.equal(out.source, "aim+refined");
  assert.equal(locate.calls.length, 0, "nothing to search for - do not spend a call");
  assert.deepEqual(refine.calls, [[AIM.nx, AIM.ny]]);
});

test("locate and refine disagreeing falls back to the aim rather than trusting either", async () => {
  // Guards against locate becoming a new single point of failure: if it places
  // the element somewhere the zoom pass says it isn't, one of them is wrong and
  // there is no way to tell which.
  const locate = spy(async () => ({ nx: 0.9, ny: 0.9 }));
  const refine = spy(async (nx, ny) => (nx === 0.9 ? { notFound: true } : { nx: 0.5, ny: 0.5 }));

  const out = await resolveClickPoint({ aim: AIM, target: "a bar", locate, refine });

  assert.deepEqual(out, { nx: 0.5, ny: 0.5, source: "aim+refined" });
  assert.deepEqual(refine.calls, [[0.9, 0.9], [AIM.nx, AIM.ny]]);
});

test("a failed zoom call does not discard locate's answer", async () => {
  // null is a dead call, not a verdict - locate's point is still a real answer
  // and is better than the aim it replaced.
  const locate = async () => ({ ...TRUTH });
  const refine = async () => null;

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: TRUTH.nx, ny: TRUTH.ny, source: "located" });
});

test("locate missing the element still gives the model's aim its chance", async () => {
  // One locate miss must not be unrecoverable: the aim is occasionally right.
  const locate = async () => ({ notFound: true });
  const refine = spy(async () => ({ nx: 0.3, ny: 0.3 }));

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: 0.3, ny: 0.3, source: "aim+refined" });
  assert.deepEqual(refine.calls, [[AIM.nx, AIM.ny]]);
});

test("not found by either pass rejects, and says the search happened", async () => {
  const locate = async () => ({ notFound: true });
  const refine = async () => ({ notFound: true });

  const out = await resolveClickPoint({ aim: AIM, target: "the '100' option", locate, refine });

  // `searched` is what lets the caller say "not on screen at all" instead of
  // "your aim was wrong" - a different, and here more accurate, complaint.
  assert.deepEqual(out, { rejected: true, searched: true });
});

test("a rejection after a locate OUTAGE does not claim the screen was searched", async () => {
  const locate = async () => null; // the call died; it is not a verdict
  const refine = async () => ({ notFound: true });

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { rejected: true, searched: false });
});

test("both passes failing as calls still clicks - an outage must never block the agent", async () => {
  // The long-standing rule: degrade to single-pass aiming, do not stop acting.
  const locate = async () => null;
  const refine = async () => null;

  const out = await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.deepEqual(out, { nx: AIM.nx, ny: AIM.ny, source: "aim" });
});

test("the happy path costs exactly two calls", async () => {
  // The cost this restructure trades for reliability: a click that would have
  // worked first time now takes locate + refine instead of refine alone.
  const locate = spy(async () => ({ ...TRUTH }));
  const refine = spy(async (nx, ny) => ({ nx, ny }));

  await resolveClickPoint({ aim: AIM, target: "the Type dropdown", locate, refine });

  assert.equal(locate.calls.length + refine.calls.length, 2);
});
