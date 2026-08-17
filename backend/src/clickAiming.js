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
// DO NOT "fix" corner controls by swapping the order to locate-then-refine. It was
// built, measured and reverted on 2026-08-17. The premise - that locate is a
// reliable global finder and only its row precision is weak - is false: on a
// Netflix run where the model named "the Type dropdown" (a control at
// (0.069,0.044)), locate resolved 9 of 11 aims to ~(0.69,0.43), the same
// centre-biased number the main loop produces, because it is the same model. Twice
// it OVERWROTE an aim the model had got half right - (0.810,0.050), correct row,
// and (0.081,0.440), correct column - by dragging both to mid-frame. The reorder
// scored 9/10 on the eval, identical to this order, while costing a third call on
// every click; the Netflix task took 12 steps against 8. Ordering only decides
// which unreliable pass is consulted first.
//
// The underlying regression is the model, not this policy. Under the local Qwen
// 4B (retired 2026-08-01, before locate and refine existed) the model emitted
// (0.080,0.040) for that same dropdown directly and repeatably: 44.6% of its
// Netflix clicks landed in the corner region against 18.0% for gemini-flash-lite,
// and 24.0% vs 4.8% across all dashboards. Every pass in this file is scaffolding
// around that gap. Fix the coordinate generation - grid-anchoring, or a stronger
// model on the aiming calls only - rather than re-permuting the passes.
//
// This module stays IO-free by injection: `locate` and `refine` are passed in, so
// the policy is unit-testable without a network or a model. Both follow the
// vlmClient contract - {nx,ny} | {notFound:true} | null, where null means the call
// itself failed and is NOT a verdict about the target.

// The click right after a search must NOT be re-aimed, and this is the one
// exemption in the file.
//
// After a search the box DISPLAYS the query text, so when the model is then
// asked to click "the '13 Reasons Why' row", the box matches that text exactly
// as well as the row does - and sits ~0.024 of frame height above it (box centre
// ny~0.133, first row ny~0.158 on Netflix). refine's evidence gate asks for the
// matched text quoted back, which the box satisfies perfectly, so the gate that
// exists to stop a bluff is what picks the wrong element. Measured on three real
// failing frames (sessions a59ab91d, f0916ea0, 668f494d, 2026-08-17): the
// model's own aim was CORRECT every time (ny~0.158) and refine dragged it onto
// the box on 12 of 15 calls.
//
// The one production run that answered correctly is the one where the model
// happened to omit `target`, so resolveClickPoint returned the raw aim
// untouched. This takes that same path deliberately instead of by luck.
//
// A prompt fix was tried first and REVERTED (d5eee42): telling refine that a box
// showing the text is not the target scored 15/15 on post-search frames, but the
// wording pushed it off ordinary comboboxes onto their labels, because a
// combobox is also "a box showing text". Do not reintroduce a global prompt rule
// for a problem that only exists in one transient state.
//
// Keyed on OUR OWN history, never on the model's say-so or a DOM read: a step we
// recorded as an executed search is a fact, not a judgement.
//
// NARROW ON PURPOSE - it also requires that the click NAMES the text just
// searched for. The first build of this exempted every click after a search, and
// session 977a3e8d showed why that is wrong: with the list showing "No matches",
// the model targeted "the Type dropdown" and aimed at (0.54,0.148) for a control
// at (0.069,0.043). Unaimed, that wild coordinate went straight through, and
// locate - which would have rescued it - never ran. What the measurements
// actually support is narrower than "the aim is good after a search": the aim is
// good when the model is clicking a ROW IN THE LIST IT JUST FILTERED. Every
// observed good aim named the searched title ("the '13 Reasons Why' row in the
// open Title list"); the bad one named something else entirely.
//
// A model that names the row without quoting the text ("the first row") loses the
// exemption and gets refine's decoy back - one wasted step, versus an unaimed
// click anywhere on the dashboard. That is the right way round to fail.
export function isPostSearchClick(history, target) {
  const named = typeof target === "string" ? target.toLowerCase() : "";
  if (!named) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    // Steps that never executed cannot have changed what is on screen, so they
    // do not end the post-search state - skip past them. Same for a wait.
    if (h.type === "wait") continue;
    if (h.status !== "ok") continue;
    // Includes a search that did NOT filter (changed:false). Enter may have been
    // swallowed, but the text is sitting in the box either way, so the decoy is
    // on screen regardless. An ERRORED search is excluded by the status check
    // above: the focus guard rejected it before a single keystroke was sent.
    if (h.type !== "search") return false;
    const searched = typeof h.text === "string" ? h.text.trim().toLowerCase() : "";
    return searched.length > 0 && named.includes(searched);
  }
  return false;
}

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
