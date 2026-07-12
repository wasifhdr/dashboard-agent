# Live Takeover & Multi-Turn Conversations — Build Plan (v1)

**Audience:** the implementing coding agent (Sonnet) and the project owner.
**Working directory:** `D:\NSU\10th semester\CSE499B.17\dashboard-agent\` (this repo).
**Status:** proposed / not started. Extends the *built* system (AGENT_PLAN Phases 0–3, FRONTEND_PLAN F0–F5).

This plan is grounded in the current code as of writing. Where it names a function or file, that thing exists today — verify before you change it, and if the running app diverges, trust the app and fix this doc (per CLAUDE.md).

---

## 1. What we are building

Today a session is **one question → one answer**, run by the agent in a Playwright browser the user never touches, streamed to the viewer as **per-step screenshots**. The dashboard is opened fresh for every question and its browser context is closed when the answer lands.

We are turning that into a **live, multi-turn conversation on one persistent dashboard**, where:

1. **The dashboard's browser context stays alive for the whole conversation.** Question 2 resumes from wherever Question 1 left the dashboard — no reload.
2. **The user watches a live video** of the agent's actual browser (CDP screencast), not just discrete frames.
3. **Between turns, the user can take the wheel** — click filters, switch tabs, drag range sliders — directly in that same live browser, via forwarded mouse/keyboard input.
4. **Turn-based lock:** while the agent is working, user input is blocked; when the agent finishes, input unlocks. Only one actor drives at a time. (User's decision — this dissolves the concurrency problem.)
5. **The agent resumes into whatever state the user left**, including manual edits, to answer the next question. Its reasoning memory (history, loop guard, inventory IDs) resets per question; the dashboard's physical state persists.
6. **The whole conversation is persisted to the DB** — every turn's full trajectory (as today) **plus** a record of each user-takeover's effect — and is fully replayable.

### Key architectural decision (do not deviate)

> **A "Conversation" owns exactly one long-lived Playwright context + page.** Every turn (agent question) and every takeover (user interaction) operates on that same page. The page is opened once when the conversation starts and closed once when it ends (explicit close or idle timeout). `runSession` no longer opens or closes the browser — the conversation runtime does.

This is the single biggest change and everything else hangs off it.

### What we persist vs. what we don't

- **Persisted (replayable):** per-step agent frames + overlays + inventory (exactly as today, unchanged), and per-takeover **before/after frames + inventory diff + Tableau event log slice**.
- **NOT persisted:** the raw live video stream, and raw user mouse/click coordinates. The live screencast is real-time only. A takeover is represented by its *effect* (what changed on the dashboard), which is meaningful and bounded — raw canvas clicks are neither.

---

## 2. Scope

**IN:**
- Persistent per-conversation browser context; N agent turns resuming into shared live state.
- Live CDP screencast of the agent's page, streamed to the viewer over WebSocket.
- Post-completion user takeover: forwarded mouse + keyboard, turn-based input lock.
- Full conversation persistence (conversations, turns, takeovers) + conversation replay.
- Lifecycle management: one active conversation at a time, idle timeout, explicit close.

**OUT (deferred — keep seams, don't build):**
- **Mid-run interrupt** of the agent (pause/resume a turn in flight). Takeover is **post-completion only**. This is the line that keeps us out of the frozen orchestrator's control flow.
- Persisting/replaying the live *video* (we persist frames + diffs, not video).
- Concurrent conversations / multi-user.
- Recording exact user cursor paths or click coordinates.
- Voice, CSV→dashboard, pixel-actuation parity mode (already deferred elsewhere).

---

## 3. What already exists that we build on (don't re-invent)

Reading the current code first saves rework:

- **The frontend is already multi-turn-shaped.** `useSessionStream.js` holds a `runs[]` array; `startQuestion()` appends a new run; `Watch.jsx`/`Feed.jsx` render a thread across runs; `flattenSteps()` walks all runs. **But** each `startQuestion` calls `POST /api/sessions`, which today spins up a *fresh, independent* session that **reloads the dashboard from scratch** (note the existing loading copy: *"Reloading the dashboard for your new question…"*) and closes its context at the end. So the UI models turns, but the backend does not share state across them. **B0's job is to make the backend match the shape the UI already implies.**
- **The bridge already logs user activity.** `host.html`'s `eventLog` accumulates `{type, ts}` for `FilterChanged` / `ParameterChanged` / `TabSwitched`, exposed via `__agentBridge.getEventLog()`. We reuse this to record what the user did during a takeover — no new instrumentation needed.
- **Inventory is captured every step.** `orchestrator.js` calls `window.__agentBridge.getInventory()` + `tracker.normalize()` at step 1 and after every action. A takeover's "what changed" diff is just two normalized inventories compared.
- **The SSE bus is per-session and idempotent-on-replay** (`sessionBus.js`, reducer in `useSessionStream.js`). We keep it exactly as-is for per-turn step events. The live video + input + lock ride a **separate WebSocket**, not SSE.
- **`store.js` already does safe additive migrations** (`ALTER TABLE … ADD COLUMN` guarded by "duplicate column"; table-rebuild for CHECK changes). Follow that established pattern.

---

## 4. Data model

### 4.1 New + changed tables (in `store.js`)

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  created_at   TEXT,
  closed_at    TEXT,
  dashboard_url  TEXT,
  dashboard_name TEXT,
  status       TEXT CHECK(status IN ('active','closed')),
  model_id     TEXT,
  config_json  TEXT
);

-- sessions gains two columns (a "session" row == one agent "turn"):
ALTER TABLE sessions ADD COLUMN conversation_id TEXT;   -- REFERENCES conversations(id); NULL = legacy standalone
ALTER TABLE sessions ADD COLUMN turn_index INTEGER;      -- 0-based order within the conversation

CREATE TABLE IF NOT EXISTS takeovers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    TEXT REFERENCES conversations(id),
  after_turn_index   INTEGER,          -- effect recorded after this turn (-1 = before the first turn)
  started_at         TEXT,
  ended_at           TEXT,
  before_frame_path  TEXT,             -- data/frames/conv_<id>/takeover_<n>_before.png
  after_frame_path   TEXT,
  before_inventory_json TEXT,
  after_inventory_json  TEXT,
  event_log_json     TEXT,             -- getEventLog() slice for the takeover window
  summary_json       TEXT              -- computed diff: [{kind:'filter', field:'Region', from:['All'], to:['Asia']}, {kind:'sheet', from:'ZHVI', to:'ZRI'}]
);

CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_takeovers_conversation ON takeovers(conversation_id, after_turn_index);
```

