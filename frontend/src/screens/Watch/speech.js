export const READ_ALOUD_STORAGE_KEY = "dashboard-agent-read-aloud";

export function loadReadAloudPref() {
  try {
    return localStorage.getItem(READ_ALOUD_STORAGE_KEY) === "on";
  } catch {
    return false; // storage unavailable (private mode) — default to silent
  }
}

export function saveReadAloudPref(enabled) {
  try {
    localStorage.setItem(READ_ALOUD_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Non-fatal: the toggle still works for this session.
  }
}

// What TTS reads for a finished turn — deliberately narrower than what
// Feed's OutcomeCard renders.
//
// Only the agent's actual response to the question is spoken:
//   answered / max_steps -> the final answer text
//   failed               -> the "can't answer this" verdict, which IS a response
// `error` and `stopped` are session conditions, not answers; reading a stack
// trace or "stopped by you" aloud is noise, and the card still shows them.
export function speakableAnswer(run) {
  if (!run) return null;
  if (run.status === "answered" || run.status === "max_steps") {
    return run.finalAnswer?.trim() || null;
  }
  if (run.status === "failed") {
    return "The agent determined this dashboard cannot answer this question.";
  }
  return null;
}
