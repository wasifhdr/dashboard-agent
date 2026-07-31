import "./env.js";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { BACKEND_ROOT, FRAMES_DIR } from "./paths.js";
import { launchBrowser } from "./perception.js";
import { runSession } from "./orchestrator.js";
import * as store from "./store.js";
import * as bus from "./sessionBus.js";
import * as conversationRuntime from "./conversationRuntime.js";
import { searchWorkbooks } from "./tableauSearch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const config = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, "config.json"), "utf-8"));

fs.mkdirSync(FRAMES_DIR, { recursive: true });

// Single source of truth for the allowed frontend origin - used by both the
// Express CORS middleware and the live WebSocket's Origin check (see
// attachLiveWebSocket below) so the two allowlists can never drift apart.
const FRONTEND_ORIGIN = "http://localhost:5173";

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// Serves the host page that Playwright loads to embed a Tableau viz.
// Query string (?viz=<url>) is read client-side in host.html.
app.get("/host", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "host.html"));
});
app.use(express.static(PUBLIC_DIR));

// Frames referenced by frame_raw_path in the DB / orchestrator events are
// served here as /frames/<sessionId>/step_N.png.
app.use("/frames", express.static(FRAMES_DIR));

function framePathToUrl(framePath) {
  if (!framePath) return null;
  const rel = path.relative(FRAMES_DIR, framePath).split(path.sep).join("/");
  return `/frames/${rel}`;
}

app.get("/api/config", (req, res) => {
  res.json({ dashboards: config.dashboards ?? [], maxSteps: config.maxSteps });
});

// Live keyword search against Tableau Public. Deliberately always 200: this
// proxies an undocumented third-party endpoint, and the landing page must stay
// fully usable (local results, paste-a-URL) when it is down or has changed
// shape. Failure is reported in the body as degraded:true.
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  const count = Math.min(Math.max(Number(req.query.count ?? 10) || 10, 1), 25);
  const out = await searchWorkbooks(q, { count });
  if (out.degraded) {
    console.warn(`[search] degraded (${out.reason}) for query ${JSON.stringify(q)}`);
  }
  res.json(out);
});

// Text-to-speech proxy. The browser must never see GROQ_API_KEY, so the
// frontend posts the answer text here and gets audio bytes back.
//
// This is strictly an ENHANCEMENT over the browser's own speechSynthesis: the
// frontend falls back to local voices on any non-200, so a missing key, an
// unaccepted model terms gate, a 429, or Groq being down all degrade to the
// robotic-but-always-available path rather than to silence.
app.get("/api/tts/config", (req, res) => {
  const tts = config.tts ?? {};
  // `available` gates the remote path in the UI. The key is only checked for
  // presence — never sent to the client.
  res.json({
    available: !!(tts.enabled && tts.endpoint && (!tts.apiKeyEnv || process.env[tts.apiKeyEnv])),
    voice: tts.voice ?? null,
  });
});

app.post("/api/tts", async (req, res) => {
  const tts = config.tts ?? {};
  if (!tts.enabled || !tts.endpoint) {
    return res.status(503).json({ error: "tts_disabled" });
  }
  const apiKey = tts.apiKeyEnv ? process.env[tts.apiKeyEnv] : null;
  if (tts.apiKeyEnv && !apiKey) {
    return res.status(503).json({ error: "tts_key_missing", detail: `${tts.apiKeyEnv} is not set` });
  }

  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "empty_text" });
  // Answers are short; the cap is a guard against a runaway best-effort answer
  // turning into a minute of billed audio, not a real content limit.
  const input = text.slice(0, tts.maxChars ?? 1200);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tts.timeoutMs ?? 20000);
  try {
    const upstream = await fetch(tts.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: tts.modelName,
        input,
        voice: req.body?.voice || tts.voice,
        response_format: "wav",
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // Surface the provider's own message (model_terms_required, rate limits,
      // a decommissioned model) rather than a bare status - these are the
      // failures that actually happen, and they're all actionable.
      const detail = await upstream.text();
      console.warn(`[tts] upstream ${upstream.status}: ${detail.slice(0, 300)}`);
      return res.status(502).json({ error: "tts_upstream_error", status: upstream.status, detail: detail.slice(0, 500) });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", "audio/wav");
    res.set("Cache-Control", "no-store");
    return res.send(audio);
  } catch (err) {
    const reason = err.name === "AbortError" ? "tts_timeout" : "tts_request_failed";
    console.warn(`[tts] ${reason}: ${err.message}`);
    return res.status(502).json({ error: reason, detail: err.message });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/api/dashboards/meta", (req, res) => {
  const dashboards = (config.dashboards ?? []).map((d) => {
    const step1 = store.latestStep1ForDashboard(d.url);
    let inventory = null;
    if (step1?.inventory_json) {
      try {
        const inv = JSON.parse(step1.inventory_json);
        inventory = {
          filterCount: inv.filters?.length ?? 0,
          parameterCount: inv.parameters?.length ?? 0,
          sheetCount: inv.sheets?.length ?? 0,
        };
      } catch {
        inventory = null;
      }
    }
    return {
      url: d.url,
      name: d.name,
      thumbnailUrl: step1?.frame_raw_path ? framePathToUrl(step1.frame_raw_path) : null,
      inventory,
      lastAnsweredSessionId: store.latestAnsweredSessionId(d.url),
    };
  });
  res.json({ dashboards });
});

