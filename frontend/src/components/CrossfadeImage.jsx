import { useEffect, useState } from "react";
import { cx } from "./ui/cx.js";

// Two-layer crossfade: the base layer is always visible; when `src` changes,
// an incoming layer is mounted at opacity 0, promoted to opacity 1 next
// frame (so the CSS transition actually runs), then swapped to become the
// new base once the transition finishes. Reused by HeroReplay (Phase F2)
// and the real Stage component (Phase F4 §6.3).
const FADE_MS = 400;

export default function CrossfadeImage({ src, alt = "", className, imgClassName, onLoad }) {
  const [layers, setLayers] = useState({ base: src, incoming: null });
  const [incomingVisible, setIncomingVisible] = useState(false);

  useEffect(() => {
    if (src === layers.base) return;
    setLayers((prev) => ({ base: prev.base, incoming: src }));
    setIncomingVisible(false);
    const raf = requestAnimationFrame(() => setIncomingVisible(true));
    const done = setTimeout(() => {
      setLayers({ base: src, incoming: null });
      setIncomingVisible(false);
    }, FADE_MS + 20);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return (
    <div className={cx("stage-crossfade", className)}>
      <img className={cx("frame-layer", imgClassName)} src={layers.base} alt={alt} onLoad={onLoad} />
      {layers.incoming && (
        <img
          className={cx("frame-layer frame-layer-incoming", incomingVisible && "is-visible", imgClassName)}
          src={layers.incoming}
          alt={alt}
          onLoad={onLoad}
        />
      )}
    </div>
  );
}
