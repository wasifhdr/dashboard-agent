# Tableau Dashboard QA Agent — Build Plan (v1)

**Audience:** the implementing coding agent (and the project owner).
**Working directory:** create the project at `D:\NSU\10th semester\CSE499B.17\dashboard-agent\` (new standalone repo — do NOT modify the old `D:\NSU\9th semester\CSE499A.17\DashboardAnalyzer` project).
**Owner context:** CSE499B senior-design showcase. A separate research track (teammates) works on beating the DashboardQA paper's accuracy; THIS system is the demo/showcase. It must visibly show a local VLM answering questions about live interactive Tableau dashboards, step by step.

---

## 1. What we are building

A web system where a user picks a **Tableau Public dashboard**, types a **question**, and watches a **local VLM agent** answer it by actually operating the dashboard — applying filters, changing parameters, switching tabs — with every step (reasoning, action, resulting screenshot) rendered live in a **trajectory viewer** UI.

Background: the DashboardQA benchmark (EACL 2026 Findings; dataset: `https://huggingface.co/datasets/ahmed-masry/DashboardQA`) evaluates VLM agents on exactly this task over Tableau Public dashboards. Best published agent ≈ 38.7% accuracy. Two findings from the paper shape this design:

1. **Structured UI info is the biggest accuracy lever** (screenshot-only agents score far worse than agents given an accessibility tree). → We give the agent a *structured control inventory* from the Tableau Embedding API instead of making it click pixels.
2. **Top failure mode is plan-tracking loops** (agents repeat completed steps until the step budget dies). → We build a loop guard into the orchestrator from day one.

## 2. Scope

**IN (this version):**
- Embedded Tableau Public dashboards (user-provided URL or picked from a configured list).
- Agent loop: perceive (screenshot) → think (VLM) → act (Tableau Embedding API v3) → observe, with step budget + loop guard.
- Semantic actuation via Embedding API only (filters, range filters, parameters, sheet/tab switching).
- Per-step trajectory persistence (SQLite + PNG frames) and live streaming to a React viewer (SSE).
- Per-step annotated frames (action badge, best-effort widget highlight, changed-region highlight).
- Local VLM via llama.cpp (`llama-server`), hot-swappable model behind one client module.

**OUT (explicitly deferred — do NOT build):**
- Voice input/output, TTS/STT.
- Live screencast / CDP video streaming (per-step frames only).
- Screenshot-only / pixel-clicking actuation mode (benchmark-parity track is not this system).
- CSV → auto-generated dashboards.
- Multi-dashboard questions, conversational multi-turn sessions (single question → single answer per session).
- Auth'd Tableau Server/Cloud (Tableau **Public** only).

## 3. Architecture

```
┌──────────────── React Trajectory Viewer (Vite, :5173) ────────────────┐
│ session launcher (URL + question) · live step timeline · stage w/     │
│ annotated frame · reasoning panel · replay of past sessions           │
└───────────▲───────────────────────────────▲───────────────────────────┘
            │ REST (start session, list)     │ SSE (step events, frames)
┌───────────┴───────────────────────────────┴───────────────────────────┐
│                Node backend (Express, ESM JS, :8990)                   │
│  Orchestrator: agent loop, step budget, loop guard, settle gate        │
│    ├─ Perception: Playwright Chromium → screenshot of embedded viz     │
│    ├─ Grounding:  control inventory via Embedding API bridge           │
│    ├─ Actuation:  bridge calls (applyFilterAsync, setParameter, …)     │
│    ├─ VLM client: llama-server (OpenAI-compatible, :8080), swappable   │
│    └─ Store: better-sqlite3 (sessions/steps) + PNG frames on disk      │
│  Also statically serves the HOST PAGE at /host                         │
└───────────┬────────────────────────────────────────────────────────────┘
            │ Playwright drives its own Chromium instance
┌───────────┴───────────────────────────────┐   ┌───────────────────────┐
│ Host page (served by backend, loaded in    │   │ llama-server (:8080)  │
│ the Playwright browser, NOT the user's):   │   │ Qwen3.5-4B distill    │
│  <tableau-viz> web component +             │   │ Q4_K_M + mmproj-BF16  │
│  window.__agentBridge (Embedding API v3)   │   └───────────────────────┘
└────────────────────────────────────────────┘
```