app.get("/api/sessions", (req, res) => {
  res.json(store.listSessions(50));
});

// Legacy standalone sessions only (never part of a conversation) - for the
// History screen (docs/LIVE_TAKEOVER_PLAN.md Phase B3) to merge with the
// enriched GET /api/conversations list without re-fetching turns that already
// belong to a listed conversation. A literal path segment ("standalone"), not
// a query param. IMPORTANT: this must stay registered BEFORE
// GET /api/sessions/:id below - Express tries routes in registration order
// and :id would otherwise greedily match "standalone" as an id (verified: a
// param route registered first DOES swallow a literal route registered
// after it - registration order matters in Express's default router, it is
// not literal-before-param by default).
app.get("/api/sessions/standalone", (req, res) => {
  res.json(store.listStandaloneSessions(50));
});

// Builds the { session, steps } trajectory shape for one session (== one
// conversation "turn", or a legacy standalone session). Shared by
// GET /api/sessions/:id and GET /api/conversations/:id (turns[]) so both
// return turns in exactly the same shape.
function buildSessionTrajectory(session) {
  const steps = store.getSteps(session.id).map((s) => ({
    idx: s.step_idx,
    thought: s.thought,
    action: s.action_json ? JSON.parse(s.action_json) : null,
    action_status: s.action_status,
    error_msg: s.error_msg,
    frame_url: framePathToUrl(s.frame_raw_path),
    overlay: s.overlay_json ? JSON.parse(s.overlay_json) : null,
    inventory: s.inventory_json ? JSON.parse(s.inventory_json) : null,
    settle_timeout: Boolean(s.settle_timeout),
    started_at: s.started_at,
    duration_ms: s.duration_ms,
  }));

  return { session, steps };
}

app.get("/api/sessions/:id", (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });

  res.json(buildSessionTrajectory(session));
});

// Translates the orchestrator's onEvent payloads into the SSE event shapes
// from AGENT_PLAN.md 6.7. Kept here (not in orchestrator.js) so the CLI and
// the server can each interpret the same underlying loop events differently.
function adaptAndPublish(sessionId, evt) {
  switch (evt.type) {
    case "session_started":
      bus.publish(sessionId, { type: "session_started" });
      break;
    case "step_started":
      bus.publish(sessionId, { type: "step_started", idx: evt.idx });
      break;
    case "thought":
      bus.publish(sessionId, { type: "thought", idx: evt.idx, text: evt.text });
      break;
    case "frame_captured":
      bus.publish(sessionId, {
        type: "frame",
        idx: evt.idx,
        url: framePathToUrl(evt.frame),
        overlay: { action_badge: null, widget_bbox: null, changed_regions: evt.changedRegions },
      });
      break;
    case "action_planned":
      bus.publish(sessionId, { type: "action_planned", idx: evt.idx, action: evt.action, label: evt.label });
      break;
    case "vlm_attempt":
      bus.publish(sessionId, { type: "vlm_attempt", idx: evt.idx, attempt: evt.attempt });
      break;
    case "widget_bbox":
      bus.publish(sessionId, { type: "widget_bbox", idx: evt.idx, bbox: evt.bbox });
      break;
    case "step":
      bus.publish(sessionId, {
        type: "action",
        idx: evt.idx,
        action: evt.action,
        status: evt.action_status,
        error_msg: evt.error_msg,
      });
      bus.publish(sessionId, {
        type: "frame",
        idx: evt.idx,
        url: framePathToUrl(evt.frame),
        overlay: evt.overlay,
      });
      if (evt.inventorySummary) {
        bus.publish(sessionId, { type: "inventory", idx: evt.idx, summary: evt.inventorySummary });
      }
      break;
    case "warning":
      bus.publish(sessionId, { type: "warning", idx: evt.idx, kind: evt.kind });
      break;
    case "session_done":
      bus.publish(sessionId, {
        type: "session_done",
        status: evt.status,
        final_answer: evt.final_answer,
        confidence: evt.confidence,
        error: evt.error ?? null,
      });
      break;
    default:
      break;
  }
}

