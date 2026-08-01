// Shape of GET /api/conversations/active. Split out of server.js so the
// decision is unit-testable without an Express app or a live Playwright
// runtime.
//
// "No conversation is active" is a completely normal state (nothing has been
// opened yet, or the last one was closed), so it is reported as data with a
// 200 - never as an error status.

export function describeActiveConversation(runtime, turnRunning) {
  if (!runtime) return { active: false };
  return {
    active: true,
    conversationId: runtime.conversationId,
    dashboardUrl: runtime.dashboardUrl,
    dashboardName: runtime.dashboardName ?? null,
    turnRunning: Boolean(turnRunning),
  };
}
