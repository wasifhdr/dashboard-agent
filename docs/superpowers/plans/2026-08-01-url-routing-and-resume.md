# URL Routing and Live-Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app real URLs so refresh, back/forward, and replay deep links work — and make a refresh inside a live dashboard re-attach to the still-running conversation instead of dropping to the landing page.

**Architecture:** `react-router-dom` replaces the `view` state machine in `App.jsx` with four routes. A new read-only `GET /api/conversations/active` exposes the singleton runtime the backend already tracks. On landing at `/watch`, the app asks that endpoint and, if a conversation is live, resumes it by reusing the existing conversation-loading branch in `useSessionStream` — deliberately skipping conversation *creation*, which would close the very session being resumed.

**Tech Stack:** React 18, Vite, `react-router-dom` (new), Express 5, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-01-url-routing-and-resume-design.md`

## Global Constraints

- `react-router-dom` is the **only** new dependency permitted. The APIs used (`BrowserRouter`, `Routes`, `Route`, `Navigate`, `useNavigate`, `useParams`, `useLocation`) are identical in v6 and v7.
- Do not modify the frozen agent core: `backend/src/vlmClient.js`, `actionSchema.js`, `actuator.js`, `perception.js`, `backend/eval/`.
- Backend is ESM (`"type": "module"`); relative imports need the `.js` extension.
- Backend tests run from `backend/` via `npm test`. Currently **50/50**; must stay green.
- Frontend must build clean: `npm run build` from `frontend/`.
- `GET /api/conversations/active` returns **HTTP 200 whether or not a conversation is live** — "none active" is a normal state, not an error.
- The resume path must **never** call `ensureConversation()` / `POST /api/conversations`. Creating a conversation makes `server.js` close the previous runtime, which would destroy the session being resumed and silently reload the dashboard.
- Routes: `/` Landing · `/watch` live · `/history` History · `/replay/c/:id` conversation replay · `/replay/s/:id` session replay · anything else redirects to `/`.
- Work happens on branch `main`.

---

### Task 1: `GET /api/conversations/active`

Exposes the active-runtime state `server.js` already tracks internally.

**Files:**
- Create: `backend/src/activeConversation.js`
- Create: `backend/test/activeConversation.test.js`
- Modify: `backend/src/server.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `describeActiveConversation(runtime, turnRunning) -> object` (pure), and the route `GET /api/conversations/active`. Task 3 consumes the route.

The pure function is separated from the route so it can be unit-tested without standing up Express or Playwright.

- [ ] **Step 1: Write the failing test**

Create `backend/test/activeConversation.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { describeActiveConversation } from "../src/activeConversation.js";

test("no runtime means no active conversation", () => {
  assert.deepEqual(describeActiveConversation(null, false), { active: false });
  assert.deepEqual(describeActiveConversation(undefined, true), { active: false });
});

test("an active runtime is described in full", () => {
  const runtime = {
    conversationId: "abc-123",
    dashboardUrl: "https://public.tableau.com/views/Book/Sheet",
    dashboardName: "Video Game Sales",
  };
  assert.deepEqual(describeActiveConversation(runtime, false), {
    active: true,
    conversationId: "abc-123",
    dashboardUrl: "https://public.tableau.com/views/Book/Sheet",
    dashboardName: "Video Game Sales",
    turnRunning: false,
  });
});

test("turnRunning is reported and always a boolean", () => {
  const runtime = { conversationId: "x", dashboardUrl: "u", dashboardName: null };
  assert.equal(describeActiveConversation(runtime, true).turnRunning, true);
  assert.equal(describeActiveConversation(runtime, undefined).turnRunning, false);
});

test("a missing dashboard name is null, not undefined", () => {
  const runtime = { conversationId: "x", dashboardUrl: "u" };
  const out = describeActiveConversation(runtime, false);
  assert.equal(out.dashboardName, null);
  assert.ok("dashboardName" in out);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && node --test test/activeConversation.test.js
```

Expected: FAIL — `Cannot find module '../src/activeConversation.js'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/activeConversation.js`:

