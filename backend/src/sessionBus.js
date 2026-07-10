// In-memory pub-sub for live SSE fan-out (AGENT_PLAN.md 6.7). Each live
// session gets a small event buffer so a client connecting mid-run (or
// reconnecting) is replayed everything so far, then streamed new events as
// they happen. Buses are process-lifetime (no cleanup) - fine for a
// single-user local demo; a past/completed session is served by the plain
// GET /api/sessions/:id trajectory endpoint instead, not by this bus.

const buffers = new Map(); // sessionId -> event[]
const subscribers = new Map(); // sessionId -> Set<res>

export function createBus(sessionId) {
  buffers.set(sessionId, []);
  subscribers.set(sessionId, new Set());
}

export function hasBus(sessionId) {
  return buffers.has(sessionId);
}

function writeSseEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function publish(sessionId, event) {
  const buf = buffers.get(sessionId);
  if (!buf) return;
  buf.push(event);
  for (const res of subscribers.get(sessionId) ?? []) {
    writeSseEvent(res, event);
  }
}

// Assumes hasBus(sessionId) was already checked and response headers for
// text/event-stream have already been written by the caller.
export function subscribe(sessionId, res) {
  subscribers.get(sessionId)?.add(res);
  for (const evt of buffers.get(sessionId) ?? []) {
    writeSseEvent(res, evt);
  }
}

export function unsubscribe(sessionId, res) {
  subscribers.get(sessionId)?.delete(res);
}
