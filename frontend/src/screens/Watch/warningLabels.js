// Carried over verbatim from the old TrajectoryViewer.jsx (FRONTEND_PLAN.md §6.1).
export const WARNING_LABEL = {
  empty_inventory:
    "This dashboard has no operable filters, parameters, or extra sheets - the agent can only read from screenshots, not interact with it.",
  settle_timeout: "A dashboard update took longer than expected to visually settle before being screenshotted.",
  wall_clock_timeout: "The session exceeded its overall time budget.",
  max_steps: "Reached the maximum step budget before answering.",
};

// Verdict reasons from the read-only viability inspection (viability.js).
// Only "unusable" reasons need copy - "good" and "unknown" render nothing.
export const INSPECTION_LABEL = {
  story: "This is a Tableau story, not a dashboard - the agent can't advance story points, so it can't work this one.",
  blank_frame: "This dashboard loaded but rendered nothing - the data source may have been removed.",
};