```js
// Shape of GET /api/conversations/active. Split out of server.js so the
// decision is unit-testable without an Express app or a live Playwright
// runtime.
//
// "No conversation is active" is a completely normal state (nothing has been
// opened yet, or the last one was closed), so it is reported as data with a
// 200 - never as an error status.

export function describeActiveConversation(runtime, turnRunning) {
  if (!runtime) return { active: false };
  return {
    active: true,
    conversationId: runtime.conversationId,
    dashboardUrl: runtime.dashboardUrl,
    dashboardName: runtime.dashboardName ?? null,
    turnRunning: Boolean(turnRunning),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && node --test test/activeConversation.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Add the route**

In `backend/src/server.js`, add to the imports near the other `./` imports:

```js
import { describeActiveConversation } from "./activeConversation.js";
```

Then add this route **immediately before** the existing `app.get("/api/conversations/:id", ...)` handler. Order matters: Express 5 matches in registration order, and a route registered after `/api/conversations/:id` would never be reached — `:id` would capture the literal string `"active"`.

```js
// Which conversation (if any) is live right now. The runtime is a singleton,
// so this is unambiguous. Used by the frontend on boot to re-attach to a
// running session after a page refresh instead of stranding it.
//
// MUST stay registered before /api/conversations/:id, or that route captures
// "active" as an id.
app.get("/api/conversations/active", (req, res) => {
  res.json(describeActiveConversation(conversationRuntime.getActiveRuntime(), turnRunning));
});
```

- [ ] **Step 6: Verify the route by hand**

Start the backend in the background from `backend/` with `node src/server.js`, wait for `dashboard-agent backend listening on http://127.0.0.1:8990`, then:

```bash
curl -s -w "\nHTTP:%{http_code}\n" "http://127.0.0.1:8990/api/conversations/active"
```

Expected: `{"active":false}` and `HTTP:200` (no conversation has been opened).

Confirm the ordering fix works — this must NOT 404 or return a conversation row:

```bash
curl -s "http://127.0.0.1:8990/api/conversations/active" | head -c 200
```

Expected: the same `{"active":false}`, **not** `{"error":"Conversation not found."}`. Seeing the error means the route was registered after `/api/conversations/:id`.

Stop the backend.

- [ ] **Step 7: Run the full suite**

```bash
cd backend && npm test
```

Expected: PASS, 54 tests (50 existing + 4 new).

- [ ] **Step 8: Commit**

```bash
git add backend/src/activeConversation.js backend/test/activeConversation.test.js backend/src/server.js
git commit -m "feat(api): expose GET /api/conversations/active"
```

---

### Task 2: Routes replace the view state machine

Converts navigation to URLs. After this task, refresh works on `/`, `/history`, and both replay routes; `/watch` still redirects to `/` on refresh (resume lands in Task 3).

**Files:**
- Modify: `frontend/package.json` (add dependency)
- Modify: `frontend/src/main.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/AppShell.jsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the route table. Task 3 replaces the `/watch` element's body.

- [ ] **Step 1: Install the dependency**

```bash
npm install react-router-dom --prefix frontend
```

- [ ] **Step 2: Wrap the app in a router**

In `frontend/src/main.jsx`, add the import and wrap `<App />`:

```jsx
import { BrowserRouter } from "react-router-dom";
```

```jsx
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

- [ ] **Step 3: Rewrite `App.jsx` as routes**

Replace the entire contents of `frontend/src/App.jsx` with:

