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

export async function listSessions() {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
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

// Opens the live-view WebSocket for a conversation (Phase B1). Receive-only:
// the server streams screencast frames, viz geometry, and lock/unlock; there
// are no client->server messages in B1 (user input is B2). Dispatches each
// message to the matching handler by its `type`. Returns { close() }.
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
