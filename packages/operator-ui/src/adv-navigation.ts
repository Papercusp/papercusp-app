/** Shared desktop/portal navigation metadata. No runtime or component imports. */
export const ADV_MORE_LABELS = {
  brainstorm: "Brainstorm",
  plans: "Create",
  git: "Git",
  stats: "Stats",
  testing: "Tests",
  docs: "Docs",
  history: "History",
  conversations: "Conversations",
  calendar: "Calendar",
  insights: "Insights",
  evals: "Evaluation",
  health: "Health",
  frames: "Frames",
  settings: "Settings",
} as const;

export const ADV_MORE_GROUPS = [
  {
    id: "build",
    label: "Create & Build",
    tabIds: [
      "brainstorm",
      "plans",
      "git",
      "stats",
      "testing",
      "docs",
      "history",
    ],
  },
  { id: "work", label: "Activity", tabIds: ["conversations", "calendar"] },
  {
    id: "insights",
    label: "Insights",
    tabIds: ["insights", "evals", "health"],
  },
  { id: "system", label: "System", tabIds: ["frames", "settings"] },
] as const;

/** Existing surface mapping, shared without importing the component graph. */
export const ADV_TAB_SURFACE_KINDS = {
  overview: "overview",
  hud: "hud",
  brainstorm: "brainstorm",
  harnesses: "work",
  health: "health",
  prs: "prs",
  insights: "insights",
  conversations: "conversations",
  learning: "learning",
  settings: "adv-settings",
  docs: "docs",
  history: "history",
  git: "git",
  stats: "stats",
  testing: "testing",
  plans: "create",
  workflows: "workflows",
  calendar: "scheduled",
  frames: "frames",
  evals: "evals",
} as const;
