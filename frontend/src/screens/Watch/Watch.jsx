import { useEffect, useRef, useState } from "react";
import { useSessionStream } from "./useSessionStream.js";
import { useLiveChannel } from "./useLiveChannel.js";
import { useBeatSequencer } from "./useBeatSequencer.js";
import { TERMINAL_STATUSES } from "./terminalStatuses.js";
import { closeConversation, stopSession } from "../../api.js";
import StatusBar from "./StatusBar.jsx";
import Stage from "./Stage.jsx";
import LiveStage from "./LiveStage.jsx";
import Filmstrip from "./Filmstrip.jsx";
import Feed from "./Feed.jsx";
import Inspect from "./Inspect.jsx";
import Composer from "./Composer.jsx";
import Badge from "../../components/ui/Badge.jsx";
import Button from "../../components/ui/Button.jsx";
import { cx } from "../../components/ui/cx.js";

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
export default function Watch({ mode, sessionId, conversationId, dashboardTarget, onBack, onEnd, onActiveRunChange }) {
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
  const [showOverlay, setShowOverlay] = useState(true);
  const [activeTab, setActiveTab] = useState("feed");

  const primaryRun = runs[0] ?? null;
  const lastRun = runs[runs.length - 1] ?? null;
  const isRunning = !!lastRun && !TERMINAL_STATUSES.has(lastRun.status);
  const canPlay = runs.length > 0 && runs.every((r) => TERMINAL_STATUSES.has(r.status));
  const isPureReplay = !stream.everLive;

  useEffect(() => {
    onActiveRunChange?.(isRunning);
  }, [isRunning, onActiveRunChange]);

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
    await stream.startQuestion(question);
    setFollowLive(true);
  }

  async function handleStop() {
    // lastRun.sessionId is briefly null for the very first turn's placeholder
    // run (it exists to drive the loading UI while POST /api/conversations
    // is still opening the dashboard - see useSessionStream's startQuestion),
    // so there's no session yet to stop.
    if (lastRun?.sessionId) await stopSession(lastRun.sessionId);
  }

  // Explicit "End session" (Phase B4). If a turn is currently running, the
  // backend's close endpoint 409s with a clear message ("A turn is currently
  // running on this conversation...") - StatusBar surfaces that rather than
  // this hook guarding against it, per docs/LIVE_TAKEOVER_PLAN.md §9 Phase
  // B4 item 2's turn-while-locked error-taxonomy requirement. When no
  // conversation has been created yet (mode==="live" but no question asked),
  // there's nothing server-side to close, so this just navigates away.
  //
  // stream.getConversationId() (rather than reading liveConversationId
  // directly) matters for the very first turn: clicking this while the first
  // turn's dashboard is still opening would otherwise see liveConversationId
  // still null (createConversation's POST hasn't resolved yet) and skip the
  // close entirely, leaking the conversation the moment it finishes opening
  // server-side - getConversationId awaits that in-flight creation instead of
  // treating "not known yet" as "doesn't exist".
  async function handleEndSession() {
    const id = await stream.getConversationId();
    if (id) await closeConversation(id);
    onEnd?.();
  }

  if (mode === "replay" && loadError) {
    return <div className="p-6 text-sm text-coral-ink">Failed to load session: {loadError}</div>;
  }
  if (mode === "replay" && !primaryRun) {
    return <div className="p-6 text-sm text-fg/60">Loading session…</div>;
  }

  // B0: only the conversation's first turn actually opens the dashboard
  // (POST /api/conversations); every later turn reuses that already-open
  // page, so it's fast and doesn't need the big loading overlay.
  const loadingState =
    lastRun?.status === "loading" && runs.length <= 1
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

  return (
    <div className="flex h-full flex-col">
      <StatusBar
        dashboard={dashboard}
        run={lastRun}
        step={selectedStep}
        showOverlay={showOverlay}
        onToggleOverlay={() => setShowOverlay((v) => !v)}
        onPrev={goPrev}
        onNext={goNext}
        canPrev={selectedFlatIdx > 0}
        canNext={selectedFlatIdx >= 0 && selectedFlatIdx < flatSteps.length - 1}
        isPlaying={sequencer.isPlaying}
        onTogglePlay={togglePlay}
        showPlayButton={canPlay}
        showEndSession={mode === "live"}
        isRunning={isRunning}
        onEndSession={handleEndSession}
      />

      {showConnectionBanner && (
        <div className="flex items-center justify-between gap-3 border-b border-coral/30 bg-coral/10 px-6 py-2 text-sm text-coral-ink">
          <span>Lost connection to the live session.</span>
          <Button size="sm" onClick={stream.reconnect}>
            Reconnect
          </Button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 min-[901px]:grid-cols-[1fr_400px]">
        <div className="relative flex min-h-0 flex-col overflow-hidden bg-canvas-edge/40">
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
          {/* Step thumbnails now live in a floating history bubble (bottom-left),
              overlaid on the Stage rather than a docked bottom strip. */}
          <Filmstrip runs={runs} selected={effectiveSelected} onSelect={selectStep} />
        </div>

        {/* Right rail: tabs / thread (scrolls internally) / composer pinned at
            the bottom — the page itself never scrolls on desktop. */}
        <div className="flex min-h-0 flex-col border-l border-glass-border max-[900px]:border-l-0 max-[900px]:border-t">
          <div className="glass-deep flex shrink-0 gap-1 px-3 py-2">
            {["feed", "inspect"].map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cx(
                  "rounded-pill px-3 py-1 text-sm font-bold capitalize",
                  activeTab === tab ? "bg-glass-hover text-gold-ink" : "text-fg/70 hover:bg-glass-hover hover:text-fg",
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          {/* Thread fills the rail; the composer floats over its bottom as a
              glass bubble, so the last messages scroll behind it (Feed/Inspect
              carry bottom padding to clear the float). */}
          <div className="relative min-h-0 flex-1 max-[900px]:max-h-[40vh] max-[900px]:flex-none max-[900px]:overflow-y-auto">
            {/* Both panels stay mounted (visibility toggled) so switching tabs
                never remounts the Feed — otherwise its live thought typewriters
                would replay from scratch on every return to the tab. */}
            <div className={cx("h-full", activeTab === "feed" ? "" : "hidden")}>
              <Feed
                runs={runs}
                selected={effectiveSelected}
                onSelectStep={selectStep}
                playback={sequencer.playback}
                atOutcome={sequencer.atOutcome}
                isLive={stream.everLive}
                liveSessionIds={stream.liveSessionIds}
                trailingTakeover={trailingTakeover}
              />
            </div>
            <div className={cx("h-full", activeTab === "inspect" ? "" : "hidden")}>
              <Inspect step={selectedStep} />
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3 pr-5">
              <div className="pointer-events-auto">
                {isPureReplay ? (
                  <div className="glass-raised flex items-center justify-between rounded-card px-4 py-3">
                    <Badge variant="neutral">REPLAY</Badge>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={togglePlay}>
                        {sequencer.isPlaying ? "Pause" : "Play"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={onBack}>
                        Back to history
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Composer
                    hasPriorRun={runs.length > 0}
                    exampleQuestions={stream.exampleQuestions}
                    isRunning={isRunning}
                    runningQuestion={lastRun?.question}
                    stepsUsed={lastRun?.steps.size ?? 0}
                    maxSteps={lastRun?.maxSteps ?? stream.maxSteps}
                    startedAt={lastRun?.startedAt}
                    onAsk={handleAsk}
                    onStop={handleStop}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