Migration notes:
- Add the two `sessions` columns with the same guarded `try/catch (duplicate column)` idiom already in `store.js`.
- Legacy sessions (`conversation_id IS NULL`) keep working in History exactly as before — treat them as standalone one-turn sessions.

### 4.2 New store.js functions

`createConversation`, `closeConversation`, `getConversation`, `listConversations`, `getConversationTurns(convId)` (sessions ordered by `turn_index`), `getTakeovers(convId)`, `insertTakeover`, and a modified `createSession` that also accepts `conversation_id` + `turn_index`.

---

## 5. The conversation runtime (new module)

Create **`backend/src/conversationRuntime.js`** — the single owner of the live browser context, screencast, input lock, and takeover bookkeeping. Only one conversation is active at a time (mirrors today's one-session-at-a-time mutex).

```js
// Conceptual shape — implementer fills in.
createRuntime({ browser, config, conversationId, dashboardUrl, dashboardName })
  // opens context+page via perception.openSession (ONCE), waits interactive+settle,
  // starts CDP screencast, mode = 'idle'
runtime.page            // the shared Playwright page (passed to runSession)
runtime.mode            // 'idle' | 'agent' | 'user'  (input dispatched only when 'user')
runtime.vizBox()        // cached bounding box of tableau-viz#agentViz (refresh on resize)
runtime.beginAgentTurn()// mode='agent'; broadcast {type:'lock'} to WS clients
runtime.endAgentTurn()  // mode='user'; broadcast {type:'unlock'}; open a takeover window
runtime.dispatchInput(msg)   // if mode==='user': map + page.mouse/keyboard; else ignore
runtime.onScreencastFrame(cb)// base64 jpeg frames -> WS broadcast
runtime.captureTakeoverStart()// snapshot before-frame + before-inventory + eventLog length
runtime.captureTakeoverEnd()  // snapshot after-frame + after-inventory + eventLog slice -> insertTakeover + diff
runtime.close()         // stop screencast, close CDP session, context.close(), finalize takeover, mark closed
```

Screencast via Playwright CDP:
```js
const cdp = await context.newCDPSession(page);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: config.screencast.quality, maxWidth: config.screencast.maxWidth, everyNthFrame: 1 });
cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
  broadcastToWsClients({ type: "frame", data /* base64 jpeg */ });
  await cdp.send("Page.screencastFrameAck", { sessionId }); // REQUIRED or the stream stalls
});
```

Input mapping (client sends normalized coords over the viz area):
```js
// msg = { type:'mouse', event:'move|down|up|click|wheel', nx, ny, button?, deltaY? }
const box = await runtime.vizBox();
const x = box.x + msg.nx * box.width, y = box.y + msg.ny * box.height;
// event -> page.mouse.move/down/up/click(x,y) or page.mouse.wheel(0, msg.deltaY)
// keyboard: { type:'key', event:'down|up|press', key } -> page.keyboard.*
```

Idle timeout: if `mode !== 'agent'` and no WS input for `config.conversationIdleMs`, auto-`close()`.

---

## 6. Transport contracts

### 6.1 REST (new)

| Method + path | Body | Returns | Effect |
|---|---|---|---|
| `POST /api/conversations` | `{dashboard_url, dashboard_name}` | `{conversation_id}` | Closes any existing active conversation, creates runtime, opens+loads dashboard, starts screencast, `mode='idle'`. 409 if one is mid-agent-turn. |
| `POST /api/conversations/:id/turns` | `{question}` | `{session_id, turn_index}` | Runs one agent turn on the live page. `beginAgentTurn()` → `runSession({page, ownsPage:false, conversationId, turnIndex})` → `endAgentTurn()`. Streams via existing SSE. 409 if a turn is already running. |
| `GET /api/conversations` | — | list | For History. |
| `GET /api/conversations/:id` | — | `{conversation, turns:[…full trajectories…], takeovers:[…]}` | Replay. |
| `POST /api/conversations/:id/close` | — | `{ok}` | Tear down runtime. |

**Unchanged:** `GET /api/sessions/:id` (per-turn trajectory), `GET /api/sessions/:id/events` (per-turn SSE), `POST /api/sessions/:id/stop`, `/api/config`, `/api/dashboards/meta`. The existing `POST /api/sessions` may be kept as a thin shim (creates a 1-turn conversation) or retired once the frontend moves to conversation endpoints — implementer's choice, but don't break the CLI, which calls `runSession` directly (not HTTP).

### 6.2 WebSocket (new): `WS /api/conversations/:id/live`

Add the `ws` package; attach a `WebSocketServer` to the same HTTP server in `server.js`. One channel per conversation for video-out, input-in, and lock control.

**Server → client:**
- `{type:'frame', data:<base64 jpeg>}` — a screencast frame.
- `{type:'vizbox', box:{x,y,width,height}, device:{width,height}}` — viz geometry (on connect + on resize) so the client can position/scale and normalize input.
- `{type:'lock'}` / `{type:'unlock'}` — agent turn started / ended (drives the input veil).
- `{type:'closed', reason}` — runtime torn down (idle/close/replaced).

**Client → server:**
- `{type:'mouse', event, nx, ny, button?, deltaY?}` and `{type:'key', event, key}` — forwarded input (ignored unless `mode==='user'`).

### 6.3 SSE (unchanged)

Per-turn step events keep flowing on `GET /api/sessions/:id/events` exactly as today. The frontend already reduces these into a `run`. No changes to `sessionBus.js` or the SSE event shapes in §6.7 of AGENT_PLAN.

---

## 7. Backend changes, file by file

| File | Change | Frozen? |
|---|---|---|
| `conversationRuntime.js` | **New.** §5. Owns context/page/CDP/screencast/lock/takeover. | new |
| `server.js` | New conversation REST (§6.1); attach `ws` server (§6.2); replace `isRunning` boolean with `activeConversationId` + `turnRunning`; route turn SSE through existing bus. | mutable |
| `store.js` | New tables + columns + functions (§4). Additive migrations. | mutable |
| `orchestrator.js` | `runSession` gains opts: `page` (reuse; skip `openSession`), `ownsPage` (default `true`; when `false`, **do not** `page.context().close()` at the end — currently line ~509), `conversationId`, `turnIndex` (persist onto the session row). In reuse mode, run `waitForSettle` once before the loop (user may have left mid-animation). **All new params default to today's behavior** so the CLI path is untouched. | **FROZEN — needs eval re-run** |
| `perception.js` | No change to `openSession`/`screenshotViz`/`waitForSettle` themselves — the runtime *calls* them. Only touch if you must expose the CDP session; prefer creating CDP in the runtime. | **FROZEN — avoid; re-run evals if touched** |
| `paths.js` | Helper for `data/frames/conv_<id>/` takeover artifacts. | mutable |
| `host.html` | Optionally add a `resetEventLog()`/index marker for clean takeover slicing (or just slice by length in the runtime — no host change needed). Bridge methods otherwise unchanged. | mutable (not agent-core) |

**The agent's per-turn logic — `vlmClient.js`, `actionSchema.js`, `actuator.js`, `inventory.js` — does not change at all.** A turn is the same loop; it just runs on a page it didn't open. That's the whole point of post-completion-only.

---

## 8. Frontend changes, file by file

| File | Change |
|---|---|
| `api.js` | Add `createConversation`, `postTurn`, `getConversation`, `listConversations`, `closeConversation`. Add a WS helper `openLiveChannel(convId, {onFrame,onVizBox,onLock,onUnlock,onClosed})` returning `{sendInput, close}`. |
| `useSessionStream.js` | Hold a `conversationId`. `startQuestion()` becomes: ensure conversation (create on first ask), then `postTurn`, then subscribe SSE for that turn's `session_id` (existing path). Interleave `takeover` markers into the thread model between runs. Replay branch switches to `getConversation` and rebuilds `runs[]` + takeovers. |
| **`useLiveChannel.js`** | **New hook.** Opens the WS, exposes `{liveFrameUrl, vizBox, mode /* 'agent'|'user'|'idle' */, sendInput, connected}`. Decodes `{type:'frame'}` base64 → object URL (or draws to a `<canvas>`); throttles outbound mouse-move (~30/s). |
| **`LiveStage.jsx`** | **New.** During a *live* conversation, render the screencast (`<img>`/`<canvas>`) sized to `vizBox`. Overlay a **lock veil** ("Docent is working…") when `mode==='agent'`. When `mode==='user'`, mount a transparent input-capture layer that maps pointer/key events to normalized coords and calls `sendInput`. |
| `Stage.jsx` | Unchanged for replay/step frames. `Watch.jsx` chooses `LiveStage` (live conversation, latest turn) vs `Stage` (scrubbing a past step / replay). Per-step frames + overlays + Filmstrip remain the persisted trajectory view. |
| `Feed.jsx` | Render interleaved **takeover cards** ("You changed Region → Asia, switched to ZRI") between turn threads, from `summary_json`. |
| `Composer.jsx` | After a turn completes, show an "Explore the dashboard, then ask a follow-up" affordance; the composer stays enabled (idle/user mode). Disabled with "Docent is working…" during a turn. |
| `Watch.jsx` | Wire `useLiveChannel`; pick live vs step view; call `closeConversation` on unmount/back; surface an "End session" control. |

---

## 9. Phases (build strictly in order; each is a dependency of the next)

### Phase B0 — Persistent context + conversation model + resume-into-state  *(the backbone)*
Deliver keep-alive multi-turn with **no** screencast and **no** takeover yet.
1. `store.js`: conversations table, `sessions.conversation_id`/`turn_index`, takeovers table (unused yet), new functions, migrations.
2. `conversationRuntime.js`: open/keep/close context + page (no CDP yet). One active conversation.
3. `orchestrator.js`: `runSession` reuse-page opts (§7). Keep CLI behavior identical.
4. `server.js`: `POST /api/conversations`, `POST /api/conversations/:id/turns`, `POST /api/conversations/:id/close`; replace `isRunning` with `activeConversationId` + `turnRunning`.
5. Frontend: `useSessionStream` uses conversation endpoints; turns run on the same live page.

**Accept when:** Ask Zillow *"What is the ZHVI for Boston?"*, then a follow-up *"Now switch to the ZRI tab and report the US value."* — the second turn starts from the first turn's ending state **without a full reload** (verify: no 90s reload spinner between turns; turn-2 step-1 inventory reflects turn-1's ending sheet/filters). Legacy standalone sessions still replay in History. (The frozen-core eval regression check is deferred to B4 — see §10.)

