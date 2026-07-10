// Carried over verbatim from the old TrajectoryViewer.jsx (FRONTEND_PLAN.md §6.1).
export const WARNING_LABEL = {
  empty_inventory:
    "This dashboard has no operable filters, parameters, or extra sheets - the agent can only read from screenshots, not interact with it.",
  settle_timeout: "A dashboard update took longer than expected to visually settle before being screenshotted.",
  wall_clock_timeout: "The session exceeded its overall time budget.",
  max_steps: "Reached the maximum step budget before answering.",
};
