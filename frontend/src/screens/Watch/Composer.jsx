import { useCallback, useEffect, useRef, useState } from "react";
import Button from "../../components/ui/Button.jsx";
import Spinner from "../../components/ui/Spinner.jsx";
import { cx } from "../../components/ui/cx.js";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition.js";

function useElapsedSeconds(startedAt, active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active || !startedAt) return 0;
  const startMs = typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
  return Math.max(0, Math.floor((now - startMs) / 1000));
}

function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Square "stop" glyph, matching the one on the end-session button in the thread
// header. The composer's stop control is icon-only — the word alongside it read
// as a second label competing with the running question it sits next to.
function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

// Speaker with sound waves / speaker with a slash — the read-aloud toggle's
// two faces.
function SpeakerIcon({ muted }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {muted ? (
        <>
          <line x1="22" y1="9" x2="16" y2="15" />
          <line x1="16" y1="9" x2="22" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

// Composer for the Watch screen — a floating glass bubble that overlays the
// bottom of the question thread (FRONTEND_PLAN.md §6.7). Idle state asks a
// question (fresh or follow-up); Running state shows live status + Stop (the
// per-question step meter lives here while a question runs). Example questions
// are no longer shown as chips: pressing Tab in an empty input drops one in.
// Busy-conflict (409) and other POST failures render inline under the input.
export default function Composer({
  hasPriorRun,
  exampleQuestions = [],
  isRunning,
  runningQuestion,
  stepsUsed,
  maxSteps,
  startedAt,
  active,
  onAsk,
  onStop,
  readAloud,
  onToggleReadAloud,
  canReadAloud,
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const elapsedSeconds = useElapsedSeconds(startedAt, isRunning);

  // Whatever was already typed when the mic opened. Each recognition event
  // carries the full session transcript, so the field is rebuilt as
  // base + transcript rather than appended to — that's what lets Chrome revise
  // an interim guess in place instead of stuttering it twice into the box.
  const dictationBaseRef = useRef("");
  const dictation = useSpeechRecognition({
    onTranscript: useCallback((transcript) => {
      const base = dictationBaseRef.current;
      setValue(base && transcript ? `${base} ${transcript}` : base + transcript);
    }, []),
  });

  function handleMicClick() {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    dictationBaseRef.current = value.trim();
    dictation.start();
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  // Opening the panel puts the caret in the composer, so you can just type.
  // Deferred to a rAF because ChatPanel clears its `inert` attribute in its own
  // effect, which runs AFTER this child's — focusing an inert subtree is a no-op.
  useEffect(() => {
    if (!active) return undefined;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active]);

  // Auto-grow the textarea upward as the question gets longer, capped at ~half
  // the viewport (the thread bubble is bottom-anchored, so it grows upward).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.45))}px`;
  }, [value]);

  async function handleSubmit(e) {
    e.preventDefault();
    const question = value.trim();
    if (!question || submitting) return;
    dictation.stop(); // sending ends dictation — never leave the mic live
    setError("");
    setSubmitting(true);
    try {
      await onAsk(question);
      setValue("");
    } catch (err) {
      if (err.status === 409) {
        setError("The agent is busy with another session. Wait for it to finish (or stop it from its tab).");
      } else {
        setError(err.message || "Failed to start the session.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Tab on an empty input drops in the first suggested question; Tab again while
  // an untouched suggestion is showing cycles to the next. Once the user edits
  // it into something of their own, Tab reverts to its normal focus behavior.
  function handleKeyDown(e) {
    // Enter submits; Shift+Enter inserts a newline (textarea default).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
      return;
    }
    if (e.key !== "Tab" || e.shiftKey || exampleQuestions.length === 0) return;
    if (value.trim() === "") {
      e.preventDefault();
      setValue(exampleQuestions[0]);
      return;
    }
    const idx = exampleQuestions.indexOf(value);
    if (idx !== -1) {
      e.preventDefault();
      setValue(exampleQuestions[(idx + 1) % exampleQuestions.length]);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await onStop();
    } catch {
      setStopping(false);
    }
  }

  if (isRunning) {
    return (
      <div className="glass-pane rounded-card px-4 py-3">
        <div className="flex items-center gap-3">
          <Spinner className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg/60">{runningQuestion}</span>
          <Button
            size="sm"
            variant="danger"
            className="size-8 shrink-0 p-0"
            disabled={stopping}
            onClick={handleStop}
            aria-label={stopping ? "Stopping…" : "Stop"}
            title={
              stopping
                ? "Stopping…"
                : "Stops at the next step boundary — the current model call finishes first."
            }
          >
            <StopIcon />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-sm text-fg/70">
          <span>
            Step {stepsUsed} of {maxSteps}
          </span>
          <span>{formatElapsed(elapsedSeconds)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-pane rounded-card">
      {/* Two rows, not one: the question gets the bubble's FULL width and the
          controls sit under it. Beside the buttons the text was wrapping in a
          column about a third narrower than the bubble, so a long question
          stacked into a tall thin block with dead space to its right. */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-1 px-3 pb-2 pt-2.5">
        <textarea
          ref={inputRef}
          rows={1}
          className="thin-scrollbar w-full resize-none bg-transparent px-1 text-[15px] leading-relaxed text-fg placeholder:text-fg/40 focus:outline-none"
          placeholder={hasPriorRun ? "Ask a follow-up…" : "Ask anything about this dashboard…"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Ask a question about this dashboard"
        />
        <div className="flex items-center justify-end gap-1">
          {canReadAloud && (
            <button
              type="button"
              onClick={onToggleReadAloud}
              aria-label={readAloud ? "Turn off reading answers aloud" : "Read answers aloud"}
              aria-pressed={readAloud}
              title={readAloud ? "Answers are read aloud" : "Answers are not read aloud"}
              className={cx(
                "grid size-10 shrink-0 place-items-center rounded-pill transition-colors",
                "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
                readAloud ? "bg-teal/15 text-teal-ink" : "text-fg/55 hover:bg-glass-hover hover:text-fg",
              )}
            >
              <SpeakerIcon muted={!readAloud} />
            </button>
          )}
          {dictation.supported && (
            <button
              type="button"
              onClick={handleMicClick}
              aria-label={dictation.listening ? "Stop dictating" : "Dictate your question"}
              aria-pressed={dictation.listening}
              title={dictation.listening ? "Stop dictating" : "Dictate your question"}
              className={cx(
                "grid size-10 shrink-0 place-items-center rounded-pill transition-colors",
                "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
                dictation.listening
                  ? "ready-ping relative bg-coral/15 text-coral-ink"
                  : "text-fg/55 hover:bg-glass-hover hover:text-fg",
              )}
            >
              <MicIcon />
            </button>
          )}
          <Button
            type="submit"
            variant="primary"
            aria-label="Send question"
            className="size-10 shrink-0 !p-0"
            disabled={submitting || !value.trim()}
          >
            <SendIcon />
          </Button>
        </div>
      </form>

      {/* Transient only — both the mic and the read-aloud toggle live in the
          controls row above, so the idle composer stays one line of text plus
          that row. This appears solely while dictating or after a mic failure. */}
      {(dictation.listening || dictation.error) && (
        <div className="px-4 pb-2 text-xs text-fg/50">
          {dictation.error ? (
            <span className="text-coral-ink">{dictation.error}</span>
          ) : (
            "Listening… click the mic to stop."
          )}
        </div>
      )}

      {error && <div className="px-4 pb-2 text-xs font-medium text-coral-ink">{error}</div>}
    </div>
  );
}
