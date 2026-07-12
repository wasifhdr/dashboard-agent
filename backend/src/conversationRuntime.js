// Owns the ONE long-lived Playwright context + page for an active
// "conversation" (docs/LIVE_TAKEOVER_PLAN.md section 5), so multiple agent
// turns (questions) can run against the same live dashboard without
// reopening it.
//
// Phase B0: context/page lifecycle + one-active-conversation tracking.
// Phase B1 (this file, added on top): a CDP screencast of the page fanned out
// to connected WebSocket clients as base64 JPEG frames, plus a normalized
// bounding box of the viz element ("vizbox") and lock/unlock signals so the
// viewer can render a live, read-only view of the agent's browser.
//
// Input dispatching + takeover capture are Phase B2 and are intentionally NOT
// implemented here - see the plan doc before adding methods for those.
import crypto from "node:crypto";

import { openSession, waitForSettle } from "./perception.js";
import * as store from "./store.js";

// Must match the id on <tableau-viz id="agentViz"> in public/host.html.
// perception.js is the source of truth (VIZ_SELECTOR there) but is frozen and
// does not export it, so the selector is duplicated here deliberately.
const VIZ_SELECTOR = "tableau-viz#agentViz";

// ws readyState OPEN. Avoids importing the ws package into this module just
// for a constant (the WebSocket instances are created in server.js).
const WS_OPEN = 1;

// --- Singleton tracking -----------------------------------------------
//
// Pattern chosen: module-level state (`activeRuntime`) exposed through the
// exported getActiveRuntime()/setActiveRuntime() accessor pair below.
//
// createRuntime() does NOT call setActiveRuntime() itself - registering the
// new runtime as "the" active one is left to the caller (server.js). This
// lets the caller sequence things explicitly and handle failure at each step,
// e.g.:
//   const runtime = await createRuntime({ ... });   // open new FIRST
//   const prev = getActiveRuntime();
//   setActiveRuntime(runtime);
//   if (prev) await prev.close();                    // replace old only on success
// (and reject with 409 up front if a turn is currently running - that
// turn-running flag lives in server.js, not in this module.)
//
// close() DOES clear the singleton automatically, but only as a safety net
// (if `runtime` is currently the registered active one).
let activeRuntime = null;

export function getActiveRuntime() {
  return activeRuntime;
}

export function setActiveRuntime(runtime) {
  activeRuntime = runtime;
}

// --- Runtime factory -----------------------------------------------------

