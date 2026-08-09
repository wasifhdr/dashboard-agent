// Thin REST/SSE client. Relative URLs go through the Vite dev proxy to the
// backend (see vite.config.js), so no base URL or CORS handling is needed.

// A response body is NOT guaranteed to be JSON, even from our own endpoints:
// when the backend is down or mid-restart the Vite dev proxy answers with an
// empty 500 of its own. Calling res.json() on that throws "Failed to execute
// 'json' on 'Response': Unexpected end of JSON input", which then got rendered
// to the user as the reason the dashboard failed to open - hiding the real
// cause behind a parser message. Read the body defensively and let the caller
// report the status instead.
async function readJsonBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Shared shape for the mutating endpoints: parse if we can, and on failure
// prefer the backend's own { error } message, falling back to something that
// still says what happened.
async function jsonOrThrow(res, label) {
  const body = await readJsonBody(res);
  if (!res.ok) {
    const err = new Error(
      body?.error ||
        (body === null
          ? `${label} failed: ${res.status} — no readable response from the backend. Is it still running?`
          : `${label} failed: ${res.status}`),
    );
    err.status = res.status;
    throw err;
  }
  if (body === null) throw new Error(`${label} returned an empty response.`);
  return body;
}

export async function getConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`GET /api/config failed: ${res.status}`);
  return res.json();
}

export async function getDashboardsMeta() {
  const res = await fetch("/api/dashboards/meta");
  if (!res.ok) throw new Error(`GET /api/dashboards/meta failed: ${res.status}`);
  return res.json();
}

export async function getTtsConfig() {
  const res = await fetch("/api/tts/config");
  if (!res.ok) throw new Error(`GET /api/tts/config failed: ${res.status}`);
  return res.json();
}

// Returns WAV bytes for `text`, or throws — callers fall back to the browser's
// own speechSynthesis rather than surfacing an error, so TTS never hard-fails.
export async function synthesizeSpeech(text, signal) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).detail ?? "";
    } catch {
      // non-JSON error body — the status is enough
    }
    throw new Error(`POST /api/tts failed: ${res.status} ${detail}`.trim());
  }
  return res.blob();
}

export async function listSessions() {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
  return res.json();
}

export async function listStandaloneSessions() {
  const res = await fetch("/api/sessions/standalone");
  if (!res.ok) throw new Error(`GET /api/sessions/standalone failed: ${res.status}`);
  return res.json();
}

export async function getSession(id) {
  const res = await fetch(`/api/sessions/${id}`);
  if (!res.ok) throw new Error(`GET /api/sessions/${id} failed: ${res.status}`);
  return res.json();
}

export async function startSession({ dashboardUrl, dashboardName, question }) {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboard_url: dashboardUrl, dashboard_name: dashboardName, question }),
  });
  return jsonOrThrow(res, "POST /api/sessions"); // { id }
}

export async function stopSession(id) {
  const res = await fetch(`/api/sessions/${id}/stop`, { method: "POST" });
  return jsonOrThrow(res, `POST /api/sessions/${id}/stop`); // { ok: true }
}

export async function createConversation({ dashboardUrl, dashboardName }) {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboard_url: dashboardUrl, dashboard_name: dashboardName }),
  });
  return jsonOrThrow(res, "POST /api/conversations"); // { conversation_id }
}

export async function postTurn(conversationId, question) {
  const res = await fetch(`/api/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return jsonOrThrow(res, `POST /api/conversations/${conversationId}/turns`); // { session_id, turn_index }
}

export async function getConversation(id) {
  const res = await fetch(`/api/conversations/${id}`);
  return jsonOrThrow(res, `GET /api/conversations/${id}`); // { conversation, turns, takeovers }
}

// Which conversation is live on the backend right now, if any. Always 200:
// { active: false } or { active: true, conversationId, dashboardUrl,
// dashboardName, turnRunning }. Used on boot to re-attach after a refresh.
export async function getActiveConversation() {
  const res = await fetch("/api/conversations/active");
  if (!res.ok) throw new Error(`GET /api/conversations/active failed: ${res.status}`);
  return res.json();
}

export async function listConversations() {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error(`GET /api/conversations failed: ${res.status}`);
  return res.json();
}

export async function closeConversation(id) {
  const res = await fetch(`/api/conversations/${id}/close`, { method: "POST" });
  return jsonOrThrow(res, `POST /api/conversations/${id}/close`); // { ok: true }
}

// Opens the live-view WebSocket for a conversation. The server streams
// screencast frames, viz geometry, and lock/unlock (Phase B1); the channel
// also accepts forwarded mouse/keyboard input via sendInput() (Phase B2),
// which the server dispatches against the shared page only while the
// conversation isn't mid-agent-turn. Dispatches each inbound message to the
// matching handler by its `type`. Returns { close(), sendInput(msg) }.
export function openLiveChannel(conversationId, handlers = {}) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/conversations/${conversationId}/live`);

  ws.onopen = () => handlers.onOpen?.();
  ws.onmessage = (msg) => {
    let evt;
    try {
      evt = JSON.parse(msg.data);
    } catch {
      return;
    }
    switch (evt.type) {
      case "frame":
        handlers.onFrame?.(evt.data);
        break;
      case "vizbox":
        handlers.onVizBox?.(evt.box, evt.viewport);
        break;
      case "lock":
        handlers.onLock?.();
        break;
      case "unlock":
        handlers.onUnlock?.();
        break;
      case "cursor":
        handlers.onCursor?.(evt.nx, evt.ny, evt.phase);
        break;
      case "closed":
        handlers.onClosed?.(evt.reason);
        break;
      case "inspection":
        handlers.onInspection?.(evt.verdict, evt.reasons);
        break;
      default:
        break;
    }
  };
  ws.onerror = () => handlers.onSocketError?.();
  ws.onclose = () => handlers.onClose?.();

  return {
    close() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    // Forwards one input message (see docs/LIVE_TAKEOVER_PLAN.md's B2 WS
    // client->server contract) as JSON. A no-op (never throws) when the
    // socket isn't open yet/anymore - e.g. mid-(re)connect, or after the
    // server closed it - matching the fire-and-forget nature of live input.
    sendInput(msg) {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* socket closing/erroring mid-send - drop */
      }
    },
  };
}

export function subscribeToSession(id, handlers) {
  const es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (msg) => {
    let evt;
    try {
      evt = JSON.parse(msg.data);
    } catch {
      return;
    }
    handlers.onEvent?.(evt);
  };
  es.onerror = () => {
    handlers.onError?.();
  };
  return () => es.close();
}
