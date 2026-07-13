import { useEffect, useRef, useState } from "react";
import { cx } from "../../components/ui/cx.js";
import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Spinner from "../../components/ui/Spinner.jsx";
import { useTypewriter } from "../../hooks/useTypewriter.js";
import { TYPEWRITER_MS_PER_CHAR } from "./pacing.js";
import { TERMINAL_STATUSES } from "./terminalStatuses.js";

const OUTCOME_CONFIG = {
  answered: { label: "ANSWER", labelColor: "text-green-ink", surface: "panel-tint-green", border: "border-l-green" },
  max_steps: {
    label: "BEST-EFFORT ANSWER",
    labelColor: "text-gold-ink",
    surface: "panel-tint-gold",
    border: "border-l-gold",
    subline: "Step budget reached before a confident answer.",
  },
  failed: {
    label: "NOT ANSWERABLE",
    labelColor: "text-gold-ink",
    surface: "panel-tint-gold",
    border: "border-l-gold",
    body: "The agent determined this dashboard cannot answer this question.",
  },
  error: { label: "SESSION ERROR", labelColor: "text-coral-ink", surface: "panel-tint-coral", border: "border-l-coral" },
  stopped: {
    label: "STOPPED",
    labelColor: "text-fg/60",
    surface: "panel",
    border: "border-l-glass-border-strong",
    body: "Stopped by you before the agent finished.",
  },
};

// revealMode: 'resolved' (fully static) | 'pending' | 'typing' | 'action-pending' | null (withheld)
function revealModeFor(runIdx, stepIdx, playback, atOutcome) {
  if (atOutcome || !playback) return "resolved";
  if (runIdx < playback.runIdx) return "resolved";
  if (runIdx > playback.runIdx) return null;
  if (stepIdx < playback.stepIdx) return "resolved";
  if (stepIdx > playback.stepIdx) return null;
  switch (playback.phase) {
    case "frame":
      return "pending";
    case "thought":
      return "typing";
    case "action-pending":
      return "action-pending";
    default:
      return "resolved";
  }
}

