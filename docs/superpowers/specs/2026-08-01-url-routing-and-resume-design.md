# URL Routing and Live-Session Resume

**Date:** 2026-08-01
**Status:** Approved, not yet implemented

## Problem

Refreshing the browser while inside a dashboard session drops the user back on
the landing page. `App.jsx` keeps the current screen in `useState("landing")`
with no URL and no persistence, so a reload forgets everything: which screen you
were on, which dashboard you were working, and which replay you were reading.

There is no back/forward navigation either, and no way to link to a replay.

## Key finding: the conversation survives the refresh

The backend does **not** tear anything down when the browser reloads.

- Nothing in the frontend runs on `beforeunload`.
- Unmounting `Watch` does not close the conversation. The only caller of
  `closeConversation` is `stopAndLeave()`, wired to the explicit "End session"
  control.
- `conversationRuntime` holds the Playwright context/page until an explicit
  close, a 30-minute idle timeout, a page crash, or until a *new* conversation
  replaces it (`server.js` closes the previous runtime when one is created).

So after a refresh the dashboard is still open server-side; the browser has
merely lost its pointer to it. This is a genuine re-attach, not a UI-state
restore.

It also means the comment at `App.jsx:21-27` — "Leaving the Watch view tears the
live session down — the backend closes the shared browser and the conversation
is over" — **does not describe what the code does**. Navigating from a live
Watch to History and back today leaves an abandoned-but-live conversation.

## Non-goals

- Shareable links to a *live* conversation. It is machine-local and singleton;
  a URL for it is meaningless on another machine.
- Scroll restoration.
- Any change to how conversations are created, closed, or replaced.
- Server-side rendering or a production history-fallback config. Vite's dev
  server already serves the SPA fallback.

## Approach

Real client-side routing with **`react-router-dom`**, one new read-only backend
endpoint, and a resume path in `useSessionStream` that attaches to an existing
conversation instead of creating one.

`react-router-dom` was chosen over a hand-rolled `pushState` router because the
user asked for working back/forward, and history handling is where the subtle
bugs live. It is the only new dependency.

### Routes

| Path | Screen |
|---|---|
| `/` | Landing |
| `/watch` | Live conversation |
| `/history` | History |
| `/replay/c/:id` | Replay of a conversation |
| `/replay/s/:id` | Replay of a standalone session |
| anything else | redirect to `/` |

The two replay routes correspond to today's `replayTarget.kind` values
(`"conversation"` and `"session"`), which `History.jsx` constructs and `App.jsx`
consumes. Splitting them into two routes removes that discriminator object.

**`/watch` carries no id, deliberately.** The runtime is a singleton — one
conversation at a time, enforced by a mutex — so "the live one" is unambiguous.
An id could not be in the URL anyway: `openWatch(target)` navigates *before* a
conversation exists, because `ensureConversation()` creates it lazily on the
first render or first question.

### Component 1 — `GET /api/conversations/active` (new)

Read-only. Exposes what `server.js` already tracks internally via
`conversationRuntime.getActiveRuntime()`.

Response when a conversation is live:

```json
{
  "active": true,
  "conversationId": "<uuid>",
  "dashboardUrl": "https://public.tableau.com/views/...",
  "dashboardName": "Video Game Sales",
  "turnRunning": false
}
```

When none is live: `{ "active": false }`, HTTP 200. Absence of a conversation is
a normal state, not an error.

`turnRunning` comes from the module-level `turnRunning` flag in `server.js`.

### Component 2 — resume path in `useSessionStream`

`useSessionStream(mode, { sessionId, conversationId, dashboardUrl, dashboardName })`
gains one additional live-mode entry point: **attach to an existing
conversation**.

When `/watch` resolves an active conversation, the hook must:

1. Set `conversationIdRef.current` to the resolved id directly.
2. Load persisted turns from `GET /api/conversations/:id` (returns
   `{ conversation, turns, takeovers }`) and render them as the thread.
3. **Skip `ensureConversation()` entirely.** This is load-bearing: that function
   POSTs `/api/conversations`, and `server.js` closes the previous runtime when
   a new conversation is created — so calling it on resume would destroy the
   session being resumed and reload the dashboard from scratch.
4. If `turnRunning` was true, subscribe to the newest turn's session id via the
   existing `subscribeLive(...)`. `sessionBus` buffers per-session events and
   replays them to a late subscriber, which is the same mechanism the existing
   "live re-attach" path uses — no new transport work.

`useLiveChannel` needs no change: it already keys on `conversationId` and opens
the screencast WebSocket once that id exists.

### Component 3 — `App.jsx` becomes routes

`view`, `watchTarget`, and `replayTarget` state disappear, replaced by routes and
route params. `watchHasActiveRun` and `watchDashboard` stay — they feed the
header and are not navigation state.

`navigate(nextView)` / `openWatch` / `openReplay` / `endLiveWatch` become
`useNavigate()` calls to the paths above. `AppShell`'s nav buttons call the same.

### Component 4 — remove the navigation confirm

`confirmLeaveLiveWatch()` and its call in `navigate()` are deleted.

The dialog exists because leaving was believed to be destructive. It is not:
nothing on unmount closes the conversation, and with routing in place leaving is
plainly recoverable — navigate back to `/watch` and the session is rejoined. A
confirmation that misdescribes what happens is worse than none.

**"End session" keeps its confirm.** `handleEndSession` in `Watch.jsx` calls
`stream.stopAndLeave()`, which really does close the runtime.

Removing this also avoids needing `useBlocker` to intercept browser-back, which
would force a `createBrowserRouter` refactor for no benefit.

The inaccurate comment at `App.jsx:21-27` is deleted with the code it describes.

## Error handling

- **`/watch` with no live conversation** — redirect to `/`. This is the normal
  outcome of refreshing long after a session ended or idled out.
- **`/replay/c/:id` or `/replay/s/:id` with an unknown id** — `Watch` already
  surfaces `loadError` from a failed fetch ("Failed to load session: …"); the
  404 from the existing endpoints flows into it unchanged.
- **`/api/conversations/active` unreachable** — treat as no active conversation
  and redirect to `/`. The landing page must always be reachable.
- **Resume while a turn is running** — the thread renders persisted turns and
  the in-flight turn re-attaches through the bus. If the turn completes between
  the `active` call and the subscribe, the bus replay still delivers its events,
  because the buffer is not cleared on completion.

## Testing

- **Unit** — the `/api/conversations/active` handler against a stubbed
  `getActiveRuntime()`: active, absent, and turn-running cases.
- **Manual, the reported bug** — open a dashboard, ask a question, refresh.
  Expect: the same dashboard, the same thread, live view reconnected, no new
  Playwright page opened (confirm in the backend log that no second dashboard
  load occurs).
- **Manual, mid-turn refresh** — ask a question and refresh while the agent is
  working. Expect the in-flight turn to re-attach and complete in the UI.
- **Manual, back/forward** — Landing → Watch → History, then browser back twice.
  Expect no confirmation dialog and no lost session; forward returns to Watch
  with the conversation still live.
- **Manual, stale `/watch`** — end a session, then navigate to `/watch`
  directly. Expect a redirect to `/`.
- **Manual, replay deep link** — copy a `/replay/c/:id` URL, reload it, confirm
  it renders.

## Open risks

- `react-router-dom` is a new dependency in a frontend that currently has none
  for routing.
- The resume path adds a second way into live mode. If a future change routes
  resume back through `ensureConversation()`, it will silently destroy the
  session it is resuming — worth a comment at that call site.