```jsx
import { useState } from "react";
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from "react-router-dom";
import AppShell from "./components/AppShell.jsx";
import ConfirmDialog, { useConfirm } from "./components/ui/ConfirmDialog.jsx";
import Landing from "./screens/Landing/Landing.jsx";
import Watch from "./screens/Watch/Watch.jsx";
import History from "./screens/History/History.jsx";

// Maps a pathname back to the coarse "view" AppShell styles itself around.
// AppShell only needs to know which of the three layouts to use, not the
// specific route.
function viewForPath(pathname) {
  if (pathname.startsWith("/watch") || pathname.startsWith("/replay")) return "watch";
  if (pathname.startsWith("/history")) return "history";
  return "landing";
}

function ConversationReplay({ onActiveRunChange, onDashboardChange }) {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <Watch
      mode="replay"
      conversationId={id}
      onBack={() => navigate("/history")}
      onActiveRunChange={onActiveRunChange}
      onDashboardChange={onDashboardChange}
    />
  );
}

function SessionReplay({ onActiveRunChange, onDashboardChange }) {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <Watch
      mode="replay"
      sessionId={id}
      onBack={() => navigate("/history")}
      onActiveRunChange={onActiveRunChange}
      onDashboardChange={onDashboardChange}
    />
  );
}

// Live watch. The dashboard to open arrives as router location state from
// Landing (history.state, so it survives a reload). Task 3 replaces this body
// with the resume-aware version; today a refresh with no state redirects home.
function LiveWatch({ onActiveRunChange, onDashboardChange, onEnd, confirm }) {
  const location = useLocation();
  const target = location.state?.dashboard ?? null;
  if (!target) return <Navigate to="/" replace />;
  return (
    <Watch
      mode="live"
      dashboardTarget={target}
      onActiveRunChange={onActiveRunChange}
      onEnd={onEnd}
      confirm={confirm}
      onDashboardChange={onDashboardChange}
    />
  );
}

export default function App() {
  const [watchHasActiveRun, setWatchHasActiveRun] = useState(false);
  // The live dashboard {name, url} Watch is currently showing, surfaced in the
  // top header as a clickable link. Null outside the watch/replay views.
  const [watchDashboard, setWatchDashboard] = useState(null);
  const [confirm, confirmProps] = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  const view = viewForPath(location.pathname);

  // Navigation no longer confirms. Leaving a live watch does NOT end the
  // conversation - nothing on unmount closes it - and with routing in place
  // the exit is recoverable: navigate back to /watch and the still-running
  // session is re-attached. "End session" inside Watch keeps its own confirm,
  // because that one really does close the runtime.
  function handleNavigate(nextView) {
    setWatchHasActiveRun(false);
    setWatchDashboard(null);
    navigate(nextView === "history" ? "/history" : "/");
  }

  function endLiveWatch() {
    setWatchHasActiveRun(false);
    setWatchDashboard(null);
    navigate("/");
  }

  const watchProps = {
    onActiveRunChange: setWatchHasActiveRun,
    onDashboardChange: setWatchDashboard,
  };

  return (
    <AppShell view={view} onNavigate={handleNavigate} headerCenter={view === "watch" ? watchDashboard : null}>
      <Routes>
        <Route
          path="/"
          element={<Landing onOpenWatch={(target) => navigate("/watch", { state: { dashboard: target } })} />}
        />
        <Route path="/watch" element={<LiveWatch {...watchProps} onEnd={endLiveWatch} confirm={confirm} />} />
        <Route path="/replay/c/:id" element={<ConversationReplay {...watchProps} />} />
        <Route path="/replay/s/:id" element={<SessionReplay {...watchProps} />} />
        <Route
          path="/history"
          element={
            <History
              onOpenReplay={(t) => navigate(t.kind === "conversation" ? `/replay/c/${t.id}` : `/replay/s/${t.id}`)}
              onGoToLanding={() => navigate("/")}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ConfirmDialog {...confirmProps} />
    </AppShell>
  );
}
```

Note what was deliberately deleted: `view`/`watchTarget`/`replayTarget` state, `confirmLeaveLiveWatch()`, `isLiveWatch`, and the comment block at the old lines 21-27 that described a teardown the code never performed.

- [ ] **Step 4: Leave `AppShell.jsx` alone except to confirm its contract**

`AppShell` already takes `view` and `onNavigate(nextView)` and calls `onNavigate("landing")` / `onNavigate("history")`. `handleNavigate` above accepts exactly those strings, so **no change to `AppShell.jsx` is required.** Read it to confirm no other view string is passed:

```bash
grep -n "onNavigate(" frontend/src/components/AppShell.jsx
```

Expected: only `onNavigate("landing")` and `onNavigate(view === "history" ? "landing" : "history")`. If any other string appears, extend `handleNavigate` to map it.

- [ ] **Step 5: Build**

```bash
npm run build --prefix frontend
```

Expected: `✓ built in …`, no errors.

- [ ] **Step 6: Verify in the browser**

Start the backend in the background from `backend/` (`node src/server.js`), then `preview_start({name: "frontend"})`.

