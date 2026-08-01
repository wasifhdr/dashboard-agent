import { useEffect, useRef, useState } from "react";
import {
  getSession,
  getConversation,
  getConfig,
  getDashboardsMeta,
  createConversation,
  postTurn,
  stopSession,
  closeConversation,
  subscribeToSession,
} from "../../api.js";
import { TERMINAL_STATUSES } from "./terminalStatuses.js";

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
export function useSessionStream(
  mode,
  { sessionId, conversationId: replayConversationId, resumeConversationId, dashboardUrl, dashboardName },
) {
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
  // eagerly when the screen mounts in live mode (see the openConversation
  // effect below) so the dashboard is live and clickable before the user has
  // asked anything; startQuestion() falls back to creating it if that eager
  // open failed. Stays null in replay mode.
  // The ref is read synchronously within startQuestion (same tick, before a
  // re-render); the state mirror is what the live-view channel (B1) subscribes
  // to, so it must trigger a re-render when the conversation is created.
  const conversationIdRef = useRef(null);
  const [conversationId, setConversationId] = useState(null);
  // Resume (page refresh into a still-running conversation): adopt the
  // existing conversation instead of creating one. Seeded synchronously so
  // the eager-open effect below sees it and stands down, and so the live
  // channel connects on the first render rather than a tick later.
  if (resumeConversationId && conversationIdRef.current === null) {
    conversationIdRef.current = resumeConversationId;
  }
  // Holds the in-flight createConversation() promise for the window between
  // startQuestion's first call and that POST resolving - conversationIdRef is
  // still null for that whole window (up to ~90s: the dashboard is opening),
  // so a caller that needs the id right now (e.g. Watch's End-session button,
  // which can be clicked during that window) can await this instead of
  // silently treating "no id yet" as "no conversation exists" - see
  // getConversationId below.
  const pendingConversationRef = useRef(null);
  // Monotonic token identifying the current question. stopTurn()/stopAndLeave()
  // bump it; a startQuestion() call whose token is no longer current bails out
  // before starting a turn (covers Stop pressed while the dashboard is still
  // opening). Per-call token (not a shared boolean) so a later question isn't
  // wrongly treated as cancelled by an earlier stop.
  const questionTokenRef = useRef(0);
  // True while a createConversation() POST is in flight (the dashboard is
  // opening). Drives the Watch stage's "Opening the live dashboard…" state
  // before any turn exists, which used to be inferable only from a run's
  // status:"loading".
  const [conversationOpening, setConversationOpening] = useState(false);
  // Message from a failed conversation open, so the stage can say so instead
  // of spinning forever. Cleared on the next attempt.
  const [conversationError, setConversationError] = useState(null);

  // Single funnel to "this Watch instance's conversation id", creating the
  // conversation on first call and de-duplicating concurrent callers through
  // pendingConversationRef (the eager open effect, StrictMode's double-invoke
  // of it, and a question asked while that open is still in flight all land
  // here - only one POST /api/conversations is ever sent).
  async function ensureConversation() {
    if (conversationIdRef.current) return conversationIdRef.current;
    if (pendingConversationRef.current) {
      const { conversation_id } = await pendingConversationRef.current;
      return conversation_id;
    }
    const createPromise = createConversation({
      dashboardUrl: dashboard.url,
      dashboardName: dashboard.name,
    });
    pendingConversationRef.current = createPromise;
    setConversationOpening(true);
    setConversationError(null);
    try {
      const { conversation_id } = await createPromise;
      conversationIdRef.current = conversation_id;
      setConversationId(conversation_id);
      return conversation_id;
    } catch (err) {
      setConversationError(err.message);
      throw err;
    } finally {
      // Only clear if this call still owns the slot, so a later attempt's
      // promise isn't dropped by an earlier one's unwinding.
      if (pendingConversationRef.current === createPromise) pendingConversationRef.current = null;
      setConversationOpening(false);
    }
  }

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
    const token = ++questionTokenRef.current;
    const isFirstTurn = !conversationIdRef.current;
    // Push a placeholder run for EVERY turn, before any await. Neither await
    // below is instant: the first turn may still be waiting on the dashboard
    // open (up to ~90s), and every later turn waits on POST turns, which the
    // server answers only after captureTakeoverEnd() has snapshotted and
    // diffed the dashboard - seconds, during which the server has ALREADY
    // locked input and veiled the live view. Without a run here, `isRunning`
    // stays false for that whole window, so the Composer keeps showing the
    // typed question as if nothing happened and the stage pill still claims
    // "Yours - click to interact" over an already-veiled dashboard.
    setRuns((prev) => [
      ...prev,
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
    // Both awaits below can fail independently (conversation creation, then
    // the turn POST). Either failure must drop the placeholder pushed above
    // rather than leave a run stuck at status:"loading" forever.
    try {
      if (isFirstTurn) await ensureConversation();
      // The user hit Stop / End session while the dashboard was still opening -
      // this question was superseded, so don't start a turn for it (End session
      // separately closes the conversation now that its id is known).
      if (questionTokenRef.current !== token) return null;
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
      // Swap the placeholder for the real run rather than appending, so the
      // turn keeps the one slot it has occupied in the thread since submit.
      setRuns((prev) =>
        prev.length && !prev[prev.length - 1].sessionId ? [...prev.slice(0, -1), newRun] : [...prev, newRun],
      );
      subscribeLive(session_id);
      return session_id;
    } catch (err) {
      // Drop the placeholder pushed above (only if it's still the trailing
      // run - Stop may have already removed it); ensureConversation owns
      // clearing pendingConversationRef, so nothing else to unwind here.
      setRuns((prev) => (prev.length && !prev[prev.length - 1].sessionId ? prev.slice(0, -1) : prev));
      throw err;
    }
  }

  // Resolves to the conversation id this Watch instance is driving, waiting
  // out an in-flight createConversation() call if one is still pending
  // (rather than the caller treating a not-yet-populated conversationIdRef as
  // "no conversation exists" - see pendingConversationRef above). Resolves to
  // null only when no conversation was ever created (or its creation failed).
  async function getConversationId() {
    if (conversationIdRef.current) return conversationIdRef.current;
    if (pendingConversationRef.current) {
      try {
        const { conversation_id } = await pendingConversationRef.current;
        return conversation_id;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Stop the CURRENT response but stay on the Watch screen (the live dashboard
  // stays open for a follow-up). Reflects the stop in the UI immediately -
  // optimistic, so it never waits on the backend - while stopSession aborts the
  // in-flight VLM call in the background. Bumping the token also cancels a turn
  // still in its dashboard-opening phase (no session id yet).
  function stopTurn() {
    questionTokenRef.current++;
    const last = runs[runs.length - 1];
    if (last?.sessionId) stopSession(last.sessionId).catch(() => {});
    // Stop applying further live events for this run, then reflect the stop now.
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setRuns((prev) => {
      if (prev.length === 0) return prev;
      const lastRun = prev[prev.length - 1];
      if (!lastRun.sessionId) return prev.slice(0, -1); // still opening: no turn yet, drop it
      if (TERMINAL_STATUSES.has(lastRun.status)) return prev; // already finished
      const stopped = { ...lastRun, status: "stopped" };
      // Drop a trailing step still stuck on "Reading the dashboard…" (a frame
      // captured but no thought/action yet) so it doesn't render a spinner that
      // never resolves next to the STOPPED card.
      const idxs = [...stopped.steps.keys()].sort((a, b) => a - b);
      const lastIdx = idxs[idxs.length - 1];
      const lastStep = lastIdx != null ? stopped.steps.get(lastIdx) : null;
      if (lastStep && !lastStep.thought && !lastStep.planned) {
        const steps = new Map(stopped.steps);
        steps.delete(lastIdx);
        stopped.steps = steps;
      }
      const next = [...prev];
      next[next.length - 1] = stopped;
      return next;
    });
  }

  // "End session": abort the running turn's in-flight VLM call AND close the
  // conversation (freeing the live dashboard). Fire-and-forget so the caller
  // can navigate away this instant regardless of backend latency;
  // getConversationId() waits out an in-flight dashboard open so the
  // conversation is still closed even if End session was hit mid-open.
  function stopAndLeave() {
    questionTokenRef.current++;
    const lastSid = runs[runs.length - 1]?.sessionId;
    if (lastSid) stopSession(lastSid).catch(() => {});
    getConversationId()
      .then((id) => (id ? closeConversation(id) : null))
      .catch(() => {});
  }

  // Open the live dashboard as soon as the Watch screen mounts in live mode,
  // instead of waiting for the first question: the conversation runtime starts
  // in mode 'idle', so the screencast connects and the dashboard is the user's
  // to click straight away, and the first question no longer pays the ~90s
  // open. Runs once per dashboard url; ensureConversation de-duplicates
  // StrictMode's double-invoke. A failure is surfaced via conversationError
  // (and retried by the first question), not thrown into the effect.
  useEffect(() => {
    if (mode !== "live" || !dashboard?.url) return;
    // Never create a conversation while resuming one. POST /api/conversations
    // makes the server close the previous runtime - it would tear down the
    // very session being resumed and silently reload the dashboard.
    if (resumeConversationId) return;
    ensureConversation().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dashboard?.url, resumeConversationId]);

  // Dashboard thumbnail (for Stage's loading state) + global maxSteps.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getConfig(), getDashboardsMeta()])
      .then(([cfg, meta]) => {
        if (cancelled) return;
        setMaxSteps(cfg.maxSteps ?? DEFAULT_MAX_STEPS);
        // On a resume there is no dashboardUrl prop; the url arrives from the
        // fetched conversation instead.
        const targetUrl = mode === "live" ? (dashboardUrl ?? dashboard?.url) : dashboard?.url;
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
    // Also runs for a live resume, which needs exactly the same load: fetch
    // the conversation, rebuild the thread, re-attach to a running turn.
    if (mode !== "replay" && !resumeConversationId) return undefined;
    setDashboard(null);
    setRuns([]);
    setLoadError(null);
    setTrailingTakeover(null);

    let cancelled = false;

    // Full-conversation replay (docs/LIVE_TAKEOVER_PLAN.md §9 Phase B3) takes
    // precedence over the legacy single-session path below when both were
    // somehow passed - see useSessionStream's Watch/App callers, which never
    // do this in practice, but branch order keeps it deterministic if they did.
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
              setConversationId(resumeConversationId);
              return;
            }
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
          if (resumeConversationId) setConversationId(resumeConversationId);

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
  }, [mode, sessionId, replayConversationId, resumeConversationId]);

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
    conversationOpening,
    conversationError,
    trailingTakeover,
    startQuestion,
    reconnect,
    getConversationId,
    stopTurn,
    stopAndLeave,
  };
}
