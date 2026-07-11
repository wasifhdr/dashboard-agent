import { useEffect, useRef, useState } from "react";
import Field from "../../components/ui/Field.jsx";
import Button from "../../components/ui/Button.jsx";
import Spinner from "../../components/ui/Spinner.jsx";

function truncateChip(text, max = 60) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

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

// Composer for the Watch screen (FRONTEND_PLAN.md §6.7), pinned at the bottom
// of the right rail under the question thread. Idle state asks a question
// (fresh or follow-up); Running state shows live status + Stop (the step
// meter lives in StatusBar — not duplicated here). Busy-conflict (409) and
// other POST failures render inline under the input with the exact copy the
// plan specifies.
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

  function handleChipClick(question) {
    setValue(question);
    inputRef.current?.focus();
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
      <div className="glass-deep px-4 py-3">
        <div className="flex items-center gap-3">
          <Spinner className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg/50">{runningQuestion}</span>
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

  return (
    <div className="glass-deep px-4 py-3">
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Field
              ref={inputRef}
              placeholder={hasPriorRun ? "Ask a follow-up — the dashboard reloads fresh…" : "Ask anything about this dashboard…"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              error={error || undefined}
            />
          </div>
          <Button type="submit" variant="primary" className="shrink-0" disabled={submitting}>
            {submitting ? "Asking…" : "Ask"}
          </Button>
        </div>

        {exampleQuestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {exampleQuestions.map((q) => (
              <Button
                key={q}
                type="button"
                size="sm"
                variant="ghost"
                title={q}
                onClick={() => handleChipClick(q)}
              >
                {truncateChip(q, 44)}
              </Button>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
