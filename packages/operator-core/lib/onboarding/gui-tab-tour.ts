/**
 * GUI tab-tour registry for the onboarding tutor's finale
 * (plan agent-first-onboarding-2026-07-03, P-018).
 *
 * The finale walks the user through the GUI's main tab strip LEFT TO RIGHT,
 * driving the real window via `ui:dispatch {intent:'set_url'}` while
 * narrating each tab. This module is the server-side source the tutor's
 * launch context renders from ({{GUI_TAB_TOUR}} in onboarding-tutor.md).
 *
 * DRIFT GUARD: the visual truth is `ADV_TABS` in
 * apps/operator-vite/src/components/adv/AdvShell.tsx (array order = strip
 * order; ids are serialized in `?tab=` URLs and are the agent ui:dispatch
 * surface, so they never get renamed). operator-core cannot import that TSX,
 * so gui-tab-tour.test.ts parses the source file and asserts this registry
 * matches it id-for-id, label-for-label, in order — add/remove/reorder a tab
 * in AdvShell.tsx and that test fails until this tour is updated too.
 */

export interface GuiTabTourStop {
  /** `?tab=` id — MUST match an ADV_TABS entry (drift-tested). */
  id: string;
  /** Visible tab label — MUST match ADV_TABS (drift-tested). */
  label: string;
  /** 1–2 sentence narration the tutor gives while showing the tab. */
  blurb: string;
}

/** Strip order = array order (left→right), mirroring ADV_TABS. */
export const GUI_TAB_TOUR: ReadonlyArray<GuiTabTourStop> = [
  {
    id: 'overview',
    label: 'Overview',
    blurb:
      'The landing dashboard — what is running right now, plans that need attention, and the pulse of the whole workspace at a glance.',
  },
  {
    id: 'hud',
    label: 'HUD',
    blurb:
      'The session board — every agent running right now, grouped by what it needs from you: waiting on an answer, blocked on a gate, working, or idle. Click a card to open that agent’s live conversation.',
  },
  // 'brainstorm' left the /adv strip for the Quick Panel popup
  // (quick-panel-saved-prompts-2026-07-13 P-010) and was RESTORED as a per-pot
  // secondary tab by WI-1008447. The tour mirrors ADV_TABS, so it is back here too.
  {
    id: 'brainstorm',
    label: 'Brainstorm',
    blurb:
      'The per-pot idea workspace — somewhere to think roughly out loud, let an idea grow, and hand it to a plan once it is worth building. The Quick Panel popup is the fast global doorway to this same surface.',
  },
  {
    id: 'plans',
    label: 'Create',
    blurb:
      'Where plans live — author them, review their items, and launch them. A plan here is the same durable object agents work from in the terminal.',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    blurb:
      'The workspace-wide workflow catalog — triggered plans, AI routines, and system tasks in one place, with their schedules, event sources, recent activity, and controls.',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    blurb:
      'The time surface for scheduled and recurring plans across every project — anything set to run on a cadence shows up here.',
  },
  {
    id: 'harnesses',
    label: 'Work',
    blurb:
      'The live work view: work items, the agents holding them, and runs in flight for the selected project. This is where you watch progress happen.',
  },
  {
    id: 'health',
    label: 'Health',
    blurb:
      'A read-only system dashboard — the orchestrator, agents, token spend, and infrastructure health in one glance. (May be hidden if its feature flag is off.)',
  },
  {
    id: 'frames',
    label: 'Frames',
    blurb:
      'Live views of deployed agent desktops — their actual screens, watchable in real time.',
  },
  {
    id: 'git',
    label: 'Git',
    blurb:
      'The code pipeline: commits flowing from the shared tree, the green gate verdict, and deploys. Agents commit nothing by hand — this shows the automation doing it.',
  },
  {
    id: 'stats',
    label: 'Stats',
    blurb:
      'Repository statistics and trends — language mix, code volume, contributors, and change history for the selected project.',
  },
  {
    id: 'testing',
    label: 'Tests',
    blurb:
      'Test runs and suite health for the project — the evidence behind “done” claims and the gate’s verdicts.',
  },
  {
    id: 'docs',
    label: 'Docs',
    blurb:
      'The project’s documentation tree — the same docs agents read first when asked how something works.',
  },
  {
    id: 'history',
    label: 'History',
    blurb:
      'The durable record of completed work, releases, and other past activity — use it to trace what changed and when.',
  },
  {
    id: 'insights',
    label: 'Insights',
    blurb:
      'Usage insights: an activity overview plus token/cost tracking, so you can see what the system spends and where.',
  },
  {
    id: 'conversations',
    label: 'Conversations',
    blurb:
      'Every kind of communication the workspace produces — Q&A, deliberations, agent chats, messages, and the raw coordination log for debugging.',
  },
  {
    id: 'learning',
    label: 'Learning',
    blurb:
      'The full learning loop in one place: observe raw signals, improve through ideas and experiments, verify with rubrics and benchmarks, then retain what worked.',
  },
  {
    id: 'evals',
    label: 'Evaluation',
    blurb:
      'Impartial third-party benchmark runs — the public evidence for how well the harness performs, kept separate from internal tests.',
  },
  {
    id: 'settings',
    label: 'Settings',
    blurb:
      'Project and workspace settings — including the setup wizard’s knobs, which live on after onboarding for anything you want to adjust later.',
  },
];

/**
 * Render the tour as the markdown block {{GUI_TAB_TOUR}} expands to.
 * Each stop names the tab, the `set_url` target, and the narration seed.
 */
export function guiTabTourMarkdown(): string {
  const stops = GUI_TAB_TOUR.map(
    (t, i) =>
      `${i + 1}. **${t.label}** — \`ui:dispatch {intent:'set_url', args:{path:'/adv', params:{tab:'${t.id}'}}}\` — ${t.blurb}`,
  );
  return [
    ...stops,
    '',
    'Notes: the strip may show fewer tabs than this list — per-project tabs hide when the selector is on “All Pots”, and Health is feature-flag-gated. Skip (don’t mention) any tab the live window doesn’t show; verify with `ui:get_state` if unsure.',
  ].join('\n');
}
