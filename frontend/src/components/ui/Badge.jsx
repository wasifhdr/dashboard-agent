import { cx } from "./cx.js";

const BASE = "inline-flex items-center gap-1 rounded-pill border px-2.5 py-0.5 text-label uppercase";

const VARIANTS = {
  neutral: "border-glass-border bg-glass text-mist/70",
  success: "border-green/40 bg-green/12 text-green",
  pending: "border-gold/40 bg-gold/12 text-gold",
  failed: "border-coral/40 bg-coral/12 text-coral",
  info: "border-sky/40 bg-sky/12 text-sky",
  violet: "border-violet/40 bg-violet/12 text-violet",
};

const DOT_COLOR = {
  neutral: "bg-mist/40",
  success: "bg-green shadow-green-glow",
  pending: "bg-gold shadow-gold-glow",
  failed: "bg-coral shadow-coral-glow",
  info: "bg-sky shadow-sky-glow",
  violet: "bg-violet",
};

export default function Badge({ variant = "neutral", pulse = false, className, children }) {
  return (
    <span className={cx(BASE, VARIANTS[variant], className)}>
      {pulse && <span className={cx("size-2 rounded-pill animate-glow-pulse", DOT_COLOR[variant])} />}
      {children}
    </span>
  );
}
