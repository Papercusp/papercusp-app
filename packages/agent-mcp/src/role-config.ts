/**
 * Papercusp's role configuration — the host half of plan P-010 / D-005.
 *
 * `@papercusp/tooldef` is role-agnostic: its `AgentRole` type is `string`
 * until a host registers its known roles by augmenting the framework's
 * `RoleRegistry` interface. This file is where the Papercusp host does that.
 * After this module is part of the program, `AgentRole` resolves to the
 * suggestion-union below program-wide (still `string`-assignable, so
 * plugin-contributed `<plugin>:<role>` ids stay valid).
 *
 * `AGENT_ROLES` is the single runtime source of truth for the built-in role
 * ids; the type-level augmentation is *derived* from it (no hand-kept second
 * list to drift). The ordering is: the seven pipeline roles, the two chat
 * roles (operator/oracle), then the cross-cutting roles that show up
 * in tool `roles:` allowlists.
 */

/**
 * The built-in Papercusp agent roles, as they appear in tool `roles:`
 * allowlists, `rolesQuota` keys, and `byRole` guidance overrides. The set is
 * open — plugins contribute additional roles at runtime (namespaced
 * `<plugin>:<role>`), which stay typed as bare `string`.
 */
export const AGENT_ROLES = [
  // Pipeline roles (scoper → curator).
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'documenter',
  'curator',
  // Chat-surface roles.
  'operator',
  'oracle',
  // The generic operator-world worker — the Pot's cup (local-hive-orchestration
  // D-003 / P-011; pot-rename SLICE-2 CONTRACT: canonical id, was `bee`). The plain
  // "do this task" role the Mug places ranked work + a brief onto. DECOUPLED from
  // the pipeline guards: unlike `worker` (which operator-spawn rejects without a
  // `chunkId`), a `cup` carries NO pipeline spine and NO chunk requirement.
  // Pipeline roles (scoper/worker/validator/…) apply ONLY when a cup explicitly
  // spins up a coding harness (kind:'harness'); the cup itself is the generic
  // agent of the pot blueprint.
  'cup',
  // The MUG — the pot blueprint's placement-specialist decider (was `queen`;
  // spine.deciderAlternatives; local-hive-orchestration P-030). The operator role
  // specialized for placement (D-001): same judgment layer, dial turned toward
  // cup:spawn/drain + work-list shaping. Registered late (EI-286 follow-up): the
  // blueprint declared the role but the registry never knew it, so a role=mug
  // launch got an almost-empty role-scoped MCP catalog and could not place work.
  'mug',
  // The PLANNER (hive-agent-tabs-psu-tui-2026-06-09 P-006): an interactive,
  // RESPONSIVE plan-authoring session launched into the dock as a Planner-kind pane
  // (no auto-injected wakes — the owner drives). It drafts/refines ONE plan via the
  // plans:* tools; like a bee it appears in the roster + is paned by the dock driver,
  // but its job is the plan, not code execution. classifyAgentPane maps it → Planner.
  'planner',
  // Coordinator + cross-cutting roles (built-in, fire on plan events).
  'orchestrator',
  // Promotes a plan's `## Promote` policy into the harness, all waves up front
  // (launched by a human/agent). promote-policy-and-waves-2026-05-30; the
  // wave-advance sweep that used to drive it per-wave is retired (P-044).
  'promote',
  'security-reviewer',
  'infra-reviewer',
  // 'summarizer' + 'project_manager' — CUT (dbos-system-completion P-015).
  // summarizer: dead role, never dispatched, no subsystem. project_manager:
  // powered the projects→spec-revision PM-dispatch feature (regenerate-spec
  // route + passed→pm_due reactive path); the whole feature was retired by
  // product decision D-020, so the role + pm-dispatch.ts + its prompt are gone.
  'crosscheck',
  'ui-qa',
  // G2 user-protection gate (papercusp-user-protection-gate-2026-05-31 P-006):
  // read-only adversarial judgment role; screens remote-authored features before
  // they reach the orchestrator pick loop. No execution capability.
  'auditor',
  // git-sync merge-conflict resolver (git-sync-auto-commit P-011). Spawned by the
  // `system:git-sync` action when an auto-merge with origin/main conflicts: it
  // redoes the merge fresh on `main`, resolves, commits, leaves the tree clean, and
  // does NOT push (the next git-sync tick pushes). Not feature-scoped.
  'merge-resolver',
  // git-sync CONTENT-guard repairer (git-sync-content-guard-2026-06-13 D-008 follow-up;
  // the merge-resolver's content-side twin). Spawned by the `system:git-sync` content
  // guard (EI-438) when a dirty file fails a content detector and is quarantined out of
  // the auto-commit — an .mdx that won't MDX-compile, a curly quote used as code. Fixes
  // ONLY the named files' syntax so they pass the detector, leaves the tree clean, does
  // NOT push. Registered late (mirrors the merge-resolver/release-fixer launch-fixer
  // family): the `content-fix` blueprint declared the role, but the registry never knew
  // it, so it lived as an untyped bare string in tool allowlists.
  'content-fixer',
  // Release manager (release-gate-ready-branch-2026-06-04 D-011). The judgment
  // half of the deploy chokepoint — Claude Opus 4.8 @ xhigh effort, because the
  // blast radius is the whole running fleet. Spawned by the `system:release-trigger`
  // action (or launched interactively); reviews the gathered deploy plan + staged
  // migrations, makes the go/no-go call, runs the scripted deploy mechanics, then
  // reads health and decides rollback. The script is the hands; this is the brain.
  'release-manager',
  // green-checkpoint GATE fixer (release-pipeline-resilience-2026-06-09 P-006; the
  // release-manager's execution-side twin, and the launch-fixer family's third member
  // alongside merge-resolver/content-fixer). Spawned by the `system:release-trigger` /
  // green-checkpoint routine when the gate goes RED: reads the checkpoint log, reproduces
  // the failing test to classify regression-vs-flake, then fixes the code or removes a
  // proven flake (hermetic / tier-out / accountable quarantine), leaves the tree clean,
  // does NOT push. Registered late (mirrors merge-resolver): the `release-fix` blueprint
  // declared the role, but the registry never knew it.
  'release-fixer',
  // The DOC-STEWARD — the automated documentation-freshness fixer (docs-corpus-audit
  // WS2 / P-008; the `doc-steward` launch blueprint). Fired by the post-git-sync
  // freshness sweep when a doc's anchored code drifts: it re-syncs the prose to the
  // current code and `harness_docs:verify`s it. Registered late, same class as the
  // launch-fixer family above (queen/sentinel/content-fixer/release-fixer): the role
  // existed ONLY in the blueprint, so every role-gated allowlist filtered it out — a
  // doc-steward spawn got a near-empty MCP catalog with NONE of harness_docs:* /
  // work_items:* / coord:* and no ToolSearch to load them, forcing a blind fallback to
  // scripts/mcp-call.mjs (EI-6643). The fix wires it into COORD_ROLES (work_items:get,
  // coord:escalate) + the harness_docs:* allowlists (verify clears the drift flag). It is
  // deliberately NOT in SU_ROLES — that would pull it into the fleet capability-cutover
  // (SU_ROLES ∪ {bee}) and STRIP the native file-read/edit/git it uses to fix docs; its
  // persona reads the file / harness_docs:list, not the SU-gated docs:get. Persona ships
  // at blueprints/base/prompts/doc-steward.md.
  'doc-steward',
  // The PAPERCUP — the fast, always-on front-end of the ONE user-facing
  // "Papercup" identity (voice-public-release-readiness-2026-07-12 D-001/D-005).
  // Plans call this half `papercup-fast`; the registered role id stays `papercup`.
  // It watches the fleet and narrates it while staying responsive; longer
  // investigations are delegated to the separate internal `papercup-deep` role.
  // Do not describe this role as the retired fleet-watcher-only/sentinel role:
  // the fast/deep split is invisible to the user, who sees one Papercup.
  'papercup',
  // The PAPERCUP-DEEP — the separate internal, hidden deep-brain half of the
  // ONE user-facing "Papercup" identity (voice-public-release-readiness-2026-07-12
  // D-001/D-005/D-006, owner-ratified). It is persistent and parked between
  // questions, and the fast front-end delegates sustained investigation to it over
  // the modern coord/wake channel (not the retired voice:delegate_deep lane — D-003).
  // It is never user-facing; its findings return through the fast front-end so the
  // user still sees one Papercup.
  'papercup-deep',
  // The KETTLE — the autonomous system-health SUPERVISOR, a sibling to the Mug
  // (was `overwatch`; overwatch-role-2026-06-15 C-2 / B-01). Where the Mug SCHEDULES
  // (places work) and the papercup WATCHES the fleet, the kettle runs the short-term
  // sense→decide→act control loop over the WHOLE running system (the Mug, the cups,
  // the work-feed, tokens, plans, escalations): it detects drift and makes LIVE
  // course-corrections by NUDGING the running agents (coord:send) + recording
  // OBSERVATIONS (improvements:capture lane:observation), never re-placing work itself
  // (D-001 — the hard Mug-boundary). READ-EVERYTHING + nudge/observe/escalate ONLY:
  // its write-to-the-world verbs are coord:send / coord:escalate / improvements:capture
  // / messages:send, and its ROLE_ENVELOPES entry DENIES capability:fs-write +
  // capability:bash — it nudges, it never edits code. Registered statically + UNGATED
  // here (the `papercusp-overwatch` flag gates the LOOP/spawn/UI in B-04/B-08/B-10, not
  // this type-level role id). Canonical persona ships at the coding (pot) blueprint
  // (blueprints/coding/prompts/overwatch.md, B-05); the fallback prompts/overwatch.md is a
  // thin STUB so the two cannot drift (D-007 / the EI-611 lesson).
  'kettle',
  // ── Blueprint-shipped specialist roles (blueprint-role-bundling-2026-06-15 Phase 0 /
  // EI-621). These ship a persona under the harness `prompts/` dir (moving to the owning
  // blueprint in Phase 2) and are dispatched by their blueprint's spine — but predated this
  // const, so the registry only "knew" them via the now-retired getKnownRoles filesystem
  // walk. Listed here so AGENT_ROLES is the COMPLETE built-in role universe and the
  // filesystem is no longer the registry (D-008). NOT including the program-blueprint-scoped
  // roles (advocate/voter — resolved only via blueprints/vote) nor the retired org-model
  // roles (ceo/coordinator); those stay valid as bare `string`s.
  //
  // research blueprint — investigation pipeline.
  'researcher',
  'research-director',
  'searcher',
  'discoverer',
  'finding-verifier',
  'findings-synthesizer',
  'synthesizer',
  // review blueprint — multi-dimension adversarial review.
  'review-director',
  'dimension-reviewer',
  'verifier',
  // migration blueprint — codemod pipeline.
  'migration-director',
  'migration-verifier',
  'transformer',
  // gym / learning-loop blueprints — eval + variant generation.
  'gym-director',
  'judge',
  'task-generator',
  'variant-runner',
  'proposer',
  // scan blueprint — the negative-space/scout scanner (also a blueprint override in scan/).
  'scanner',
  // The generic director + committer (single-agent / coding sub-roles).
  'director',
  'committer',
  // Multi-phase coding pipeline (staging/testing/production) roles still DISPATCHED live by
  // classifyDecision (orchestrator-decide): GENERATE_TESTS→test-writer, NEXT_TESTER→tester,
  // NEXT_MONITOR→monitor. Their personas currently live ONLY in the phase subdirs
  // (prompts/{testing,staging,production}/<role>.md); their blueprint-resolvable home is
  // decided in Phase 2/5 (they must move before the global prompts/ dir is deleted).
  'tester',
  'test-writer',
  'monitor',
  // ── pot-rename SLICE-2 CONTRACT: the old ids (bee/queen/sentinel/overwatch) are
  //    REMOVED — cup/mug/papercup/kettle above are the canonical entries, and the
  //    orchestrator ROLE_ALIASES bridge is gone (persona files resolve natively).
  //    `blender` is the negative-space scanner successor (was `scout` — never in
  //    this array; its coord identity + loop_id prefixes flipped with SLICE-2).
  'blender',
  // The FOREIGN-SESSION role — the p2p D-007 SPAWN leg's execution identity for
  // work claimed from a PEER host (WI-1937, agent-capability-confinement-2026-06-13
  // follow-on). A remote host's offered work is executed locally under THIS role, not
  // under the requesting fleet's own role ids, so the P-105 foreign-work sandbox +
  // the capability envelope (`ROLE_ENVELOPES['foreign-session']`, landed alongside the
  // launchSession wiring — SHIPS AS DEFAULT-DENY-ALL, D-007/owner-ratified 2026-07-09)
  // have exactly ONE identity to gate, regardless of what role name the foreign
  // offer claims for itself. Deliberately a GENUINE core member here rather than a
  // plugin-namespaced `<plugin>:foreign-session` id: FLEET_ENVELOPE_ROLES
  // (capability-envelope/policy.ts) is built from AGENT_ROLES minus operator/oracle,
  // and a plugin-namespaced role is NOT in that set — it would run EXEMPT from the
  // capability envelope entirely, which is exactly backwards for code we did not
  // author. Read role-config.ts's FROZEN_OVERLAY_ROLES doc-comment before touching
  // this array again: AGENT_ROLES membership is sometimes the ONLY thing standing
  // between a role and code that assumes "unknown role ⇒ no special access" — the
  // opposite direction to this role's own risk (adding it must NOT accidentally
  // hand it some OTHER allowlist's default-open behavior). Audited at add-time
  // (2026-07-09): OPERATOR_CONFIG_WRITE_ROLES / SU_ROLES / SU_WRITE_ROLES /
  // TESTING_FULL_ACCESS_ROLES do not enumerate "all roles" — each is an explicit,
  // short allowlist this id is not in, so it inherits none of their grants by
  // merely existing here.
  'foreign-session',
] as const;

