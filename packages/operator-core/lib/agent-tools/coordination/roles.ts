/**
 * Roles permitted to call coord:* tools. Superuser and power-user
 * callers bypass the role gate entirely (dispatch-stack.ts); this list
 * only matters for role-gated callers. It mirrors the SU role set the
 * sibling locks:* tools use.
 */
export const COORD_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
  // The generic Hive worker (local-hive-orchestration D-003 / P-011). The bee
  // coordinates via coord:* (declare-intent, send, await-inbox) and maintains its
  // ordered work-list via work_items:* — both gated on this list — so it MUST be a
  // coord role. Same gate the pipeline worker passes, minus the chunk coupling.
  'cup',
  // The QUEEN — the hive's placement decider (operator specialized; local-hive
  // D-001/P-030). Her whole loop is coord/fleet/work_items: survey
  // (coord:presence/inbox, work_items:list) → place (cup:spawn — note
  // fleet/spawn.ts filters OUT bee+sentinel but keeps queen; placement is hers)
  // → warm-inject (coord:send {wake}) → drain (fleet:drain). EI-286 follow-up:
  // the role existed only in the blueprint, so every gate here filtered her out.
  'mug',
  // The SENTINEL — the fleet watcher (unify-launch-mechanics-2026-06-09 D-004).
  // Its core surface IS coord: it READS the substrate (coord:presence/inbox/feed)
  // + the fleet (fleet:assignments/tree — both COORD_ROLES-gated, surfacing stuck/
  // orphaned spawns) and RAISES ALARMS (coord:escalate/send). Its caps
  // (BLUEPRINT_ROLE_CAPS.sentinel) are read-mostly, so the COORD_ROLES write tools
  // it cannot use (work_items:write etc.) stay capped out — only coord:write
  // resolves. Excluded from cup:spawn (placement is the Queen's, not the
  // watcher's — see fleet/spawn.ts, same carve-out as bee).
  'papercup',
  // The PAPERCUP-DEEP — the hidden deep-brain half of the one "Papercup"
  // identity (voice-public-release-readiness-2026-07-12 P-014). Its core
  // surface IS coord: the fast front-end (papercup) wakes it with a delegated
  // question (coord:send { wake }) and it replies + wakes the asker back; it
  // orients, checkpoints investigations on work_items, and reads the substrate.
  // Read+think+reply-mostly — like cup/papercup/kettle it MUST stay excluded
  // from the placement/execution filter sites (AUTH INVARIANT below).
  'papercup-deep',
  // The OVERWATCH — the autonomous system-health supervisor (overwatch-role-2026-06-15
  // C-2 / B-01). Like the sentinel, its core surface IS coord: it READS the substrate
  // (coord:presence/inbox/feed, improvements:digest, topics:feed) + the fleet
  // (fleet:assignments/tree) + the work frontier (work_items:list) + the ledgers
  // (decision_ledger, pot:status) and its ONLY writes are NUDGES + observations
  // (coord:send / coord:escalate / improvements:capture). Its caps
  // (BLUEPRINT_ROLE_CAPS.overwatch) are read-mostly (coord:write for nudges only), so the
  // COORD_ROLES write tools it cannot use stay capped out. Excluded from cup:spawn
  // (placement is the Queen's — the overwatch NUDGES her to re-place, never re-places
  // itself; D-001 — same carve-out as bee/sentinel).
  'kettle',
  // The DOC-STEWARD — the automated doc-freshness fixer (docs-corpus-audit P-008;
  // the `doc-steward` launch blueprint). Its prompt calls `work_items:get` (to read
  // WHY the anchored code changed) and `coord:escalate` (when it can't faithfully fix
  // a doc) — both COORD_ROLES-gated. It was never a registered role, so those failed
  // `role_not_allowed` for a doc-steward-scoped URL, forcing a scripts/mcp-call.mjs
  // fallback (EI-6643). Same registered-late class as bee/sentinel/overwatch above.
  'doc-steward',
  // The RELEASE-FIXER — a launch-blueprint role whose repair protocol is
  // coordinated work: orient, claim/checkpoint/complete the gate item, and
  // escalate when the regression cannot be fixed safely. It retains native
  // file/shell tools (so it deliberately stays out of SU_ROLES); the matching
  // synthesized principal grants live in role-principal-caps.ts.
  'release-fixer',
  // The CONTENT-FIXER — another launch-blueprint role whose repair protocol is
  // coordinated work: orient, hold/checkpoint/complete its repair item, and
  // escalate when the quarantined content cannot be fixed safely. Its
  // synthesized principal carries only coord/work_items read-write caps (see
  // role-principal-caps.ts); it has no broader operator or filesystem surface.
  'content-fixer',
  // pot-rename SLICE-2 CONTRACT: the old ids (bee/queen/sentinel/overwatch) are
  // gone — cup/mug/papercup/kettle above are the canonical coord roles. (scout was
  // never a coord role, so blender is intentionally absent.) ⚠ AUTH INVARIANT: the
  // read-mostly roles (cup/papercup/papercup-deep/kettle) MUST stay excluded from
  // the Mug-only write tools — the `COORD_ROLES.filter((r) => r !== 'cup' &&
  // r !== 'papercup' && r !== 'papercup-deep' && r !== 'kettle')` sites move in
  // LOCKSTEP with this list. `mug` is deliberately NOT excluded — it keeps the
  // Mug's placement access.
] as const;

