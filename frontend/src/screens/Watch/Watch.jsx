import { useEffect, useRef, useState } from "react";
import { useSessionStream } from "./useSessionStream.js";
import { useLiveChannel } from "./useLiveChannel.js";
import { useBeatSequencer } from "./useBeatSequencer.js";
import { TERMINAL_STATUSES } from "./terminalStatuses.js";
import Stage from "./Stage.jsx";
import LiveStage from "./LiveStage.jsx";
import Filmstrip from "./Filmstrip.jsx";
import Feed from "./Feed.jsx";
import Composer from "./Composer.jsx";
import ChatPanel from "./ChatDock.jsx";
import QuickAsk from "./QuickAsk.jsx";
import Spinner from "../../components/ui/Spinner.jsx";
import { cx } from "../../components/ui/cx.js";
import Card from "../../components/ui/Card.jsx";
import Badge from "../../components/ui/Badge.jsx";
import Button from "../../components/ui/Button.jsx";
import { WARNING_LABEL, INSPECTION_LABEL } from "./warningLabels.js";
import { useSpeechSynthesis } from "../../hooks/useSpeechSynthesis.js";
import { loadReadAloudPref, saveReadAloudPref, speakableAnswer } from "./speech.js";

// Live height of a node, via ResizeObserver. Used for the composer: it floats
// over the bottom of the thread and changes height (auto-growing textarea, plus
// a second row while a turn runs), so the thread's bottom clearance has to be
// measured rather than guessed. Returned as state on purpose — the re-render is
// what lets the Feed re-pin its scroll to the bottom as the composer grows.
// Callback ref rather than a plain ref so a node that mounts later (the composer
// is absent during a pure replay) is still picked up.
function useMeasuredHeight() {
  const [node, setNode] = useState(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setHeight(Math.round(entry.contentRect.height)));
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, height];
}

// Small square "stop" glyph for the red end-session button in the thread header.
function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function flattenSteps(runs) {
  const flat = [];
  runs.forEach((run, runIdx) => {
    [...run.steps.keys()]
      .sort((a, b) => a - b)
      .forEach((stepIdx) => flat.push({ runIdx, stepIdx }));
  });
  return flat;
}