function ElapsedTimer({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const totalSeconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return (
    <span className="font-mono text-xs text-fg/60">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

function ThoughtLine({ text, active }) {
  const { revealed, done } = useTypewriter(text, TYPEWRITER_MS_PER_CHAR, active);
  if (!text) return null;
  return (
    <p className={cx("mt-1 text-sm leading-relaxed text-fg", active && !done && "typewriter-caret")}>{revealed}</p>
  );
}

function ActionLine({ step, pending }) {
  if (pending) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-control border border-glass-border px-3 py-2 font-mono text-[13px]">
        <span className="text-fg">▸ {step.planned.label}</span>
        <Spinner className="size-4 border-glass-border border-t-gold-ink" />
        <span className="text-fg/60">applying…</span>
      </div>
    );
  }

  const status = step.actionStatus;
  let icon = "✓";
  let colorClass = "text-green-ink";
  let explain = null;

  if (status === "rejected_loop") {
    icon = "✗";
    colorClass = "text-gold-ink";
    explain = "rejected: already tried — rethinking…";
  } else if (status === "rejected_target") {
    icon = "✗";
    colorClass = "text-gold-ink";
    explain = "rejected: unknown target — rethinking…";
  } else if (status === "error") {
    icon = "✗";
    colorClass = "text-coral-ink";
    explain = (step.errorMsg ?? "").slice(0, 120);
  }

  return (
    <div className="mt-2 rounded-control border border-glass-border px-3 py-2 font-mono text-[13px]">
      <div className={colorClass}>
        {icon} {step.planned.label}
      </div>
      {explain && <div className="mt-1 text-xs text-fg/60">{explain}</div>}
    </div>
  );
}

function StepCard({ step, revealMode, isSelected, onSelect }) {
  if (revealMode === null) return null;

  const isInvalid = !step.thought && !step.planned;

  return (
    <div
      className={cx("cursor-pointer rounded-control border px-3 py-2", isSelected ? "border-glass-border-strong" : "border-transparent")}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between font-mono text-xs text-fg/50">
        <span>STEP {step.idx}</span>
        {step.durationMs != null && <span>{(step.durationMs / 1000).toFixed(1)} s</span>}
      </div>

      {revealMode === "pending" && (
        <div className="mt-1 flex items-center gap-2">
          <Spinner className="border-glass-border border-t-gold-ink" />
          <span className="text-sm text-fg/70">Reading the dashboard…</span>
          {step.attempt && (
            <span className="text-xs text-gold-ink">
              Attempt {step.attempt} of 3 — the previous response was invalid.
            </span>
          )}
        </div>
      )}

      {revealMode !== "pending" && isInvalid && (
        <div className="mt-1 text-sm">
          {step.actionStatus === "vlm_error" ? (
            <span className="text-coral-ink">VLM request failed: {(step.errorMsg ?? "").slice(0, 120)}</span>
          ) : (
            <span className="text-gold-ink">The model's response was invalid — retrying.</span>
          )}
        </div>
      )}

      {revealMode !== "pending" && !isInvalid && (
        <>
          <ThoughtLine text={step.thought} active={revealMode === "typing"} />
          {step.planned && (revealMode === "action-pending" || revealMode === "resolved") && (
            <ActionLine step={step} pending={revealMode === "action-pending"} />
          )}
        </>
      )}
    </div>
  );
}

// Live (data-driven) step rendering: unlike the playback-driven StepCard
// above, there's no beat sequencer imposing artificial pacing here - the
// thought's own typewriter reveal is what gates the action card, since real
// `thought` and `action_planned` events arrive near-simultaneously (gating
// on raw event data alone would make the typewriter effectively invisible).
function LiveStepCard({ step, isSelected, onSelect }) {
  const isInvalid = step.actionStatus === "invalid_json" || step.actionStatus === "vlm_error";
  const { revealed, done } = useTypewriter(step.thought, TYPEWRITER_MS_PER_CHAR, !!step.thought);

  return (
    <div
      className={cx("cursor-pointer rounded-control border px-3 py-2", isSelected ? "border-glass-border-strong" : "border-transparent")}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between font-mono text-xs text-fg/50">
        <span>STEP {step.idx}</span>
        {step.durationMs != null && <span>{(step.durationMs / 1000).toFixed(1)} s</span>}
      </div>

      {!step.thought && !isInvalid && (
        <div className="mt-1 flex items-center gap-2">
          <Spinner className="border-glass-border border-t-gold-ink" />
          <span className="text-sm text-fg/70">Reading the dashboard…</span>
          {step.attempt && (
            <span className="text-xs text-gold-ink">
              Attempt {step.attempt} of 3 — the previous response was invalid.
            </span>
          )}
          {step.stepStartedAt && <ElapsedTimer since={step.stepStartedAt} />}
        </div>
      )}

      {isInvalid && (
        <div className="mt-1 text-sm">
          {step.actionStatus === "vlm_error" ? (
            <span className="text-coral-ink">VLM request failed: {(step.errorMsg ?? "").slice(0, 120)}</span>
          ) : (
            <span className="text-gold-ink">The model's response was invalid — retrying.</span>
          )}
        </div>
      )}

      {step.thought && !isInvalid && (
        <>
          <p className={cx("mt-1 text-sm leading-relaxed text-fg", !done && "typewriter-caret")}>{revealed}</p>
          {done && step.planned && <ActionLine step={step} pending={step.actionStatus == null} />}
        </>
      )}
    </div>
  );
}

// Renders one summary_json entry (see conversationRuntime.js's
// diffInventories / docs/LIVE_TAKEOVER_PLAN.md §4.1) as a short human line.
function formatFilterValue(v) {
  if (v == null) return "none";
  if (Array.isArray(v.appliedValues)) {
    return v.appliedValues.length ? v.appliedValues.join(", ") : "(cleared)";
  }
  if (v.min != null || v.max != null) return `${v.min ?? "…"}–${v.max ?? "…"}`;
  if ("min" in v || "max" in v) return "any"; // range filter present, no bounds set
  return String(v);
}

function formatScalar(v) {
  return v == null ? "none" : String(v);
}

function takeoverLineFor(entry) {
  switch (entry.kind) {
    case "filter":
      return `Changed ${entry.field}: ${formatFilterValue(entry.from)} → ${formatFilterValue(entry.to)}`;
    case "parameter":
      return `Set ${entry.field} to ${formatScalar(entry.to)}`;
    case "sheet":
      return `Switched to the ${formatScalar(entry.to)} tab`;
    default:
      return null;
  }
}

// Compact, muted card for a user takeover between two turns (Phase B2) -
// deliberately smaller/quieter than QuestionCard/OutcomeCard since it's a
// side-note in the thread, not a turn of its own.
function TakeoverCard({ takeover }) {
  const lines = (takeover.summary ?? []).map(takeoverLineFor).filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className="panel-tint-violet rounded-control border-l-4 border-l-violet px-3 py-1.5">
      <CapsLabel className="text-violet-ink">YOU EXPLORED THE DASHBOARD</CapsLabel>
      <ul className="mt-1 space-y-0.5 text-xs text-fg/70">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function QuestionCard({ index, question }) {
  return (
    <div className="panel-tint-teal rounded-control p-3">
      <CapsLabel className="text-teal-ink">QUESTION {index}</CapsLabel>
      <p className="mt-1 text-[15px] font-medium text-fg">{question}</p>
    </div>
  );
}

function OutcomeCard({ run }) {
  const config = OUTCOME_CONFIG[run.status];
  if (!config) return null;

  const body = config.body ?? (run.status === "error" ? run.error : run.finalAnswer);
  const showConfidence = (run.status === "answered" || run.status === "max_steps") && run.confidence != null;

  return (
    <div className={cx("rounded-control border-l-4 p-4", config.surface, config.border)}>
      <div className={cx("text-label uppercase", config.labelColor)}>{config.label}</div>
      <p className="mt-1 text-base font-bold text-fg">{body}</p>
      {showConfidence && <div className="mt-1 font-mono text-xs text-fg/60">confidence {run.confidence.toFixed(2)}</div>}
      {config.subline && <p className="mt-1 text-sm text-fg/70">{config.subline}</p>}
    </div>
  );
}

export default function Feed({ runs, selected, onSelectStep, playback, atOutcome, isLive }) {
  const scrollRef = useRef(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    // offsetParent is null while the Feed tab is hidden (display:none) — skip
    // so a hidden Feed doesn't reset its scroll position on background renders.
    if (!el || el.offsetParent === null || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  function handleScroll(e) {
    const el = e.target;
    userScrolledUpRef.current = el.scrollTop + el.clientHeight < el.scrollHeight - 24;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      aria-live="polite"
      className="thin-scrollbar glass-deep flex h-full flex-col gap-3 overflow-y-auto p-4 pb-28 text-fg"
    >
      {runs.map((run, runIdx) => {
        const sortedIdxs = [...run.steps.keys()].sort((a, b) => a - b);
        const runOutcomeVisible = atOutcome ? true : !playback ? true : runIdx < playback.runIdx;

        return (
          <div key={run.sessionId} className="flex flex-col gap-2">
            {runIdx > 0 && (
              <div className="my-1 text-center font-mono text-xs text-fg/50">— new question —</div>
            )}
            {runIdx > 0 && run.precedingTakeover && <TakeoverCard takeover={run.precedingTakeover} />}
            <QuestionCard index={runIdx + 1} question={run.question} />
            {run.status === "loading" ? (
              <div className="font-mono text-xs text-fg/60">→ opening dashboard…</div>
            ) : (
              run.steps.size > 0 && <div className="font-mono text-xs text-fg/60">→ dashboard ready</div>
            )}

            {sortedIdxs.map((stepIdx) => {
              const step = run.steps.get(stepIdx);
              const isSelected = selected?.runIdx === runIdx && selected?.stepIdx === stepIdx;
              const onSelect = () => onSelectStep({ runIdx, stepIdx });

              if (isLive && !playback) {
                return <LiveStepCard key={stepIdx} step={step} isSelected={isSelected} onSelect={onSelect} />;
              }
              const revealMode = revealModeFor(runIdx, stepIdx, playback, atOutcome);
              return <StepCard key={stepIdx} step={step} revealMode={revealMode} isSelected={isSelected} onSelect={onSelect} />;
            })}

            {TERMINAL_STATUSES.has(run.status) && runOutcomeVisible && <OutcomeCard run={run} />}
          </div>
        );
      })}
    </div>
  );
}
