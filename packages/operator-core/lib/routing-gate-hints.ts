/**
 * routing-gate-hints.ts — EI-8809: stamp trigger-matching work-items with the
 * matched "papercusp-way" routing row so a claimer sees the prescribed mechanism
 * IN the dispatched item, not only in the persona prompt they must re-derive it
 * from mid-flow.
 *
 * Root cause (GRADE iteration 1, scorecard EI-8808, rubric su-agent-behavior): a
 * well-executing agent silently bypassed 3 of 4 papercusp-way trigger rows on a
 * provoked battery ("daily 9am digest" → hand-seeded routine instead of
 * plans:set-schedule+arm-schedule; "alert me when gate red" → hand-wired push
 * instead of watch:create; "create a web app" → a page in the existing app
 * instead of templates:*). The routing table lives in the persona; the
 * DISPATCHED ITEM the agent actually reads carries no signal that a row matched.
 *
 * This is a cheap, pure keyword/pattern matcher — HINT ONLY, never a gate: it
 * never blocks a create/claim/dispatch, it only ATTACHES a `routingHint` the
 * claimer's brief can render, e.g. "papercusp way: plans:set-schedule ->
 * plans:arm-schedule (deviating requires stating why)". Mirrors the existing
 * non-blocking-nudge pattern in work_items/create.ts's `codeSmellsLikeCode`.
 *
 * ROUTING_GATE_ROWS covers the 6 rows EI-8809 named explicitly (schedule/
 * recurrence, watch/alert, credential/API key, create-app,
 * bring-repo-under-management, design-screen) — the full su-playbook routing
 * table has more rows; widen ROUTING_GATE_ROWS if a future finding names one.
 */

export interface RoutingGateRow {
  /** Stable id for this row (also usable as a scorecard/rubric join key). */
  id: string;
  /** Human label for the trigger this row matches (kept short for the hint line). */
  trigger: string;
  /** The prescribed papercusp-way mechanism, verbatim enough to act on. */
  mechanism: string;
  /** One-line gloss of why this mechanism, for a claimer unfamiliar with it. */
  gloss: string;
  /** Keywords/phrases (lowercase) — a single hit on title+summary is a match. */
  keywords: readonly string[];
}

export const ROUTING_GATE_INTENTS = [
  'schedule-recurrence',
  'watch-alert',
  'credential-key',
  'create-app',
  'bring-repo-under-management',
  'design-screen',
] as const;
export type RoutingGateIntent = (typeof ROUTING_GATE_INTENTS)[number];

export interface RoutingGateMatchInput {
  /** Explicit owner/caller-selected routing row. Never inferred from body prose. */
  ownerIntent?: RoutingGateIntent | null;
  /** Required with an explicit schedule intent; e.g. "daily at 09:00" or a cron. */
  cadence?: string | null;
}

const SCHEDULE_ACTIONS = [
  'schedule', 'send', 'run', 'generate', 'publish', 'deliver', 'email',
  'post', 'execute', 'repeat',
] as const;
const SCHEDULE_CADENCES = [
  'daily', 'weekly', 'nightly', 'every day', 'every week', 'on a schedule',
  'on a cadence', 'recurring', 'cron', 'each morning', 'every morning',
  '9am', 'periodic', 'every hour', 'hourly',
] as const;

