// Beat-sequencer pacing constants (FRONTEND_PLAN.md §6.6). Do not tweak -
// these are the plan's locked timings, reused verbatim by HeroReplay
// (Phase F2, OUTCOME_DWELL_MS only) and the replay beat sequencer here.

export const TYPEWRITER_MS_PER_CHAR = 24;
export const CROSSFADE_MS = 400;
export const FRAME_DWELL_MS = 1200;
export const ACTION_PENDING_DWELL_MS = 900;
export const POST_RESOLVE_PAUSE_MS = 600;
export const OUTCOME_DWELL_MS = 3000;