/** Union of the built-in role ids. Plugin roles widen `AgentRole` to `string`. */
export type BuiltinAgentRole = (typeof AGENT_ROLES)[number];

/**
 * Roles that exist in AGENT_ROLES but must NEVER be applied as a gym variant
 * prompt-overlay or throwaway-harness override target. The external `judge` is
 * FROZEN (gym D-003): the gym overlays + optimizes a harness's PIPELINE roles and
 * the judge then EVALUATES the resulting variants — overlaying the judge itself
 * would let a variant rewrite (and so game) its own evaluator.
 *
 * This protection used to be IMPLICIT — `judge` was absent from AGENT_ROLES, so the
 * overlay validators rejected it as an "unknown role". That hole re-opened silently
 * when blueprint-role-bundling (EI-621 / D-008) made AGENT_ROLES the COMPLETE
 * built-in role universe (judge is a gym/learning-loop blueprint role). It is now
 * EXPLICIT and pinned here next to the role declaration so adding a role to
 * AGENT_ROLES can't re-open it. `satisfies` pins each member to AGENT_ROLES, so
 * renaming `judge` breaks compilation here instead of silently orphaning the freeze.
 */
export const FROZEN_OVERLAY_ROLES = ['judge'] as const satisfies readonly BuiltinAgentRole[];

