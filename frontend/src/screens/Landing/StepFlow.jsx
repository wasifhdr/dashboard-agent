import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import CapsLabel from "../../components/ui/CapsLabel.jsx";
import { cx } from "../../components/ui/cx.js";

gsap.registerPlugin(useGSAP);

// "The Loop" as a vertical, connected sequence — squircle numbered nodes on a
// drawn connector line — so it reads top-to-bottom in the narrow left column
// (replaces the old horizontal 4-card grid). Node fill + connector share the
// step's accent, so the eye follows 01→04 by color as well as position.
const STEPS = [
  {
    n: "01",
    title: "Perceive",
    body: "Takes a screenshot of the live dashboard — the same pixels you would see.",
    accent: "teal",
  },
  {
    n: "02",
    title: "Think",
    body: "A local 4-billion-parameter vision-language model reads the view and picks one next move.",
    accent: "sky",
  },
  {
    n: "03",
    title: "Act",
    body: "Applies real filters, parameters, and tab switches through the Tableau Embedding API.",
    accent: "gold",
  },
  {
    n: "04",
    title: "Observe",
    body: "Waits for the dashboard to settle, re-reads it, and repeats until it can answer.",
    accent: "green",
  },
];

const NODE_TINT = {
  teal: "panel-tint-teal text-teal-ink",
  sky: "panel-tint-sky text-sky-ink",
  gold: "panel-tint-gold text-gold-ink",
  green: "panel-tint-green text-green-ink",
};

const LINE_COLOR = {
  teal: "bg-teal/35",
  sky: "bg-sky/35",
  gold: "bg-gold/35",
  green: "bg-green/35",
};

export default function StepFlow() {
  const container = useRef(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      // Only animate when the visitor hasn't asked for reduced motion; if they
      // have, the elements simply render in their natural (visible) state.
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
        tl.from(".sf-node", { scale: 0.4, opacity: 0, duration: 0.5, stagger: 0.12, ease: "back.out(1.7)" })
          .from(".sf-text", { x: -14, opacity: 0, duration: 0.5, stagger: 0.12 }, "<")
          .from(".sf-line", { scaleY: 0, transformOrigin: "top center", duration: 0.45, stagger: 0.12 }, "<0.08");
      });
      return () => mm.revert();
    },
    { scope: container },
  );

  return (
    <div ref={container}>
      <CapsLabel className="text-green-ink">THE LOOP</CapsLabel>
      <div className="mt-5">
        {STEPS.map((s, i) => {
          const last = i === STEPS.length - 1;
          return (
            <div key={s.n} className="flex gap-4">
              {/* Node + connector column */}
              <div className="flex flex-col items-center">
                <div
                  className={cx(
                    "sf-node grid size-11 shrink-0 place-items-center rounded-control font-mono text-sm font-bold",
                    NODE_TINT[s.accent],
                  )}
                >
                  {s.n}
                </div>
                {!last && <div className={cx("sf-line my-1 w-0.5 flex-1 rounded-pill", LINE_COLOR[s.accent])} />}
              </div>
              {/* Step copy */}
              <div className={cx("sf-text", last ? "pb-0" : "pb-7")}>
                <h3 className="text-h3 text-fg">{s.title}</h3>
                <p className="mt-1 max-w-[42ch] text-sm text-fg/70">{s.body}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
