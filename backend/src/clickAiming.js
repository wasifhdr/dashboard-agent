// Where a pixel-mode click actually lands: the policy that turns the model's
// proposed click into a point on the frame, or into a rejection.
//
// REFINE first, LOCATE as the fallback, and nothing may veto.
//
// The two passes are not interchangeable, and the difference is reach:
//
//   refine crops 22% of the frame around a given point and upscales it ~2.4x. It
//   is a LOCAL corrector - reach about +/-11% of the frame - and magnification is
//   what makes it precise.
//   locate searches the WHOLE frame and returns the element's centre. It is a
//   GLOBAL finder, and it is the only thing that can fix a coordinate the model
//   cannot produce at all.
//
// Why refine leads. Measured on the "How old are recent newlyweds" dashboard,
// asked for "the 'Advanced degree' option": locate returned ny=0.398, refine
// returned ny=0.425. Rows there are 23px apart - 2.8% of frame height - with
// Advanced degree at 0.429 and Bachelor's at 0.400. locate was exactly one row
// high, which in a real run meant selecting Bachelor's degree five times and
// exhausting the step budget. refine sees those rows 57px apart and picks right.
// Leading with it also makes the common case ONE verification call.
//
// Why locate stays. On the same dashboard refine returned NOT FOUND for the
// "Region dropdown": a 422px-wide crop centred on a 625px-wide combobox excludes
// the label at its left edge, leaving an unidentifiable grey bar. locate found it
// on 4/4 phrasings. And for the documented (0.68,0.46)-for-a-(0.07,0.04)-control
// case, refine physically cannot reach the target.
//
// Why nothing vetoes. refine's not-found says only "not within 11% of that
// point", so it must ESCALATE, never reject. Treating it as a refutation - and
// then caching the refusal - is what previously turned a single bad verdict into
// a run that could only be stopped by the user.
//
// Cost: 1 verification call when the aim is roughly right, 2 when it is not,
// versus up to 3 under the old policy. That matters on a tier where roughly eight
// steps exhausts the per-minute allowance.
//
// This module stays IO-free by injection: `locate` and `refine` are passed in, so
// the policy is unit-testable without a network or a model. Both follow the
// vlmClient contract - {nx,ny} | {notFound:true} | null, where null means the call
// itself failed and is NOT a verdict about the target.

// Returns one of:
//   {nx, ny, source}  - click here. `source` records which pass produced the
//                       point, for logging and for tests: "aim+refined",
//                       "located", or "aim".
//   {rejected: true, searched: true} - do not click. Both passes declined, so the
//                       element is not on this frame. This is the one case where
//                       refusing is right: firing at a point where the named
//                       target demonstrably is not hits whatever else is there,
//                       which changes the dashboard and therefore reads as a
//                       SUCCESS to the pixel-diff guard - a wrong answer rather
//                       than a wasted step.
//
//                       The caller must NOT cache this. Caching a rejection is
//                       what turned one bad verdict into a dead run, and the frame
//                       changes from one step to the next.
export async function resolveClickPoint({ aim, target, locate, refine }) {
  // Nothing to search for, so nothing to spend a call on.
  if (!target) return { nx: aim.nx, ny: aim.ny, source: "aim" };

  // 1. The cheap, precise pass: magnify around the aim and snap onto the target.
  const refined = await refine(aim.nx, aim.ny);
  if (refined && !refined.notFound) {
    return { nx: refined.nx, ny: refined.ny, source: "aim+refined" };
  }

  // 2. refined.notFound means only "not within ~11% of the aim"; refined === null
  //    means the call died. Neither says anything about the rest of the frame, so
  //    both ESCALATE to the global search rather than rejecting.
  const located = await locate();
  if (located && !located.notFound) {
    return { nx: located.nx, ny: located.ny, source: "located" };
  }

  // 3. A whole-frame search that came back empty is a real verdict about absence.
  if (located?.notFound) return { rejected: true, searched: true };

  // 4. located === null: the call died and says nothing. Degrade to the model's
  //    own aim rather than letting an outage stop the agent from acting.
  return { nx: aim.nx, ny: aim.ny, source: "aim" };
}