let sharedBrowser;
// Replaces the old single-session `isRunning` boolean: `turnRunning` tracks
// whether an agent turn is in flight on the currently active conversation.
// There is still only ever one turn running at a time (one active
// conversation, per docs/LIVE_TAKEOVER_PLAN.md section 5/7).
let turnRunning = false;
// Guards the async dashboard-open+settle window inside
// createConversationInternal. `turnRunning` alone doesn't cover this window
// (it's only set once a conversation already exists), so without this flag
// two overlapping POST /api/conversations calls could both proceed
// concurrently and leak a Playwright context (B0 review fix).
let conversationOpening = false;
// Per-turn AbortControllers, keyed by turnId. Stop requests abort the
// controller, which both flips shouldStop() and aborts the in-flight VLM
// request so a stop takes effect immediately instead of at the next step.
const stopControllers = new Map();

// Resolves once no turn is running (or after timeoutMs). Used before closing a
// conversation whose turn we just aborted, so the Playwright context isn't torn
// out from under an in-flight runSession before it unwinds.
function waitForTurnToStop(timeoutMs) {
  if (!turnRunning) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (!turnRunning || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

// Shared by POST /api/conversations and the POST /api/sessions shim (#6):
// opens a fresh conversation runtime and registers it as active, closing
// whatever conversation was previously active (if any) - but only *after*
// the new one has successfully opened. This ordering matters: if the new
// dashboard fails to load, the previous (healthy) conversation must survive
// untouched rather than being torn down for nothing (B0 review fix). Caller
// is responsible for checking `turnRunning` (409) before calling this;
// `conversationOpening` (checked/set here, synchronously, before the first
// await) protects against two overlapping calls racing each other.
async function createConversationInternal({ dashboardUrl, dashboardName }) {
  if (conversationOpening) {
    throw Object.assign(new Error("A conversation is already being opened. Try again in a moment."), { statusCode: 409 });
  }
  conversationOpening = true;
  try {
    const conversationId = crypto.randomUUID();
    const runtime = await conversationRuntime.createRuntime({
      browser: sharedBrowser,
      config,
      conversationId,
      dashboardUrl,
      dashboardName: dashboardName ?? null,
    });

    const prev = conversationRuntime.getActiveRuntime();
    conversationRuntime.setActiveRuntime(runtime);
    if (prev) {
      await prev.close();
    }
    return runtime;
  } finally {
    conversationOpening = false;
  }
}

// Shared by POST /api/conversations/:id/turns and the POST /api/sessions
// shim (#6): starts one agent turn (== one `sessions` row) on the given
// runtime's already-open page, fire-and-forget, mirroring the existing
// "respond before the run finishes" / safety-net catch+finally pattern from
// the old POST /api/sessions handler.
//
// Phase B2 (async): closes out any takeover window left open from the END of
// the PREVIOUS turn before this one proceeds. Ordering here is load-bearing
// (B2 review fix) -
//   1. turnId/turnIndex/bus.createBus/turnRunning=true/setMode("agent") all
//      run SYNCHRONOUSLY, before any await, so the caller's `if (turnRunning)
//      return 409` check and this flip stay atomic (a TOCTOU race reopened by
//      naively awaiting captureTakeoverEnd() first) - and so input is already
//      locked before the awaited capture work below runs, leaving no gap
//      where forwarded input is dispatched but recorded by no open window.
//   2. captureTakeoverEnd() only runs AFTER that lock is in place. On the
//      first-ever turn of a conversation there is no open window yet, so it
//      correctly no-ops and resolves to null.
async function startTurn({ conversationId, activeRuntime, question }) {
  const turnId = crypto.randomUUID();
  const turnIndex = store.getConversationTurns(conversationId).length;
  bus.createBus(turnId);
  const stopController = new AbortController();
  stopControllers.set(turnId, stopController);
  turnRunning = true;
  // Live-view lock: tell any WS watchers the agent is now driving (veil on).
  activeRuntime.setMode("agent");

  const takeover = await activeRuntime.captureTakeoverEnd();

  runSession({
    browser: sharedBrowser,
    config,
    dashboardUrl: activeRuntime.dashboardUrl,
    dashboardName: activeRuntime.dashboardName,
    question,
    sessionId: turnId,
    page: activeRuntime.page,
    ownsPage: false,
    conversationId,
    turnIndex,
    onEvent: (evt) => {
      if (evt.type === "agent_cursor") {
        activeRuntime.broadcastCursor(evt.nx, evt.ny, evt.phase);
        return;
      }
      adaptAndPublish(turnId, evt);
    },
    shouldStop: () => stopController.signal.aborted,
    stopSignal: stopController.signal,
  })
    .catch((err) => {
      console.error(`Turn ${turnId} (conversation ${conversationId}) failed:`, err);
      // Safety net for a bug that escapes runSession's own error handling -
      // without this the session row would stay stuck at status='running'
      // forever and look like a hang in the History list.
      const errorMessage = `Unexpected error: ${err.message}`;
      store.finishSession(turnId, { status: "error", error_message: errorMessage });
      bus.publish(turnId, { type: "session_done", status: "error", final_answer: null, confidence: null, error: errorMessage });
    })
    .finally(async () => {
      stopControllers.delete(turnId);
      // Live-view unlock (veil off) - but only if THIS conversation is still
      // the active one. If the runtime was closed/replaced mid-turn, there's
      // nothing to unlock and setMode on a stale runtime would be wrong.
      const current = conversationRuntime.getActiveRuntime();
      if (current && current.conversationId === conversationId) {
        // Open the takeover recording window BEFORE unlocking input - order
        // matters: the "before" snapshot must exist before the user can
        // possibly touch anything, never the other way around.
        await current.captureTakeoverStart(turnIndex);
        current.setMode("idle");
      }
      // turnRunning stays true through the housekeeping above, not just the
      // run itself (B2 review fix): releasing it earlier let a rapid next
      // turn start mid-cleanup and have its "agent" mode clobbered back to
      // "idle" by this stale callback once it finally resumed.
      turnRunning = false;
    });

  return { turnId, turnIndex, takeover };
}

app.post("/api/conversations", async (req, res) => {
  const { dashboard_url, dashboard_name } = req.body ?? {};
  if (!dashboard_url) {
    return res.status(400).json({ error: "dashboard_url is required." });
  }
  if (turnRunning) {
    return res.status(409).json({ error: "A turn is already running. This system runs one turn at a time." });
  }

  try {
    const runtime = await createConversationInternal({ dashboardUrl: dashboard_url, dashboardName: dashboard_name });
    res.json({ conversation_id: runtime.conversationId });
  } catch (err) {
    const status = err.statusCode ?? 500;
    if (status !== 409) console.error("Failed to create conversation:", err);
    res.status(status).json({ error: err.message });
  }
});

app.post("/api/conversations/:id/turns", async (req, res) => {
  const { question } = req.body ?? {};
  if (!question) {
    return res.status(400).json({ error: "question is required." });
  }

  const activeRuntime = conversationRuntime.getActiveRuntime();
  if (!activeRuntime || activeRuntime.conversationId !== req.params.id) {
    return res.status(404).json({ error: "Conversation not found or not active." });
  }
  if (turnRunning) {
    return res.status(409).json({ error: "A turn is already running. This system runs one turn at a time." });
  }
  // A conversation is mid-open/replace: the runtime that is "active" right now
  // is the OLD one, about to be torn down. Starting a turn on it would let
  // createConversationInternal's prev.close() pull the context out from under
  // a running turn. Reject until the swap completes.
  if (conversationOpening) {
    return res.status(409).json({ error: "A conversation is currently being opened. Try again in a moment." });
  }

  const { turnId, turnIndex, takeover } = await startTurn({ conversationId: req.params.id, activeRuntime, question });
  res.json({ session_id: turnId, turn_index: turnIndex, takeover });
});

app.post("/api/conversations/:id/close", async (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });

  const activeRuntime = conversationRuntime.getActiveRuntime();
  if (activeRuntime && activeRuntime.conversationId === req.params.id) {
    // If a turn is still running (the user hit Stop / End session mid-turn),
    // abort it first - this cancels the in-flight VLM call and ends the turn -
    // then wait for it to unwind before tearing down the Playwright context, so
    // the in-flight runSession stops cleanly rather than hitting "context
    // closed" on its next page call. (Previously this rejected with 409 and
    // left the caller to stop-then-retry; the "stop and leave" flow closes in
    // one shot instead.)
    if (turnRunning) {
      for (const controller of stopControllers.values()) controller.abort();
      await waitForTurnToStop(8000);
    }
    // runtime.close() self-clears the active-runtime singleton, but only if
    // this is still the active one - so an explicit setActiveRuntime(null)
    // here would clobber a runtime that a concurrent POST /api/conversations
    // registered during the await. Let close() handle it.
    await activeRuntime.close();
  }
  res.json({ ok: true });
});

