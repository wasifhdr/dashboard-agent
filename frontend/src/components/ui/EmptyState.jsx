import { cx } from "./cx.js";

export default function EmptyState({ statement, line, action, dashed = true, className }) {
  return (
    <div
      className={cx(
        "rounded-card p-10 text-center",
        dashed && "border-2 border-dashed border-glass-border-strong bg-glass/40",
        className,
      )}
    >
      {statement && <div className="font-sans text-display-sm font-extrabold text-fg">{statement}</div>}
      {line && <p className="mt-3 text-sm text-fg/70">{line}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}
