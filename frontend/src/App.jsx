import { useState } from "react";
import AppShell from "./components/AppShell.jsx";
import ConfirmDialog, { useConfirm } from "./components/ui/ConfirmDialog.jsx";
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
  const [confirm, confirmProps] = useConfirm();

  // Leaving the Watch view tears the live session down — the backend closes the
  // shared browser and the conversation is over — so EVERY exit from a live
  // watch confirms first, not just the ones taken mid-run. "Docent", "New
  // dashboard" and "History" all funnel through navigate(), so this covers them
  // all. Replays have nothing to lose and never prompt. (The dashboard title in
  // the header is a target="_blank" link to Tableau Public; it opens a new tab
  // rather than leaving, so it ends nothing and is deliberately not gated.)
  const isLiveWatch = view === "watch" && !replayTarget && !!watchTarget;

  function confirmLeaveLiveWatch() {
    if (!isLiveWatch) return Promise.resolve(true);
    return confirm({
      title: "Leave this session?",
      body: watchHasActiveRun
        ? "The agent is still working on your question. Leaving closes the dashboard and the answer is lost."
        : "Leaving closes the dashboard and ends the conversation. Past turns stay in your history.",
      confirmLabel: "Leave",
      danger: true,
    });
  }

  async function navigate(nextView) {
    if (view === "watch" && nextView !== "watch" && !(await confirmLeaveLiveWatch())) return;
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
      {view === "landing" && <Landing onOpenWatch={openWatch} />}
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
          confirm={confirm}
          onDashboardChange={setWatchDashboard}
        />
      )}
      {view === "history" && <History onOpenReplay={openReplay} onGoToLanding={() => navigate("landing")} />}
      <ConfirmDialog {...confirmProps} />
    </AppShell>
  );
}
