import { useEffect, useRef, useState } from "react";
import Button from "../../components/ui/Button.jsx";
import Spinner from "../../components/ui/Spinner.jsx";

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
  onAsk,
  onStop,
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const elapsedSeconds = useElapsedSeconds(startedAt, isRunning);

  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  async function handleSubmit(e) {
    e.preventDefault();
    const question = value.trim();
    if (!question || submitting) return;
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
      <div className="glass-raised rounded-card px-4 py-3">
        <div className="flex items-center gap-3">
          <Spinner className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg/60">{runningQuestion}</span>
          <Button
            size="sm"
            variant="danger"
            className="shrink-0"
            disabled={stopping}
            onClick={handleStop}
            title="Stops at the next step boundary — the current model call finishes first."
          >
            {stopping ? "Stopping…" : "Stop"}
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

  const showTabHint = value === "" && exampleQuestions.length > 0;

  return (
    <div className="glass-raised rounded-card">
      <form onSubmit={handleSubmit} className="flex items-center gap-2 py-2 pl-4 pr-2">
        <input
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-fg placeholder:text-fg/40 focus:outline-none"
          placeholder={hasPriorRun ? "Ask a follow-up — the dashboard reloads fresh…" : "Ask anything about this dashboard…"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Ask a question about this dashboard"
        />
        <Button
          type="submit"
          variant="primary"
          aria-label="Send question"
          className="size-10 shrink-0 !p-0"
          disabled={submitting || !value.trim()}
        >
          <SendIcon />
        </Button>
      </form>
      {error ? (
        <div className="px-4 pb-2 text-xs font-medium text-coral-ink">{error}</div>
      ) : (
        showTabHint && (
          <div className="px-4 pb-2 text-right text-xs text-fg/40">
            Press{" "}
            <kbd className="rounded border border-glass-border px-1 py-0.5 font-mono text-[11px] text-fg/60">Tab</kbd>{" "}
            for a suggested question
          </div>
        )
      )}
    </div>
  );
}
