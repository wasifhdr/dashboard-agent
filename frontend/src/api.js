// Thin REST/SSE client. Relative URLs go through the Vite dev proxy to the
// backend (see vite.config.js), so no base URL or CORS handling is needed.

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
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `POST /api/sessions failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body; // { id }
}

export async function stopSession(id) {
  const res = await fetch(`/api/sessions/${id}/stop`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `POST /api/sessions/${id}/stop failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body; // { ok: true }
}

export async function createConversation({ dashboardUrl, dashboardName }) {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dashboard_url: dashboardUrl, dashboard_name: dashboardName }),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `POST /api/conversations failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body; // { conversation_id }
}

export async function postTurn(conversationId, question) {
  const res = await fetch(`/api/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `POST /api/conversations/${conversationId}/turns failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body; // { session_id, turn_index }
}

export async function getConversation(id) {
  const res = await fetch(`/api/conversations/${id}`);
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `GET /api/conversations/${id} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body; // { conversation, turns, takeovers }
}

export async function listConversations() {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error(`GET /api/conversations failed: ${res.status}`);
  return res.json();
}

export async function closeConversation(id) {
  const res = await fetch(`/api/conversations/${id}/close`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `POST /api/conversations/${id}/close failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body; // { ok: true }
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
