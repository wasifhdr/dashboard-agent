import { useEffect, useRef, useState } from "react";
import { useSessionStream } from "./useSessionStream.js";
import { useBeatSequencer } from "./useBeatSequencer.js";
import { TERMINAL_STATUSES } from "./terminalStatuses.js";
import { stopSession } from "../../api.js";
import StatusBar from "./StatusBar.jsx";
import Stage from "./Stage.jsx";
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
export default function Watch({ mode, sessionId, dashboardTarget, onBack, onActiveRunChange }) {
  const stream = useSessionStream(mode, {
    sessionId,
    dashboardUrl: dashboardTarget?.url,
    dashboardName: dashboardTarget?.name,
  });
  const { dashboard, runs, loadError } = stream;
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
    if (lastRun) await stopSession(lastRun.sessionId);
  }

  if (mode === "replay" && loadError) {
    return <div className="p-6 text-sm text-coral">Failed to load session: {loadError}</div>;
  }
  if (mode === "replay" && !primaryRun) {
    return <div className="p-6 text-sm text-mist/60">Loading session…</div>;
  }

  const loadingState =
    lastRun?.status === "loading"
      ? {
          thumbnailUrl: stream.thumbnailUrl,
          message:
            runs.length > 1
              ? "Reloading the dashboard for your new question…"
              : "Opening the live dashboard… first load can take up to a minute.",
        }
      : null;

  const showConnectionBanner = stream.connectionError && isRunning;

  return (
    <div className="flex h-full flex-col">
      <StatusBar dashboard={dashboard} run={lastRun} maxSteps={lastRun?.maxSteps ?? stream.maxSteps} />

      {showConnectionBanner && (
        <div className="flex items-center justify-between gap-3 border-b border-coral/30 bg-coral/10 px-6 py-2 text-sm text-coral">
          <span>Lost connection to the live session.</span>
          <Button size="sm" onClick={stream.reconnect}>
            Reconnect
          </Button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 min-[901px]:grid-cols-[1fr_400px]">
        <div className="flex min-h-0 flex-col">
          <Stage
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
            showJumpToLivePill={stream.everLive && !followLive && isRunning}
            onJumpToLive={jumpToLive}
            loadingState={loadingState}
          />
          <Filmstrip runs={runs} selected={effectiveSelected} onSelect={selectStep} />
        </div>

        <div className="flex min-h-0 flex-col border-l border-glass-border max-[900px]:border-l-0 max-[900px]:border-t">
          <div className="glass-deep flex gap-1 px-3 py-2">
            {["feed", "inspect"].map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cx(
                  "rounded-pill px-3 py-1 text-sm font-bold capitalize",
                  activeTab === tab ? "bg-glass-hover text-gold" : "text-mist/70 hover:bg-glass-hover hover:text-mist",
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 max-[900px]:max-h-[40vh] max-[900px]:flex-none max-[900px]:overflow-y-auto">
            {activeTab === "feed" ? (
              <Feed
                runs={runs}
                selected={effectiveSelected}
                onSelectStep={selectStep}
                playback={sequencer.playback}
                atOutcome={sequencer.atOutcome}
                isLive={stream.everLive}
              />
            ) : (
              <Inspect step={selectedStep} />
            )}
          </div>
        </div>
      </div>

      <div className="max-[900px]:sticky max-[900px]:bottom-0 max-[900px]:z-10">
        {isPureReplay ? (
          <div className="glass-deep flex items-center justify-between px-6 py-3">
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
  );
}
