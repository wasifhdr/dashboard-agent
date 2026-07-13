import { useState } from "react";
import AppShell from "./components/AppShell.jsx";
import Landing from "./screens/Landing/Landing.jsx";
import Watch from "./screens/Watch/Watch.jsx";
import History from "./screens/History/History.jsx";

export default function App() {
  const [view, setView] = useState("landing");
  const [watchTarget, setWatchTarget] = useState(null);
  // { kind: "conversation", id } | { kind: "session", id } | null. Discriminates
  // whether Watch below gets a conversationId or a sessionId prop - constructed
  // by History.jsx's row click handler, consumed only here.
  const [replayTarget, setReplayTarget] = useState(null);
  const [watchHasActiveRun, setWatchHasActiveRun] = useState(false);

  function navigate(nextView) {
    if (view === "watch" && nextView !== "watch" && watchHasActiveRun) {
      if (!window.confirm("The agent is still running. Leave this session?")) return;
    }
    setWatchHasActiveRun(false);
    setView(nextView);
  }

  function openWatch(target) {
    setWatchTarget(target);
    setReplayTarget(null);
    setWatchHasActiveRun(false);
    setView("watch");
  }

  function openReplay(target) {
    setReplayTarget(target);
    setWatchTarget(null);
    setWatchHasActiveRun(false);
    setView("watch");
  }

  // Explicit "End session" on a live conversation (Watch's StatusBar, Phase
  // B4). Only fires after the conversation has actually been closed
  // server-side (or never existed), so — unlike navigate() — there's no
  // still-running conversation left behind to confirm about. Goes to
  // "history" to mirror the replay branches' own onBack, which land there too.
  function endLiveWatch() {
    setWatchTarget(null);
    setReplayTarget(null);
    setWatchHasActiveRun(false);
    setView("history");
  }

  return (
    <AppShell view={view} onNavigate={navigate}>
      {view === "landing" && <Landing onOpenWatch={openWatch} onOpenHistory={() => navigate("history")} />}
      {view === "watch" && replayTarget?.kind === "conversation" && (
        <Watch
          mode="replay"
          conversationId={replayTarget.id}
          onBack={() => navigate("history")}
          onActiveRunChange={setWatchHasActiveRun}
        />
      )}
      {view === "watch" && replayTarget?.kind === "session" && (
        <Watch
          mode="replay"
          sessionId={replayTarget.id}
          onBack={() => navigate("history")}
          onActiveRunChange={setWatchHasActiveRun}
        />
      )}
      {view === "watch" && !replayTarget && watchTarget && (
        <Watch
          mode="live"
          dashboardTarget={watchTarget}
          onActiveRunChange={setWatchHasActiveRun}
          onEnd={endLiveWatch}
        />
      )}
      {view === "history" && <History onOpenReplay={openReplay} onGoToLanding={() => navigate("landing")} />}
    </AppShell>
  );
}
