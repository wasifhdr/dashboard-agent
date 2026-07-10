import { useEffect, useMemo, useRef, useState } from "react";
import { listSessions, getSession, getDashboardsMeta } from "../../api.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import CrossfadeImage from "../../components/CrossfadeImage.jsx";
import Card from "../../components/ui/Card.jsx";
import Badge from "../../components/ui/Badge.jsx";
import EmptyState from "../../components/ui/EmptyState.jsx";
import { OUTCOME_DWELL_MS } from "../Watch/pacing.js";

const HERO_FRAME_MS = 2200;
const HERO_OUTCOME_DWELL_MS = OUTCOME_DWELL_MS;

export default function HeroReplay() {
  const [sessionData, setSessionData] = useState(null); // { session, steps } | null
  const [fallbackThumb, setFallbackThumb] = useState(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [showingOutcome, setShowingOutcome] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([listSessions(), getDashboardsMeta()]).then(([sessionsResult, metaResult]) => {
      if (cancelled) return;
      const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
      const meta = metaResult.status === "fulfilled" ? (metaResult.value.dashboards ?? []) : [];
      setFallbackThumb(meta[0]?.thumbnailUrl ?? null);

      const answered = sessions.find((s) => s.status === "answered");
      if (!answered) {
        setSessionData(null);
        return;
      }
      getSession(answered.id)
        .then((data) => {
          if (!cancelled) setSessionData(data);
        })
        .catch(() => {
          if (!cancelled) setSessionData(null);
        });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = useMemo(() => (sessionData?.steps ?? []).filter((s) => s.frame_url), [sessionData]);

  useEffect(() => {
    if (!steps.length || reducedMotion) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => {
        if (!showingOutcome && frameIdx >= steps.length - 1) {
          setShowingOutcome(true);
        } else if (showingOutcome) {
          setShowingOutcome(false);
          setFrameIdx(0);
        } else {
          setFrameIdx((i) => i + 1);
        }
      },
      showingOutcome ? HERO_OUTCOME_DWELL_MS : HERO_FRAME_MS,
    );
    return () => clearTimeout(timerRef.current);
  }, [frameIdx, showingOutcome, steps.length, reducedMotion]);

  // Reduced motion: show only the final frame + answer strip, no cycling.
  const effectiveIdx = reducedMotion ? steps.length - 1 : frameIdx;
  const effectiveShowingOutcome = reducedMotion ? true : showingOutcome;

  if (!steps.length) {
    if (fallbackThumb) {
      return (
        <Card variant="feature">
          <Badge variant="neutral">RECORDED SESSION</Badge>
          <div className="panel mt-4 overflow-hidden rounded-control">
            <img src={fallbackThumb} alt="" className="w-full" />
          </div>
          <p className="mt-3 text-sm text-fg/70">Waiting for the first recorded session</p>
        </Card>
      );
    }
    return (
      <Card variant="feature">
        <EmptyState statement="Your first session will appear here." dashed={false} />
      </Card>
    );
  }

  const currentStep = steps[effectiveIdx];
  const caption = currentStep.overlay?.action_badge?.text ?? `Step ${currentStep.idx}`;

  return (
    <Card variant="feature">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-h3">{sessionData.session.question}</h3>
        <Badge variant="neutral">RECORDED SESSION</Badge>
      </div>

      {!effectiveShowingOutcome ? (
        <>
          <CrossfadeImage
            src={currentStep.frame_url}
            className="panel mt-4 overflow-hidden rounded-control"
          />
          <p className="mt-2 font-mono text-xs text-fg/60">{caption}</p>
        </>
      ) : (
        <div className="panel-tint-green mt-4 rounded-control border-l-4 border-l-green p-4">
          <div className="text-label uppercase text-green-ink">Answer</div>
          <p className="mt-1 text-sm text-fg">{sessionData.session.final_answer}</p>
        </div>
      )}
    </Card>
  );
}