app.get("/api/conversations", (req, res) => {
  res.json(store.listConversationsWithSummary(50));
});

app.get("/api/conversations/:id", (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });

  const turns = store.getConversationTurns(req.params.id).map(buildSessionTrajectory);
  const takeovers = store.getTakeovers(req.params.id);
  res.json({ conversation, turns, takeovers });
});

// Backward-compatible shim (docs/LIVE_TAKEOVER_PLAN.md section 9, Phase B0
// item 6): internally creates a one-turn conversation and immediately starts
// a turn on it, but keeps responding with today's exact shape, {id}, so
// existing callers (frontend pre-migration, and anything else hitting this
// endpoint directly) don't break. Unlike the old handler, the dashboard load
// (inside createConversationInternal -> conversationRuntime.createRuntime)
// is awaited before responding - that's an inherent consequence of reusing
// the conversation-creation path, not a behavior this shim tries to hide.
app.post("/api/sessions", async (req, res) => {
  const { dashboard_url, dashboard_name, question } = req.body ?? {};
  if (!dashboard_url || !question) {
    return res.status(400).json({ error: "dashboard_url and question are required." });
  }
  if (turnRunning) {
    return res.status(409).json({ error: "A session is already running. This system runs one session at a time." });
  }

  let runtime;
  try {
    runtime = await createConversationInternal({ dashboardUrl: dashboard_url, dashboardName: dashboard_name });
  } catch (err) {
    const status = err.statusCode ?? 500;
    if (status !== 409) console.error("Failed to create conversation for /api/sessions:", err);
    return res.status(status).json({ error: err.message });
  }

  const { turnId } = await startTurn({ conversationId: runtime.conversationId, activeRuntime: runtime, question });
  res.json({ id: turnId });
});

