import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BACKEND_ROOT, FRAMES_DIR } from "./paths.js";
import { launchBrowser } from "./perception.js";
import { runSession } from "./orchestrator.js";
import * as store from "./store.js";
import * as bus from "./sessionBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const config = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, "config.json"), "utf-8"));

fs.mkdirSync(FRAMES_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
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

app.get("/api/sessions/:id", (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });

  const steps = store.getSteps(req.params.id).map((s) => ({
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

  res.json({ session, steps });
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
let isRunning = false;
const stopRequests = new Set();

app.post("/api/sessions", (req, res) => {
  const { dashboard_url, dashboard_name, question } = req.body ?? {};
  if (!dashboard_url || !question) {
    return res.status(400).json({ error: "dashboard_url and question are required." });
  }
  if (isRunning) {
    return res.status(409).json({ error: "A session is already running. This system runs one session at a time." });
  }

  const sessionId = crypto.randomUUID();
  bus.createBus(sessionId);
  isRunning = true;

  res.json({ id: sessionId });

  runSession({
    browser: sharedBrowser,
    config,
    dashboardUrl: dashboard_url,
    dashboardName: dashboard_name ?? null,
    question,
    sessionId,
    onEvent: (evt) => adaptAndPublish(sessionId, evt),
    shouldStop: () => stopRequests.has(sessionId),
  })
    .catch((err) => {
      console.error(`Session ${sessionId} failed:`, err);
      // Safety net for a bug that escapes runSession's own error handling -
      // without this the session row would stay stuck at status='running'
      // forever and look like a hang in the History list.
      const errorMessage = `Unexpected error: ${err.message}`;
      store.finishSession(sessionId, { status: "error", error_message: errorMessage });
      bus.publish(sessionId, { type: "session_done", status: "error", final_answer: null, confidence: null, error: errorMessage });
    })
    .finally(() => {
      isRunning = false;
      stopRequests.delete(sessionId);
    });
});

app.post("/api/sessions/:id/stop", (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  stopRequests.add(req.params.id);
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

const PORT = config.backendPort ?? 8788;

launchBrowser()
  .then((browser) => {
    sharedBrowser = browser;
    app.listen(PORT, "127.0.0.1", () => {
      console.log(`dashboard-agent backend listening on http://127.0.0.1:${PORT}`);
      console.log(`host page: http://127.0.0.1:${PORT}/host?viz=<tableau-public-view-url>`);
    });
  })
  .catch((err) => {
    console.error("Failed to launch shared browser:", err);
    process.exit(1);
  });
