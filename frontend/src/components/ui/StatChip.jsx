import { cx } from "./cx.js";

// Tinted panel + matching glow — each stat reads as its own colored zone.
const ACCENT = {
  teal: "panel-tint-teal shadow-teal-glow",
  gold: "panel-tint-gold shadow-gold-glow",
  coral: "panel-tint-coral shadow-coral-glow",
  sky: "panel-tint-sky shadow-sky-glow",
  green: "panel-tint-green shadow-green-glow",
};

export default function StatChip({ value, label, accent = "teal", className }) {
  return (
    <div className={cx("inline-flex flex-col gap-0.5 rounded-card px-5 py-3", ACCENT[accent] ?? ACCENT.teal, className)}>
      <span className="text-2xl font-extrabold tabular-nums leading-none text-fg">{value}</span>
      <span className="text-xs font-bold text-fg/60">{label}</span>
    </div>
  );
}