app.post("/api/sessions/:id/stop", (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  // Abort the in-flight turn (if still running): flips shouldStop() AND cancels
  // any in-flight VLM request, so the orchestrator ends at the very next check
  // instead of waiting out a slow pixel-mode call. A no-op if the turn already
  // finished (controller removed in startTurn's finally).
  stopControllers.get(req.params.id)?.abort();
  res.json({ ok: true });
});

app.get("/api/sessions/:id/events", (req, res) => {
  if (!bus.hasBus(req.params.id)) {
    return res.status(404).json({ error: "No live session with that id. Use GET /api/sessions/:id to replay a finished one." });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  bus.subscribe(req.params.id, res);
  req.on("close", () => bus.unsubscribe(req.params.id, res));
});

// Live-view WebSocket (docs/LIVE_TAKEOVER_PLAN.md section 6.2): streams the
// active conversation's CDP screencast frames + viz geometry + lock/unlock to
// the viewer, and (Phase B2) accepts forwarded mouse/keyboard input. `ws` has
// no Express-style path params, so we match /api/conversations/:id/live
// manually on the HTTP upgrade event.
const LIVE_PATH_RE = /^\/api\/conversations\/([^/]+)\/live$/;

function attachLiveWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    const match = LIVE_PATH_RE.exec(pathname);
    if (!match) {
      // Not our endpoint - let it die cleanly rather than hanging the socket.
      socket.destroy();
      return;
    }
    // Origin check (B2, deferred from B1): mirrors the Express CORS
    // allowlist (FRONTEND_ORIGIN, same constant used by `cors({origin:
    // FRONTEND_ORIGIN})` above) so the two can't drift. Required now that the
    // socket accepts input, to prevent cross-site WebSocket hijacking (CSWSH)
    // driving the agent's browser. This also rejects a raw non-browser
    // WebSocket client with no Origin header - intended hardening, not a bug.
    if (req.headers.origin !== FRONTEND_ORIGIN) {
      socket.destroy();
      return;
    }
    const conversationId = decodeURIComponent(match[1]);
    const runtime = conversationRuntime.getActiveRuntime();
    if (!runtime || runtime.conversationId !== conversationId) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, conversationId);
    });
  });

  wss.on("connection", (ws, req, conversationId) => {
    // Attach an 'error' handler immediately: Node throws on an unhandled
    // socket 'error' event (crashing the process), and the close handshake in
    // the early-return branch below can emit one. Needed on ALL paths.
    ws.on("error", () => {});
    // The runtime can be torn down between upgrade and connection; re-check.
    const runtime = conversationRuntime.getActiveRuntime();
    if (!runtime || runtime.conversationId !== conversationId) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    // Bind cleanup (and input forwarding) to THIS runtime instance, not a
    // later getActiveRuntime(): if the conversation is swapped while this
    // socket is still open, the socket must keep talking to the runtime it
    // actually joined.
    runtime.addClient(ws).catch(() => {});
    ws.on("close", () => runtime.removeClient(ws).catch(() => {}));
    ws.on("error", () => runtime.removeClient(ws).catch(() => {}));
    ws.on("message", (raw) => {
      // Phase B2: forwarded mouse/keyboard input. Malformed JSON is silently
      // dropped (never throws); dispatchInput is already internally safe
      // (never throws, self-gates on mode/lastVizBox) but the call is still
      // wrapped here as defense in depth, matching the rest of this file.
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        runtime.dispatchInput(parsed).catch(() => {});
      } catch {
        /* ignore */
      }
    });
  });
}