### Phase B1 — Live screencast (read-only)
1. Runtime: start CDP `Page.startScreencast`, ack every frame, broadcast over WS.
2. `server.js`: attach `ws` server, `WS /api/conversations/:id/live` (frames + vizbox out only).
3. Frontend: `useLiveChannel` + `LiveStage` showing live video for the active conversation (no input yet). Lock veil driven by a temporary `mode` broadcast.

**Accept when:** During an agent turn you watch the dashboard change **live** (filters apply, tabs switch) in the viewer, in addition to the per-step frames still being persisted. WS reconnect works; frame acks keep the stream flowing (no stall).

### Phase B2 — Post-completion takeover (input + lock + persistence)
1. Runtime: `mode` state machine; `dispatchInput` with coord mapping (§5); `beginAgentTurn`/`endAgentTurn` broadcasting `lock`/`unlock`.
2. Runtime: takeover capture — on unlock snapshot before-frame/inventory + eventLog index; on next turn start (or close) snapshot after-frame/inventory + eventLog slice, compute `summary_json` diff, `insertTakeover`.
3. `server.js`/WS: accept input messages; enforce lock (ignore input when `mode==='agent'`). **Add WebSocket Origin validation to the `/api/conversations/:id/live` upgrade handler here** — mirror the Express CORS allowlist (`http://localhost:5173`). Deferred from B1 (the socket was receive-only then, so cross-site hijacking was harmless), but B2 promotes it to an *input* channel, so an Origin check is required before inbound handling lands to prevent cross-site WebSocket hijacking (CSWSH) driving the agent's browser.
4. Frontend: input-capture layer in `LiveStage` (mouse move/click/drag/wheel + keyboard), throttled; veil when locked; takeover cards in `Feed`.

