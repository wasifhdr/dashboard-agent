// Where a pixel-mode click actually lands: the policy that turns the model's
// proposed click into a point on the frame, or into a rejection.
//
// LOCATE, then click. One verification call, and no veto.
//
// Why locate at all: the model reads the screenshot correctly and cannot express
// it in coordinates. Across every trace of one dashboard it named "the Type
// dropdown" in its thought while emitting (0.68,0.46) - for a control that sits
// at (0.07,0.04), i.e. the far corner of the same image. locate is a narrow
// whole-frame "where is X?" that SUPPLIES the coordinate instead of judging one,
// which is the only thing that can fix a coordinate the model cannot produce.
//
// Why the zoom-refine pass is no longer here. It was a second opinion with a
// veto, and it is structurally blind to a whole class of control:
//
//   On the "How old are recent newlyweds" dashboard the model aimed at
//   (0.18,0.198) for a Region combobox whose true centre is (0.169,0.200) -
//   accurate to about 2%. locate found the control on 4 out of 4 phrasings.
//   refine denied it, four steps running, because REFINE_WINDOW is 22% of the
//   frame: a 422px-wide crop centred on a 625px-wide combobox excludes the
//   "Region" label and the "(All)" value text at its left edge, leaving an
//   unidentifiable grey bar. So the pass with LESS evidence overruled the pass
//   with more, the orchestrator cached the aim as proven-wrong, and a correct
//   reading became permanently unusable - the run could only end by being
//   stopped. That also explains the inconsistency this file used to record
//   ("rejected eight times in one session and APPROVED in the next"): it depends
//   on whether the identifying label happens to fall inside the crop.
//
// refineClickPoint is deliberately KEPT in vlmClient.js. Its real job - nudging a
// roughly-right point onto a thin target, since an open dropdown's rows are ~2.6%
// of frame height - is genuine, and locate alone may land a row off. If precision
// regresses, bring it back anchored on the LOCATED element and still without the
// power to reject.
//
// Cost: a click step is now main + locate = 2 model calls, down from up to 4
// (main + locate + refine + refine again on disagreement). That matters on a
// tier where roughly eight steps exhausts the per-minute allowance.
//
// This module stays IO-free by injection: `locate` is passed in, so the policy is
// unit-testable without a network or a model. It follows the vlmClient contract -
// {nx,ny} | {notFound:true} | null, where null means the call itself failed and
// is NOT a verdict about the target.

// Returns one of:
//   {nx, ny, source}  - click here. `source` records which pass produced the
//                       point, for logging and for tests: "located" or "aim".
//   {rejected: true, searched: true} - do not click. locate searched the whole
//                       frame and reported the element absent. This is the one
//                       case where refusing to click is right: firing at a point
//                       where the named target demonstrably is not hits whatever
//                       else is there, which changes the dashboard and therefore
//                       reads as a SUCCESS to the pixel-diff guard - a wrong
//                       answer rather than a wasted step.
//
//                       The caller must NOT cache this. Caching a rejection is
//                       what turned one bad verdict into a dead run; the target
//                       may simply be off screen, and a scroll can bring it in.
export async function resolveClickPoint({ aim, target, locate }) {
  // Nothing to search for, so nothing to spend a call on.
  if (!target) return { nx: aim.nx, ny: aim.ny, source: "aim" };

  const located = await locate();

  if (located && !located.notFound) {
    return { nx: located.nx, ny: located.ny, source: "located" };
  }

  // An explicit "not anywhere on this frame" is a real verdict; act on it.
  if (located?.notFound) return { rejected: true, searched: true };

  // located === null: the call died and says nothing. Degrade to the model's own
  // aim rather than letting a refine/locate outage stop the agent from acting.
  return { nx: aim.nx, ny: aim.ny, source: "aim" };
}
