// Liveness for the ONE shared Playwright browser (server.js `sharedBrowser`),
// split out so it is unit-testable without launching Chromium (same reasoning
// as openGuard.js and activeConversation.js).
//
// Background - the failure this exists to stop:
//   The shared browser is launched once at startup and was then used for the
//   life of the process with nothing ever checking it. In the field its
//   connection went dead while the process stayed alive: `isConnected()` still
//   reported true, the headless process sat idle at zero CPU with no renderer,
//   and `browser.newContext()` simply never resolved. Playwright puts NO
//   default timeout on newContext(), so every dashboard open hung until the
//   150s guard in server.js fired - for curated, pasted and searched URLs
//   alike - and it stayed that way permanently, because nothing detected the
//   dead browser or replaced it. The only recovery was restarting the backend.
//
// Hence the two rules encoded here:
//   1. Liveness must be an actual bounded round-trip. Reading isConnected() is
//      a cheap pre-filter, not the test - it was true the whole time.
//   2. Tearing the dead browser down must never be awaited; close() can hang
//      for the same reason newContext() did.

import { withTimeout } from "./openGuard.js";

// Cheap on a healthy browser (a context open+close is well under a second) and
// bounded on a wedged one, which is the entire point.
export const PROBE_TIMEOUT_MS = 15000;

// Is this browser actually able to do work right now? Never throws - every
// failure mode (null handle, disconnected, hung, rejected) is just "no".
export async function probeBrowser(browser, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!browser) return false;
  if (typeof browser.isConnected === "function" && !browser.isConnected()) return false;

  try {
    const context = await withTimeout(browser.newContext(), timeoutMs, "Browser health probe");
    // Probe context is disposable; failing to close it would leak one context
    // per open, so swallow-and-continue rather than report the browser dead.
    await Promise.resolve(context?.close?.()).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// Returns a browser that just passed the probe, relaunching if the current one
// did not. `probe` and `launch` are injected so the decision is testable.
export async function ensureHealthyBrowser({ browser, probe = probeBrowser, launch, onRelaunch }) {
  if (await probe(browser)) return { browser, relaunched: false };

  if (browser) {
    // Fire-and-forget: see rule 2 above. Worst case the OS reaps a stray
    // headless process; that beats reintroducing the stall we just removed.
    Promise.resolve(browser.close?.()).catch(() => {});
  }

  const fresh = await launch();
  onRelaunch?.();
  return { browser: fresh, relaunched: true };
}