**Accept when:** After the agent answers, you click a filter / switch a tab **in the viewer** and it takes effect on the live dashboard; ask a follow-up and the agent answers **from your modified state**; the takeover appears in the thread and its before/after + diff are in the DB. While the agent is working, your clicks are ignored (veil shown).

### Phase B3 — Conversation replay + History
1. `GET /api/conversations/:id` returns ordered turns (full trajectories) + takeovers.
2. Frontend replay: rebuild the interleaved thread (turns + takeover cards) from persisted data; per-step frames drive the Stage (no live WS in replay).
3. History screen lists conversations (turn count, dashboard, last answer) alongside/into the existing sessions list.

**Accept when:** A finished multi-turn conversation with at least one takeover replays end-to-end from the DB — every turn's steps, and each takeover's before/after + summary — with no live processes running.

### Phase B4 — Lifecycle, hardening, docs, **frozen-core eval regression gate**
1. Idle timeout auto-close; explicit "End session"; starting a conversation on another dashboard closes the prior one; finalize any open takeover on close.
2. Error cards: WS drop, screencast stall, context crash, turn-while-locked — every failure has a human-readable surface (extend the existing error taxonomy).
3. `config.json`: `screencast:{fps,quality,maxWidth}`, `conversationIdleMs`. Note in README that screencast is CPU/GPU-light and **does not touch the 6 GB VRAM budget** (browser RAM only).
4. README/demo-script update: the new best live demo is the two-turn Zillow flow with a manual tab-switch in between.
5. **Frozen-core regression check (do this ONCE, here, not per-phase).** With all agent-core changes from B0–B3 in place, run the smoke set (`npm run smoke-questions` / the CLI smoke path) **and** the batch eval (`npm run eval -- eval/questions.json` → `eval/results.csv`). Compare against a baseline captured **before B0 started** (capture it now if none exists). The single-shot CLI path (`npm run run-agent`) must behave identically — a turn must produce the same trajectory whether its page was opened by the conversation runtime or, in the CLI, by `runSession` itself. If numbers move, stop and diagnose before shipping.

