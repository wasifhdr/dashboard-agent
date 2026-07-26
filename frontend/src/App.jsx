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
  // The live dashboard {name, url} Watch is currently showing, surfaced in the
  // top header as a clickable link. Null outside the watch view.
  const [watchDashboard, setWatchDashboard] = useState(null);

  function navigate(nextView) {
    if (view === "watch" && nextView !== "watch" && watchHasActiveRun) {
      if (!window.confirm("The agent is still running. Leave this session?")) return;
    }
    setWatchHasActiveRun(false);
    if (nextView !== "watch") setWatchDashboard(null);
    setView(nextView);
  }

  function openWatch(target) {
    setWatchTarget(target);
    setReplayTarget(null);
    setWatchHasActiveRun(false);
    setWatchDashboard(target ?? null);
    setView("watch");
  }

  function openReplay(target) {
    setReplayTarget(target);
    setWatchTarget(null);
    setWatchHasActiveRun(false);
    setWatchDashboard(null);
    setView("watch");
  }

  // Stop / End session on a live conversation (the composer Stop button and the
  // red stop button in Watch's thread header). Navigates back to the landing
  // page immediately; Watch has already kicked off the backend cleanup
  // (abort the turn + close the dashboard) fire-and-forget, so there's nothing
  // to await here.
  function endLiveWatch() {
    setWatchTarget(null);
    setReplayTarget(null);
    setWatchHasActiveRun(false);
    setWatchDashboard(null);
    setView("landing");
  }

  return (
    <AppShell view={view} onNavigate={navigate} headerCenter={view === "watch" ? watchDashboard : null}>
      {view === "landing" && <Landing onOpenWatch={openWatch} onOpenHistory={() => navigate("history")} />}
      {view === "watch" && replayTarget?.kind === "conversation" && (
        <Watch
          mode="replay"
          conversationId={replayTarget.id}
          onBack={() => navigate("history")}
          onActiveRunChange={setWatchHasActiveRun}
          onDashboardChange={setWatchDashboard}
        />
      )}
      {view === "watch" && replayTarget?.kind === "session" && (
        <Watch
          mode="replay"
          sessionId={replayTarget.id}
          onBack={() => navigate("history")}
          onActiveRunChange={setWatchHasActiveRun}
          onDashboardChange={setWatchDashboard}
        />
      )}
      {view === "watch" && !replayTarget && watchTarget && (
        <Watch
          mode="live"
          dashboardTarget={watchTarget}
          onActiveRunChange={setWatchHasActiveRun}
          onEnd={endLiveWatch}
          onDashboardChange={setWatchDashboard}
        />
      )}
      {view === "history" && <History onOpenReplay={openReplay} onGoToLanding={() => navigate("landing")} />}
    </AppShell>
  );
}
