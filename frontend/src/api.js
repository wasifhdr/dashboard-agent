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