/**
 * The standard SU-tool `agentRoles:` allowlist — the eight pipeline roles +
 * the operator chat role. THE single source for this set (audit P-072,
 * EI-145/EI-66 — it used to exist as ~113 identical inline copies named
 * SU_ROLES/ALL_ROLES across agent-tools). Variants compose at the use site:
 * `[...SU_ROLES, 'bee']`, `[...SU_ROLES, 'sentinel']`, etc.
 *
 * `satisfies` pins every member to AGENT_ROLES, so renaming a role there
 * breaks compilation here instead of silently orphaning an allowlist.
 */
export const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  // The mug is the operator specialized (local-hive D-001) — operator-equivalent
  // grants so her placement loop (events:emit, pot wake declarations) resolves.
  'mug',
  'documenter',
  'curator',
] as const satisfies readonly BuiltinAgentRole[];

/**
 * The write-side subset of SU_ROLES: validator + reviewer are judgment
 * roles — they read artifacts/state but never author it (the artifacts
 * tools' allowlist; audit P-072 "shared READ/WRITE role consts").
 */
export const SU_WRITE_ROLES = [
  'scoper',
  'architect',
  'worker',
  'debugger',
  'operator',
  'mug',
  'documenter',
  'curator',
] as const satisfies readonly BuiltinAgentRole[];

