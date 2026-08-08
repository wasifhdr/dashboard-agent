# Docent — an agent that *operates* Tableau dashboards to answer questions

Most "chat with your data" tools answer questions by querying a database. Docent doesn't have the database. It gets the same thing a human analyst gets — a published, interactive Tableau dashboard — and answers by **looking at it and clicking on it**: filtering, drilling in, switching views, then reading the result off the screen.

Every step is recorded — the model's reasoning, the action it chose, and a screenshot of the dashboard at that moment — so you can watch a run live or replay it later, frame by frame.

Built as the systems half of an NSU CSE499B senior-design project around the [DashboardQA](https://huggingface.co/datasets/ahmed-masry/DashboardQA) benchmark (agentic VLM question-answering on interactive dashboards).

---

## The problem that shapes everything

You cannot screenshot a Tableau dashboard from a web page.

Tableau renders its marks to a `<canvas>` inside a **cross-origin iframe**. Page JavaScript can't read pixels from it, can't walk its DOM, can't find where anything is on screen. There is no HTML to parse — the "bar chart" is paint.

So the browser doing the work can't be yours. Docent runs a **Playwright-controlled browser server-side**, which operates one level below the page and *can* screenshot the canvas. Your browser only ever receives frames and events streamed from the backend — it never embeds the viz at all.

That single constraint explains most of the architecture:

- **Perception is visual.** A screenshot of the rendered viz, sent to a vision model. There's no accessibility tree to fall back on.
- **Actuation is by coordinate.** The model returns a normalized `(x, y)` and a description of what it's aiming at; the backend clicks there in the real browser.
- **You need a settle gate.** Tableau's own API promises resolve *before* rendering finishes. Screenshot too early and you capture a half-drawn dashboard and confidently misread it. Docent waits for the pixels to stop changing before every frame.

## What it does

- **Search the live Tableau Public library.** Type "netflix" and it queries Tableau Public's search endpoint through a backend proxy, then opens whichever workbook you pick — not just a hardcoded list.
- **Check whether a dashboard is even workable.** Unvetted public workbooks include Tableau *stories* (which the agent has no action to navigate) and dashboards that load but paint nothing. A read-only inspection runs after the dashboard opens and warns you instead of letting the run fail confusingly later.
- **Multi-turn conversations on one live dashboard.** The dashboard is opened once and stays open. Turn two resumes from wherever turn one left it — no reload, no re-filtering.
- **Take the wheel mid-conversation.** Between turns the input lock flips to you: click a bar, drag a slider, switch a tab directly on the live browser. The next turn continues from the state *you* left.
- **Refresh without losing your place.** The dashboard is held open server-side, so reloading the page re-attaches to the running session rather than starting over — including mid-question. Replays have real URLs you can bookmark or share.
- **Watch it work.** A live CDP screencast with the agent's cursor visible, or scrub the recorded frames afterwards.
- **Ask out loud.** Browser-native dictation, with answers optionally read back.

## Architecture

```
┌──────────── React "Docent" UI (Vite, :5173) ─────────────┐
│  Landing (search + picker) · Watch (live) · History       │
└────▲──────────────────▲───────────────────▲──────────────┘
     │ REST             │ SSE               │ WebSocket
     │ conversations,   │ per-turn step     │ live screencast
     │ turns, replay    │ events            │ + forwarded input
┌────┴──────────────────┴───────────────────┴──────────────┐
│              Node backend (Express, ESM, :8990)           │
│                                                           │
│  conversationRuntime  ONE long-lived Playwright page per   │
│                       conversation; CDP screencast out,    │
│                       mouse/keyboard in, under a lock      │
│  orchestrator         perceive → prompt → validate →       │
│                       execute → settle → persist           │
│  perception           screenshot + settle gate + diff      │
│  tableauSearch        proxy for Tableau Public search       │
│  viability            is this dashboard workable at all?     │
│  store                SQLite: conversations, turns, steps,   │
│                       takeovers, frames                      │
└────┬──────────────────────────────────────┬───────────────┘
     │ Playwright (headless Chromium)       │ HTTPS
┌────┴─────────────────────────┐   ┌────────┴────────────────┐
│ host.html                    │   │ Google Gemini            │
│ <tableau-viz> + __agentBridge │   │ (vision — reads frames,  │
│ (Tableau Embedding API v3)    │   │  returns click targets)  │
└──────────────────────────────┘   └─────────────────────────┘
```

**The vision model is Google Gemini** (`gemini-flash-lite-latest`), called over an OpenAI-compatible endpoint. Screenshots of the dashboard are sent to it each step — see [Data egress](#data-egress).

## Requirements

- **Node 20+** (24 is what this is developed against)
- **A Google Gemini API key** — this is the agent's eyes; nothing works without it
- Playwright's Chromium, downloaded automatically by `npm install`
- Optional: a **Groq API key** for higher-quality text-to-speech (falls back to the OS voice)

Windows is the primary development platform, but nothing here is Windows-specific except one port workaround in [Troubleshooting](#troubleshooting).

## Setup

```bash
git clone https://github.com/wasifhdr/dashboard-agent.git
cd dashboard-agent
npm install --prefix backend
npm install --prefix frontend
```

Create a `.env` in the repo root (git-ignored):

```
GEMINI_API_KEY=your-key-here
GROQ_API_KEY=optional-for-nicer-tts
```

The key is read by name from `config.pixel.vlmApiKeyEnv` and never stored in `config.json`.

## Running it

Two processes.

**Backend** — Express plus the shared Playwright browser:

```bash
npm run dev --prefix backend
```

Wait for `dashboard-agent backend listening on http://127.0.0.1:8990`. That banner only prints if the socket genuinely bound — if you see a port diagnostic instead, read [Troubleshooting](#troubleshooting).

**Frontend** — Vite, proxying `/api` and `/frames` to the backend:

```bash
npm run dev --prefix frontend
```

Open <http://localhost:5173>.

### Try these

Two verified runs, good for a first look:

| Dashboard | Ask | Expect |
|---|---|---|
| Video Game Sales | *In the Top 5 Publishers chart, which publisher has the highest total sales?* | **Nintendo** — one step, pure reading |
| Video Game Sales | *Click the 'Electronic Arts' bar in the Top 5 Publishers chart to filter to that publisher, then report which single game has the highest global sales in the Top 10 Games chart.* | **FIFA 15** — two steps; watch it click the bar, then read the re-filtered chart |

The second one is the interesting demo: you see the cursor land on the EA bar, the whole dashboard re-filter, and the answer come off the *new* frame.

**Aim at large, clearly-labeled marks.** Pointing it at the small stacked rows in "Top Genres" makes it loop — the click target is too small and ambiguous to hit reliably. That's a genuine limit of coordinate-based actuation, not a bug.

### Command line

Run from `backend/`, no UI needed:

```bash
npm run run-agent -- <tableau-url> "<question>"   # one run, streams to stdout
npm run probe -- <tableau-url>                    # inspect a dashboard, no model involved
npm run eval -- <path/to/questions.json>          # batch harness → eval/results.csv
npm test                                          # unit tests
```

## How a turn works

1. **Perceive** — wait for the dashboard to stop changing, then screenshot the viz.
2. **Ground** — read the control inventory (filters, parameters, sheets) through the Tableau Embedding API bridge. In pixel mode this is *context*, not a control surface: it tells the model that "Electronic Arts" exists as a value even when it's off-screen, which makes its click targets far better.
3. **Decide** — the frame, the inventory, and the history go to Gemini, which returns strict JSON: one thought and one action.
4. **Validate** — a zod discriminated union over the eight action types (`click`, `set_filter`, `set_range_filter`, `set_parameter`, `switch_sheet`, `wait`, `answer`, `fail`). Malformed output is re-prompted, not crashed on.
5. **Execute** — a click is aimed coarsely, then refined: the backend zooms into a small window around the point and looks for the thing the model *said* it was clicking. Found, and the click snaps to its center; not found, and the click is rejected and re-aimed.
6. **Settle and record** — wait for pixels to stabilize, capture the new frame, persist the step.

There's a 15-step budget, a loop guard that rejects repeated dead-end clicks, and a forced best-effort answer if the budget runs out — so a run always terminates with *something*, rather than spinning.

## Layout

```
backend/
  src/          orchestrator, perception, inventory, actuator, vlmClient,
                conversationRuntime, tableauSearch, viability, store, server
  public/       host.html — the Tableau embed page Playwright loads
  eval/         question sets + results
  config.json   model endpoint, timeouts, settle gate, starter dashboards
frontend/
  src/screens/  Landing · Watch · History
docs/           AGENT_PLAN.md · LIVE_TAKEOVER_PLAN.md · DESIGN.md
```

`config.json`'s `dashboards` array is a **starting shortcut** on the landing page, not a restriction — search or a pasted URL opens any Tableau Public workbook.

## Data egress

In normal operation, **a screenshot of the dashboard is sent to Google Gemini on every step.** The bundled dashboards are Tableau Public — already public data — so the sensitivity is low, but point it at something private and you should understand where the pixels go. No credentials or personal data are sent.

Dictation is handled by the browser's own Web Speech API (in Chrome, that means audio goes to Google's recognizer). The optional TTS path sends the agent's *answer text* — never your voice — to Groq.

## Limitations

- **Small click targets are unreliable.** Dense charts with many small marks are the main failure mode.
- **Tableau stories aren't supported.** No action advances a story point; the viability check detects this and says so up front.
- **One conversation at a time.** A single shared browser, guarded by a mutex.
- **Tableau Public's search endpoint is undocumented.** It has no SLA and can change without notice, so the proxy degrades to the local dashboard list rather than erroring — but a change there is a change we don't control.
- **Answers are not guaranteed correct.** Dense, fine-grained charts are hard to verify even by careful human inspection of the same screenshot. Treat model answers on that class of question as claims, not ground truth.

## Troubleshooting

**The backend says it's listening but nothing works (Windows).** Windows hands whole TCP ranges to Hyper-V/WSL/WinNAT out of the dynamic port range. If that range has been widened down into dev-port territory, reservations land on ports like 8990 — and a failed bind still fires Express's `listen` callback, so it can *look* like it started. The backend now checks `address()` and prints a real diagnostic instead.

Diagnose:

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

Permanent fix, in an **elevated** PowerShell, then reboot:

```bash
netsh int ipv4 set dynamicport tcp start=49152 num=16384
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=8990 numberofports=1 store=persistent
net start winnat
```

Quick escape hatch, no admin: `BACKEND_PORT=9500 npm run dev`, and set `hostPageOrigin` in `backend/config.json` to match.

**A run hangs on "Running".** Every stage is bounded (viz load 90s, model call 120s, action 30s, session 15min). If it truly hangs, a stuck Playwright page is the one thing that can't self-recover — restart the backend.

**"Settle timeout" warnings.** A dashboard took longer than 12s to stop changing. Occasional ones are normal on heavy workbooks; frequent ones mean that dashboard is a poor fit.

**Answers read aloud in a robotic voice.** The Groq TTS path failed and fell back to the OS voice. Check the backend log for `[tts] upstream` — `model_terms_required` means a one-time model terms acceptance is still pending in the Groq console.

## Things learned the hard way

Worth knowing before extending this:

- **Tableau's internal iframe reuses `id="viz"`.** The embed element is `id="agentViz"` to avoid Playwright locator collisions.
- **`Dashboard.applyFilterAsync` broadcasts natively** to every worksheet sharing a field. Range filters have no dashboard-level equivalent and still need per-worksheet calls.
- **Real workbooks contain decoy controls** — a "Select Region" parameter wired to nothing, sitting next to the `RegionName` filter that actually drives the view. The loop guard and escalating corrective feedback recover; nothing detects decoys directly, because that isn't generally knowable.
- **`getInventory()` throws on a story.** A Story object has no `getFiltersAsync`, so a story must be detected by reading the sheet type off the element *before* touching the bridge.
- **`waitForSettle` returns `{timedOut}` rather than throwing.** Ignore the return value and you'll screenshot a still-painting dashboard and conclude it rendered nothing.
- **Dashboards with `size.behavior === "automatic"`** have no published size to snap to, so frames carry dead margin and waste image tokens.

## Project notes

Earlier iterations ran a locally-hosted 4B vision model (llama.cpp) and actuated dashboards through structured Embedding API calls rather than clicks. That approach is retired, and its scaffolding has been removed — there is no local model server, no `llamaEndpoint`, and no GPU requirement. A hosted VLM with coordinate clicking is the only supported path; an unconfigured endpoint now fails loudly at startup of a run rather than quietly pointing at a dead localhost port.

Two things from that era remain on purpose. `config.actuationMode` still accepts `"api"`, which swaps in the structured-bridge prompt and lets the agent operate filters and parameters by id instead of by click — it runs against the same hosted endpoint, and is useful for comparing the two grounding strategies. And `eval/reading/` keeps the chart-reading crops and the measurements taken on the old local models, as archived data.

Build plans and contracts, if you want the reasoning behind the design: [docs/AGENT_PLAN.md](docs/AGENT_PLAN.md), [docs/LIVE_TAKEOVER_PLAN.md](docs/LIVE_TAKEOVER_PLAN.md), [docs/DESIGN.md](docs/DESIGN.md).