**Accept when:** A conversation can be opened, driven through ≥2 turns with a manual takeover between them, replayed, and closed — unattended, no hangs, no leaked contexts (verify one context alive at a time) — **and** the smoke + batch eval match the pre-B0 baseline.

---

## 10. Frozen-core impact (read CLAUDE.md "Frozen vs. mutable")

Only **`orchestrator.js`** is meaningfully touched, and only additively (reuse-page opts that default to current behavior). `perception.js` should ideally be *called*, not *changed*. Everything else in the agent core (`vlmClient`, `actionSchema`, `actuator`, `inventory`, `eval/`) is untouched.

**Requirement (batched to B4, not per-phase — to save tokens/time):** capture a smoke + batch-eval **baseline before starting B0**, then run the regression check **once at B4** (step 5) after all core changes are in, confirming the single-shot path is unchanged. A turn must behave identically whether the page was opened by the runtime or (in the CLI) by `runSession` itself.

> ⚠️ Trade-off you accepted: batching the eval to the end means a frozen-core regression introduced in B0 won't be *caught* until B4. To limit blast radius, keep the B0 `orchestrator.js` changes strictly additive (new opts defaulting to today's behavior), and sanity-check the CLI (`npm run run-agent -- <url> "<question>"`) by hand at the end of B0 — a 2-step Zillow run is enough to catch a gross break early without the full eval.