// BACKEND_PORT wins over config.json so a blocked port can be worked around
// without editing tracked files (the frontend proxy reads the same override).
const PORT = Number(process.env.BACKEND_PORT) || config.backendPort || 8990;

// hostPageOrigin is what Playwright navigates to for /host, so it has to point
// at the port we actually bound. Catching the mismatch here beats debugging a
// blank Tableau embed later.
const hostPagePort = Number(new URL(config.hostPageOrigin).port);
if (hostPagePort !== PORT) {
  console.error(
    `config mismatch: hostPageOrigin is ${config.hostPageOrigin} but the backend ` +
      `binds :${PORT}. Update hostPageOrigin in backend/config.json to match.`
  );
  process.exit(1);
}

// Windows hands 1024-15000 to Hyper-V/WinNAT on some machines (see
// `netsh interface ipv4 show excludedportrange protocol=tcp`); a bind inside a
// reserved range fails with EACCES, which reads like a permissions bug unless
// you know to look. Say so explicitly instead of dying on an unhandled event.
function explainListenError(err) {
  if (err.code === "EACCES") {
    console.error(
      `\nCannot bind 127.0.0.1:${PORT} - Windows has reserved it (EACCES).\n` +
        `Nothing is running there; the OS excluded the port from user binds.\n` +
        `  Check:  netsh interface ipv4 show excludedportrange protocol=tcp\n` +
        `  Fix:    see "Port 8990 is blocked on Windows" in README.md\n` +
        `  Escape: BACKEND_PORT=<free port> npm run dev (also update hostPageOrigin)\n`
    );
  } else if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use - another backend is probably still running.\n` +
        `  Find it:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen\n`
    );
  } else {
    console.error(`Failed to listen on ${PORT}:`, err);
  }
  process.exit(1);
}

launchBrowser()
  .then((browser) => {
    sharedBrowser = browser;
    // Express runs this callback even when the bind failed, leaving address()
    // null - that is why a backend on a reserved port used to print a cheerful
    // "listening" banner and then serve nothing. Only claim success if we
    // really got the socket; the error handler below reports the failure.
    const httpServer = app.listen(PORT, "127.0.0.1", () => {
      if (!httpServer.address()) return;
      console.log(`dashboard-agent backend listening on http://127.0.0.1:${PORT}`);
      console.log(`host page: http://127.0.0.1:${PORT}/host?viz=<tableau-public-view-url>`);
    });
    httpServer.on("error", explainListenError);
    attachLiveWebSocket(httpServer);
  })
  .catch((err) => {
    console.error("Failed to launch shared browser:", err);
    process.exit(1);
  });