1. Landing renders at `/`.
2. Click History — URL becomes `/history`, list renders. **Refresh** — still on History.
3. Open a past conversation — URL becomes `/replay/c/<id>`. **Refresh** — the replay still renders.
4. Browser **back** returns to `/history`; **forward** returns to the replay.
5. Navigate to `http://localhost:5173/nonsense` — redirects to `/`.
6. From Landing, open a dashboard — URL becomes `/watch` and the live session starts. Leaving via "New dashboard" shows **no confirmation dialog**.
7. `read_console_messages` — no errors.

Refreshing on `/watch` redirecting to `/` is **expected at this task** and is fixed in Task 3.

Stop both when done.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/main.jsx frontend/src/App.jsx
git commit -m "feat(ui): real URLs for landing, history and replays"
```

---

### Task 3: Resume the live conversation on `/watch`

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/screens/Watch/useSessionStream.js`
- Modify: `frontend/src/App.jsx` (the `LiveWatch` component from Task 2)

**Interfaces:**
- Consumes: `GET /api/conversations/active` from Task 1; the `LiveWatch` component from Task 2.
- Produces: `getActiveConversation()` in `api.js`; a `resumeConversationId` option on `useSessionStream`.

**Why this reuses the replay branch.** `useSessionStream`'s effect at roughly lines 476-574 already has a `replayConversationId` branch that calls `getConversation(id)`, sets the dashboard, builds `runs` from turns and takeovers, and calls `subscribeLive(...)` when the last turn is still `running`. That is exactly what a resume needs. Resume differs in only four ways: `mode` is `"live"`, the conversation id must be written into `conversationIdRef`/`conversationId` state, `ensureConversation()` must be suppressed, and a **zero-turn conversation is valid** (you opened a dashboard and refreshed before asking anything) rather than the load error replay reports.

- [ ] **Step 1: Add the API client function**

In `frontend/src/api.js`, add next to the other conversation helpers:

```js
// Which conversation is live on the backend right now, if any. Always 200:
// { active: false } or { active: true, conversationId, dashboardUrl,
// dashboardName, turnRunning }. Used on boot to re-attach after a refresh.
export async function getActiveConversation() {
  const res = await fetch("/api/conversations/active");
  if (!res.ok) throw new Error(`GET /api/conversations/active failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Accept a resume id in `useSessionStream`**

Find the hook's options destructuring (the second parameter, alongside `sessionId`, `conversationId`, `dashboardUrl`, `dashboardName`) and add `resumeConversationId`. The existing `conversationId` option is the **replay** id — do not reuse it; a resumed conversation is live and drives the composer, a replayed one does not.

Then make three edits inside the hook:

**(a) Seed the conversation id.** Immediately after the `conversationIdRef` / `conversationId` state declarations (around line 212), add:

```js
  // Resume (page refresh into a still-running conversation): adopt the
  // existing conversation instead of creating one. Seeded synchronously so
  // the eager-open effect below sees it and stands down, and so the live
  // channel connects on the first render rather than a tick later.
  if (resumeConversationId && conversationIdRef.current === null) {
    conversationIdRef.current = resumeConversationId;
  }
```

**(b) Suppress conversation creation.** In the eager-open effect (around line 441), add the resume guard:

```js
  useEffect(() => {
    if (mode !== "live" || !dashboard?.url) return;
    // Never create a conversation while resuming one. POST /api/conversations
    // makes the server close the previous runtime - it would tear down the
    // very session being resumed and silently reload the dashboard.
    if (resumeConversationId) return;
    ensureConversation().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dashboard?.url, resumeConversationId]);
```

**(c) Let the loading effect run in live mode.** This is the easiest step to miss and nothing works without it. The effect that loads a conversation opens with a hard gate (around line 470):

```js
  useEffect(() => {
    if (mode !== "replay") return undefined;
```

In live mode it returns immediately, so the branch edited in (d) below would never execute. Change that line to:

```js
  useEffect(() => {
    // Also runs for a live resume, which needs exactly the same load: fetch
    // the conversation, rebuild the thread, re-attach to a running turn.
    if (mode !== "replay" && !resumeConversationId) return undefined;
```

The four reset calls immediately below it (`setDashboard(null)`, `setRuns([])`, `setLoadError(null)`, `setTrailingTakeover(null)`) are correct for resume too — the fetch repopulates them.