---

## 11. Risks & gotchas

- **Screencast ack is mandatory.** Forgetting `Page.screencastFrameAck` silently stalls the stream after a few frames.
- **Coordinate mapping is the fiddly bit.** The viz auto-shrinks to its published size after `FirstInteractive` (see `host.html`), so `vizBox` changes after load and on sheet switches — re-read it and rebroadcast on resize, or input lands in the wrong place.
- **State divergence is already solved by the design** — because each turn starts with **fresh** history/loop-guard/inventory IDs and re-perceives from scratch, the agent simply *observes* whatever the user left; there is no stale plan to confuse it. Do **not** try to carry agent memory across turns.
- **Settle after takeover.** The user may ask a follow-up mid-animation; run `waitForSettle` at turn start in reuse mode before the first screenshot.
- **One active conversation.** Keep the single-active invariant (one context, one user, 6 GB laptop). Opening a new conversation must close the old runtime first.
- **Don't persist video.** Storage stays bounded by persisting frames + inventory diffs, not the stream. If full-video replay is ever wanted, it's a separate deferred feature.
- **Cross-origin canvas still applies.** Input is forwarded as viewport mouse/keyboard events to the *page*; we are not reaching into Tableau's iframe DOM. Marks remain unreadable/unclickable by DOM — the user clicks Tableau's own controls, which Tableau handles natively.

---

## 12. Deferred (explicitly not in this plan)

Mid-run interrupt / agent pause-resume · live-video persistence & replay · concurrent conversations · exact cursor-path capture · undo of a user takeover · letting the agent *see* that a human acted (it only sees the resulting state).
