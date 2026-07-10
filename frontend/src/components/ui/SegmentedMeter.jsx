import { cx } from "./cx.js";

export default function SegmentedMeter({ used, total, unlimited = false, caption, className }) {
  if (unlimited) {
    return <div className={cx("text-sm text-mist/60", className)}>Unlimited</div>;
  }

  const atLimit = total > 0 && used >= total;
  const cellClass = (isUsed) =>
    cx(
      "size-5 rounded-dot border",
      isUsed
        ? atLimit
          ? "border-coral/40 bg-coral shadow-coral-glow"
          : "border-green/40 bg-green shadow-green-glow"
        : "border-glass-border bg-glass",
    );

  return (
    <div className={cx("flex items-center gap-3", className)}>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cellClass(i < used)} />
        ))}
      </div>
      <div className="font-mono text-sm tabular-nums text-mist/70">{caption ?? `${used} / ${total}`}</div>
    </div>
  );
}