**(d) Load the existing turns.** Change the loading effect's branch condition and its dependency array. The branch currently reads `if (replayConversationId) {`; make it load for either id, and treat zero turns as an error only for replay:

```js
    const loadConversationId = replayConversationId ?? resumeConversationId;
    if (loadConversationId) {
      getConversation(loadConversationId)
        .then(({ conversation, turns, takeovers }) => {
          if (cancelled) return;
          if (turns.length === 0) {
            // Resuming a conversation whose first question was never asked is
            // normal - show the live dashboard with an empty thread. In pure
            // replay there is nothing to render, so it stays an error.
            if (resumeConversationId) {
              setDashboard({ url: conversation.dashboard_url, name: conversation.dashboard_name });
              return;
            }
            setLoadError("This conversation has no turns yet — there is nothing to replay.");
            return;
          }
```

Leave the rest of the branch body unchanged. Update the dependency array at the end of that effect from `[mode, sessionId, replayConversationId]` to:

```js
  }, [mode, sessionId, replayConversationId, resumeConversationId]);
```

**(e) Mirror the id into state** so the live WebSocket channel connects. Inside the same `.then(...)`, right after the `setDashboard(...)` call that runs for the non-empty case, add:

```js
          if (resumeConversationId) setConversationId(resumeConversationId);
```

and add the same line in the zero-turn resume branch from (d), before its `return`.

**(f) Fix the thumbnail / example-question lookup for resume.** The metadata effect (around line 454) reads:

```js
        const targetUrl = mode === "live" ? dashboardUrl : dashboard?.url;
```

On a resume there is no `dashboardUrl` prop — the URL arrives later from `getConversation` — so this would resolve to `undefined` and the resumed session would silently lose its example-question chips and thumbnail. Change it to fall back:

```js
        // On a resume there is no dashboardUrl prop; the url arrives from the
        // fetched conversation instead.
        const targetUrl = mode === "live" ? (dashboardUrl ?? dashboard?.url) : dashboard?.url;
```

- [ ] **Step 3: Pass it through from `Watch.jsx`**

`Watch` already forwards its props into the hook. Add `resumeConversationId` to the component's props and to the hook options object:

```jsx
  const stream = useSessionStream(mode, {
    sessionId,
    conversationId,
    resumeConversationId,
    dashboardUrl: dashboardTarget?.url,
    dashboardName: dashboardTarget?.name,
  });
```

and add `resumeConversationId` to the destructured props in the `export default function Watch({ ... })` signature.

- [ ] **Step 4: Make `/watch` resolve the active conversation**

In `frontend/src/App.jsx`, replace the `LiveWatch` component from Task 2 with:

```jsx
// Live watch. On mount, ask the backend whether a conversation is already
// running: after a refresh one usually is, and re-attaching to it preserves
// the open dashboard, its filters, and the thread. Only when nothing is live
// do we open the dashboard carried in router location state (set by Landing,
// and preserved across reloads because it lives in history.state).
function LiveWatch({ onActiveRunChange, onDashboardChange, onEnd, confirm }) {
  const location = useLocation();
  const [resolved, setResolved] = useState(null); // null = still checking

  useEffect(() => {
    let cancelled = false;
    getActiveConversation()
      .then((info) => {
        if (cancelled) return;
        setResolved(info.active ? { resume: info.conversationId } : { resume: null });
      })
      .catch(() => {
        // Backend unreachable: fall back to whatever the URL carried rather
        // than stranding the user on a spinner.
        if (!cancelled) setResolved({ resume: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (resolved === null) return <div className="p-6 text-sm text-fg/60">Reconnecting…</div>;

  if (resolved.resume) {
    return (
      <Watch
        mode="live"
        resumeConversationId={resolved.resume}
        onActiveRunChange={onActiveRunChange}
        onEnd={onEnd}
        confirm={confirm}
        onDashboardChange={onDashboardChange}
      />
    );
  }

  const target = location.state?.dashboard ?? null;
  if (!target) return <Navigate to="/" replace />;
  return (
    <Watch
      mode="live"
      dashboardTarget={target}
      onActiveRunChange={onActiveRunChange}
      onEnd={onEnd}
      confirm={confirm}
      onDashboardChange={onDashboardChange}
    />
  );
}
```