// Watch screen (FRONTEND_PLAN.md §6). `mode === "live"` starts fresh (or
// follow-up) questions on `dashboardTarget` via the Composer; `mode ===
// "replay"` loads a historical session (live re-attaching automatically if
// it's still running - see useSessionStream's replay branch).
// `confirm` is App's promise-based ConfirmDialog opener (see ui/ConfirmDialog).
// Taken as a prop rather than mounting a second dialog here so there is exactly
// one overlay in the tree, anchored above Watch's fixed-viewport cockpit layout.
export default function Watch({ mode, sessionId, conversationId, dashboardTarget, onBack, onEnd, onActiveRunChange, onDashboardChange, confirm }) {
  const stream = useSessionStream(mode, {
    sessionId,
    conversationId,
    dashboardUrl: dashboardTarget?.url,
    dashboardName: dashboardTarget?.name,
  });
  // Renamed on destructure: `conversationId` above is the incoming replay
  // prop; `stream.conversationId` is the live conversation this Watch
  // instance itself created (null until the first turn, and always null in
  // replay mode) - the one the End-session control and live channel need.
  const { dashboard, runs, loadError, trailingTakeover, conversationId: liveConversationId } = stream;
  // Live, read-only screencast of the agent's browser (Phase B1). Connects
  // once the conversation exists (after the first turn's dashboard load).
  const live = useLiveChannel(liveConversationId);
  const sequencer = useBeatSequencer(runs);
  const [manualSelected, setManualSelected] = useState(null);
  const [followLive, setFollowLive] = useState(mode === "live");
  const showOverlay = true; // step-action overlays are always on now (toggle removed)
  // Floating conversation dock: minimized to a bubble by default so the
  // dashboard gets the whole canvas; the bubble expands it on demand.
  const [dockOpen, setDockOpen] = useState(false);
  const [inspectionDismissed, setInspectionDismissed] = useState(false);
  // Reset on the SAME clock useLiveChannel resets `live.inspection` on. The
  // banner renders on the AND of the two, so if this one only reset on unmount
  // (plain useState) they'd tick differently: dismiss a banner, reach a second
  // unusable conversation without leaving this screen, and the new verdict
  // would arrive to a still-true dismissed flag and be silently suppressed.
  // Unreachable today (App.jsx unmounts Watch between live conversations), but
  // that's a routing coincidence, not a guarantee — and the failure is an
  // un-shown warning, which is exactly the kind that goes unnoticed.
  useEffect(() => {
    setInspectionDismissed(false);
  }, [liveConversationId]);
  // True when a turn finished while the dock was minimized, so the bubble can
  // advertise "Response ready" until the user looks at it.
  const [unread, setUnread] = useState(false);
  // Read-aloud (TTS) of each turn's final answer. Off by default, remembered
  // across sessions, and only ever the answer — never thoughts or action cards.
  const tts = useSpeechSynthesis();
  const [readAloud, setReadAloud] = useState(loadReadAloudPref);
  // Measured height of the floating composer, fed to the Feed as its bottom
  // clearance so the thread scrolls up as the composer grows instead of being
  // overlapped by it.
  const [composerRef, composerHeight] = useMeasuredHeight();

  const primaryRun = runs[0] ?? null;
  const lastRun = runs[runs.length - 1] ?? null;
  const isRunning = !!lastRun && !TERMINAL_STATUSES.has(lastRun.status);
  const canPlay = runs.length > 0 && runs.every((r) => TERMINAL_STATUSES.has(r.status));
  const isPureReplay = !stream.everLive;

  useEffect(() => {
    onActiveRunChange?.(isRunning);
  }, [isRunning, onActiveRunChange]);

  // Flag "Response ready" on the minimized bubble the moment a running turn
  // settles while the dock is closed. Opening the dock (below) clears it.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning && !dockOpen) setUnread(true);
    wasRunningRef.current = isRunning;
  }, [isRunning, dockOpen]);

  function openDock() {
    setDockOpen(true);
    setUnread(false);
  }

  // Applies to LATER turns only: switching it on does NOT read the answer
  // already on screen. It used to, on the reasoning that a toggle which stays
  // silent until the next question looks broken — but that made enabling it for
  // future turns always cost an unwanted replay of the last one. The answer on
  // screen now has its own speaker button on its outcome card, which is the
  // precise way to hear one response, so the toggle can mean only what it says.
  function toggleReadAloud() {
    const next = !readAloud;
    setReadAloud(next);
    saveReadAloudPref(next);
    if (!next) tts.cancel(); // turning it off mid-sentence should shut up now
  }

  // Speak each turn's answer once, as it lands.
  //
  // Scoped to `liveSessionIds` — the runs actually driven by a live SSE
  // subscription — for the same reason Feed uses it: opening a past
  // conversation from History must not read its whole answer history aloud.
  // Turns are marked spoken whether or not the toggle is on, so this effect
  // never replays a backlog of answers when the toggle flips. Speaking the
  // answer already on screen at that moment is toggleReadAloud's job.
  const spokenRef = useRef(new Set());
  // Set by handleVoiceAsk; makes the next settling turn speak regardless of the
  // toggle, then clears itself.
  const forceSpeakRef = useRef(false);
  useEffect(() => {
    runs.forEach((run) => {
      if (!TERMINAL_STATUSES.has(run.status)) return;
      if (!stream.liveSessionIds?.has(run.sessionId)) return;
      if (spokenRef.current.has(run.sessionId)) return;
      spokenRef.current.add(run.sessionId);
      // Read (and clear) the override here rather than at ask time, so it is
      // consumed exactly once by the turn it was set for.
      const forced = forceSpeakRef.current;
      forceSpeakRef.current = false;
      if ((!readAloud && !forced) || !tts.supported) return;
      const text = speakableAnswer(run);
      if (text) tts.speak(text);
    });
  }, [runs, readAloud, stream.liveSessionIds, tts.supported, tts.speak]);

  // Per-answer read-aloud — the small speaker on each outcome card. Reads that
  // one answer once, independent of the toggle and of whether the turn was ever
  // live, so it also works in replay where the composer (and its toggle) isn't
  // mounted at all. Tracked by session id so the card currently being read can
  // offer to STOP rather than restart itself.
  const [speakingRunId, setSpeakingRunId] = useState(null);
  useEffect(() => {
    if (!tts.speaking) setSpeakingRunId(null);
  }, [tts.speaking]);

  function handleSpeakRun(run) {
    if (speakingRunId === run.sessionId && tts.speaking) {
      tts.cancel(); // the effect above clears speakingRunId
      return;
    }
    const text = speakableAnswer(run);
    if (!text) return;
    setSpeakingRunId(run.sessionId);
    tts.speak(text);
  }

  // Surface the resolved dashboard {name, url} to the app header (clickable
  // link). In live mode the stream fills this in once the first turn opens the
  // dashboard; in replay it comes from the loaded session.
  useEffect(() => {
    if (dashboard?.name || dashboard?.url) onDashboardChange?.({ name: dashboard.name, url: dashboard.url });
  }, [dashboard?.name, dashboard?.url, onDashboardChange]);

  useEffect(() => {
    if (manualSelected || followLive || !primaryRun) return;
    const firstIdx = [...primaryRun.steps.keys()].sort((a, b) => a - b)[0];
    if (firstIdx != null) setManualSelected({ runIdx: 0, stepIdx: firstIdx });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRun]);

  // Whenever playback stops - whether the user paused it or it finished the
  // walk on its own - sync the manual selection to wherever it ended up, so
  // the view doesn't snap back to the pre-Play position.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (wasPlayingRef.current && !sequencer.isPlaying && sequencer.lastSelection) {
      setManualSelected(sequencer.lastSelection);
    }
    wasPlayingRef.current = sequencer.isPlaying;
  }, [sequencer.isPlaying, sequencer.lastSelection]);

  const flatSteps = flattenSteps(runs);
  const latestFlatStep = flatSteps[flatSteps.length - 1] ?? null;

  const effectiveSelected = sequencer.playback
    ? { runIdx: sequencer.playback.runIdx, stepIdx: sequencer.playback.stepIdx }
    : followLive && latestFlatStep
      ? latestFlatStep
      : manualSelected;

  const selectedStep =
    effectiveSelected && runs[effectiveSelected.runIdx]
      ? runs[effectiveSelected.runIdx].steps.get(effectiveSelected.stepIdx)
      : null;

  const selectedFlatIdx = effectiveSelected
    ? flatSteps.findIndex((s) => s.runIdx === effectiveSelected.runIdx && s.stepIdx === effectiveSelected.stepIdx)
    : -1;

  function selectStep(sel) {
    sequencer.pause();
    setFollowLive(false);
    setManualSelected(sel);
  }

  function jumpToLive() {
    setFollowLive(true);
  }

  function goPrev() {
    if (selectedFlatIdx > 0) selectStep(flatSteps[selectedFlatIdx - 1]);
  }
  function goNext() {
    if (selectedFlatIdx >= 0 && selectedFlatIdx < flatSteps.length - 1) selectStep(flatSteps[selectedFlatIdx + 1]);
  }

  function togglePlay() {
    if (sequencer.isPlaying) sequencer.pause();
    else sequencer.play();
  }

  useEffect(() => {
    function handleKey(e) {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFlatIdx, flatSteps.length]);

  async function handleAsk(question) {
    tts.cancel(); // a new question cuts off the previous answer being read
    await stream.startQuestion(question);
    setFollowLive(true);
  }

  // A question asked by voice from the minimized dock is always spoken back,
  // whatever the Read-aloud toggle says — you asked without looking, so you
  // shouldn't have to look to get the answer. Deliberately a ONE-SHOT: the
  // saved preference is left alone, so typing a question later still behaves
  // however the user set it.
  //
  // Consumed by whichever turn settles first, which is unambiguous because the
  // backend runs one turn at a time. It's cleared even when the turn produces
  // no speakable answer (error/stopped), so a failed voice turn can't leak the
  // override onto the next typed one. (`forceSpeakRef` is declared up with
  // `spokenRef`, next to the effect that consumes it.)
  async function handleVoiceAsk(question) {
    forceSpeakRef.current = true;
    try {
      await handleAsk(question);
    } catch (err) {
      forceSpeakRef.current = false;
      throw err;
    }
  }

  // Composer "Stop": halt the current response but STAY on the Watch screen -
  // the live dashboard stays open so the user can ask a follow-up. Reflects
  // instantly (stream.stopTurn is optimistic) while the backend aborts the
  // in-flight VLM call in the background.
  function handleStopTurn() {
    stream.stopTurn();
  }

  // Header red "End session": leave to the landing page IMMEDIATELY (via onEnd)
  // while the backend cleanup — abort the in-flight VLM call + close the live
  // dashboard — runs in the background (stream.stopAndLeave is fire-and-forget).
  // The frontend never waits on the backend, so it's instant even mid-open or
  // mid-VLM-call.
  // Confirmed first because it is irreversible and instant: onEnd navigates away
  // before the backend cleanup has even been issued, so there is nothing to
  // undo. The header nav routes are gated the same way, in App's navigate().
  async function handleEndSession() {
    const ok = await confirm({
      title: "End this session?",
      body: isRunning
        ? "The agent is still working on your question. Ending closes the dashboard and the answer is lost."
        : "This closes the dashboard and ends the conversation. Past turns stay in your history.",
      confirmLabel: "End session",
      danger: true,
    });
    if (!ok) return;
    tts.cancel();
    stream.stopAndLeave();
    onEnd?.();
  }

  if (mode === "replay" && loadError) {
    return <div className="p-6 text-sm text-coral-ink">Failed to load session: {loadError}</div>;
  }
  if (mode === "replay" && !primaryRun) {
    return <div className="p-6 text-sm text-fg/60">Loading session…</div>;
  }

  // The dashboard now opens on mount, before any question (useSessionStream's
  // eager ensureConversation). Hold the loading overlay for that whole window —
  // through the POST and on until the screencast is actually on screen — so the
  // thumbnail never flashes "ask a question to begin" in the gap between the
  // conversation being created and the WS connecting.
  const openingLive =
    mode === "live" &&
    runs.length === 0 &&
    !stream.conversationError &&
    !live.connected &&
    !live.closedReason;
  // Turns after the first reuse the already-open page, so they're fast and
  // don't need the big overlay.
  // The second clause covers a question asked while the eager open is still in
  // flight (no conversation yet). Once the conversation exists the page is
  // already open, so a turn's own "loading" must NOT raise the big overlay -
  // every turn now pushes a placeholder run at submit time.
  const loadingState =
    openingLive || (!liveConversationId && lastRun?.status === "loading" && runs.length <= 1)
      ? {
          thumbnailUrl: stream.thumbnailUrl,
          message: "Opening the live dashboard… first load can take up to a minute.",
        }
      : null;

  const showConnectionBanner = stream.connectionError && isRunning;

  // Show the live screencast when following the running/idle conversation and
  // the WS is connected; scrubbing a past step or replaying falls back to the
  // per-step Stage frame (which is what's persisted). Also keep showing it
  // once live.closedReason is set even though live.connected has since
  // flipped false: the server's close() sequence broadcasts {type:"closed"}
  // and THEN closes the socket, so `connected` goes false moments after
  // `closedReason` is set for 3 of the 4 terminal reasons (idle_timeout,
  // browser_crashed, conversation_closed) - without this, LiveStage (the only
  // place that renders the "why did this end" overlay) would get swapped out
  // for the frozen last-step Stage before the user can read it.
  const showLive = !isPureReplay && followLive && (live.connected || !!live.closedReason);

  const hasFrame = !!selectedStep;
  const canPrev = selectedFlatIdx > 0;
  const canNext = selectedFlatIdx >= 0 && selectedFlatIdx < flatSteps.length - 1;
  const warningKinds = lastRun ? [...new Set(lastRun.warnings.map((w) => w.kind))] : [];

  // Every dashboard status shares one row BELOW the frame — nothing is written
  // over the dashboard itself. Rendered as a Badge pill so the agent-working,
  // yours-to-explore, loading and idle states all read as the same control.
  // The showingPreview branch mirrors Stage's own condition.
  const showingStagePreview = !showLive && !loadingState && !selectedStep?.frameUrl && !!stream.thumbnailUrl;
  let stageStatus = null;
  if (loadingState) {
    stageStatus = { variant: "info", text: loadingState.message, spinner: true };
  } else if (stream.conversationError && runs.length === 0) {
    // The eager open failed — say so instead of showing an idle preview that
    // looks live. Asking a question retries the open.
    stageStatus = { variant: "failed", text: `Couldn't open the dashboard: ${stream.conversationError}` };
  } else if (showLive && !live.closedReason) {
    // Keyed to the RUN state, not live.mode: the backend flips the live-view
    // mode back to idle a beat after the turn's session_done, which briefly
    // showed "Docent is working…" next to an already-delivered answer.
    stageStatus = isRunning
      ? // The dashboard itself is no longer dimmed while the agent drives, so
        // this pill carries that signal: same repeating ping ring the minimized
        // chat bubble uses to announce a ready response.
        { variant: "info", text: "Docent is working…", pulse: true, className: "relative ready-ping" }
      : { variant: "success", text: "Yours — click to interact" };
  } else if (showingStagePreview) {
    stageStatus = { variant: "neutral", text: "Default view · ask a question to begin" };
  }

  return (
    <div className="flex h-full flex-col">
      {warningKinds.length > 0 && (
        <div className="glass-deep shrink-0 space-y-2 px-6 py-2">
          {warningKinds.map((kind) => (
            <Card key={kind} variant="callout" accent="gold" className="py-2 text-sm text-fg/80">
              {WARNING_LABEL[kind] ?? kind}
            </Card>
          ))}
        </div>
      )}

      {showConnectionBanner && (
        <div className="flex items-center justify-between gap-3 border-b border-coral/30 bg-coral/10 px-6 py-2 text-sm text-coral-ink">
          <span>Lost connection to the live session.</span>
          <Button size="sm" onClick={stream.reconnect}>
            Reconnect
          </Button>
        </div>
      )}

      {live.inspection?.verdict === "unusable" && !inspectionDismissed && (
        <div className="flex items-center justify-between gap-3 border-b border-coral/30 bg-coral/10 px-6 py-2 text-sm text-coral-ink">
          <span>
            {INSPECTION_LABEL[live.inspection.reasons?.[0]] ?? "The agent may not be able to work this dashboard."}
          </span>
          <span className="flex shrink-0 gap-2">
            <Button size="sm" onClick={handleEndSession}>
              Back to search
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInspectionDismissed(true)}>
              Dismiss
            </Button>
          </span>
        </div>
      )}

      {/* Dashboard owns the full canvas; the conversation floats over it. */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-canvas-edge/40">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {showLive ? (
            <LiveStage
              liveFrameUrl={live.liveFrameUrl}
              vizBox={live.vizBox}
              viewport={live.viewport}
              mode={live.mode}
              connected={live.connected}
              closedReason={live.closedReason}
              sendInput={live.sendInput}
              cursor={live.cursor}
              dashboardName={dashboard?.name}
            />
          ) : (
            <Stage
              step={selectedStep}
              showOverlay={showOverlay}
              showJumpToLivePill={stream.everLive && !followLive && isRunning}
              onJumpToLive={jumpToLive}
              loadingState={loadingState}
              previewUrl={stream.thumbnailUrl}
              dashboardName={dashboard?.name}
            />
          )}
        </div>

        {/* Dashboard status row — one pill for every dashboard state. */}
        <div className="flex h-7 shrink-0 items-center justify-center gap-2 px-4">
          {stageStatus && (
            <Badge variant={stageStatus.variant} pulse={stageStatus.pulse} className={stageStatus.className}>
              {stageStatus.spinner && <Spinner className="size-3 shrink-0" />}
              {stageStatus.text}
            </Badge>
          )}
        </div>

        {/* Bar under the dashboard: conversation + step history on the left,
            step playback centered, session controls on the right. */}
        <div className="flex shrink-0 items-center gap-2 px-4 py-3">
          {/* Padding (not transform) so the row actually reflows: the step
              history slides out from behind the open panel AND pushes the
              playback controls along, instead of sliding over them. */}
          <div
            className={cx(
              "flex flex-1 items-center gap-2 transition-[padding] duration-300 ease-glass motion-reduce:transition-none",
              dockOpen && "min-[901px]:pl-[26rem]",
            )}
          >
            {!dockOpen && (
              <QuickAsk
                isRunning={isRunning}
                unread={unread}
                onOpen={openDock}
                onVoiceAsk={handleVoiceAsk}
              />
            )}
            <Filmstrip runs={runs} selected={effectiveSelected} onSelect={selectStep} />
          </div>

          <div className="flex items-center gap-2">
            {hasFrame && (
              <>
                <Button size="sm" variant="ghost" onClick={goPrev} disabled={!canPrev}>
                  Prev
                </Button>
                <Button size="sm" variant="ghost" onClick={goNext} disabled={!canNext}>
                  Next
                </Button>
                {canPlay && (
                  <Button size="sm" variant="ghost" onClick={togglePlay}>
                    {sequencer.isPlaying ? "Pause" : "Play"}
                  </Button>
                )}
              </>
            )}
          </div>

          <div className="flex flex-1 items-center justify-end gap-2">
            {isPureReplay ? (
              <>
                <Badge variant="neutral">REPLAY</Badge>
                <Button size="sm" variant="ghost" onClick={onBack}>
                  Back to history
                </Button>
              </>
            ) : (
              mode === "live" && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleEndSession}
                  className="gap-2"
                  title="End session and return to the landing page (the live dashboard closes in the background)."
                >
                  <StopIcon />
                  End session
                </Button>
              )
            )}
          </div>
        </div>

        {/* Expanded conversation. A sibling of the stage AND the bottom bar (not
            nested in the stage) so it grows out of exactly where the minimized
            bubble sits, rising to 10px below the site header. Always mounted so
            open/close animates both ways and the Feed never remounts mid-run. */}
        <ChatPanel
          open={dockOpen}
          onMinimize={() => setDockOpen(false)}
          footerHeight={composerHeight}
          thread={
            <Feed
              runs={runs}
              selected={effectiveSelected}
              onSelectStep={selectStep}
              playback={sequencer.playback}
              atOutcome={sequencer.atOutcome}
              isLive={stream.everLive}
              liveSessionIds={stream.liveSessionIds}
              trailingTakeover={trailingTakeover}
              composerHeight={composerHeight}
              onSpeakAnswer={tts.supported ? handleSpeakRun : null}
              speakingRunId={speakingRunId}
            />
          }
          footer={
            isPureReplay ? null : (
              <div ref={composerRef}>
                <Composer
                  hasPriorRun={runs.length > 0}
                  exampleQuestions={stream.exampleQuestions}
                  isRunning={isRunning}
                  runningQuestion={lastRun?.question}
                  stepsUsed={lastRun?.steps.size ?? 0}
                  maxSteps={lastRun?.maxSteps ?? stream.maxSteps}
                  startedAt={lastRun?.startedAt}
                  active={dockOpen}
                  onAsk={handleAsk}
                  onStop={handleStopTurn}
                  readAloud={readAloud}
                  onToggleReadAloud={toggleReadAloud}
                  canReadAloud={tts.supported}
                />
              </div>
            )
          }
        />
      </div>
    </div>
  );
}
