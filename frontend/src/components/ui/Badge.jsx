import { cx } from "./cx.js";

const BASE = "inline-flex items-center gap-1 rounded-pill border px-2.5 py-0.5 text-label uppercase";

// Text uses the theme-flipping `-ink` accents (deep on light, bright on dark)
// so badges stay AA-readable in both themes; the fills stay light tints.
const VARIANTS = {
  neutral: "border-glass-border bg-glass text-fg/70",
  success: "border-green/40 bg-green/12 text-green-ink",
  pending: "border-gold/40 bg-gold/12 text-gold-ink",
  failed: "border-coral/40 bg-coral/12 text-coral-ink",
  info: "border-sky/40 bg-sky/12 text-sky-ink",
  violet: "border-violet/40 bg-violet/12 text-violet-ink",
};

const DOT_COLOR = {
  neutral: "bg-fg/40",
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
