/**
 * agent-pane-kind.ts — the shared AgentPaneKind taxonomy
 * (hive-agent-tabs-psu-tui-2026-06-09, P-001 / D-001..D-008).
 *
 * ONE source of truth for "what kind of agent tab is this" across the backend
 * (spawn / roster shaping) and pui (pane render + per-type color). The backend
 * stamps the resolved kind onto the roster entry; pui mirrors only the string
 * VALUES (a serde contract test in apps/tui guards the mirror) rather than
 * re-deriving the mapping — so there is no per-call string matching split across
 * two languages.
 *
 * The four owner-facing pane kinds (the zellij dock tabs the owner sees):
 *   - queen     — the autonomous brain: the `psu --brain` session, driven by the
 *                 cadence loop + events (D-006). Auto-injected by default.
 *   - overwatch — the autonomous system-health SUPERVISOR, a sibling to the Queen
 *                 (overwatch-role-2026-06-15 C-2 / B-01): cadence-woken like the Queen
 *                 (driveMode auto), but it WATCHES + NUDGES the running system rather
 *                 than placing work. Its own dock pane-kind so the roster separates it
 *                 from the Queen.
 *   - bee       — a system-driven worker/role agent: the generic `bee`, the
 *                 pipeline roles (scoper…curator), AND the read-mostly fleet
 *                 `sentinel` WATCHER role + the other cross-cutting roles. Auto.
 *   - sentinel  — the always-on, owner-facing operator persona: the `operator`
 *                 role (operator-converse). Responsive. NB the COLLISION (D-001):
 *                 the *display* "Sentinel" == the operator persona (matching the
 *                 lexicon `operator → Sentinel`), which is DISTINCT from the
 *                 `sentinel` *role* (a fleet watcher → `bee` kind above). The
 *                 owner-facing tab named "Sentinel" is the operator persona.
 *   - planner   — an agent launched from Create → New plan (P-006). Responsive.
 *   - su        — the owner's own interactive engineer session (psu): `su-…`
 *                 coord ids, never a nursery spawn. Responsive; NEVER paned by
 *                 the dock driver (it's the owner's terminal, not a dock agent).
 *                 Added by progress-tab-agents-convergence-2026-06-11 P-005 —
 *                 the old fallback classified psu sessions as bees, so neither
 *                 roster could tell the owner's sessions from workers (and the
 *                 dock driver would have tried to resume-pane them).
 *
 * `driveMode` is the ORTHOGONAL axis (D-003 / D-005): `auto` = the system
 * auto-injects the next turn (cadence loop / event wake); `responsive` = the
 * agent waits for the owner. It is the DEFAULT for the kind — the per-agent wake
 * mode (D-005) can still flip an `auto` agent to manual at runtime.
 */

export const AGENT_PANE_KINDS = ['mug', 'kettle', 'cup', 'papercup', 'planner', 'su'] as const;
export type AgentPaneKind = (typeof AGENT_PANE_KINDS)[number];

export const DRIVE_MODES = ['auto', 'responsive'] as const;
export type DriveMode = (typeof DRIVE_MODES)[number];

export interface AgentPaneClass {
  kind: AgentPaneKind;
  driveMode: DriveMode;
}

/**
 * How the session was launched, when the role alone doesn't disambiguate.
 * `brain` = the pinned `psu --brain` Queen; `planner` = a Create → New plan
 * launch. Absent for an ordinary role spawn.
 */
export type AgentLaunchHint = 'brain' | 'planner' | undefined;

/**
 * Classify an agent into its dock pane-kind + drive mode from its role, an
 * optional launch hint, and (for hint-less roster entries) its coord owner id.
 * Precedence (most specific first):
 *   1. brain launch OR the `brain` principal role OR the registered `queen`
 *      role (the hive blueprint's placement decider) → queen / auto
 *   1b. overwatch role        → overwatch / auto   (the system-health supervisor, a
 *                              cadence-woken sibling to the Queen — overwatch-role B-01)
 *   2. planner launch/role   → planner / responsive
 *   3. operator role         → sentinel / responsive   (the owner-facing persona)
 *   4. oracle role           → sentinel / responsive   (a responsive Q&A chat)
 *   5. su role, or a role-less `su-…` owner id → su / responsive (the owner's
 *      own interactive psu session — never dock-paned)
 *   6. everything else       → bee / auto   (pipeline roles, the generic `bee`,
 *                              the `sentinel` WATCHER role, reviewers, orchestrator…)
 */
export function classifyAgentPane(input: {
  role?: string | null;
  launch?: AgentLaunchHint;
  ownerId?: string | null;
}): AgentPaneClass {
  const role = (input.role ?? '').trim().toLowerCase();
  // The Queen is the brain: a `psu --brain` launch (hint), the `brain` principal
  // role an active brain session carries (BRAIN_PRINCIPAL_ROLE), or the
  // registered `queen` role itself (hive invoke-route launches; EI-286
  // follow-up — before the role was registered the live Queen fell to the bee
  // arm and glyphed ☕).
  // pot-rename dual-accept (P1 MIGRATE): `mug` is the additive twin of the `queen`
  // role INPUT — it classifies to the SAME `queen` pane-kind. (RETURN value/glyph unchanged.)
  if (input.launch === 'brain' || role === 'brain' || role === 'queen' || role === 'mug') {
    return { kind: 'mug', driveMode: 'auto' };
  }
  // The overwatch is the Queen's sibling supervisor — cadence-woken (auto), but its OWN
  // pane kind so the roster/dock separates it from the Queen (overwatch-role-2026-06-15 B-01).
  // pot-rename dual-accept (P1 MIGRATE): `kettle` is the additive twin of the `overwatch`
  // role INPUT — it classifies to the SAME `overwatch` pane-kind. (RETURN value/glyph unchanged.)
  if (role === 'overwatch' || role === 'kettle') {
    return { kind: 'kettle', driveMode: 'auto' };
  }
  if (input.launch === 'planner' || role === 'planner') {
    return { kind: 'planner', driveMode: 'responsive' };
  }
  if (role === 'operator' || role === 'oracle') {
    return { kind: 'papercup', driveMode: 'responsive' };
  }
  // The owner's interactive engineer sessions: an explicit su role, or a
  // role-less presence whose coord id carries the psu `su-` prefix (nursery
  // spawns mint `s-<ts>-…` ids / role-stamped rows, so they never match).
  if (role === 'su' || (!role && (input.ownerId ?? '').startsWith('su-'))) {
    return { kind: 'su', driveMode: 'responsive' };
  }
  return { kind: 'cup', driveMode: 'auto' };
}
