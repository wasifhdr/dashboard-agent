import { cx } from "./cx.js";

const GLOW = {
  teal: "shadow-teal-glow",
  gold: "shadow-gold-glow",
  coral: "shadow-coral-glow",
  sky: "shadow-sky-glow",
  green: "shadow-green-glow",
};

export default function StatChip({ value, label, accent = "teal", className }) {
  return (
    <div className={cx("glass inline-flex flex-col gap-0.5 rounded-card px-5 py-3", GLOW[accent], className)}>
      <span className="text-2xl font-extrabold tabular-nums leading-none text-mist">{value}</span>
      <span className="text-xs font-bold text-mist/60">{label}</span>
    </div>
  );
}