/**
 * The OPERATOR-CONFIG write-authority roles — the in-handler gate for tools that
 * MUTATE fleet-wide operator config (the rate-limit knobs, operator preferences,
 * config overrides, the db-migrate policy, watchdog tunables, scheduled routines).
 * Those tools advertise the broad `[...SU_ROLES]` INVOKE allowlist (read/list is
 * open to every pipeline role) but NARROW the mutating op to operator-level
 * authority — historically a hand-rolled `ctx.role !== 'operator' && ctx.role !==
 * 'architect'` re-spread across ~6 tools.
 *
 * `queen` belongs here: she is the operator SPECIALIZED for placement (local-hive
 * D-001 — "operator-equivalent grants"). She was silently omitted from those
 * re-spread literals when added to SU_ROLES, which is exactly EI-2204 — the Queen
 * could INVOKE `operator:rate_limit_config` but its `set` rejected her role,
 * blocking the clean path to reset a jammed concurrency ceiling (EI-2186).
 * Centralizing the set here keeps the operator≡queen equivalence from drifting
 * back out of sync across those tools (and the `isOperatorConfigWriteRole` guard
 * fails CI if the literal is re-introduced).
 */
export const OPERATOR_CONFIG_WRITE_ROLES = [
  'operator',
  'architect',
  'mug',
] as const satisfies readonly BuiltinAgentRole[];

