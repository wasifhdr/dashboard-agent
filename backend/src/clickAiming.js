// Where a pixel-mode click actually lands: the policy that turns the model's
// proposed click into a point on the frame, or into a rejection.
//
// LOCATE FIRST, then refine. The model's nx/ny is a HINT, not the anchor.
//
// Why: the model reads the screenshot correctly and cannot express it in
// coordinates. Across every trace of one dashboard it named "the Type dropdown"
// in its thought while emitting (0.67,0.42), (0.74,0.42), (0.68,0.46) - for a
// control that sits at (0.07,0.04), i.e. the far corner of the same image.
// Anchoring the zoom check to that aim meant the check could only ever confirm
// or deny a guess, never supply the answer: a 22%-wide crop centred on a point
// 60% of the frame away cannot contain the target, so the best available
// outcome was a correct rejection that cost a call and taught nothing.
//
// Worse, the check is not consistent. The same (0.68,0.46) was rejected eight
// times in one session and APPROVED in the next, letting a blind click through.
// A gate that unreliable cannot be what stands between the agent and actuation.
//
// So the target's NAME becomes the anchor. locate() searches the whole frame
// for it; refine() then does what it has always been good at - turning a
// roughly-right point into a precise one, which small controls need (an open
// dropdown's rows are ~2.6% of frame height).
//
// Cost: a click that would have succeeded first time now takes two calls
// instead of one. A click that would have failed takes two instead of two AND
// a wasted step - plus a settle cycle, and whatever the stray click did to the
// dashboard. Read-only steps are untouched; they never enter this path.
//
// This module is IO-free by injection: `locate` and `refine` are passed in, so
// the policy is unit-testable without a network or a model. Both follow the
// vlmClient contract - {nx,ny} | {notFound:true} | null, where null means the
// call itself failed and is NOT a verdict about the target.

// Returns one of:
//   {nx, ny, source}  - click here. `source` records which pass produced the
//                       point, for logging and for tests: "located+refined",
//                       "located", "aim+refined", or "aim".
//   {rejected: true, searched} - do not click. `searched` is true when the
//                       whole-frame locate ran and reported the element absent,
//                       which is the difference between "your aim was wrong"
//                       and "this element is not on screen".
export async function resolveClickPoint({ aim, target, locate, refine }) {
  // No name to search for - there is nothing to locate, so this degrades to the
  // original behavior: verify the aim, reject if the target isn't there.
  if (!target) return refineAroundAim(aim, target, refine);

  const located = await locate();

  if (located && !located.notFound) {
    const refined = await refine(located.nx, located.ny);
    if (refined && !refined.notFound) {
      return { nx: refined.nx, ny: refined.ny, source: "located+refined" };
    }
    if (refined?.notFound) {
      // The two passes disagree: locate put the element here, the zoom says it
      // isn't. One of them is wrong and there is no way to tell which, so fall
      // back to the model's own aim rather than trusting either blindly. This
      // is the cross-check that stops locate from becoming a new single point
      // of failure.
      return refineAroundAim(aim, target, refine, { searched: true });
    }
    // refined === null: the zoom call failed, so it is not a verdict. locate's
    // point is a real answer and is better than the aim it replaced.
    return { nx: located.nx, ny: located.ny, source: "located" };
  }

  // located.notFound - the element is genuinely not visible anywhere, OR the
  // locate pass missed it. Give the model's aim its chance before rejecting;
  // it is occasionally right, and rejecting on locate alone would make a single
  // miss unrecoverable.
  // located === null - the call failed and says nothing. Same fallback.
  return refineAroundAim(aim, target, refine, { searched: !!located?.notFound });
}

// The original path, kept intact as the fallback: verify the model's aim with a
// crop around it, reject if the target isn't there.
async function refineAroundAim(aim, target, refine, { searched = false } = {}) {
  const refined = await refine(aim.nx, aim.ny);
  if (refined && !refined.notFound) {
    return { nx: refined.nx, ny: refined.ny, source: "aim+refined" };
  }
  if (refined?.notFound) return { rejected: true, searched };
  // Both passes failed as CALLS, neither returning a verdict. Preserve the
  // long-standing rule that a refinement outage never blocks clicking: degrade
  // to single-pass aiming rather than stopping the agent from acting.
  return { nx: aim.nx, ny: aim.ny, source: "aim" };
}
