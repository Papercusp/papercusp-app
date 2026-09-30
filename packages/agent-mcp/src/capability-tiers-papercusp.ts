/**
 * Papercusp's capability → tier table — the host half of plan P-012 / D-006.
 *
 * Tiers per spec/capabilities §10.6.1. This table used to live baked inside
 * the engine (`@papercusp/tooldef`'s `capability-tiers.ts`); P-012 moved it out
 * so the engine ships only a pluggable resolver (defaulting everything to
 * `'low'`). Importing this module registers `papercuspTierFor` as the active
 * resolver, so `defineTool`/`defineResource`/`definePrompt` stamp each tool's
 * `tier` from this table. The registration is a load-time side effect; it is
 * imported at the top of `index.ts` (before `bootstrap`) so it runs before any
 * tool self-registers.
 *
 * Unenumerated capabilities default to `'medium'` (NOT the engine's `'low'`) —
 * adding a capability without a deliberate tier choice should raise an eyebrow
 * at install time, not silently land at low.
 */

import { setCapabilityTierResolver } from '@papercusp/tooldef';
import type { CapabilityTier } from '@papercusp/tooldef';

/**
 * Exact-match table. Wildcards (`secrets:read:*`) are matched by prefix
 * after this lookup misses.
 */
const EXACT: Record<string, CapabilityTier> = {
  // Low — internal reads, UI mounts, plugin-private storage
  'tasks:read': 'low',
  'features:read': 'low',
  'goals:read': 'low',
  'projects:read': 'low',
  'comments:read': 'low',
  'issues:read': 'low',
  'work_items:read': 'low',
  'harness:read': 'low',
  'docs:read': 'low',
  'messages:read': 'low',
  'activity:read': 'low', // activity:recent — a read; was unlisted → defaulted to 'medium' (mis-tiered as a write), inflating watchdog timeouts (EI-99)
  'activity:report': 'low', // the activity-bridge sink — cheap fire-and-forget telemetry (one bounded INSERT), not a governed mutation; 'low' (cf. storage:plugin-private) de-noises the decision-ledger + lets the dispatch ok-on-abort read-path absorb load-induced slow completions (EI-111)
  // SU plan-tracking (agent-plan-tracking-2026-05-20.md)
  'plans:read': 'low',
  'plans:write': 'medium',
  // code:run recipe reads (code-recipes-2026-06-21): list/get/search/candidates were
  // mis-tagged 'intel:read' (a copy-paste reuse of the actual intel-panel-reads
  // capability, which is legitimately 'high' because it surfaces every agent's
  // prompt+activity — see 'intel:read' below). A recipe read is a cheap, non-sensitive
  // lookup over harness_shared.code_recipes with no such exposure, but inheriting
  // 'high' tier (a) denied it the dispatch ok-on-abort read-completion exemption (the
  // EI-99/EI-111 class: a load-induced slow-but-COMPLETED read gets reported as a false
  // watchdog 'timeout' instead of returning its result — this is what produced the
  // EI-9359 recipes:search false-timeout flood) and (b) mislabeled it `destructive:true`
  // in the capability palette (toolDefinitionToCapability: tier==='high' ⇒ destructive).
  // Split into its own low-tier capability, same fix shape as EI-99/EI-111.
  'recipes:read': 'low',
  // SU file-lock coordination (su-agent-coordination-v3-2026-05-14.md)
  'locks:read': 'low',
  'locks:write': 'medium',
  'coord:read': 'low',
  'coord:write': 'medium',
  'pending_events:read': 'low',
  'routines:read': 'low',
  // Named-fleet registry (named-su-agent-fleets-2026-06-29 P-004). Reads are 'low'
  // (registry list / one fleet's roster); the membership MUTATIONS — create a fleet,
  // join/leave it, take leadership (the D-002 handoff) — write coord_presence labels +
  // the agent_fleets leader, so 'medium' (the same tier as coord:write / plans:write).
  'fleet:list': 'low',
  'fleet:status': 'low',
  'fleet:create': 'medium',
  'fleet:join': 'medium',
  'fleet:leave': 'medium',
  'fleet:take-leadership': 'medium',
  // Rebind a fleet's color scheme — persists agent_fleets.color_scheme + live-recolors
  // every active session in the fleet (a write on both, so 'medium' like the others).
  'fleet:recolor': 'medium',
  // Per-member declarative launch specs (per-member-declarative-launch-specs P-007/P-008):
  // a leader reconfigures ONE member's runtime settings (compaction limit / claim spec /
  // brief) or RESPAWNS it with new boot-baked settings — writes to another session, 'medium'
  // like the other fleet mutations.
  'fleet:reconfigure-member': 'medium',
  'fleet:respawn-member': 'medium',
  'storage:plugin-private': 'low',
  // Storage settings page (storage-settings-page-2026-06-15). Read is a usage
  // introspection; write is a destructive prune-by-age (+ VACUUM FULL) → high.
  'storage:read': 'low',
  'storage:write': 'high',
  'db:plugin-schema': 'low',
  'ui:dashboard-tab': 'low',
  'ui:sidebar-item': 'low',
  'ui:harness-route': 'low',
  // Medium — writes, hooks, role registrations, cross-harness messaging
  'tasks:write': 'medium',
  'features:write': 'medium',
  'goals:write': 'medium',
  'projects:write': 'medium',
  'comments:write': 'medium',
  'issues:write': 'medium',
  'work_items:write': 'medium',
  'docs:write': 'medium',
  'messages:write': 'medium',
  'routines:write': 'medium',
  'proposals:write': 'medium',
  // turn:interrupt (turn-lifecycle-control D-008): end a peer's CURRENT turn.
  // Operator-mediated + universal (any agent → any peer), so it sits at the
  // coord-write tier — reachable by all COORD_ROLES, no bearer. The forceful
  // half is governed by the tool's own reason/audit/storm-limit/critical-section
  // guardrails (D-009), NOT by tier gating.
  'turn:interrupt': 'medium',
  'search:read': 'medium',
  // High — secrets, outbound network, cross-plugin reads, audit, dispatch wildcards
  'audit:read': 'high',
  // Intel panel reads from harness_shared.tool_invocations(_spawn_tree|_artifacts).
  // High-tier because it surfaces every agent's prompt + workspace activity.
  'intel:read': 'high',
  'workspaces:read': 'low',
  'harness:dispatch': 'high',
  // /dev page process kill — Tier 1 sensitive. Requires bearer; agents
  // (URL spawn ctx, no bearer) cannot call. Dashboard hits it via the
  // operator's superuser-token. Defense-in-depth: handler enforces a
  // kind allowlist + writes audit_log on every call.
  'processes:kill': 'high',
  // task-manager-no-escape-2026-07-27 P-014: the NON-destructive task-manager
  // verbs (processes:freeze / processes:limit). High-tier like its kill sibling
  // because pausing or capping a peer's in-flight work is disruptive — but a
  // DISTINCT capability, deliberately kept OUT of PROTECTED_CAPABILITY_GLOBS:
  // both are reversible, and protecting them would block exactly the
  // memory-pressure relief they exist for (freeze the fattest runs instead of
  // killing them). Splitting reversible control from irreversible kill is the
  // whole point of not reusing 'processes:kill' here.
  'processes:control': 'high',
  // Fleet capability surface (agent-capability-confinement-2026-06-13, B-05):
  // the gated defineTool re-exposure of native capabilities. High for anything
  // that executes code, mutates the tree, or reaches the network; low for the
  // read-only file read. The capability-envelope (B-06) keys on these strings.
  'capability:bash': 'high',
  // capability:computer (computer-tool-plan) — bee-operated SANDBOX desktop
  // (screenshot/click/type via xdotool against a leased Xvfb display, never the
  // host :0). High: it drives a GUI that can run arbitrary apps. Display is
  // resolved server-side from the lease env; the tool hard-refuses :0.
  'capability:computer': 'high',
  // capability:terminal — opens a VISIBLE terminal on the user's HOST desktop
  // and runs an arbitrary command in it (the visible-terminal sibling of
  // capability:bash). High: it executes arbitrary code. Unlike capability:bash
  // it runs in the user's REAL desktop session OUTSIDE the bwrap exec-sandbox
  // (the visible terminal IS the point) — same tier/role gating, but NOT the
  // fs/credential/egress containment. A deliberate trade recorded on the plan.
  'capability:terminal': 'high',
  'capability:fs-read': 'low',
  // capability:inspect (EI-524 / P-035) — read-only verification (typecheck/test)
  // via FIXED commands, no free-form exec. Low: it's the read-only sibling of
  // capability:bash that the bee envelope opens for verify-before-diagnose.
  'capability:code-inspect': 'low',
  'capability:fs-write': 'high',
  'capability:git': 'high',
  'capability:net': 'high',
};