/**
 * Does `role` carry operator-config write authority (one of
 * OPERATOR_CONFIG_WRITE_ROLES)? The single predicate the operator-config-write
 * tools gate their mutating op on. Plugin-namespaced (`<plugin>:<role>`) and
 * unknown roles are not operator-equivalent → false (fail-closed).
 */
export function isOperatorConfigWriteRole(role: string | undefined | null): boolean {
  return role != null && (OPERATOR_CONFIG_WRITE_ROLES as readonly string[]).includes(role);
}

/**
 * The PRINCIPAL role that marks "the brain" — the operator/orchestration intelligence
 * that decides whether a new agent spawn is worth it (unify-agent-spawn-chokepoint
 * P-006 / D-008). This is an RBAC role on `Principal.roles` (the fail-closed
 * `requireRoles` dispatch axis), NOT an agent `ctx.role`: it is assigned by the HOST
 * to the operator's OWN principal (the bearer-resolved `system:operator` + the
 * loopback palette caller), and is never carried by a spawned agent's caller-asserted
 * `?role=`. A tool gated `requireRoles: [BRAIN_PRINCIPAL_ROLE]` is therefore
 * approvable ONLY by the brain (or a superuser, which bypasses RBAC) — making "only
 * the brain decides spawns" enforced at the dispatch layer, not prompt convention.
 */
export const BRAIN_PRINCIPAL_ROLE = 'brain';

/**
 * Register the built-in roles with the framework. Declaration merging adds
 * these keys to `@papercusp/tooldef`'s `RoleRegistry`, which the framework
 * reads (`keyof RoleRegistry`) to shape `AgentRole`. Derived from
 * `AGENT_ROLES` so the two never drift.
 */
declare module '@papercusp/tooldef' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RoleRegistry extends Record<BuiltinAgentRole, true> {}
}
