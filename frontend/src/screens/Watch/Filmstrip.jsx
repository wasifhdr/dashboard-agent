import { cx } from "../../components/ui/cx.js";

function statusDotColor(actionStatus) {
  if (!actionStatus || actionStatus === "ok") return null;
  if (actionStatus === "rejected_loop" || actionStatus === "rejected_target") return "bg-gold";
  return "bg-coral"; // error, invalid_json, vlm_error
}

export default function Filmstrip({ runs, selected, onSelect }) {
  const items = [];
  runs.forEach((run, runIdx) => {
    const sortedIdxs = [...run.steps.keys()].sort((a, b) => a - b);
    sortedIdxs.forEach((stepIdx, i) => {
      const step = run.steps.get(stepIdx);
      if (!step.frameUrl) return;
      items.push({ runIdx, stepIdx, step, isRunStart: i === 0 && runIdx > 0 });
    });
  });

  if (!items.length) {
    return <div className="glass-deep px-4 py-3 text-sm text-fg/60">No frames yet.</div>;
  }

  return (
    <div className="glass-deep flex gap-2 overflow-x-auto px-4 py-3">
      {items.map(({ runIdx, stepIdx, step, isRunStart }) => {
        const isSelected = selected && selected.runIdx === runIdx && selected.stepIdx === stepIdx;
        const dotColor = statusDotColor(step.actionStatus);
        return (
          <button
            key={`${runIdx}-${stepIdx}`}
            type="button"
            onClick={() => onSelect({ runIdx, stepIdx })}
            className={cx(
              "relative h-[55px] w-[88px] flex-shrink-0 overflow-hidden rounded-dot border bg-glass",
              isRunStart && "ml-2 border-l-2 border-l-glass-border-strong pl-2",
              isSelected ? "border-2 border-teal shadow-teal-glow" : "border-glass-border",
              "focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
            )}
          >
            <img src={step.frameUrl} alt="" className="h-full w-full object-cover" />
            {dotColor && <span className={cx("absolute right-1 top-1 size-1.5 rounded-pill", dotColor)} />}
          </button>
        );
      })}
    </div>
  );
}
