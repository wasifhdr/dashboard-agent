// Pure geometry helper for the pixel-mode dead-click guard (kept in its own
// dependency-free module so it can be unit-tested without importing the
// orchestrator's heavy deps). A "dead point" is the normalized location of a
// click that produced no visible change; a new click within `radius`
// (normalized Euclidean distance) of any dead point is rejected before it
// executes, so the agent can't burn its step budget hammering the same spot.
export function isNearDeadPoint(point, deadPoints, radius) {
  return deadPoints.some((d) => Math.hypot(d.nx - point.nx, d.ny - point.ny) <= radius);
}