export const ROUTING_GATE_ROWS: readonly RoutingGateRow[] = [
  {
    id: 'schedule-recurrence',
    trigger: 'do X daily / weekly / on a schedule',
    mechanism: 'plans:set-schedule THEN plans:arm-schedule',
    gloss: 'arming is a separate, autonomy-gated step — an unarmed schedule never fires.',
    // Schedule routing is deliberately NOT a one-keyword match. The matcher
    // below requires one action + one cadence, or typed ownerIntent + cadence.
    keywords: SCHEDULE_CADENCES,
  },
  {
    id: 'watch-alert',
    trigger: 'watch for Y / alert me when Z',
    mechanism: 'watch:create',
    gloss:
      'the unified subscription primitive; events:await is its wake preset, and targetKind:"topic" + wake:false is the ambient-inject one. Patterns are EXACT-match — fall back to a scheduled poll+diff if events:catalog has no key.',
    keywords: [
      'alert me when', 'alert when', 'notify me when', 'notify when',
      'let me know when', 'watch for', 'keep an eye on', 'ping me when',
      'tell me if', 'tell me when',
    ],
  },
  {
    id: 'credential-key',
    trigger: 'user hands you a credential / API key',
    mechanism: 'setup:save_key',
    gloss:
      'ONLY for the 4 platform provider keys (openai / anthropic / zeroentropy / github_pat) — any other secret goes to injected config outside the repo, never a tree file.',
    keywords: [
      'api key', 'api token', 'access token', 'credential', 'secret key',
      'here is my key', "here's my key", 'save this key', 'oauth token',
    ],
  },
  {
    id: 'create-app',
    trigger: 'create/build an app (any form)',
    mechanism: 'templates:list -> templates:get-guide -> templates:new-app',
    gloss:
      '3 app-scope roots (webapp / desktop / agentic-desktop) — never a hand-rolled scaffold; ask which root when the shape is ambiguous.',
    keywords: [
      'create an app', 'build an app', 'new app', 'scaffold an app',
      'build a web app', 'create a web app', 'build a desktop app',
      'new webapp', 'stand up an app',
    ],
  },
  {
    id: 'bring-repo-under-management',
    trigger: 'bring this repo under management',
    mechanism: 'pot:create_from_repo (GitHub URL) or harness:generate-from-repo (existing local repo)',
    gloss: 'a FORK — pick by whether the repo is a GitHub URL or an already-local checkout.',
    keywords: [
      'bring this repo', 'bring the repo', 'onboard this repo', 'import this repo',
      'manage this repo', 'under management', 'add this repo to papercusp',
    ],
  },
  {
    id: 'design-screen',
    trigger: 'design this screen / component',
    mechanism: 'design-phase.search_registry -> spec -> design-phase.validate_spec / lint_spec',
    gloss: 'search the existing component registry FIRST instead of inventing a new component.',
    keywords: [
      'design this screen', 'design a screen', 'design this component',
      'design a component', 'new ui screen', 'design the ui for',
    ],
  },
] as const;

export interface RoutingGateHint {
  row: string;
  mechanism: string;
  gloss: string;
  /** The keyword that triggered the match — useful for a claimer to sanity-check the hit. */
  matchedOn: string;
}

/**
 * Match an owner-authored TITLE or an explicit typed intent. Arbitrary body /
 * summary prose is intentionally absent from this API: implementation phrases
 * such as "add a recurrence guard" cannot silently prescribe a scheduler.
 * Schedule inference additionally requires an action AND a cadence.
 */
export function matchRoutingGateHint(
  title: string | null | undefined,
  input: RoutingGateMatchInput = {},
): RoutingGateHint | null {
  const hay = (title ?? '').toLowerCase().trim();
  const explicit = input.ownerIntent
    ? ROUTING_GATE_ROWS.find((row) => row.id === input.ownerIntent)
    : undefined;
  if (explicit) {
    if (explicit.id === 'schedule-recurrence' && !(input.cadence ?? '').trim()) return null;
    return {
      row: explicit.id,
      mechanism: explicit.mechanism,
      gloss: explicit.gloss,
      matchedOn: explicit.id === 'schedule-recurrence'
        ? `ownerIntent+cadence:${input.cadence!.trim()}`
        : `ownerIntent:${explicit.id}`,
    };
  }
  if (!hay) return null;

  const scheduleAction = SCHEDULE_ACTIONS.find((kw) => hay.includes(kw));
  const scheduleCadence = SCHEDULE_CADENCES.find((kw) => hay.includes(kw));
  if (scheduleAction && scheduleCadence) {
    const row = ROUTING_GATE_ROWS.find((candidate) => candidate.id === 'schedule-recurrence')!;
    return {
      row: row.id,
      mechanism: row.mechanism,
      gloss: row.gloss,
      matchedOn: `${scheduleAction}+${scheduleCadence}`,
    };
  }

  for (const row of ROUTING_GATE_ROWS.slice(1)) {
    const hit = row.keywords.find((kw) => hay.includes(kw));
    if (hit) {
      return { row: row.id, mechanism: row.mechanism, gloss: row.gloss, matchedOn: hit };
    }
  }
  return null;
}

/** Render a RoutingGateHint as the one-line brief a claimer sees. */
export function renderRoutingGateHintLine(hint: RoutingGateHint): string {
  return `papercusp way: ${hint.mechanism} (${hint.gloss})`;
}