const PREFIX_HIGH = ['secrets:', 'http:fetch:', 'data:read:'];
const PREFIX_MEDIUM = ['events:', 'roles:register:'];

/**
 * Host-installed SYNC override seam (live-configurability-audit P-010, the `capability_tier:set` dial).
 * Returns a CapabilityTier to OVERRIDE the baked classification for a capability, or null/undefined to
 * fall through to the EXACT table + prefixes below. operator-core installs the real resolver (flag-
 * gated, reading its sync-cached operator_capability_tiers store) at boot; until then the baked table
 * governs (byte-identical). Consulted FIRST so a deliberate runtime re-tier (e.g. the EI-99/EI-111
 * mis-tiering class, which were LOWERINGS) takes effect without a deploy — for every consumer that
 * calls papercuspTierFor/tierFor at RUNTIME (the capability catalog/palette projection + the
 * decision-ledger posture). NOTE: consumers that read a tool's LOAD-TIME-STAMPED `tier` (the
 * endpoint-auth-tiers exposure gate, the watchdog per-tool timeout) re-stamp on the next operator boot,
 * so a tier change for THOSE applies after a restart — documented on the dial, an owner-decision to
 * widen to live consumer-side re-resolution (plan D-010 cluster).
 */
export type CapabilityTierOverride = (capability: string) => CapabilityTier | null | undefined;
let capabilityTierOverride: CapabilityTierOverride | undefined;

/** Install (or clear, with `undefined`) the host override resolver. Called once by operator-core at boot. */
export function setCapabilityTierOverride(fn: CapabilityTierOverride | undefined): void {
  capabilityTierOverride = fn;
}

/**
 * Papercusp's capability→tier policy. Returns `'medium'` when no deliberate
 * classification is found — see file header.
 */
export function papercuspTierFor(capability: string): CapabilityTier {
  const override = capabilityTierOverride?.(capability);
  if (override) return override;
  if (EXACT[capability]) return EXACT[capability]!;
  for (const p of PREFIX_HIGH) {
    if (capability.startsWith(p)) return 'high';
  }
  for (const p of PREFIX_MEDIUM) {
    if (capability.startsWith(p)) return 'medium';
  }
  return 'medium';
}

// Register on import (load-time side effect). Imported at the top of index.ts
// before bootstrap so the resolver is active before any tool self-registers.
setCapabilityTierResolver(papercuspTierFor);
