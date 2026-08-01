// Shape of GET /api/conversations/active. Split out of server.js so the
// decision is unit-testable without an Express app or a live Playwright
// runtime.
//
// "No conversation is active" is a completely normal state (nothing has been
// opened yet, or the last one was closed), so it is reported as data with a
// 200 - never as an error status.

// `currentTurn` is server.js's { id, question } for the in-flight turn, or null.
// It is reported separately from `turnRunning` because a resuming client needs
// more than a boolean: startTurn awaits a takeover capture before runSession
// writes the session row, so there is a real window where a turn is running and
// GET /api/conversations/:id still returns nothing for it. The id lets the
// client subscribe to that turn's event bus (which is created synchronously and
// buffers from the start), and the question lets it render the thread entry
// before any event arrives.
export function describeActiveConversation(runtime, turnRunning, currentTurn = null) {
  if (!runtime) return { active: false };
  return {
    active: true,
    conversationId: runtime.conversationId,
    dashboardUrl: runtime.dashboardUrl,
    dashboardName: runtime.dashboardName ?? null,
    turnRunning: Boolean(turnRunning),
    runningTurn: currentTurn ? { id: currentTurn.id, question: currentTurn.question ?? null } : null,
  };
}