**Critical architectural decision — do not deviate:** the Tableau viz is embedded in a **host page that the backend serves and Playwright loads in its own browser**. The backend executes Embedding API calls inside that page via `page.evaluate()` on `window.__agentBridge`, and takes screenshots of the same page. The user-facing React viewer never embeds the viz itself — it only displays frames/events streamed from the backend. (Reason: Tableau renders inside a cross-origin iframe onto canvas; the user's browser cannot screenshot or introspect it. Playwright, operating at browser level, can traverse cross-origin frames and screenshot anything.)

## 4. Tech stack (pinned)

- **Backend:** Node.js, ESM JavaScript (not TS), Express, `playwright` (Chromium), `better-sqlite3`, `sharp` (resize), `pixelmatch` + `pngjs` (frame diff), `zod` (action validation). One session at a time (simple `isRunning` mutex like the owner's previous project).
- **Frontend:** Vite + React (JS). Simple hand-rolled CSS, dark theme default. No UI framework needed.
- **Tableau:** Embedding API v3 ESM from `https://public.tableau.com/javascripts/api/tableau.embedding.3.latest.min.js` (system requires internet anyway for Tableau Public).
- **VLM runtime:** llama.cpp `llama-server`, OpenAI-compatible `/v1/chat/completions` with base64 `image_url` (owner already runs this pattern).
- **Ports:** backend 8990, Vite 5173, llama-server 8080.
- Git repo with `.gitignore` for `node_modules/`, `data/` (frames + sqlite), model files.

## 5. Model & runtime configuration

**Primary model (owner's choice):** `Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF` — files `Qwen3.5-4B.Q4_K_M.gguf` (2.71 GB) + `mmproj-BF16.gguf` (676 MB). It IS multimodal (Qwen3-VL-4B base + reasoning LoRA). **Ask the owner for the local paths to these files** (do not download without asking; they may already exist near the old project's llama.cpp models dir).

**Hardware constraint: RTX 4050 Laptop, 6 GB VRAM.** Non-negotiable settings:

```
llama-server --model <Q4_K_M path> --mmproj <mmproj path> \
  -c 8192 -ngl 99 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
  --host 127.0.0.1 --port 8080
```

- Q4_K_M only (higher quants + mmproj + KV won't fit 6 GB).
- Context 8192; KV cache quantized (requires flash-attn on).
- **Images resized so long side ≤ 1280 px** before sending (use `sharp`; full-res PNG kept on disk for the viewer). Resolution is the scarce resource — never downscale below label readability; if a dashboard is unreadable at 1280, crop to the active region rather than shrinking further.
- Context budget per call ≈ system+inventory+history ~2k tok, image ~1–1.5k tok, completion ≤ 768 tok. **Send only the CURRENT screenshot each step; prior steps go in as a compact text log, never as images.**
- Per-VLM-call timeout 120 s.

**Output discipline (small model, reasoning-distill that likes to ramble):**
- Primary approach: request `response_format: { type: "json_object" }` (llama.cpp supports constrained JSON) so the model's "thinking" is confined to the schema's `thought` field.
- Fallback (config flag): allow free text (the model may emit `<think>…</think>`), then extract the **last** JSON object from the reply.
- Build both; default to constrained JSON. This is also an A/B knob.

**Swappability:** all model specifics live in `backend/config.json` (`llamaEndpoint`, `modelName`, `promptStyle`, `maxSteps`, `imageLongSide`, `dashboards[]`). The owner will later A/B this distill vs stock `Qwen3-VL-4B-Instruct`; nothing outside the VLM client module may assume a specific model.

## 6. Core contracts

### 6.1 Control inventory (grounding — the agent's "Set of Marks")

Produced by the bridge after load and refreshed after every action. Stable IDs are assigned by the backend (`S*` sheets, `F*` filters, `P*` parameters) and must stay stable within a session.

```json
{
  "activeSheet": "Overview",
  "sheets":     [ { "id": "S1", "name": "Overview", "type": "dashboard", "active": true } ],
  "filters":    [ { "id": "F1", "field": "Region", "type": "categorical",
                    "worksheets": ["Sales Map", "Trend"],
                    "applied": ["(All)"], "domain": ["Africa","Asia","Europe"] } ,
                  { "id": "F2", "field": "Year", "type": "range",
                    "worksheets": ["Trend"], "min": 2010, "max": 2024,
                    "appliedMin": 2010, "appliedMax": 2024 } ],
  "parameters": [ { "id": "P1", "name": "Metric", "type": "list",
                    "current": "Sales", "allowable": ["Sales","Profit","Quantity"] } ]
}
```

Notes for the builder:
- Sheets: from `viz.workbook.publishedSheetsInfo` + `activeSheet`.
- Parameters: `workbook.getParametersAsync()` → name, current value, `allowableValues` (list/range/all).
- Filters: iterate `dashboard.worksheets[i].getFiltersAsync()`; merge same-field filters across worksheets into one inventory entry (record which worksheets carry it).
- **Verify at build time** whether categorical filter domain enumeration is available in the current Embedding API (e.g., `getDomainAsync`) — if not available for some filter, set `"domain": null`; the VLM then reads visible options from the screenshot and supplies values verbatim. Do not hard-fail on missing domains.

### 6.2 Action schema (VLM → orchestrator, strict JSON, validated with zod)

```json
{
  "thought": "string, <= 2 sentences",
  "action": {
    "type": "set_filter | set_range_filter | set_parameter | switch_sheet | wait | answer | fail",
    "target_id": "F1 | P1 | S2 (for set_/switch_ types)",
    "values": ["Asia"],
    "min": 2015, "max": 2020,
    "value": "Profit",
    "answer": "final answer text (type=answer)",
    "confidence": 0.8,
    "reason": "why unsolvable (type=fail)"
  }
}
```

Rules enforced by the orchestrator (not trusted to the model):
- Exactly one action per step. Unknown `target_id` → step rejected with corrective feedback.
- Invalid JSON / schema → up to 2 re-prompts appending the validator error; a 3rd failure records the step as `invalid_json` and injects a corrective note; 3 total invalid steps → session status `error`.
- `set_filter` values are matched case-insensitively against the domain when a domain is known; on no-match, return the near-misses to the model as feedback.
- Loop guard: an exact repeat of a previously executed `(type, target_id, values/value/min/max)` is **not executed**; the model gets: *"You already did this at step N; the result is in the history. Choose a different action or answer."* Max 2 consecutive `wait`s.
- Step budget: `maxSteps` = 15 (config). Hitting it → status `max_steps`, and one final forced "best-effort answer" call is made with the last frame.

### 6.3 Bridge interface (host page `window.__agentBridge`)

```js
window.__agentBridge = {
  ready,                    // Promise; resolves on FirstInteractive
  getInventory(),           // -> inventory JSON (raw; backend assigns IDs)
  applyCategoricalFilter(worksheetNames, field, values),   // applyFilterAsync (REPLACE) on each listed worksheet, try/catch each
  applyRangeFilter(worksheetNames, field, min, max),
  setParameter(name, value),
  switchSheet(name),
  getEventLog(),            // [{type: "FilterChanged"|"ParameterChanged"|"TabSwitched", ts}]
}
```

- Host page route: `GET /host?viz=<encoded Tableau Public URL>` (served by backend).
- Dashboard-level filter controls are per-worksheet in the API → the apply helpers iterate **all** worksheets listed for that field (this is why the inventory records `worksheets`).
- Every bridge mutation returns `{ ok, error? }`; never throws across `page.evaluate`.

### 6.4 Settle gate (MANDATORY before every screenshot)

Embedding API promises can resolve when an action *starts*, not when rendering finishes (documented behavior). Screenshotting too early = the paper's "locked in a stale state" failure. After every action (and initial load):

1. Await the bridge promise, then wait 400 ms.
2. Screenshot the viz element, downscale to 640 px grayscale, compare with a screenshot taken 500 ms later via `pixelmatch`; **settled** when diff < 0.5% of pixels.
3. Repeat until settled or 12 s timeout → proceed but set `settle_timeout: true` on the step (viewer shows a warning badge).

### 6.5 SQLite schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, created_at TEXT, finished_at TEXT,
  dashboard_url TEXT, dashboard_name TEXT, question TEXT,
  status TEXT CHECK(status IN ('running','answered','failed','max_steps','error')),
  final_answer TEXT, confidence REAL, model_id TEXT, config_json TEXT
);
CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  idx INTEGER, thought TEXT, action_json TEXT,
  action_status TEXT,             -- ok | error | invalid_json | rejected_loop | rejected_target
  error_msg TEXT,
  frame_raw_path TEXT,            -- full-res PNG:  data/frames/<session>/step_<idx>.png
  overlay_json TEXT,              -- see 6.6
  inventory_json TEXT,            -- inventory AFTER the action
  settle_timeout INTEGER DEFAULT 0,
  started_at TEXT, duration_ms INTEGER
);
```

Frames live on disk, paths in DB. Never delete frames (the old project deleted them; the trajectory viewer depends on keeping them).

### 6.6 Overlay metadata (`overlay_json`) — annotation is data, not baked pixels

Frames are stored clean; the viewer draws SVG overlays from metadata (toggleable):

```json
{
  "action_badge": { "text": "Filter: Region → Asia", "type": "set_filter" },
  "widget_bbox":  { "x": 12, "y": 80, "w": 180, "h": 32 },
  "changed_regions": [ { "x": 300, "y": 120, "w": 420, "h": 260 } ]
}
```

- `widget_bbox`: best-effort — try to locate the filter/parameter widget inside the Tableau iframe via Playwright frame locators (text/ARIA heuristics). **This may fail on many vizzes; it is optional per step — never block on it.**
- `changed_regions`: bounding box(es) of the pixel diff between previous and current frame (pixelmatch → cluster changed pixels → 1–3 boxes). This is the reliable "look what changed" signal and must always be computed.

### 6.7 SSE events (`GET /api/sessions/:id/events`)

`session_started`, `step_started {idx}`, `thought {idx, text}`, `action {idx, action, status}`, `frame {idx, url, overlay}`, `inventory {idx, summary}`, `warning {idx, kind}`, `session_done {status, final_answer, confidence}`. (Thought arrives as one chunk per step; token-level streaming is a deferred nicety.)

### 6.8 Prompt skeleton (VLM client)

System: role ("You operate a Tableau dashboard to answer a question"), the question, the rules (one JSON action per turn; thought ≤ 2 sentences; prefer `answer` as soon as the current view shows the needed values; never repeat a completed action; exact JSON schema with one example per action type).
User (per step): compact inventory (IDs + names + applied/current values + domains), history log (one line per prior step: `#3 set_filter F1=[Asia] → ok`), any corrective feedback from the previous step, then the current screenshot.
Keep the whole text portion ≤ ~2k tokens; truncate domains over ~30 values with "… (+N more)".

## 7. Known pitfalls — MUST-level mitigations

1. **Tableau marks are canvas in a cross-origin iframe.** There is no DOM for bars/lines/points. Never attempt to enumerate or click marks; values are READ from screenshots, controls are OPERATED via the API. (Mark selection `selectMarksByValueAsync` is a deferred stretch goal.)
2. **Promise ≠ rendered.** Always run the settle gate (6.4). No exceptions, including the first load (also await `FirstInteractive` + settle).
3. **6 GB VRAM.** Respect §5 exactly. If llama-server OOMs: first drop `-c` to 6144, then image long side to 1120. Log VRAM guidance in the README.
4. **Small model + loops.** Loop guard (6.2) is required in Phase 1, not polish. The forced best-effort answer at budget exhaustion is required too — a wrong answer beats a silent death for the demo.
5. **Filter domains may be unavailable** per filter/API version → `domain: null` path must work end to end (model reads options from pixels).
6. **Dashboard filters are per-worksheet in the API** → apply across all worksheets carrying the field; partial failures are OK (report which applied).
7. **Old/heavy Tableau Public vizzes**: first-load timeout ≥ 90 s; sane error surface to the UI if the viz never becomes interactive.
8. **Some vizzes have no API-operable controls** (static or all-canvas custom controls). Detect: empty inventory → warn in UI ("agent can only read, not operate, this dashboard") and still allow answering from the initial view.

## 8. Phases

### Phase 0 — Foundations (every risky primitive proven in isolation)

Goal: all the hard integrations work before any agent logic exists.

1. Scaffold repo (`backend/`, `frontend/`, `README.md`, config, gitignore, git init).
2. llama-server launch script + **vision smoke test**: script sends one dashboard screenshot with "list every number and label you can read" → verify the model actually reads chart text (this validates the owner's chosen distill kept its vision).
3. Host page + bridge: embed a configured Tableau Public viz, `__agentBridge` complete, manual test page buttons (dev-only) to fire each bridge call.
4. Playwright service: launch browser, open `/host?viz=…`, await ready, settle gate, element screenshot → PNG on disk.
5. Inventory module: bridge raw inventory → backend assigns stable IDs → normalized JSON (6.1). Print it for 2–3 different dashboards.
6. CLI probe: `node probe.js <tableau-url>` → prints inventory, takes a screenshot, applies one hardcoded filter, settles, screenshots again, computes changed-region boxes.

**Accept when:** probe runs green on 2–3 real Tableau Public dashboards (pick from the DashboardQA HF dataset so we're on benchmark-real dashboards) and the smoke test shows the model reading chart labels.

### Phase 1 — Agent loop (the core)

Goal: question in → trajectory + answer out, no UI yet.

1. VLM client: prompt builder (6.8), image resize, constrained-JSON + fallback extraction, zod validation, re-prompt policy.
2. Orchestrator: session state machine, loop (perceive → inventory → prompt → validate → execute → settle → persist), step budget, loop guard, consecutive-wait cap, forced best-effort answer on budget exhaustion, per-action timeout 30 s, session wall clock 15 min.
3. Persistence: sessions/steps writes per 6.5, frames per session dir, overlay computation (changed regions always; widget bbox best-effort).
4. CLI runner: `node run.js <tableau-url> "<question>"` → streams steps to stdout, prints final answer + session id.
5. 5–10 handwritten QA pairs over the chosen dashboards (easy factoid + one filter-required + one tab-required) as `eval/smoke-questions.json`; run them; iterate on the prompt until the filter-required case reliably executes a correct filter action (answer correctness is model-dependent; ACTION correctness is what Phase 1 must prove).

**Accept when:** CLI answers a question that REQUIRES a filter change + a tab switch, with a persisted trajectory whose every step has thought, valid action, settled frame, inventory; loop guard demonstrably fires (test by asking an impossible question and watching it not burn the budget on repeats).

### Phase 2 — Streaming + trajectory viewer

Goal: the showcase UI.

1. REST: `POST /api/sessions` (url + question) → id; `GET /api/sessions`, `GET /api/sessions/:id` (full trajectory), static `/frames/...`; SSE per 6.7.
2. Viewer, live mode: launcher (dashboard picker from config + free URL field + question box) → 3-pane layout: **left** step timeline (cards: idx, action badge, status, thumbnail), **center** stage (selected step's frame + SVG overlays, overlay toggle, prev/next, ▶ auto-play), **right** details (thought, action JSON, inventory delta, warnings). Header: question, status chip, budget meter `step k / 15`, final-answer card on completion.
3. Replay mode: sessions list → same viewer over persisted data.
4. Polish that matters for the demo: changed-region pulse animation on frame arrival, loop-guard/settle-timeout warning badges, copy-transcript button. Dark theme.

**Accept when:** a full live run is watchable end-to-end in the browser with no dev tools open, and any past session replays identically from the DB.

### Phase 3 — Hardening + evaluation readiness

1. Error taxonomy surfaced to UI (viz load failure, empty inventory, VLM timeout, bridge rejection) — every failure mode has a human-readable card, no silent hangs.
2. Batch eval harness: `node eval.js eval/questions.json` → runs sessions sequentially, writes `results.csv` (question, answer, steps, status, duration). This doubles as the teammates' trajectory-collection tool.
3. Model A/B: config-switch between the Jackrong distill and stock `Qwen3-VL-4B-Instruct`; chart-reading micro-benchmark (`eval/reading/` — ~10 dashboard crops + expected values) + the smoke-questions set; README documents how to run the comparison and record a winner.
4. Curate `config.dashboards[]`: 4–6 known-good DashboardQA dashboards verified end to end (inventory non-empty, load < 90 s).
5. README: architecture sketch, setup (model paths, llama-server script, npm scripts), demo script (which dashboard + which question makes the best live demo), troubleshooting (VRAM, settle timeouts).

**Accept when:** the batch harness completes a 10-question run unattended with zero crashes (wrong answers allowed, hangs not), and both models have recorded reading-benchmark scores.

## 9. Build order & verification discipline

- Phases strictly in order; within a phase, tasks in the listed order (each is a dependency of the next).
- After each phase, run the acceptance check literally before moving on.
- Anything marked "verify at build time" (filter domain API surface, widget bbox locatability, exact llama.cpp flag names for the installed version) must be tested against reality, not assumed from these notes.
- Ask the owner when needed: model file paths, which DashboardQA dashboards to configure, whether llama.cpp is up to date.

## 10. Deferred backlog (do not build now — keep seams for them)

Voice I/O (STT/TTS, narrated steps) · live screencast stage · CSV→dashboard generator · pixel-actuation benchmark-parity mode · mark selection (`selectMarksByValueAsync`) · token-level thought streaming · conversational multi-turn · concurrent sessions.
