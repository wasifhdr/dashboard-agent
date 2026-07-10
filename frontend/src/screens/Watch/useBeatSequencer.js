import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { TYPEWRITER_MS_PER_CHAR, FRAME_DWELL_MS, ACTION_PENDING_DWELL_MS, POST_RESOLVE_PAUSE_MS, OUTCOME_DWELL_MS } from "./pacing.js";

// Drives replay "Play" (FRONTEND_PLAN.md §6.6): walks every step across every
// run in order, narrating frame -> thought -> action-pending ->
// action-resolved, then an outcome beat, then stops (no loop, unlike
// HeroReplay). Steps whose frame equals the previous step's frame skip the
// frame-dwell beat. Pause/scrub (caller stops calling play again) halts it.
function buildStepList(runs) {
  const list = [];
  runs.forEach((run, runIdx) => {
    const sortedIdxs = [...run.steps.keys()].sort((a, b) => a - b);
    for (const stepIdx of sortedIdxs) {
      list.push({ runIdx, stepIdx, step: run.steps.get(stepIdx) });
    }
  });
  return list;
}

export function useBeatSequencer(runs) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState("frame"); // frame | thought | action-pending | action-resolved | outcome
  const reducedMotion = usePrefersReducedMotion();
  const timerRef = useRef(null);
  const stepList = buildStepList(runs);

  function play() {
    if (!stepList.length) return;
    clearTimeout(timerRef.current);
    setCursor(0);
    setPhase("frame");
    setIsPlaying(true);
  }

  function pause() {
    clearTimeout(timerRef.current);
    setIsPlaying(false);
  }

  useEffect(() => {
    if (!isPlaying) return undefined;
    clearTimeout(timerRef.current);

    if (cursor >= stepList.length) {
      if (phase !== "outcome") {
        setPhase("outcome");
      } else {
        timerRef.current = setTimeout(() => setIsPlaying(false), reducedMotion ? 0 : OUTCOME_DWELL_MS);
      }
      return () => clearTimeout(timerRef.current);
    }

    if (reducedMotion) {
      timerRef.current = setTimeout(() => {
        setCursor((c) => c + 1);
        setPhase("frame");
      }, FRAME_DWELL_MS);
      return () => clearTimeout(timerRef.current);
    }

    const { step } = stepList[cursor];
    const prevFrameUrl = cursor > 0 ? stepList[cursor - 1].step.frameUrl : null;

    function advance() {
      if (phase === "frame") {
        if (step.thought) setPhase("thought");
        else if (step.planned) setPhase("action-pending");
        else setPhase("action-resolved");
      } else if (phase === "thought") {
        setPhase(step.planned ? "action-pending" : "action-resolved");
      } else if (phase === "action-pending") {
        setPhase("action-resolved");
      } else {
        setCursor((c) => c + 1);
        setPhase("frame");
      }
    }

    let delay;
    if (phase === "frame") {
      delay = step.frameUrl && step.frameUrl === prevFrameUrl ? 0 : FRAME_DWELL_MS;
    } else if (phase === "thought") {
      delay = Math.max((step.thought?.length ?? 0) * TYPEWRITER_MS_PER_CHAR, 200);
    } else if (phase === "action-pending") {
      delay = ACTION_PENDING_DWELL_MS;
    } else {
      delay = POST_RESOLVE_PAUSE_MS;
    }

    timerRef.current = setTimeout(advance, delay);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, cursor, phase, reducedMotion]);

  const current = stepList[cursor] ?? null;
  const atOutcome = isPlaying && cursor >= stepList.length;
  // Clamped to the last step once the cursor runs past the end, so the
  // caller can restore selection to where the narration finished instead of
  // reverting to whatever was selected before Play was pressed.
  const lastVisited = stepList[Math.min(cursor, stepList.length - 1)] ?? null;

  return {
    isPlaying,
    play,
    pause,
    playback: isPlaying && current ? { runIdx: current.runIdx, stepIdx: current.stepIdx, phase } : null,
    lastSelection: lastVisited ? { runIdx: lastVisited.runIdx, stepIdx: lastVisited.stepIdx } : null,
    atOutcome,
  };
}
