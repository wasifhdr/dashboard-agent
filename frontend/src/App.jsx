import { useState } from "react";
import AppShell from "./components/AppShell.jsx";
import Landing from "./screens/Landing/Landing.jsx";
import Watch from "./screens/Watch/Watch.jsx";
import History from "./screens/History/History.jsx";

export default function App() {
  const [view, setView] = useState("landing");
  const [watchTarget, setWatchTarget] = useState(null);
  const [replaySessionId, setReplaySessionId] = useState(null);
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
    setReplaySessionId(null);
    setWatchHasActiveRun(false);
    setView("watch");
  }

  function openReplay(sessionId) {
    setReplaySessionId(sessionId);
    setWatchTarget(null);
    setWatchHasActiveRun(false);
    setView("watch");
  }

  return (
    <AppShell view={view} onNavigate={navigate}>
      {view === "landing" && <Landing onOpenWatch={openWatch} onOpenHistory={() => navigate("history")} />}
      {view === "watch" && replaySessionId && (
        <Watch
          mode="replay"
          sessionId={replaySessionId}
          onBack={() => navigate("history")}
          onActiveRunChange={setWatchHasActiveRun}
        />
      )}
      {view === "watch" && !replaySessionId && watchTarget && (
        <Watch mode="live" dashboardTarget={watchTarget} onActiveRunChange={setWatchHasActiveRun} />
      )}
      {view === "history" && <History onOpenReplay={openReplay} onGoToLanding={() => navigate("landing")} />}
    </AppShell>
  );
}