Add the imports this needs at the top of `App.jsx`:

```jsx
import { useState, useEffect } from "react";
import { getActiveConversation } from "./api.js";
```

- [ ] **Step 5: Build**

```bash
npm run build --prefix frontend
```

Expected: `✓ built in …`, no errors.

- [ ] **Step 6: Verify the reported bug is fixed**

Backend in the background, `preview_start({name: "frontend"})`.

1. From Landing, open **Video Game Sales**. Wait for the dashboard to render.
2. Ask: *In the Top 5 Publishers chart, which publisher has the highest total sales?* Wait for **Nintendo**.
3. **Refresh the page.**

Expected: you land back in the same session — same dashboard, the Nintendo turn still in the thread, live view reconnected. **Critically, check the backend log: there must be no second dashboard load.** A new `[viability]` line or a fresh Playwright open means resume fell through to creation and the session was replaced.

4. Ask a follow-up question. It must run on the resumed conversation.

- [ ] **Step 7: Verify the remaining cases**

- **Mid-turn refresh** — ask a question and refresh while the agent is working. Expect the in-flight turn to re-attach and finish in the UI.
- **Refresh before asking anything** — open a dashboard, refresh before typing. Expect the dashboard with an empty thread, not a load error and not a redirect.
- **Stale `/watch`** — end the session with "End session", then navigate to `http://localhost:5173/watch` directly. Expect a redirect to `/`.
- `read_console_messages` and `read_network_requests` — no errors; exactly one `GET /api/conversations/active` per `/watch` mount.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api.js frontend/src/screens/Watch/useSessionStream.js frontend/src/screens/Watch/Watch.jsx frontend/src/App.jsx
git commit -m "feat(ui): resume the live conversation after a refresh"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Update `README.md`**

In the "What it does" bullet list, add this item after the "Take the wheel mid-conversation" bullet:

```markdown
- **Refresh without losing your place.** The dashboard is held open server-side, so reloading the page re-attaches to the running session rather than starting over — including mid-question. Replays have real URLs you can bookmark or share.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Add this row to the backend module map, directly after the `tableauSearch.js` row:

```markdown
| `activeConversation.js` | Pure shaping of `GET /api/conversations/active` (`{active:false}` or `{active:true, conversationId, dashboardUrl, dashboardName, turnRunning}`). Split out of `server.js` so the decision is unit-testable without Express or Playwright. |
```

Append this sentence to the `server.js` row's description:

```markdown
`/api/conversations/active` MUST stay registered before `/api/conversations/:id`, or the `:id` route captures the literal string "active".
```

Add these two bullets to the "Non-obvious gotchas" list:

```markdown
- **The resume path must never call `ensureConversation()`** — `POST /api/conversations` makes the server close the previous runtime, so "simplifying" the two live-mode entry points in `useSessionStream` into one destroys the session being resumed. The symptom is a dashboard that silently reloads and loses its filters, not an error.
- **Navigating away from a live Watch does not close the conversation** — only "End session" does (`stopAndLeave` → `POST /api/conversations/:id/close`). An abandoned conversation survives until the 30-minute `conversationIdleMs` timer, which only runs while no WebSocket client is connected *and* no turn is in flight. Closing the tab mid-turn therefore lets the agent keep working, and keep billing, with nobody watching.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: record URL routing and live-session resume"
```

---

## Notes for the implementer

- **Route order is load-bearing** in Task 1. Express 5 matches in registration order, so `/api/conversations/active` registered after `/api/conversations/:id` would never fire — `:id` swallows `"active"` and you get a 404 from a database lookup for a conversation named "active".
- **The resume-vs-create distinction is the whole feature.** Every guard in Task 3 exists to keep `POST /api/conversations` from running on a resume. If you find yourself deleting one of those guards to simplify, you are re-introducing the bug.
- **Location state survives reload.** `navigate("/watch", { state: … })` stores into `history.state`, which persists across a refresh. That is why the resume check must run *first* — otherwise a refresh would find the old target in location state and open a second conversation.
- **Zero-turn conversations are real.** A conversation row is persisted as soon as the dashboard opens, before any question. Replay treats that as an error; resume must not.
