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
// Phase B2 (this file, added on top): forwarded mouse/keyboard input against
// the shared page (turn-based lock - only dispatched while mode !== 'agent'),
// and takeover capture (before/after frame + inventory + Tableau event-log
// slice around a user takeover window, diffed and persisted to the
// `takeovers` table). See docs/LIVE_TAKEOVER_PLAN.md sections 5, 6.2, 9 (B2).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { openSession, waitForSettle, screenshotViz } from "./perception.js";
import * as store from "./store.js";
import { FRAMES_DIR } from "./paths.js";

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
  let lastVizBoxKey = null; // dedup key so we only broadcast vizbox on change (POLL LOOP ONLY - do not repurpose)
  let lastVizBox = null; // { box:{nx,ny,nw,nh}, viewport:{width,height} } - cache for dispatchInput's coord mapping
  let mode = "idle"; // 'idle' | 'agent' (two-state; input is dispatched only when mode !== 'agent')
  let closed = false;
  let openTakeover = null; // { afterTurnIndex, startedAt, beforeFramePath, beforeInventory, eventLogStartLength } | null
  const heldMouseButtons = new Set(); // buttons dispatchInput has pressed but not yet released
  const heldKeys = new Set(); // keys dispatchInput has pressed but not yet released

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
        lastVizBox = vb; // cache for dispatchInput's coord mapping, independent of the dedup key below
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
    if (vb) {
      lastVizBox = vb; // cache for dispatchInput's coord mapping
      if (ws.readyState === WS_OPEN) {
        try {
          ws.send(JSON.stringify({ type: "vizbox", box: vb.box, viewport: vb.viewport }));
        } catch {
          /* ignore */
        }
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

  // Best-effort release of any mouse button / keyboard key a forwarded
  // gesture left "held" - e.g. the user starts a drag, then immediately
  // submits a question before releasing. Fire-and-forget (never awaited by
  // setMode - see below) so it can never delay the synchronous lock.
  async function releaseHeldInput() {
    for (const button of heldMouseButtons) {
      try {
        await page.mouse.up({ button });
      } catch {
        /* page busy/navigating - best effort */
      }
    }
    heldMouseButtons.clear();
    for (const key of heldKeys) {
      try {
        await page.keyboard.up(key);
      } catch {
        /* ignore */
      }
    }
    heldKeys.clear();
  }

  // server.js calls this at turn start ('agent') and turn end ('idle').
  function setMode(newMode) {
    if (newMode === "agent" && mode !== "agent") {
      // A dangling down/keydown whose matching up/keyup arrived too late
      // (dropped by dispatchInput's lock check below) would otherwise leave
      // the shared page's virtual mouse button or a modifier key stuck
      // "pressed" for the whole next turn. Release it before locking. Must
      // stay fire-and-forget: setMode is called synchronously as the very
      // first, mutex-establishing statement in server.js's startTurn, and
      // must not become async itself.
      releaseHeldInput().catch(() => {});
    }
    mode = newMode;
    broadcast({ type: newMode === "agent" ? "lock" : "unlock" });
  }

  // --- Forwarded input (Phase B2) ----------------------------------------
  //
  // Coordinate contract (docs/LIVE_TAKEOVER_PLAN.md section on B2's input
  // coordinate contract): the CLIENT sends nx/ny as fractions [0,1] of the
  // DISPLAYED (cropped) viz container it renders - i.e. already relative to
  // the viz rectangle itself, matching exactly what the user clicked on. The
  // server is the only side that knows the current vizbox + viewport, and
  // performs the one necessary transform into absolute page pixels:
  //   pixelX = (vizBox.nx + clientNx * vizBox.nw) * viewport.width
  //   pixelY = (vizBox.ny + clientNy * vizBox.nh) * viewport.height
  function clamp01(v) {
    const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
    return Math.min(1, Math.max(0, n));
  }

  // Ignored (silently dropped, never queued) while an agent turn is running -
  // that lock is the entire point of the turn-based takeover model. Never
  // throws: a Playwright error here (stale element, page mid-navigation,
  // unrecognized key) must not crash the WS message handler or the process.
  async function dispatchInput(msg) {
    if (mode === "agent") return; // locked - agent is driving
    if (!lastVizBox) return; // no geometry to map against yet
    try {
      const { box, viewport } = lastVizBox;
      const nx = clamp01(msg?.nx);
      const ny = clamp01(msg?.ny);
      const pixelX = (box.nx + nx * box.nw) * viewport.width;
      const pixelY = (box.ny + ny * box.nh) * viewport.height;

      if (msg?.type === "mouse") {
        const button = msg.button ?? "left";
        switch (msg.event) {
          case "move":
            await page.mouse.move(pixelX, pixelY);
            break;
          case "down":
            await page.mouse.move(pixelX, pixelY);
            await page.mouse.down({ button });
            heldMouseButtons.add(button);
            break;
          case "up":
            await page.mouse.up({ button });
            heldMouseButtons.delete(button);
            break;
          case "click":
            await page.mouse.click(pixelX, pixelY, { button });
            break;
          case "wheel":
            await page.mouse.move(pixelX, pixelY);
            await page.mouse.wheel(0, msg.deltaY ?? 0);
            break;
          default:
          // Unknown mouse sub-event - ignore.
        }
      } else if (msg?.type === "key") {
        switch (msg.event) {
          case "down":
            await page.keyboard.down(msg.key);
            heldKeys.add(msg.key);
            break;
          case "up":
            await page.keyboard.up(msg.key);
            heldKeys.delete(msg.key);
            break;
          case "press":
            await page.keyboard.press(msg.key);
            break;
          default:
          // Unknown key sub-event - ignore.
        }
      }
    } catch {
      // Stale element / page navigating / unmapped key name - swallow. The
      // live screencast already shows whatever did or didn't happen; there is
      // nothing useful to surface back over this fire-and-forget channel.
    }
  }

  // --- Takeover capture (Phase B2) ----------------------------------------
  //
  // A "takeover window" spans from the moment the agent goes idle after a
  // turn to the moment the next turn starts (or the conversation closes).
  // captureTakeoverStart/End are plain methods - the CALLER (server.js,
  // next stage) decides exactly when to invoke them; this file only wires
  // the close() backstop described below.

  function takeoverFramesDir() {
    const dir = path.join(FRAMES_DIR, `conv_${id}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Same-fieldName filters can repeat once per worksheet in the RAW bridge
  // shape (unlike orchestrator.js's merged, agent-facing inventory) - dedupe
  // by taking the first occurrence per fieldName. Safe because Tableau's own
  // Dashboard.applyFilterAsync keeps same-field filters in sync dashboard-wide.
  function dedupeFiltersByField(filters) {
    const map = new Map();
    for (const f of filters || []) {
      if (!map.has(f.fieldName)) map.set(f.fieldName, f);
    }
    return map;
  }

  function sortedValuesJSON(values) {
    return JSON.stringify([...(values || [])].sort());
  }

  function filterRepr(f) {
    if (!f) return null;
    if (f.filterType === "range") {
      return { min: f.minValue ?? null, max: f.maxValue ?? null };
    }
    return { appliedValues: [...(f.appliedValues || [])].sort() };
  }

  function filtersEqual(a, b) {
    if (!a || !b) return a === b; // present-vs-missing is always a change
    if (a.filterType === "range" || b.filterType === "range") {
      return (a.minValue ?? null) === (b.minValue ?? null) && (a.maxValue ?? null) === (b.maxValue ?? null);
    }
    return sortedValuesJSON(a.appliedValues) === sortedValuesJSON(b.appliedValues);
  }

  // Pure diff of two RAW getInventory() snapshots -> array of
  // {kind:'filter'|'parameter'|'sheet', field?, from, to}. Empty array if
  // nothing changed. This is exactly what gets JSON.stringify'd into
  // takeovers.summary_json (see docs/LIVE_TAKEOVER_PLAN.md section 4.1).
  function diffInventories(before, after) {
    const diffs = [];

    const beforeFilters = dedupeFiltersByField(before?.filters);
    const afterFilters = dedupeFiltersByField(after?.filters);
    const fieldNames = new Set([...beforeFilters.keys(), ...afterFilters.keys()]);
    for (const fieldName of fieldNames) {
      const bf = beforeFilters.get(fieldName) ?? null;
      const af = afterFilters.get(fieldName) ?? null;
      if (!filtersEqual(bf, af)) {
        diffs.push({ kind: "filter", field: fieldName, from: filterRepr(bf), to: filterRepr(af) });
      }
    }

    const beforeParams = new Map((before?.parameters || []).map((p) => [p.name, p]));
    const afterParams = new Map((after?.parameters || []).map((p) => [p.name, p]));
    const paramNames = new Set([...beforeParams.keys(), ...afterParams.keys()]);
    for (const name of paramNames) {
      const bv = beforeParams.get(name)?.currentValue ?? null;
      const av = afterParams.get(name)?.currentValue ?? null;
      if (bv !== av) {
        diffs.push({ kind: "parameter", field: name, from: bv, to: av });
      }
    }

    const beforeSheet = before?.activeSheetName ?? null;
    const afterSheet = after?.activeSheetName ?? null;
    if (beforeSheet !== afterSheet) {
      diffs.push({ kind: "sheet", from: beforeSheet, to: afterSheet });
    }

    return diffs;
  }

  // Starts a takeover window: snapshots "before" frame + inventory, and
  // remembers the current event-log length so captureTakeoverEnd can slice
  // just this window's events. If a window is already open, this should not
  // normally happen given the intended call sequencing (next turn start /
  // close always ends the previous window first) - warn and leave the
  // existing open window alone rather than silently overwriting/losing it.
  async function captureTakeoverStart(afterTurnIndex) {
    if (openTakeover) {
      console.warn(
        `[conversationRuntime] captureTakeoverStart(${afterTurnIndex}) called while a takeover window is already open (afterTurnIndex=${openTakeover.afterTurnIndex}) for conversation ${id}; leaving the existing window open.`,
      );
      return;
    }
    try {
      const dir = takeoverFramesDir();
      const beforeFramePath = path.join(dir, `takeover_${afterTurnIndex}_before.png`);
      await screenshotViz(page, beforeFramePath);
      const beforeInventory = await page.evaluate(() => window.__agentBridge.getInventory());
      const eventLog = await page.evaluate(() => window.__agentBridge.getEventLog());
      openTakeover = {
        afterTurnIndex,
        startedAt: new Date().toISOString(),
        beforeFramePath,
        beforeInventory,
        eventLogStartLength: eventLog.length,
      };
    } catch (e) {
      console.warn(`[conversationRuntime] captureTakeoverStart failed for conversation ${id}: ${e.message}`);
      openTakeover = null;
    }
  }

  // Ends the currently open takeover window (no-op -> null if none is open).
  // Snapshots "after" frame + inventory, slices the event log to just this
  // window, diffs the two inventories, and persists a takeovers row UNLESS
  // both the diff and the event-log slice are empty (nothing actually
  // happened - don't clutter the thread with a no-op takeover card). Returns
  // the full persisted row (or null if discarded/no window/on error) so the
  // caller can thread it into an API response without a re-fetch.
  async function captureTakeoverEnd() {
    if (!openTakeover) return null;
    const win = openTakeover;
    openTakeover = null; // clear regardless of what happens below
    try {
      const dir = takeoverFramesDir();
      const afterFramePath = path.join(dir, `takeover_${win.afterTurnIndex}_after.png`);
      await screenshotViz(page, afterFramePath);
      const afterInventory = await page.evaluate(() => window.__agentBridge.getInventory());
      const fullEventLog = await page.evaluate(() => window.__agentBridge.getEventLog());
      const eventLogSlice = fullEventLog.slice(win.eventLogStartLength);
      const diff = diffInventories(win.beforeInventory, afterInventory);

      if (diff.length === 0 && eventLogSlice.length === 0) {
        // Nothing changed - discard, no takeover row. Clean up the before/
        // after PNGs already written to disk so a long conversation with no
        // real takeovers doesn't leak two orphaned frame files per turn
        // boundary (best-effort, never blocks the return).
        for (const p of [win.beforeFramePath, afterFramePath]) {
          fs.promises.unlink(p).catch(() => {});
        }
        return null;
      }

      const row = {
        conversation_id: id,
        after_turn_index: win.afterTurnIndex,
        started_at: win.startedAt,
        ended_at: new Date().toISOString(),
        before_frame_path: win.beforeFramePath,
        after_frame_path: afterFramePath,
        before_inventory_json: JSON.stringify(win.beforeInventory),
        after_inventory_json: JSON.stringify(afterInventory),
        event_log_json: JSON.stringify(eventLogSlice),
        summary_json: JSON.stringify(diff),
      };
      const result = store.insertTakeover(row);
      return { id: result.lastInsertRowid, ...row };
    } catch (e) {
      console.warn(`[conversationRuntime] captureTakeoverEnd failed for conversation ${id}: ${e.message}`);
      return null;
    }
  }

  async function close(reason = "conversation_closed") {
    if (closed) return;
    closed = true;
    // Backstop: if the user took over and the conversation is closed (or
    // replaced) without another question ever being asked, still finalize
    // and persist that takeover window here - before any teardown, since it
    // needs a live page. Must never block the rest of close().
    if (openTakeover) {
      try {
        await captureTakeoverEnd();
      } catch {
        /* never let a takeover-capture failure block teardown */
      }
    }
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
    // Phase B2 surface (used by server.js's WS message handler + turn
    // sequencing - see the plan doc before adding call sites elsewhere):
    dispatchInput,
    captureTakeoverStart,
    captureTakeoverEnd,
  };

  return runtime;
}
