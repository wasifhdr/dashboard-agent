import { useEffect, useRef, useState } from "react";
import {
  getSession,
  getConversation,
  getConfig,
  getDashboardsMeta,
  createConversation,
  postTurn,
  subscribeToSession,
} from "../../api.js";

const DEFAULT_MAX_STEPS = 15;

function inventorySummaryOf(inventory) {
  if (!inventory) return null;
  return {
    activeSheet: inventory.activeSheet,
    sheetCount: inventory.sheets?.length ?? 0,
    filterCount: inventory.filters?.length ?? 0,
    parameterCount: inventory.parameters?.length ?? 0,
  };
}

function mapStoredStepToStep(s) {
  return {
    idx: s.idx,
    pending: false,
    attempt: null,
    thought: s.thought,
    planned: s.action ? { action: s.action, label: s.overlay?.action_badge?.text ?? s.action.type } : null,
    action: s.action,
    actionStatus: s.action_status,
    errorMsg: s.error_msg,
    frameUrl: s.frame_url,
    overlay: s.overlay,
    inventorySummary: inventorySummaryOf(s.inventory),
    durationMs: s.duration_ms,
    settleTimeout: Boolean(s.settle_timeout),
    stepStartedAt: null,
  };
}

function parseMaxSteps(configJson) {
  try {
    return JSON.parse(configJson || "{}").maxSteps ?? DEFAULT_MAX_STEPS;
  } catch {
    return DEFAULT_MAX_STEPS;
  }
}