// Opens the dashboard once (via perception.openSession + waitForSettle -
// mirrors runSession's current opening sequence and error message format
// exactly, see orchestrator.js) and persists the conversations row on
// success. Returns a runtime object the caller (server.js) holds for the life
// of the conversation.
export async function createRuntime({ browser, config, conversationId, dashboardUrl, dashboardName }) {
  const id = conversationId ?? crypto.randomUUID();

  // Screencast tuning, with fallbacks so an older config.json (no `screencast`
  // block) never crashes the runtime. 6GB-laptop-friendly defaults.
  const sc = config.screencast ?? {};
  const SC = {
    quality: sc.quality ?? 60,
    maxWidth: sc.maxWidth ?? 1280,
    maxHeight: sc.maxHeight ?? 800,
    everyNthFrame: sc.everyNthFrame ?? 1,
    vizboxPollMs: sc.vizboxPollMs ?? 1000,
  };

  let context;
  let page;
  try {
    const opened = await openSession(browser, config.hostPageOrigin, dashboardUrl, { firstLoadTimeoutMs: 90000 });
    context = opened.context;
    page = opened.page;
    await waitForSettle(page, config.settleGate);
  } catch (e) {
    // Best-effort cleanup of a context that opened but never settled - same
    // thrown message format as runSession's "Dashboard failed to load: ...".
    if (context) {
      await context.close().catch(() => {});
    }
    throw new Error(`Dashboard failed to load: ${e.message}`);
  }

  store.createConversation({
    id,
    dashboard_url: dashboardUrl,
    dashboard_name: dashboardName ?? null,
    model_id: config.modelName,
    config_json: JSON.stringify(config),
  });

  // --- Live-view state (Phase B1) ---------------------------------------
  const clients = new Set(); // connected WebSocket instances
  let cdp = null; // lazily created CDP session
  let screencasting = false; // is Page.startScreencast currently active
  let vizboxTimer = null; // self-rescheduling vizbox poll
  let lastVizBoxKey = null; // dedup key so we only broadcast vizbox on change
  let mode = "idle"; // 'idle' | 'agent' | 'user' (drives lock/unlock)
  let closed = false;

  function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WS_OPEN) {
        try {
          ws.send(payload);
        } catch {
          // A send can throw on a socket that's mid-close; the ws 'close'
          // handler in server.js will remove it. Don't let one bad client
          // break the broadcast to the others.
        }
      }
    }
  }

  // Normalized viz rectangle over the viewport, so the client can crop the
  // full-viewport frame to just the viz regardless of resolution/scale.
  async function computeVizBox() {
    try {
      const box = await page.locator(VIZ_SELECTOR).boundingBox();
      const vp = page.viewportSize();
      if (!box || !vp || !vp.width || !vp.height) return null;
      return {
        box: {
          nx: box.x / vp.width,
          ny: box.y / vp.height,
          nw: box.width / vp.width,
          nh: box.height / vp.height,
        },
        viewport: { width: vp.width, height: vp.height },
      };
    } catch {
      // Element mid-transition / page busy - skip this tick.
      return null;
    }
  }

  function vizBoxKey(vb) {
    return `${vb.box.nx.toFixed(4)},${vb.box.ny.toFixed(4)},${vb.box.nw.toFixed(4)},${vb.box.nh.toFixed(4)}`;
  }

  async function ensureCdp() {
    if (cdp) return cdp;
    cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", async (frame) => {
      // Broadcast the frame to watchers (only while actively screencasting)...
      if (screencasting) {
        broadcast({ type: "frame", data: frame.data });
      }
      // ...but ALWAYS ack, even a straggler that arrived after stop/close.
      // Forgetting the ack stalls the whole stream after a few frames - this
      // is the single most important correctness detail in this file.
      try {
        if (cdp) await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      } catch {
        // cdp detached during teardown, or frame raced close(); safe to drop.
      }
    });
    return cdp;
  }

  function scheduleVizbox() {
    vizboxTimer = setTimeout(async () => {
      vizboxTimer = null;
      if (!screencasting || closed) return;
      const vb = await computeVizBox();
      if (vb) {
        const key = vizBoxKey(vb);
        if (key !== lastVizBoxKey) {
          lastVizBoxKey = key;
          broadcast({ type: "vizbox", box: vb.box, viewport: vb.viewport });
        }
      }
      if (screencasting && !closed) scheduleVizbox();
    }, SC.vizboxPollMs);
  }

  async function startScreencast() {
    if (screencasting || closed) return;
    await ensureCdp();
    screencasting = true;
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: SC.quality,
        maxWidth: SC.maxWidth,
        maxHeight: SC.maxHeight,
        everyNthFrame: SC.everyNthFrame,
      });
    } catch {
      screencasting = false;
      return;
    }
    scheduleVizbox();
  }

  async function stopScreencast() {
    if (!screencasting) return;
    screencasting = false;
    if (vizboxTimer) {
      clearTimeout(vizboxTimer);
      vizboxTimer = null;
    }
    lastVizBoxKey = null;
    try {
      if (cdp) await cdp.send("Page.stopScreencast");
    } catch {
      // context/cdp may already be gone.
    }
  }

  // Ref-counted by client count: encode frames only while someone is watching.
  async function addClient(ws) {
    if (closed) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    clients.add(ws);
    if (clients.size === 1) {
      await startScreencast();
    }
    // Prime the new client with current geometry + lock state immediately,
    // so it doesn't have to wait for the next poll tick / turn boundary.
    const vb = await computeVizBox();
    if (vb && ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify({ type: "vizbox", box: vb.box, viewport: vb.viewport }));
      } catch {
        /* ignore */
      }
      // Do NOT set lastVizBoxKey here: it's the poll loop's shared dedup key,
      // and suppressing its next broadcast would leave already-connected
      // clients cropping to stale geometry. Priming this one socket is enough;
      // a redundant re-broadcast to it on the next tick is harmless.
    }
    if (mode === "agent" && ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify({ type: "lock" }));
      } catch {
        /* ignore */
      }
    }
  }

  async function removeClient(ws) {
    clients.delete(ws);
    if (clients.size === 0) {
      await stopScreencast();
    }
  }

  // server.js calls this at turn start ('agent') and turn end ('idle').
  function setMode(newMode) {
    mode = newMode;
    broadcast({ type: newMode === "agent" ? "lock" : "unlock" });
  }

  async function close(reason = "conversation_closed") {
    if (closed) return;
    closed = true;
    try {
      broadcast({ type: "closed", reason });
    } catch {
      /* ignore */
    }
    try {
      await stopScreencast();
    } catch {
      /* ignore */
    }
    if (vizboxTimer) {
      clearTimeout(vizboxTimer);
      vizboxTimer = null;
    }
    // Close the sockets after telling them why, so browser clients stop and
    // don't linger as orphaned connections (they already got {type:"closed"}
    // above, which tells useLiveChannel not to reconnect).
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    if (cdp) {
      try {
        await cdp.detach();
      } catch {
        /* ignore */
      }
      cdp = null;
    }
    try {
      await context.close();
    } catch {
      // Already closed / closing - close() must be safe to call more than once
      // and must never throw.
    }
    try {
      store.closeConversation(id);
    } catch {
      // Best-effort - don't let a DB hiccup make close() throw.
    }
    if (activeRuntime === runtime) {
      activeRuntime = null;
    }
  }

  const runtime = {
    conversationId: id,
    page,
    context,
    dashboardUrl,
    dashboardName: dashboardName ?? null,
    close,
    // Phase B1 live-view surface (used by server.js's WebSocket wiring):
    addClient,
    removeClient,
    broadcast,
    setMode,
    get mode() {
      return mode;
    },
  };

  return runtime;
}
