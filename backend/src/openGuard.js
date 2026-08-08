// Guards around the conversation-open window in server.js, split out so they
// are unit-testable without starting Express or Playwright (same reasoning as
// activeConversation.js and perception.js's settleDecision).
//
// Background: createConversationInternal raises `conversationOpening` and
// clears it in a finally. That is only sound if everything it awaits actually
// settles. It didn't - a hung open latched the flag true for the life of the
// process, so every later open 409'd and the only escape was a server restart
// ("A conversation is already being opened. Try again in a moment." forever).

// Rejects after `ms` rather than waiting forever. The underlying promise keeps
// running: a caller that can leak a resource on late resolution must attach its
// own handler to clean up (createConversationInternal closes a late runtime).
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`), { statusCode: 504 })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// Should a new open proceed while one is already marked in-flight?
//
// "reject" is the normal concurrency guard - two overlapping opens would leak a
// Playwright context. "override" is the self-heal: the flag has been held past
// every timeout that should have released it, so the holder is not coming back.
// Refusing forever would leave the user with no recovery but a restart, which
// is strictly worse than proceeding and possibly leaking one context.
export function openGuardDecision({ opening, openingSince, now, staleMs }) {
  if (!opening) return "proceed";
  const heldMs = now - openingSince;
  return heldMs >= staleMs ? "override" : "reject";
}
