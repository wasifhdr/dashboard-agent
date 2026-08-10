// Pure geometry helper for the pixel-mode dead-click guard (kept in its own
// dependency-free module so it can be unit-tested without importing the
// orchestrator's heavy deps). A "dead point" is the normalized location of a
// click that produced no visible change; a new click within `radius`
// (normalized Euclidean distance) of any dead point is rejected before it
// executes, so the agent can't burn its step budget hammering the same spot.
export function isNearDeadPoint(point, deadPoints, radius) {
  return deadPoints.some((d) => Math.hypot(d.nx - point.nx, d.ny - point.ny) <= radius);
}

// The dead-scroll variant. Direction is part of the identity: a pane scrolled to
// its end reports "no change" exactly like a pane with nothing scrollable in it
// (measured: both give 0 changed regions and a 0.0000% frame diff), so the point
// gets recorded as dead - but scrolling back UP must still be allowed, or the
// agent can never undo an over-scroll.
//
// Expect a LARGER radius than the click guard's. The unit of scrolling is a
// whole pane (the measured pie pane is ~0.10 x 0.61 of the frame), not a
// control, so a click-sized radius lets the model evade the guard by shifting
// its aim a few percent while staying inside the same dead pane.
export function isNearDeadScroll(point, deadScrolls, radius) {
  return isNearDeadPoint(
    point,
    deadScrolls.filter((d) => d.direction === point.direction),
    radius,
  );
}

// Every recorded guard judgement was made against a frame that no longer
// exists, so a view-changing action invalidates all of them at once: a click
// that found nothing may now land on the target, and a pane with nothing
// scrollable may have been replaced by one that scrolls. Emptied IN PLACE
// because the orchestrator closes over these arrays for the life of the run -
// reassigning them would leave it holding the stale originals.
export function clearStaleGuards(guards) {
  for (const key of ["deadClickPoints", "rejectedAimPoints", "deadScrollPoints"]) {
    if (Array.isArray(guards[key])) guards[key].length = 0;
  }
}
