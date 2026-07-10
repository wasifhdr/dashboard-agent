import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.js";

// Reveals `text` one character at a time at `msPerChar`. `active` gates
// whether the reveal runs at all (pass false to show the text fully resolved
// with no animation, e.g. for already-passed steps). Reduced motion always
// reveals instantly. Reused by Feed's step cards for both replay playback
// (Phase F3) and live thought arrival (Phase F4).
export function useTypewriter(text, msPerChar, active = true) {
  const reducedMotion = usePrefersReducedMotion();
  const [revealedLength, setRevealedLength] = useState(active && !reducedMotion ? 0 : (text ?? "").length);
  const timerRef = useRef(null);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!text || !active || reducedMotion) {
      setRevealedLength((text ?? "").length);
      return;
    }
    setRevealedLength(0);
    function tick(pos) {
      if (pos >= text.length) return;
      timerRef.current = setTimeout(() => {
        setRevealedLength(pos + 1);
        tick(pos + 1);
      }, msPerChar);
    }
    tick(0);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active, reducedMotion, msPerChar]);

  const done = revealedLength >= (text ?? "").length;
  return { revealed: (text ?? "").slice(0, revealedLength), done };
}