// The acceptance judge is deliberately added only to the two narrow role
// extensions below. It must stay outside COORD_ROLES: that shared set gates
// broad coordination, placement, and work-item mutation surfaces.
const EVIDENCE_JUDGE_ROLE = ['judge'] as const;

/**
 * Coordination read surfaces — general coordination readers plus the
 * evidence-only acceptance judge. Keep judge out of COORD_ROLES so the
 * read-only judge lane does not inherit coordination writers/placement tools.
 */
export const COORD_READ_ROLES = [...COORD_ROLES, ...EVIDENCE_JUDGE_ROLE] as const;

/**
 * Reply/ack channel roles — general coordination roles plus the evidence-only
 * acceptance judge. A judge may answer the peer that woke it, but does not gain
 * the rest of coord:* merely by being able to use these reply surfaces.
 */
export const COORD_REPLY_ROLES = [...COORD_ROLES, ...EVIDENCE_JUDGE_ROLE] as const;

/**
 * Work-item lifecycle roles — the general coordination roles plus the
 * evidence-only acceptance judge. This is intentionally separate from
 * COORD_ROLES: judge may annotate/checkpoint/complete or release its own
 * misplaced claim without gaining create/set_state or other broad writers.
 */
export const WORK_ITEM_LIFECYCLE_ROLES = [...COORD_ROLES, ...EVIDENCE_JUDGE_ROLE] as const;

/**
 * EI-145 (part 2): the Queen/Mug-only PLACEMENT/steering allowlist — COORD_ROLES
 * minus the read-mostly agents (cup/papercup/papercup-deep/kettle) whose caps are
 * read+nudge-only and must never gain a placement/gym/desktop-provisioning tool.
 *
 * Before this constant existed, ~10 tool files (fleet/place_batch, gym/judge,
 * gym/signals, cup/spawn, computer/list-desktops, computer/release-desktop,
 * computer/provision-desktop, experiment/catalog, experiment/run,
 * experiment/results) each re-spread the IDENTICAL inline predicate
 * `COORD_ROLES.filter((r) => r !== 'cup' && r !== 'papercup' && r !== 'papercup-deep'
 * && r !== 'kettle')` — the exact copy-paste foot-gun EI-145 warned about: a future
 * Queen-only tool reaching for `[...COORD_ROLES]` (or re-typing this filter with one
 * exclusion missing) silently re-leaks a placement/gym/provisioning tool to a
 * read-mostly role. ONE shared array closes that: every site imports this instead
 * of re-deriving it, so the "AUTH INVARIANT" test in roles.test.ts only has to hold
 * in one place to hold everywhere.
 */
export const QUEEN_PLACEMENT_ROLES = COORD_ROLES.filter(
  (r) => r !== 'cup' && r !== 'papercup' && r !== 'papercup-deep' && r !== 'kettle',
);

/**
 * pot-rename D-007 map (old role id → canonical new id) — the same mapping
 * migration 519 (`519-pot-rename-slice2-role-contract.sql`) backfilled into
 * every DB column (spawned_agents.child_role, agent_usage_samples.role, …)
 * and `hive/soak-report.ts`'s read-side CASE reproduces. No shared TS helper
 * existed anywhere in the repo (WI-3168-adjacent gap) — most call sites
 * instead hand-roll a `role === 'queen' || role === 'mug'` dual-check inline
 * (bee/spawn.ts, blueprint/launch-blueprint.ts, role-launch-spec.ts, …). This
 * is the single reusable form: `canonicalCoordRole(x) === canonicalCoordRole(y)`
 * is the general equivalence test, and `canonicalCoordRole(role)` is what a
 * *storage* site (a DB column, a stored `role:` field) should persist instead
 * of the raw, possibly-old-spelling literal a caller passed.
 */
const POT_RENAME_ROLE_MAP: Readonly<Record<string, string>> = {
  bee: 'cup',
  queen: 'mug',
  sentinel: 'papercup',
  overwatch: 'kettle',
  scout: 'blender',
};

/** Canonicalize a role id through the pot-rename map (identity if already-canonical / unknown). */
export function canonicalCoordRole(role: string): string {
  return POT_RENAME_ROLE_MAP[role] ?? role;
}