// takeovers.summary_json -> array of {kind:'filter'|'parameter'|'sheet',
// field?, from, to} (see docs/LIVE_TAKEOVER_PLAN.md §4.1 and
// conversationRuntime.js's diffInventories). Tolerates a missing/malformed
// string the same way parseMaxSteps tolerates a missing/malformed config.
function parseTakeoverSummary(json) {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Shapes the takeover row a turns-POST response piggybacks (or null) into
// what Feed's takeover card renders. Attached onto the *new* run as
// `precedingTakeover` (Watch's thread renders one turn per run, so "the
// takeover between the previous turn and this one" naturally belongs on
// this run - see docs/LIVE_TAKEOVER_PLAN.md §8/§9 Phase B2).
function toPrecedingTakeover(takeover) {
  if (!takeover) return null;
  return { ...takeover, summary: parseTakeoverSummary(takeover.summary_json) };
}

function blankStep(idx) {
  return {
    idx,
    pending: false,
    attempt: null,
    thought: null,
    planned: null,
    action: null,
    actionStatus: null,
    errorMsg: null,
    frameUrl: null,
    overlay: { action_badge: null, widget_bbox: null, changed_regions: null },
    inventorySummary: null,
    durationMs: null,
    settleTimeout: false,
    stepStartedAt: null,
  };
}

function upsertStep(stepsMap, idx, patch) {
  const next = new Map(stepsMap);
  const existing = next.get(idx) ?? blankStep(idx);
  next.set(idx, { ...existing, ...patch });
  return next;
}

// Per key, incoming non-null overwrites; incoming null never clears an
// existing non-null value (FRONTEND_PLAN.md §6.2 overlay merge rule).
function mergeOverlay(base, incoming) {
  const b = base ?? { action_badge: null, widget_bbox: null, changed_regions: null };
  const i = incoming ?? {};
  return {
    action_badge: i.action_badge ?? b.action_badge,
    widget_bbox: i.widget_bbox ?? b.widget_bbox,
    changed_regions: i.changed_regions ?? b.changed_regions,
  };
}

// Reduces one live SSE event into a new Run object. Must be idempotent - the
// bus replays its full event buffer on every new subscription (including
// reconnects), so replayed duplicates must land in the same state, never
// accumulate (e.g. `warnings` is deduped, not blindly appended).
function reduceEvent(run, evt) {
  switch (evt.type) {
    case "session_started":
      return { ...run, status: "loading" };
    case "step_started":
      return {
        ...run,
        status: "running",
        steps: upsertStep(run.steps, evt.idx, { pending: true, stepStartedAt: Date.now() }),
      };
    case "frame": {
      const existing = run.steps.get(evt.idx);
      const overlay = mergeOverlay(existing?.overlay, evt.overlay);
      return { ...run, steps: upsertStep(run.steps, evt.idx, { frameUrl: evt.url, overlay }) };
    }
    case "vlm_attempt":
      return { ...run, steps: upsertStep(run.steps, evt.idx, { attempt: evt.attempt }) };
    case "thought":
      return { ...run, steps: upsertStep(run.steps, evt.idx, { thought: evt.text }) };
    case "action_planned":
      return { ...run, steps: upsertStep(run.steps, evt.idx, { planned: { action: evt.action, label: evt.label } }) };
    case "widget_bbox": {
      const existing = run.steps.get(evt.idx);
      const overlay = mergeOverlay(existing?.overlay, { widget_bbox: evt.bbox });
      return { ...run, steps: upsertStep(run.steps, evt.idx, { overlay }) };
    }
    case "action":
      return {
        ...run,
        steps: upsertStep(run.steps, evt.idx, {
          action: evt.action,
          actionStatus: evt.status,
          errorMsg: evt.error_msg,
          pending: false,
        }),
      };
    case "inventory":
      return { ...run, steps: upsertStep(run.steps, evt.idx, { inventorySummary: evt.summary }) };
    case "warning": {
      const alreadyPresent = run.warnings.some((w) => w.idx === evt.idx && w.kind === evt.kind);
      return alreadyPresent ? run : { ...run, warnings: [...run.warnings, { idx: evt.idx, kind: evt.kind }] };
    }
    case "session_done":
      return { ...run, status: evt.status, finalAnswer: evt.final_answer, confidence: evt.confidence, error: evt.error };
    default:
      return run;
  }
}

// Session-state hook for the Watch screen (FRONTEND_PLAN.md §6.2). `replay`
// fetches a finished (or in-progress, for live re-attach) session once;
// `live` starts brand-new sessions via startQuestion and reduces their SSE
// stream incrementally. Both share the same Run/Step state shape.
export function useSessionStream(mode, { sessionId, conversationId: replayConversationId, dashboardUrl, dashboardName }) {
  const [dashboard, setDashboard] = useState(mode === "live" ? { url: dashboardUrl, name: dashboardName } : null);
  const [runs, setRuns] = useState([]);
  const [loadError, setLoadError] = useState(null);
  // A takeover captured after the LAST turn of a replayed conversation (e.g.
  // right as it was closed), with no further turn ever asked to attach it to
  // as a run's `precedingTakeover` - see docs/LIVE_TAKEOVER_PLAN.md §9 Phase
  // B2's documented scope boundary and Phase B3's replay requirements. Stays
  // null for the sessionId (legacy single-session) replay path and for live
  // mode, where it never applies.
  const [trailingTakeover, setTrailingTakeover] = useState(null);
  const [connectionError, setConnectionError] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState(null);
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS);
  const [exampleQuestions, setExampleQuestions] = useState([]);
  // Sticky flag: was this Watch instance ever live (fresh question, or a
  // live-reattach to a running session)? Stays true for its whole lifetime
  // once set, even after the run finishes - so Feed doesn't remount a step
  // from the live rendering path to the replay one mid-session just because
  // its status became terminal.
  const [everLive, setEverLive] = useState(mode === "live");
  // Session ids that have actually been driven by a live SSE subscription at
  // least once - unlike `everLive` (sticky for the whole Watch instance),
  // this is per-run. Needed so Feed renders only the run(s) that were truly
  // live via LiveStepCard, instead of applying that to every run when
  // reattaching to the running last turn of a replayed multi-turn
  // conversation, which would spuriously re-typewriter earlier, already-
  // resolved turns' thoughts on load (review fix; see
  // docs/LIVE_TAKEOVER_PLAN.md §9 Phase B3).
  const [liveSessionIds, setLiveSessionIds] = useState(() => new Set());
  const unsubscribeRef = useRef(null);
  // The one conversation this live Watch instance drives, shared across all
  // its turns (B0: turns reuse the same persistent dashboard page). Created
  // lazily on the first startQuestion() call; stays null in replay mode.
  // The ref is read synchronously within startQuestion (same tick, before a
  // re-render); the state mirror is what the live-view channel (B1) subscribes
  // to, so it must trigger a re-render when the conversation is created.
  const conversationIdRef = useRef(null);
  const [conversationId, setConversationId] = useState(null);

  function applyEvent(runSessionId, evt) {
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.sessionId === runSessionId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = reduceEvent(prev[idx], evt);
      return next;
    });
  }

  function subscribeLive(runSessionId) {
    setConnectionError(false);
    setEverLive(true);
    setLiveSessionIds((prev) => (prev.has(runSessionId) ? prev : new Set(prev).add(runSessionId)));
    unsubscribeRef.current?.();
    unsubscribeRef.current = subscribeToSession(runSessionId, {
      onEvent: (evt) => applyEvent(runSessionId, evt),
      onError: () => setConnectionError(true),
    });
  }

  function reconnect() {
    const last = runs[runs.length - 1];
    if (last) subscribeLive(last.sessionId);
  }

  async function startQuestion(question) {
    const isFirstTurn = !conversationIdRef.current;
    if (isFirstTurn) {
      // POST /api/conversations itself blocks until the dashboard has opened
      // and settled (up to ~90s on first load) - push a placeholder run
      // *before* that await so `runs`/`lastRun` are non-empty for the whole
      // wait, not just after it. Without this, Watch.jsx's loadingState gate
      // and Composer's isRunning branch both stay inactive for the entire
      // open, making the first question of a conversation look hung (B0
      // review fix).
      setRuns([
        {
          sessionId: null,
          question,
          status: "loading",
          finalAnswer: null,
          confidence: null,
          error: null,
          warnings: [],
          steps: new Map(),
          startedAt: Date.now(),
          maxSteps,
          precedingTakeover: null,
        },
      ]);
    }
    // Both awaits below can fail independently (conversation creation, then
    // the turn POST). Either failure must clear the placeholder pushed above
    // rather than leave a run stuck at status:"loading" forever - matching
    // the pre-fix behavior where a failure left `runs` untouched.
    try {
      if (isFirstTurn) {
        const { conversation_id } = await createConversation({
          dashboardUrl: dashboard.url,
          dashboardName: dashboard.name,
        });
        conversationIdRef.current = conversation_id;
        setConversationId(conversation_id);
      }
      const { session_id, takeover } = await postTurn(conversationIdRef.current, question);
      const newRun = {
        sessionId: session_id,
        question,
        status: "loading",
        finalAnswer: null,
        confidence: null,
        error: null,
        warnings: [],
        steps: new Map(),
        startedAt: Date.now(),
        maxSteps,
        // Non-null only when the user changed the dashboard (via live
        // takeover) between the previous turn ending and this one starting -
        // Feed renders it as a card right before this run.
        precedingTakeover: toPrecedingTakeover(takeover),
      };
      setRuns((prev) => (isFirstTurn ? [newRun] : [...prev, newRun]));
      subscribeLive(session_id);
      return session_id;
    } catch (err) {
      if (isFirstTurn) setRuns([]);
      throw err;
    }
  }

  // Dashboard thumbnail (for Stage's loading state) + global maxSteps.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getConfig(), getDashboardsMeta()])
      .then(([cfg, meta]) => {
        if (cancelled) return;
        setMaxSteps(cfg.maxSteps ?? DEFAULT_MAX_STEPS);
        const targetUrl = mode === "live" ? dashboardUrl : dashboard?.url;
        const entry = (meta.dashboards ?? []).find((d) => d.url === targetUrl);
        setThumbnailUrl(entry?.thumbnailUrl ?? null);
        const cfgEntry = (cfg.dashboards ?? []).find((d) => d.url === targetUrl);
        setExampleQuestions(cfgEntry?.exampleQuestions ?? []);
      })
      .catch(() => {
        /* thumbnail is a nice-to-have loading aid, not required */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dashboardUrl, dashboard?.url]);

  useEffect(() => {
    if (mode !== "replay") return undefined;
    setDashboard(null);
    setRuns([]);
    setLoadError(null);
    setTrailingTakeover(null);

    let cancelled = false;

    // Full-conversation replay (docs/LIVE_TAKEOVER_PLAN.md §9 Phase B3) takes
    // precedence over the legacy single-session path below when both were
    // somehow passed - see useSessionStream's Watch/App callers, which never
    // do this in practice, but branch order keeps it deterministic if they did.
    if (replayConversationId) {
      getConversation(replayConversationId)
        .then(({ conversation, turns, takeovers }) => {
          if (cancelled) return;
          if (turns.length === 0) {
            // A conversation row is persisted as soon as the dashboard opens,
            // before any turn is ever posted (conversationRuntime.js) - if the
            // first postTurn never completes (tab closed, dropped network, a
            // 409), a real zero-turn conversation is left behind. There is no
            // run to replay and no in-panel UI for "ask a first question" in
            // pure-replay mode, so surface this as a load error instead of
            // leaving `runs` empty forever (Watch's !primaryRun branch would
            // otherwise spin on "Loading session…" indistinguishably from a
            // still-in-flight fetch - review fix).
            setLoadError("This conversation has no turns yet — there is nothing to replay.");
            return;
          }
          setDashboard({ url: conversation.dashboard_url, name: conversation.dashboard_name });

          const turnIndices = new Set(turns.map((t) => t.session.turn_index));
          const newRuns = turns.map((t) => {
            const preceding = takeovers.find((tk) => tk.after_turn_index + 1 === t.session.turn_index);
            return {
              sessionId: t.session.id,
              question: t.session.question,
              status: t.session.status,
              finalAnswer: t.session.final_answer,
              confidence: t.session.confidence,
              error: t.session.error_message,
              warnings: [],
              steps: new Map(t.steps.map((s) => [s.idx, mapStoredStepToStep(s)])),
              startedAt: t.session.created_at,
              maxSteps: parseMaxSteps(t.session.config_json),
              precedingTakeover: toPrecedingTakeover(preceding),
            };
          });
          setRuns(newRuns);

          // The takeover (if any) whose after_turn_index+1 matches no turn in
          // this conversation was captured after the LAST turn and never got
          // a following turn to attach to as `precedingTakeover` - Feed renders
          // it after the last run instead (see the state comment above).
          const trailing = takeovers.find((tk) => !turnIndices.has(tk.after_turn_index + 1));
          setTrailingTakeover(toPrecedingTakeover(trailing));

          const lastTurn = turns[turns.length - 1];
          if (lastTurn && lastTurn.session.status === "running") {
            // Live re-attach: only one turn can ever be running at a time
            // system-wide, so this mirrors the sessionId path below exactly -
            // the bus replays its buffer; the idempotent reducer lands those
            // events on top of the state above safely.
            subscribeLive(lastTurn.session.id);
          }
        })
        .catch((e) => {
          if (!cancelled) setLoadError(e.message);
        });
    } else if (sessionId) {
      getSession(sessionId)
        .then(({ session, steps }) => {
          if (cancelled) return;
          setDashboard({ url: session.dashboard_url, name: session.dashboard_name });
          const stepMap = new Map(steps.map((s) => [s.idx, mapStoredStepToStep(s)]));
          setRuns([
            {
              sessionId: session.id,
              question: session.question,
              status: session.status,
              finalAnswer: session.final_answer,
              confidence: session.confidence,
              error: session.error_message,
              warnings: [],
              steps: stepMap,
              startedAt: session.created_at,
              maxSteps: parseMaxSteps(session.config_json),
            },
          ]);
          if (session.status === "running") {
            // Live re-attach: the bus replays its buffer; the idempotent
            // reducer lands those events on top of the state above safely.
            subscribeLive(session.id);
          }
        })
        .catch((e) => {
          if (!cancelled) setLoadError(e.message);
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sessionId, replayConversationId]);

  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  return {
    dashboard,
    runs,
    loadError,
    connectionError,
    thumbnailUrl,
    everLive,
    liveSessionIds,
    maxSteps,
    exampleQuestions,
    conversationId,
    trailingTakeover,
    startQuestion,
    reconnect,
  };
}
