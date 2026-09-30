import type { Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import type { Principal } from '@papercusp/agent-mcp';
import { SUPERUSER_FALLBACK_CLIENT_ID } from '../../../agent-tools/coordination/identity';

/**
 * Capabilities granted to **blueprint-declared roles** — agents a blueprint spawns
 * that are NOT provisioned system principals (they're declared by a blueprint, not
 * seeded per workspace), so they have no `system_principals` row and
 * `loadRoleCapabilities` would otherwise return an empty set — which denies the
 * capability-gated built-ins their workflow needs (surfaced as `role-not-allowed`).
 * They get exactly the caps that workflow needs — least-privilege, no blanket grant,
 * workspace-agnostic (no per-workspace seed). Composes with any provisioned row
 * (the two are unioned). Covers:
 *   - **program-blueprint roles** (coordination-ops-as-blueprint-primitives): a
 *     `vote`'s `voter` / `advocate` post their structured vote/objection into the
 *     thread (`coord:thread-post` → `coord:write`) and read docs/search to ground it.
 *   - **launch-blueprint roles** (unify-agent-launches-as-blueprints D-005): the
 *     `scan` blueprint's `scanner` reads harness/plans/search state and captures each
 *     finding via `improvements:capture` (`coord:write`) into the self-improvement
 *     backlog — so it needs the read caps + coord:write, nothing more.
 */
export const BLUEPRINT_ROLE_CAPS: Readonly<Record<string, readonly string[]>> = {
  voter: ['coord:read', 'coord:write', 'docs:read', 'search:read'],
  advocate: ['coord:read', 'coord:write', 'docs:read', 'search:read'],
  scanner: ['coord:read', 'coord:write', 'docs:read', 'search:read', 'harness:read', 'plans:read'],
  // The pipeline reviewer has no provisioned system_principals row. Its grading-
  // integrity workflow reads scorecards, rubrics and facts, declares coordination
  // intent, and captures defects; it also inspects/claims adequacy-gate work. Keep
  // the grant to coordination read/write, work-item read/write, and plan reads —
  // the independent role allowlists still decide which concrete tools it may use.
  reviewer: ['coord:read', 'coord:write', 'work_items:read', 'work_items:write', 'plans:read'],
  // The green-checkpoint release-fixer is a launch-blueprint role with no
  // provisioned system_principals row. Its runbook uses the platform directly
  // to establish gate ownership, orient/claim/checkpoint its repair, hold file
  // locks, inspect release truth, run focused tests, and fire a fresh verdict.
  // Keep these grants paired with the tool allowlists (COORD_ROLES plus the
  // explicit state/release/testing/locks allowlists); otherwise the helper CLI
  // becomes an accidental privilege bridge and the documented direct path
  // fails with missing_capability.
  'release-fixer': [
    'coord:read',
    'coord:write',
    'docs:read',
    'work_items:read',
    'work_items:write',
    'harness:read',
    'locks:read',
    'locks:write',
    'intel:read',
    'operator:write',
    'testing:run',
    // The ATTRIBUTION pair. The persona forbids `git blame` for "who caused this"
    // (git-sync commits the whole tree under one identity — WI-5111) and directs the
    // fixer to the two read-only routes that DO resolve: the commissioning
    // work-item/plan-item (`plans:get` → plans:read) and, when that fails,
    // `sessions:search` correlated to the commit time (→ search:read). Both are
    // declared in the release-fix blueprint's `dependencies.tools`; without the caps
    // the allowlist half is inert and the mandated procedure dead-ends in
    // missing_capability. Read-only: neither admits a plan/session WRITE.
    'plans:read',
    'search:read',
  ],
  // The git-sync content-fixer is a launch-blueprint role with no provisioned
  // system_principals row. Its runbook must orient, hold/checkpoint/complete
  // its repair item, and escalate when a content error is not mechanically
  // repairable. Grant only the two workflow capability pairs; the independent
  // COORD_ROLES/tool allowlists remain the other dispatch gate. In particular,
  // do not grant filesystem, shell, docs, locks, release, or operator caps.
  'content-fixer': ['coord:read', 'coord:write', 'work_items:read', 'work_items:write'],
  // Dedicated plan-acceptance judges are evidence-scoped: they may read the
  // rubric, prior scorecards, test-run ledger, and work-item completion evidence;
  // emit the verdict; run the rubric's named checks; read the files those checks
  // cite; capture a defect they encounter; and persist their own lifecycle
  // annotation/checkpoint/close. The lifecycle tools independently allowlist
  // `judge`, so this write cap does not admit the role to broader work-item or
  // coordination surfaces, and judge remains outside COORD_ROLES.
  judge: [
    'coord:read',
    'coord:write',
    'work_items:read',
    'work_items:write',
    'operator:read',
    'plans:read',
    'testing:run',
    'capability:fs-read',
  ],
  // The SENTINEL — the fleet WATCHER (unify-launch-mechanics-2026-06-09 D-004,
  // split out of the overloaded "operator"). READ-MOSTLY: it observes fleet
  // health (intel: dev diagnostics, activity), harness health, the coord
  // substrate (presence/inbox/feed), the work frontier, recent audit events, and
  // lock contention — and its ONLY writes are raising alarms (coord:write →
  // coord:escalate / coord:send / messages). Deliberately WITHOUT work_items /
  // harness / plans / docs / routines write, and without the Queen's placement
  // surface (cup:spawn/drain, autoloop, processes:kill): the sentinel watches +
  // alerts, the Queen acts. Two-gate reality applies — these caps are paired with
  // adding `sentinel` to the watcher tools' `agentRoles` (COORD_ROLES + the
  // explicit fleet/intel/audit reads below).
  // Caps are kept IN LOCKSTEP with the tools sentinel is actually allowlisted on
  // (the two-gate reality — an un-allowlisted cap is INERT). Enforced surface:
  // COORD_ROLES (fleet:assignments/tree, coord:presence/inbox/feed/escalate/send,
  // work_items:list, issues:list) + the ALL_ROLES health/search reads
  // (harness:health/escalation, activity:recent, search:fulltext/semantic).
  //
  // HERALD RE-HOME (Sentinel-as-Herald): the sentinel is re-homed onto the
  // always-on, voice-first HERALD — it is the user-facing single voice into the
  // Hive (watch + narrate = ONE role). That adds a USER-FACING surface on top of
  // the read-mostly watcher: it CONVERSES (operator:converse — the brain loaded
  // with role='sentinel'), drives the VOICE channel (voice:* → operator:read /
  // operator:write), reads the live blackboard it heralds from (curation:read →
  // curation:feed / state-of-pot / change-feed; plans:read → plans:attention),
  // and ACTS on a user request the ONLY way it is allowed to — it FILES a
  // high-priority work_item (work_items:write → work_items:create /
  // set_priority) and NUDGES the Queen (coord:write → coord:send / escalate). It
  // still NEVER places/executes: the ROLE_ENVELOPES.sentinel deny (capability:
  // fs-write / capability:bash) holds, cup:spawn carves it out, and it gets NO
  // work_items:set_state / harness:write / plans:write / routines:write /
  // processes:kill. Suggest + file + nudge + hand-off to the Queen; never place.
  // TWO-GATE: each cap below is paired with `sentinel` in the matching tool's
  // agentRoles — operator:converse + voice:* explicitly add it; work_items:create/
  // set_priority + coord:send/escalate already admit it via COORD_ROLES;
  // plans:attention adds it to its SU_ROLES list; the curation:* reads are
  // un-allowlisted (capability-only) so curation:read alone resolves them.
  // pot-rename SLICE-2 CONTRACT: `papercup` is the canonical id (was `sentinel`).
  papercup: [
    'coord:read',
    'coord:write',
    'work_items:read',
    'work_items:write',
    'issues:read',
    'harness:read',
    'activity:read',
    'search:read',
    'curation:read',
    'plans:read',
    'operator:converse',
    'operator:read',
    'operator:write',
    'memory:read',
    'intel:read',
  ],
  // The OVERWATCH — the autonomous system-health SUPERVISOR (overwatch-role-2026-06-15
  // C-2 / B-01; a sibling to the Queen, the sense→decide→act actuator the watchdog lacks).
  // READ-EVERYTHING + NUDGE/OBSERVE/ESCALATE ONLY. Like the sentinel its only world-writes
  // are coord:write (coord:send nudge / coord:escalate / improvements:capture observation),
  // but its READ surface is broader — the whole running system: the work frontier
  // (work_items:read → work_items:list, fleet:assignments/tree), the Queen + watchdog +
  // gateway health (harness:read → pot:status, harness:health/escalation), the ledgers +
  // rate-governor + gym-experiment telemetry (intel:read → decision_ledger,
  // dev:rate_governor_status, change_ledger), the plan state (plans:read), recent app
  // notifications (notifications:read → notifications:recent), activity (activity:read),
  // and search (search:read) to ground its nudges. PLUS messages:write so it can forward a
  // directive to a specific agent — dispatched as execute-action `op:'send_directive'`, which
  // performs a coord send and returns a stable `msg_id`. (The old `messages:send` mail verb is
  // RETIRED — _retired/work-item-mail/ — so do not describe this grant in terms of it.)
  // ⚠ DO NOT "SWEEP" `messages:write` BELOW. It is a live CAPABILITY name, not a retired tool
  // verb: operator-suggestion-schema.ts pins `capability: z.literal('messages:write')` in
  // SuggestionSchema's `action:'send_directive'` arm, so removing the grant on line ~109 breaks
  // EVERY operator directive card. Capability names and tool verbs are both spelled
  // `namespace:verb` and are DIFFERENT surfaces — see agent-trap-guards-2026-07-26#D-003.
  // DELIBERATELY WITHOUT work_items:write /
  // harness:write / plans:write / routines:write / cup:spawn / processes:kill: it NUDGES
  // the Queen to re-place, it never re-places/edits/restarts (D-001/D-002). The capability
  // ENVELOPE (capability-envelope/policy.ts ROLE_ENVELOPES.overwatch) ALSO denies
  // capability:fs-write + capability:bash — it cannot edit code. TWO-GATE REALITY: these
  // caps are paired with adding `overwatch` to each tool's `agentRoles` (COORD_ROLES + the
  // explicit notifications/dev:rate_governor/plans/search/harness/activity allowlists).
  // pot-rename SLICE-2 CONTRACT: `kettle` is the canonical id (was `overwatch`).
  kettle: [
    'coord:read',
    'coord:write',
    'work_items:read',
    'harness:read',
    'intel:read',
    'plans:read',
    'notifications:read',
    'activity:read',
    'search:read',
    'messages:write',
    'memory:read',
  ],
  // The Pot's decider (autoloop-pot-operator-rebuild-2026-06-05 P-004,
  // D-001/D-003): the `pot` launch blueprint wakes the `operator` role to
  // survey the blackboard (work_items frontier, curation feed, activity
  // bridge, coord, plans) and create/manage harnesses from blueprints
  // (blueprint:catalog/validate → harness:read; blueprint:extend +
  // harness:create → harness:write; pot:declare-wake → routines:write).
  // Declared here AS WELL AS in the provisioned OPERATOR_CAPS (provision.ts)
  // because provision-without-force is a no-op for an existing row — the pot
  // must not depend on a re-provision to function. The two union cleanly.
  operator: [
    'harness:read',
    'harness:write',
    'work_items:read',
    'work_items:write',
    'curation:read',
    'activity:read',
    'coord:read',
    'coord:write',
    'plans:read',
    // owner-fix 2026-06-20: a `role=planner` session ("Create → New plan", launch-su.ts:150) resolves
    // to system:operator, yet `operator` had only plans:READ while the `bee` role carries plans:write
    // (D-005, psu plan-authoring parity) — so a planner could NOT write the very plan it exists to
    // author (write 100%-failed with "Principal system:operator lacks capability plans:write"). Grant
    // it here so loadRoleCapabilities unions it in at load time (no re-provision needed).
    'plans:write',
    'routines:write',
    // EI-2048 (owner-fix 2026-06-20): grant memory caps on the synthesized-
    // principal (loadRoleCapabilities) path too, so it stays in lockstep with
    // OPERATOR_CAPS (provision.ts). A planner/operator psu session must be able
    // to curate the memory store (memory:remember/forget/update/search); without
    // this it 100%-failed with `lacks capability "memory:write"` (mirrors the
    // earlier plans:write parity fix). The `bee` role already carries these.
    'memory:read',
    'memory:write',
    // EI-2048 follow-up (owner-fix 2026-06-20): operator lacked locks:* while the
    // lower-privileged `bee` role carries them (an inversion) — so db:next-migration,
    // db:check_drift, and explicit multi-file holds 100%-failed for an operator/psu
    // session with `lacks capability "locks:write"`. The operator should have ≥ the
    // bee's infra caps; grant the locks pair. (The capability-envelope protected
    // floor — secrets:* / processes:kill — still holds regardless.)
    'locks:read',
    'locks:write',
  ],
  // The QUEEN — the hive's placement-specialist decider (local-hive D-001:
  // "the operator specialized"), so her caps mirror the operator's. They cover
  // her whole placement loop: cup:spawn + work_items:set_priority/reorder
  // (work_items:write), fleet:drain + coord:send{wake} + events:emit
  // (coord:write), fleet:assignments (work_items:read), survey reads
  // (curation:read, activity:read), pot:declare-wake (routines:write).
  // EI-286 follow-up — third and final missing grant: the blueprint declared
  // the role, but neither AGENT_ROLES/COORD_ROLES (fixed earlier) nor this cap
  // map knew it, so a role=queen launch saw an EMPTY capability-gated catalog.
  // pot-rename SLICE-2 CONTRACT: `mug` is the canonical id (was `queen`).
  mug: [
    'harness:read',
    'harness:write',
    'work_items:read',
    'work_items:write',
    'curation:read',
    'activity:read',
    'coord:read',
    'coord:write',
    'plans:read',
    'routines:write',
    'memory:read',
    'memory:write',
    'intel:read',
    'plans:write',
    'capability:bash',
    'capability:fs-write',
    'capability:fs-read',
    'capability:git',
    'capability:net',
  ],
  // The generic Hive worker (local-hive-orchestration D-003 / P-011; expanded by
  // bee-capability-expansion-2026-06-08): a plain implementation agent the Queen
  // places ranked work + a brief onto. A BROAD but deliberately NON-operator cap
  // set — broader than a pipeline role (it owns its sequencing + can spin up a
  // structured subharness for harder work, D-017) yet WITHOUT the Queen-only
  // privileges. The goal is bee == psu *engineering* parity (D-005): the bee
  // inherits the worker engineering surface; the Queen-bee adds placement/steering.
  //   - work_items read/write  → maintain + publish its ordered work-list (P-020/P-021)
  //   - coord read/write       → declare-intent, send, coord:await-inbox at idle (P-041);
  //                              ALSO improvements:capture + issues:create/list/get
  //                              (those gate on coord:read/write + COORD_ROLES — bee is a
  //                              COORD_ROLE, so issue/idea read+create already resolve)
  //   - harness read/write     → blueprint:catalog/validate + harness:create a kind:'harness'
  //                              subharness for structured work (a bee may, a hive may not nest)
  //   - plans read/write       → ground its work against plans AND author/edit them
  //                              (D-005, owner-ratified: full plan-authoring parity with psu)
  //   - docs read/write        → ground against docs + write harness_docs/insights (D-001)
  //   - search read            → the fulltext + semantic index
  //   - memory read/write      → durable cross-turn learnings
  //   - tasks read/write       → its own task scaffolding
  //   - intel read             → the dev-diagnostics surface (dev:service_health/build_status/
  //                              processes/activity, flags:get, dogfood_substrate_status, …)
  //                              + the intel:artifacts / intel:spawn_tree reads (D-001)
  //   - locks read/write       → explicit multi-file holds, locks:queue/list, db:check_drift (D-001)
  //   - issues read            → the papercusp://harness/issues MCP resource (the issues:* TOOLS
  //                              already resolve via coord:read above) (D-001)
  // Deliberately NOT granted (D-002 — these stay Queen-only; the Queen is a kind:'hive'
  // bee that holds them): routines:write (self-wake scheduling = the Queen's placement
  // axis), curation:* / activity:report / operator:* / autoloop:* / processes:kill /
  // secrets:* / backup:* / plugins:write / discovery:write / hive:* / gym:* (brain-only
  // judgment + admin + placement surfaces). Least-privilege, workspace-agnostic; unions
  // with any provisioned row.
  //
  // ⚠ TWO-GATE REALITY (bee-capability-expansion-2026-06-08 audit): a capability here is
  // NECESSARY but NOT SUFFICIENT to call a tool. The dispatch stack (libs/generic/tooldef
  // dispatch-stack.ts) runs an independent `role-allowlist` gate FIRST: a tool that
  // declares `agentRoles` is callable only by a role in that list, regardless of caps. The
  // intel/locks/docs:write/plans:write tools each declared an agentRoles list that
  // historically EXCLUDED bee, so the caps above were INERT until the allowlist co-edit.
  // P-004 DID that co-edit: `bee` is now in the agentRoles of every tool gated by these caps
  // (the ~60 dev:*/flags:*/locks:*/db:*/harness_docs:*/plans:* tools), and the COORD_ROLES-gated
  // tools (coord:*, issues:*, improvements:capture) already admit bee. CARVE-OUT: three
  // COORD_ROLES tools that are PLACEMENT/optimization surfaces — cup:spawn, gym:judge,
  // gym:signals — filter bee BACK OUT of their allowlist (D-002, Queen-only; see those files).
  // The boundary is pinned empirically in bee-tool-boundary.test.ts.
  // pot-rename SLICE-2 CONTRACT: `cup` is the canonical id (was `bee`).
  cup: [
    'harness:read',
    'harness:write',
    'work_items:read',
    'work_items:write',
    'coord:read',
    'coord:write',
    'plans:read',
    'plans:write',
    'docs:read',
    'docs:write',
    'search:read',
    'memory:read',
    'memory:write',
    'tasks:read',
    'tasks:write',
    'intel:read',
    'locks:read',
    'locks:write',
    'issues:read',
    'capability:fs-write',
    'capability:bash',
    'capability:fs-read',
    'capability:git',
    'capability:net',
    'capability:code-inspect',
  ],
};

/**
 * Roles whose native Bash/Edit/Write/WebFetch surface the orchestrator can
 * replace with capability:* tools. The role allowlist and capability envelope
 * are separate gates; a signed principal also needs these exact grants or the
 * cutover advertises replacements that every call then denies.
 *
 * Keep this role set in lockstep with orchestrator FLEET_CAPABILITY_ROLES. The
 * cross-package regression in role-principal-caps.test.ts enforces the mirror
 * without importing the orchestrator's large graph into this transport module.
 */
export const CAPABILITY_REPLACEMENT_PRINCIPAL_ROLES: ReadonlySet<string> = new Set([
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'mug',
  'documenter',
  'curator',
  'cup',
]);

/** The capability-gate half of the native-tool replacement contract. */
export const CAPABILITY_REPLACEMENT_PRINCIPAL_CAPS: readonly string[] = [
  'capability:bash',
  'capability:fs-read',
  'capability:fs-write',
  'capability:git',
  'capability:net',
];

/**
 * Least-privilege capabilities for a role-scoped (non-superuser) MCP caller.
 *
 * Background: principal-gated built-in tools (the default `defineTool`) hard-
 * require `ctx.principal` + `ctx.tx`. The MCP handler used to synthesize those
 * only for `?superuser=1` calls, so a signed role-scoped agent (operator,
 * oracle, director, …) got neither and every such built-in 100%-failed with
 * `requires authenticated request (bearer + workspace tx)` (seen in
 * harness_shared.tool_invocations, 2026-05-31).
 *
 * The caller is already authenticated by its verified signed role URL, so we
 * synthesize a principal — but only with the capabilities its **provisioned
 * system principal** carries. `operator`/`oracle` have rows in
 * harness_shared.system_principals (their OPERATOR_CAPS / ORACLE_CAPS); pipeline
 * roles (worker/scoper/validator/…) often have no row. Roles participating in
 * the orchestrator's native-tool cutover receive only the five matching
 * capability:* replacement grants below; every other capability-gated built-in
 * stays denied unless provisioned or declared by its blueprint. The independent
 * role allowlist, capability envelope, and RLS remain binding.
 *
 * `tx` must already be workspace-scoped (the GUC that `withWorkspace` sets).
 */
export async function loadRoleCapabilities(
  tx: Sql,
  workspaceId: string,
  roleName: string,
): Promise<Set<string>> {
  const rows = await tx<Array<{ capabilities: unknown }>>`
    SELECT capabilities
      FROM harness_shared.system_principals
     WHERE workspace_id = ${workspaceId} AND name = ${roleName}
     LIMIT 1
  `;
  const raw = rows[0]?.capabilities;
  const caps = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  // Blueprint-declared roles (voter/advocate/scanner) carry no system_principals
  // row; union in their declared baseline so the capability gate passes for the
  // tools their blueprint role uses (e.g. coord:thread-post / improvements:capture →
  // coord:write).
  for (const c of BLUEPRINT_ROLE_CAPS[roleName] ?? []) caps.add(c);
  // B-18 cutover parity: these roles can have Bash/Edit/Write/WebFetch removed
  // from their native CLI surface. Give their signed MCP principal the exact
  // replacement capability grants so the cutover never strands them. This is
  // additive to provisioned/blueprint caps and still flows through the static
  // capability envelope (e.g. a judge-specific deny would continue to win).
  if (CAPABILITY_REPLACEMENT_PRINCIPAL_ROLES.has(roleName)) {
    for (const c of CAPABILITY_REPLACEMENT_PRINCIPAL_CAPS) caps.add(c);
  }
  // Universal tool-discovery. `agent_tools:list` is declared `agentRoles:[ALL_ROLES]`
  // + `requirePrincipal:false`, and EVERY pipeline-role persona
  // (worker/scoper/architect/validator/reviewer .tools.md) instructs calling
  // `agent_tools:list { asRole }` as the runtime fallback playbook. It is read-only
  // introspection — it lists tool metadata + a per-tool `allowed` flag; the
  // role-allowlist + each tool's own capability still gate actual CALLS — so granting
  // its `agent_tools:read` capability to every role-scoped caller is safe
  // least-privilege. Without it, the synthesize-principal change (this module)
  // regressed pipeline roles: pre-change they carried NO principal so the dispatch
  // cap-gate was skipped and `agent_tools:list` ran via the role-allowlist; now they
  // carry an empty-cap synthesized principal, so the cap-gate denied their own
  // documented discovery tool with `missing_capability`.
  caps.add('agent_tools:read');
  // live-configurability-audit-2026-06-20 P-008 — runtime role→capability grants, FLAG-GATED.
  // Default-OFF ⇒ the (cached) flag read returns false ⇒ no SQL + byte-identical resolution.
  // Fail-safe: a flag/read error never blocks cap resolution (grants are purely additive).
  try {
    if (await getFlag(FLAGS.CAPABILITY_GRANT_TOOL, workspaceId)) {
      const grantRows = await tx<Array<{ capabilities: unknown }>>`
        SELECT capabilities FROM harness_shared.role_capability_grants
         WHERE workspace_id = ${workspaceId} AND role = ${roleName} LIMIT 1
      `;
      const granted = grantRows[0]?.capabilities;
      if (Array.isArray(granted)) for (const c of granted) if (typeof c === 'string') caps.add(c);
    }
  } catch {
    /* additive grants only — never block capability resolution on a flag/read error */
  }
  return caps;
}

/**
 * Whether a tool call needs a synthesized principal + workspace tx. Any
 * concrete workspace does; `'*'` (superuser with no chosen workspace) and an
 * empty workspace do NOT — principal-gated built-ins then fail and the caller
 * must pass `?workspace=X` (or, superuser only, a per-call `workspace` arg —
 * see `effectiveDispatchWorkspace`).
 */
export function dispatchNeedsTx(spawnCtx: { workspaceId: string }): boolean {
  return Boolean(spawnCtx.workspaceId) && spawnCtx.workspaceId !== '*';
}

/**
 * Build the transport-auth principal used by contexts that do not need a
 * workspace transaction. Dispatch-time synthesis below enriches this with
 * role capabilities when a transaction is available; this lightweight form
 * keeps telemetry provenance present on the no-tx path too.
 */
export function synthesizeTransportPrincipal(spawnCtx: {
  workspaceId: string;
  role: string;
  isSuperuser?: boolean;
  authenticatedPrincipal?: Principal;
  /** Explicitly false only for an accepted unsigned legacy spawn URL. */
  sigVerifiedSpawn?: boolean;
}): Principal | null {
  if (spawnCtx.authenticatedPrincipal) return spawnCtx.authenticatedPrincipal;
  if (!spawnCtx.workspaceId || spawnCtx.workspaceId === '*') return null;
  const isSuperuser = spawnCtx.isSuperuser === true;
  const unsignedLegacy = !isSuperuser && spawnCtx.sigVerifiedSpawn === false;
  return {
    kind: isSuperuser ? 'system' : unsignedLegacy ? 'loopback' : 'harness',
    slug: isSuperuser ? 'system:operator' : `system:${spawnCtx.role}`,
    workspaceId: spawnCtx.workspaceId,
    authMethod: isSuperuser ? 'bearer-token' : unsignedLegacy ? 'host-loopback' : 'spawn-url',
    trust: isSuperuser || !unsignedLegacy ? 'trusted' : 'unverified-loopback',
    capabilities: new Set<string>(),
  };
}

/**
 * Build the principal used by MCP resources/list and resources/read after the
 * transport has already authenticated a spawn context. Unlike projected tool
 * dispatch, resource authorization needs the caller's capability set and the
 * stable result-door owner id. A superuser's bearer is intentionally absent
 * from agent-mcp's token_index, so passing that raw bearer to resolveBearer()
 * would reject every scratch reference as invalid_bearer.
 */
export function synthesizeResourcePrincipal(spawnCtx: {
  workspaceId: string;
  isSuperuser?: boolean;
  uiClientId?: string | null;
  authenticatedPrincipal?: Principal;
}): Principal | null {
  if (spawnCtx.authenticatedPrincipal) return spawnCtx.authenticatedPrincipal;
  if (spawnCtx.isSuperuser !== true || !spawnCtx.workspaceId) return null;
  const ownerId = spawnCtx.uiClientId?.trim() || SUPERUSER_FALLBACK_CLIENT_ID;
  return {
    kind: 'system',
    slug: ownerId,
    workspaceId: spawnCtx.workspaceId,
    authMethod: 'bearer-token',
    trust: 'trusted',
    capabilities: new Set(['*']),
  };
}

/**
 * The workspace a tool call should dispatch under — EI-30.
 *
 * An UNSCOPED superuser session (`?superuser=1`, workspaceId `'*'`) gets no
 * synthesized workspace tx, so every principal-gated built-in (harness:list,
 * …) hard-fails even though the SU playbooks document `workspace` as a
 * per-call arg ("hop without re-auth"). Honor that promise at the dispatch
 * layer: when the caller is superuser, the session is unscoped, and the args
 * carry a concrete `workspace` string, dispatch under THAT workspace (tx
 * synthesis + ALS pin), exactly as `?workspace=X` would have.
 *
 * Superuser is admin across every workspace, so this is a convenience, not a
 * privilege change. It deliberately does NOT apply to power-user callers
 * (their `workspace` arg is clamped to the token's workspace upstream) or to
 * role-scoped callers (they always carry a concrete workspace).
 */
export function effectiveDispatchWorkspace(
  spawnCtx: { workspaceId: string; isSuperuser?: boolean },
  args: unknown,
): string {
  if (spawnCtx.isSuperuser !== true || spawnCtx.workspaceId !== '*') return spawnCtx.workspaceId;
  const ws =
    args && typeof args === 'object' && typeof (args as Record<string, unknown>).workspace === 'string'
      ? ((args as Record<string, unknown>).workspace as string)
      : '';
  return ws.length > 0 ? ws : spawnCtx.workspaceId;
}

/**
 * The principal to dispatch a concrete-workspace call under. Superuser keeps the
 * `gateBypass.capability` it already carries (its empty cap-set is fine); a
 * signed role-scoped caller is NOT bypassed, so it gets exactly its provisioned
 * capabilities (least-privilege) and the capability gate enforces normally.
 * `tx` must already be workspace-scoped.
 */
export async function synthesizeDispatchPrincipal(
  tx: Sql,
  spawnCtx: {
    workspaceId: string;
    role: string;
    isSuperuser?: boolean;
    authenticatedPrincipal?: Principal;
    /** Explicitly false only for an accepted unsigned legacy spawn URL. */
    sigVerifiedSpawn?: boolean;
  },
): Promise<Principal> {
  if (spawnCtx.authenticatedPrincipal) return spawnCtx.authenticatedPrincipal;
  const capabilities = spawnCtx.isSuperuser
    ? new Set<string>()
    : await loadRoleCapabilities(tx, spawnCtx.workspaceId, spawnCtx.role);
  // Keep the legacy capability/role behavior above, but carry the transport's
  // resolved provenance into telemetry. `sigVerifiedSpawn` is supplied by the
  // MCP adapter for URL calls; omitted by older nested-dispatch callers, which
  // are already inside an authenticated dispatch and therefore retain the
  // trusted spawn identity. Only an explicit false is the unsigned fallback.
  const provenance: Pick<Principal, 'kind' | 'authMethod' | 'trust'> = spawnCtx.isSuperuser
    ? { kind: 'system', authMethod: 'bearer-token', trust: 'trusted' }
    : spawnCtx.sigVerifiedSpawn === false
      ? { kind: 'loopback', authMethod: 'host-loopback', trust: 'unverified-loopback' }
      : { kind: 'harness', authMethod: 'spawn-url', trust: 'trusted' };
  return {
    ...provenance,
    slug: spawnCtx.isSuperuser ? 'system:operator' : `system:${spawnCtx.role}`,
    workspaceId: spawnCtx.workspaceId,
    capabilities,
  };
}
