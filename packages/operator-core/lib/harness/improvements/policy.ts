/**
 * Risk-tier policy for the papercusp self-improvement loop
 * (papercusp-self-improvement-loop-2026-06-04, D-004 / D-005 / D-008 / Phase 4).
 *
 * Pure logic — no DB, no IO — so it is exhaustively unit-testable. It answers the
 * one per-item question the implement loop asks: **is this captured improvement
 * safe to AUTO-implement (no human approval), or must it wait for a human?**
 *
 * v1 (conservative, D-004): `kind=bug` → AUTO; every other kind + anything
 * touching the safety/deploy/loop machinery → HUMAN. "AUTO" means *no human
 * approval*, NOT *no gates* (D-005): an auto item still runs its blueprint
 * (validator/reviewer), needs green tests, and passes the Opus-4.8-xhigh
 * release-manager at deploy — which is the real backstop for the bootstrapping
 * hazard. This policy is the cheap *first* filter, not the last line of defence.
 *
 * Phase 4 (graduate) is a CONFIG change, not a code change: add a kind to
 * `autoKinds` (bug → change → feature) as each tier earns trust. The protected
 * path/keyword lists stay human-gated indefinitely (operator-core safety, the
 * deploy machinery, migrations, the loop itself — bootstrapping).
 */

import { DETERMINISTIC_EXECUTOR_TCB_PATTERNS } from '../../blueprint-steps/tcb';
import { CAPABILITY_DISPATCH_TCB_PATTERNS } from '../../capability-envelope/tcb';
import type { LifecycleState } from '@papercusp/coordination/capabilities';

/** Work-item kinds (forward-compatible with unify-work-items-2026-06-04 D-002). */
export type WorkItemKind = 'feature' | 'bug' | 'change' | 'chunk';

export type ImprovementSeverity = 'critical' | 'major' | 'minor' | 'nit';
// Canonical lifecycle vocabulary (P-007) — one definition across all ObjectRefs.
export type ImprovementState = LifecycleState;

/** The unit the loop reasons over — a captured improvement (an issue today, a
 *  work_item[kind=bug|change] after unify-work-items lands). Storage-agnostic. */
export interface ImprovementCandidate {
  id: string;
  kind: WorkItemKind;
  /** 'operator' | 'harness:<slug>' — per-Hive scope (P-010). */
  scope: string;
  /** Storage lane provenance. Only the observation lane is surfaced because the
   * ordinary improvement lane is the historical default and remains omitted. */
  lane?: 'observation';
  title: string;
  body?: string;
  severity?: ImprovementSeverity;
  state?: ImprovementState;
  assignee?: string | null;
  /** When the current assignee claimed it (in-flight detection for the dispatch loop). */
  assignedAt?: string | null;
  createdAt?: string;
  /** Last lifecycle update (issue.updated_at) — for a resolved/closed item this is
   *  the resolution timestamp, which the recurrence-decay matcher reads as "when
   *  this signature last recurred / was last decided" (self-learning P-003). */
  updatedAt?: string;
  /** Who FILED this candidate (engineer_issues.created_by) — the filer's ownerId.
   *  The "distinct authors" axis for Scout's rubric-gap detection (plan-templates-
   *  and-rubric-v2 P-008): a recurring cluster spanning ≥N distinct authors is a
   *  stronger gap signal than one author repeating. Absent on legacy rows that
   *  predate created_by capture. */
  createdBy?: string | null;
  /** Optional one-line "already decided: <reason>" recall, surfaced when a NEW
   *  capture matches the stable signature of a prior resolved/closed item — so the
   *  loop recognises an already-decided friction instead of re-proposing it
   *  (self-learning P-003). Populated from payload.decidedReason when present. */
  decidedReason?: string;
  /** Known implementation paths, when available — supplied at capture
   *  (`improvements:capture { paths }`) or post-scoping. Feeds the
   *  protected-path gate (close-the-self-improvement-loop D-002). */
  paths?: string[];
  /** How many times the auto-implement loop has dispatched this item
   *  (payload.implementAttempts — the anti-re-dispatch counter, D-001). */
  attempts?: number;
  /** Legacy compatibility cohort awaiting P-006 classification. Forces the human
   * tier only so pre-split rows remain safely excluded. */
  needsHuman?: boolean;
  /** A strict owner-capability escalation: credential, physical device, or an
   * external-service action no agent can perform. Forces the human tier. */
  needsOwnerAction?: boolean;
  /** Source role that filed this improvement (P-010 source-tag): Queen, bee, system, or human.
   *  Tracked for per-Hive analytics and topic lens. */
  sourceRole?: 'Queen' | 'cup' | 'system' | 'Scout' | 'human';
  /** The idea-lifecycle journey (payload.ideaLifecycle — self-learning P-030/P-031):
   *  open → triaged(place/gate/gym/reject) → applied → verified/recurred. Initialized
   *  at capture; written by triage-core, resolve-core, and the decay sweep. Items
   *  captured before the lifecycle landed have none (treated as 'open'). */
  ideaLifecycle?: import('./lifecycle').IdeaLifecyclePayload;
  /** Stable watchdog signal identity (payload.watchdogKey, '<source>:<key>' —
   *  watchdog-audit P-004). DIFFERENT keys = DIFFERENT signals even when the
   *  template titles token-collide (nested-path red-tests, per-tool errors) —
   *  dedup/hygiene must never merge across distinct keys. */
  watchdogKey?: string;
  /** Learning-signal provenance (frontier P-002/D-002): organic | drill | replay
   *  | shadow. Absent = organic (legacy rows / pre-column fakes). Candidates are
   *  already origin-filtered at the read seam (read-items.ts); this rides along
   *  for display + downstream decisions. */
  origin?: import('./provenance').SignalOrigin;
  /** EI-15659: FEDERATION provenance ('local' | 'remote', from the physical
   *  work_items row's `origin` column) — DISTINCT from the `origin` field above,
   *  which is the unrelated learning-signal SignalOrigin (organic/drill/replay/
   *  shadow). 'remote' means this row is federated in from its authoring peer;
   *  `work_items:complete` REFUSES to terminal-complete a remote-authored issue
   *  locally (only the authoring peer can). Only set when 'remote' — a local row
   *  omits it (byte-identical candidates for the common case). */
  workItemOrigin?: 'remote';
  /** Machine-readable finding class (payload.findingClass — frontier P-044/D-008):
   *  a stable `<miner>:<shape>` slug from the filing edge (e.g.
   *  `negative-space:resolution-gap`). The graduation tracker counts clean
   *  passes per class; absent on interactive/legacy captures. */
  findingClass?: string;
  /** The structured-observation v2 view (rubric-driven-observations-2026-06-20
   *  P-001 / D-003), surfaced from payload.observation for observation-lane rows:
   *  { kind, scope, confidence, refs, sourceHive, targetHive, rubricRef, ratings }.
   *  Lets the Scout corpus-digest (P-006) group by rubricRef/sourceHive + surface
   *  rubric ratings WITHOUT re-reading the raw payload. Absent on non-observation /
   *  free-text rows. */
  observation?: import('./observation-types').StructuredObservation;
  /** IDEATE-pass provenance (payload.ideation — su-ideate-learning-substrate-2026-07-10
   *  P-007): the declared lens, the bet, and the cheap falsifiable first experiment,
   *  persisted at capture. Enrichment only (D-005) — absent on non-ideation captures,
   *  and absence changes nothing downstream; a COMPLETE cheapExperiment is what makes
   *  the idea machine-checkably bettable (scout/invariants isBettable → the
   *  bettable-first ranking feature). */
  ideation?: CandidateIdeation;
  /** EI-1404: an exact quota/rate-limit reset instant (ISO) parsed off a prior
   *  dead-on-arrival worker's output (payload.dispatchHoldUntil, set by
   *  implement-worker-exit.ts's reset-hold classification) — the auto-implement
   *  dispatcher holds re-dispatch of THIS item until this instant instead of
   *  re-firing on the generic cadence into the same closed window. Undefined =
   *  no hold (the common case). */
  dispatchHoldUntil?: string;
}

/**
 * The persisted `payload.ideation` shape (su-ideate-learning-substrate P-002 declared
 * it on the capture tool contract; P-007 persists it). Mirrors the capture schema:
 * all fields optional, `cheapExperiment` the ScoutExperiment triple (hypothesis /
 * method / falsifiableSignal) — fields optional HERE because a payload round-trip is
 * untrusted input; completeness is judged by `isBettable`, never assumed from the type.
 */
export interface CandidateIdeation {
  /** The generative stance that produced the idea (a SuIdeationLens value). */
  lens?: string;
  /** The bet — the concrete upside if the idea pans out. */
  bet?: string;
  /** The cheap falsifiable first experiment (ScoutExperiment shape, D-006). */
  cheapExperiment?: { hypothesis?: string; method?: string; falsifiableSignal?: string };
}

/**
 * The replication-liveness detector's stable filer identity (payload._ei.created_by,
 * == RECOVERY_OWNER in sync/hyperbee/replication-stall-ei.ts — hardcoded here rather
 * than imported to keep this module pure/IO-free per the file-header contract; pinned
 * against drift by tcb-invariants-style string-literal tests). These are RUNTIME
 * p2p-fleet conditions (connected_never_replicated / stall episodes) a generic worker
 * structurally cannot resolve: verifying the current verdict needs the p2p fleet live
 * in-process (getReplicationLiveness()/dogfood-substrate diagnostics), not PG-queryable
 * (same rationale as WI-2633, which added `federationDetectorExclusionSql` for the
 * SELF-SELECT path in work-items.ts). EI-8455: the AUTO-IMPLEMENT DISPATCH path (this
 * classifier) had no equivalent gate — kind=bug made these auto-eligible, so the
 * detector's EIs slipped into the auto lane and burned a dispatch/wake each time.
 */
export const REPLICATION_LIVENESS_DETECTOR_OWNER = 'system:replication-liveness';

export type Tier = 'auto' | 'human';

export interface RiskTierPolicy {
  /**
   * Kinds eligible for AUTO-implementation (no human approval). **Graduation
   * (Phase 4) edits THIS** — bug → change → feature as trust is earned. Empty =
   * everything human-gated (a valid "pause auto" config).
   */
  autoKinds: WorkItemKind[];
  /**
   * Glob-ish repo-relative path patterns that force HUMAN even for an auto kind
   * — the safety/deploy/bootstrapping surfaces. `*` matches within a segment,
   * `**` matches across segments. Applied only when a candidate carries `paths`.
   */
  protectedPathPatterns: string[];
  /**
   * Title/body keywords (case-insensitive substring) that force HUMAN even for an
   * auto kind — the cheap pre-paths backstop for items whose blast radius is the
   * safety/deploy/security machinery. The release-manager at deploy is the real
   * guarantee (D-005); this just keeps obvious hazards out of the auto lane early.
   */
  protectedKeywords: string[];
}

/**
 * v1 policy (D-004): bug = auto, everything else = human; the safety/deploy/loop
 * machinery is human-gated regardless of kind (bootstrapping — D-006/D-008).
 */
export const DEFAULT_RISK_TIER_POLICY: RiskTierPolicy = {
  autoKinds: ['bug'],
  protectedPathPatterns: [
    // The deploy machinery (release gate) — never auto-touch what ships the fleet.
    'packages/operator-core/lib/release/**',
    'apps/operator/lib/release/**',
    // The scheduler / durable-workflow engine that runs the loop itself.
    'packages/operator-core/lib/dbos/**',
    'packages/operator-core/lib/harness/routines/**',
    // git-sync (commits + pushes the whole tree) + the lock authority.
    'packages/operator-core/lib/git-sync/**',
    'libs/papercusp/packages/locks/**',
    // Schema migrations — destructive/irreversible blast radius.
    'libs/papercusp/libs/db/sql/**',
    // The flag system (this loop's master switch lives here) + the loop's own code.
    'libs/flags/**',
    'packages/operator-core/lib/harness/improvements/**',
    'packages/operator-core/lib/agent-tools/improvements/**',
    // The loop's governance rails (frontier P-049): the learning-spend budget
    // machinery (D-004 — an auto-edit could un-make the refuse-unattended rule)
    // and the behavior-change ledger (D-003 — the one mutation-attribution rail).
    'packages/operator-core/lib/learning-governor/**',
    'packages/operator-core/lib/change-ledger/**',
    // Auth / security surfaces.
    '**/auth/**',
    '**/credentials/**',
    // The deterministic-blueprint executor TCB (deterministic-blueprints-migration
    // P-141 / agent-capability-confinement D-007): the spine executor + the
    // deterministic-step runner cannot graduate their own permissions — an
    // auto-edit to the dispatch/validation/runner code stays human-gated under any
    // graduation dial. Declared in blueprint-steps/tcb.ts; pinned by
    // tcb-invariants.test.ts. (The durable executor + spawn chokepoint are already
    // covered above by `dbos/**`; the routine cadence layer by `harness/routines/**`.)
    ...DETERMINISTIC_EXECUTOR_TCB_PATTERNS,
    // The capability dispatch GATE TCB (agent-capability-confinement P-030 / D-007):
    // once the fleet is confined, every capability flows through one chokepoint —
    // the envelope PDP, the decision-ledger, the host wiring, the dispatch stack,
    // and the gated capability tools. The gate cannot graduate its own permissions,
    // so an auto-edit to any of it stays human-gated under every graduation dial.
    // Declared in capability-envelope/tcb.ts; pinned by
    // capability-envelope/tcb-invariants.test.ts.
    ...CAPABILITY_DISPATCH_TCB_PATTERNS,
  ],
  protectedKeywords: [
    'migration',
    'deploy',
    'release gate',
    'release-gate',
    'git-sync',
    'operator-core safety',
    'auth',
    // EI-19485505354981364: the auth FAMILY is listed explicitly because keyword matching is
    // word-anchored (see mentionsProtectedKeyword). Under the old substring test these were all
    // covered incidentally by 'auth'; naming them keeps every genuine hit gated while 'auth'
    // itself stops matching 'author'/'authoritative'/'authority'. NOT a widening — it restores
    // exactly the true positives the narrowing would otherwise drop.
    'oauth',
    'authentication',
    'authorization',
    'authn',
    'authz',
    'credential',
    'rls',
    'security',
    'feature flag',
    // Autoloop safety-gate inventory (P-041 trust graduation): never auto-apply
    'dont-deploy-on-red',
    'budget cap',
    'quota cap',
    'auth perimeter',
    'double-allocate',
  ],
};

/**
 * Does `hayLower` mention `keyword` as a WORD, rather than as an arbitrary substring?
 *
 * EI-19485505354981364. This used to be a bare `hay.includes(keyword)`, which is a silent,
 * high-blast-radius bug: a keyword hit writes `payload.needsHuman = true`, and that is claim
 * floor #6 — the row becomes INVISIBLE to scheduler:get_next and self-select. It does not fail
 * loudly; the item simply never appears in anyone's queue. So every false positive is a work-item
 * quietly removed from the backlog.
 *
 * MEASURED on papercusp-workspace 2026-08-10, before this fix: 351 items keyword-gated, of which
 * `auth` alone accounted for 109 — and only 13 of those 109 mention `auth` as a word. The other 96
 * were `author`, `authoritative`, `authority`, `authored`, `author_pubkey`, `cueAuthority`. `rls`
 * matched `urls` and `urlsearchparams`. One casualty was a severity=critical item hidden 18 days.
 *
 * WHY NOT A PLAIN \b...\b ANCHOR (what the item proposed): it would fix `auth` and simultaneously
 * BREAK the keywords that were working — `deploy` would stop matching `deployment`/`deployed` and
 * `migration` would stop matching `migrations`, turning a false-positive bug into false NEGATIVES
 * on a safety gate. So the keyword may carry a conservative inflection: a small prefix set and a
 * small suffix set, chosen so that no auth false positive comes back (`or`/`ority`/`oritative` are
 * deliberately NOT suffixes).
 *
 * Validated against the live corpus rather than by inspection — per-keyword, gated-before →
 * gated-after: git-sync 126→126, migration 32→32, release gate 7→7, credential 4→4, security 3→3,
 * release-gate 2→2 (every correctly-working keyword preserved exactly), deploy 65→64 (the one loss
 * is the concatenated identifier `deployinprogress` in a TS type-error item), rls 3→1 (both losses
 * are `urls`), auth 109→13. The narrowing lands only where the bug was.
 */
const KEYWORD_INFLECTION_PREFIXES = '(?:un|re|non|de)?';
const KEYWORD_INFLECTION_SUFFIXES = '(?:s|es|ed|d|ing|ment|ments|ion|ions|able|ables)?';
const protectedKeywordRegexCache = new Map<string, RegExp>();

export function mentionsProtectedKeyword(hayLower: string, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  let re = protectedKeywordRegexCache.get(lower);
  if (!re) {
    // Escape first: `protectedKeywordAdditions` is caller-supplied (improvements:set-auto-policy),
    // so an unescaped metachar would either throw at construction or silently widen the gate.
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(
      `(^|[^a-z0-9])${KEYWORD_INFLECTION_PREFIXES}${escaped}${KEYWORD_INFLECTION_SUFFIXES}([^a-z0-9]|$)`,
    );
    protectedKeywordRegexCache.set(lower, re);
  }
  return re.test(hayLower);
}

export interface TierDecision {
  tier: Tier;
  /** Human-readable trail of why this tier was chosen (for the digest + audit). */
  reasons: string[];
  /** The protected path-pattern or keyword that forced HUMAN, if any. */
  protectedHit?: string;
}

/** Per-call classification options (queen-autonomy-and-selffeed-fix Phase 2). */
export interface ClassifyOptions {
  /**
   * The OWNER FULL-AUTONOMY grant (`FLAGS.MUG_FULL_AUTONOMY`). When true, the
   * self-improvement loop's protected-path/keyword TCB bars are LIFTED — a kind=bug
   * touching the deploy gate / flags / capability dispatch / migrations / the loop's
   * own code becomes auto-eligible (the owner accepted the recursive-self-improvement
   * boundary). The needs-human routing, the kind gate (autoKinds — a SEPARATE Phase-4
   * dial, unchanged here), and the infra-environment gate (a worker cannot fix a down
   * service regardless) still apply. The auto lane STILL runs blueprint + tests + the
   * release-manager at deploy (D-005), and is STILL separately gated by
   * IMPROVEMENT_AUTO_IMPLEMENT (default OFF). REVERSIBLE: clearing the grant restores
   * the bars verbatim.
   */
  ownerFullAutonomy?: boolean;
}

/** Minimal glob matcher: `**` → any (incl. `/`), `*` → any non-`/` run. */
export function matchGlob(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex specials (NOT * which we handle)
        .replace(/\*\*/g, ' ') // placeholder for **
        .replace(/\*/g, '[^/]*')
        .replace(/ /g, '.*') +
      '$',
  );
  return re.test(value);
}

// ── infra-environment detection (D-002/D-005: infra failures escalate, never auto) ──
//
// The SINGLE source of truth for "is this an environment problem a code-fix worker
// cannot touch?" — owned here (the safety layer) and re-used by the triage taxonomy
// (triage.ts re-exports these + classifyIdeaType keys its infra-environment leg off
// `infraEnvironmentHit`). Living here is what lets `classifyImprovement` consult it
// so an infra-classed kind=bug never reaches tier=auto (EI-408): the verdict chain
// stays policy-first (D-003) instead of the infra knowledge existing only at triage.

/**
 * Watchdog signal sources whose class is INFRA-ENVIRONMENT (D-002: escalate, never
 * auto). Shared vocabulary with the known-open aging escalation's infra-class
 * (D-004 — the shorter aging threshold keys off the same set). PROPOSED (P-004).
 */
export const INFRA_SIGNAL_SOURCES: readonly string[] = [
  'service-down',
  'fire-circuit-open',
  'migration-drift',
  // EI-18787755090726525: the live DB carries a migration this process's code tree
  // doesn't ship yet — the fix is "update/redeploy this process", never an inline code
  // edit (there is no diff to make; the code that matches the schema already exists,
  // it just hasn't reached this process). Same class as migration-drift above, opposite
  // direction.
  'schema-ahead-of-code',
  // WI-918476. INFRA, and deliberately so: one of the two remedies is DROP INDEX
  // against the shared live database, and choosing between "add a migration" and
  // "drop the object" needs judgment about which side is wrong. Neither is a call
  // an auto-implement worker should make unsupervised.
  'schema-object-drift',
  // EI-5994: a dead-owner engine loop (loop:arm) parked with no completion signal is an
  // environment/session-liveness fact (the owner's process/wake-channel died), not a
  // product idea a worker can code-fix — misrouting it to ideaType:product/triageDecision:place
  // was the second half of the mis-triage this closes.
  'loop-stalled',
  // EI-805: a stalled-feature signal ("dispatchable work in harness X is not being picked
  // up") means the autonomous loop (routine tick → blueprint-run → dispatch) is not
  // reaching that harness — the fix is always the routines/DBOS scheduler + dispatch
  // machinery (an explicit STOP surface for auto-implement), never an inline code change.
  // EI-287 burned 4 consecutive auto-implement dispatch attempts re-confirming this same
  // non-auto-fixable root cause before a worker manually routed it needs-human each time;
  // this makes the routing automatic instead of relying on every dispatch attempt to
  // rediscover it.
  'stalled-feature',
];

/** Paths that mean the fix lives in the ENVIRONMENT, not papercusp code. PROPOSED (P-004). */
export const INFRA_PATH_PATTERNS: readonly string[] = [
  'Dockerfile*',
  '**/Dockerfile*',
  'docker-compose*',
  '**/docker-compose*',
  '**/*.service',
  '**/systemd/**',
  '.env*',
  '**/.env*',
  'infra/**',
];

/** The signal class of a watchdogKey ('<source>:<key>') — '' when absent/malformed. */
export function watchdogSourceOf(watchdogKey: string | undefined): string {
  if (!watchdogKey) return '';
  const i = watchdogKey.indexOf(':');
  return i > 0 ? watchdogKey.slice(0, i) : '';
}

/**
 * Whether a candidate is an infra/environment problem — keyed off the watchdog
 * signal class (the strongest key: a service-down or circuit-open firing IS an
 * environment fact) with infra paths as the fallback. Returns a short human-readable
 * hit string (for the reason trail) or null. Pure — both `classifyImprovement`
 * (safety tier) and `classifyIdeaType` (routing taxonomy) consume it (D-003).
 */
export function infraEnvironmentHit(c: Pick<ImprovementCandidate, 'watchdogKey' | 'paths'>): string | null {
  const source = watchdogSourceOf(c.watchdogKey);
  if (INFRA_SIGNAL_SOURCES.includes(source)) return `watchdog signal class "${source}"`;
  // An EXTERNAL provider rate-limit (the `:rate-limit` tool-error class — OpenAI embed TPM
  // 429, etc.) is CAPACITY, not a code bug: route to infra-environment (owner-escalate,
  // never the auto-implement lane), since a worker cannot fix a provider quota
  // (watchdog-and-exposed-systems-improvement-2026-06-18 P-010). The class is the
  // watchdogKey SUFFIX, not its source segment, so INFRA_SIGNAL_SOURCES misses it.
  if (c.watchdogKey && /:rate-limit$/.test(c.watchdogKey)) return 'external provider rate-limit (capacity)';
  // EI-20983096990125721: `shared-hive:peer-federation-silence:<harness>` reports a
  // REMOTE PEER's liveness/announce-admission state — its own alert text says so
  // plainly ("The peers are ABSENT, not slow — nothing current can be folded. Suspect
  // the announce/admission path or peer liveness, NOT this host's merge loop.", see
  // judgePeerFederationSilence in shared-pot-loop/fleet-monitors.ts). A worker cannot
  // make a departed peer re-announce or force its admission any more than it can fix a
  // port mapping, so this incident kind is infra-environment (owner-escalate, never
  // auto) even though its SOURCE segment ("shared-hive") is shared with sibling
  // incident kinds (double-completion, outbox-health, presence-ghost, ...) that ARE
  // genuine, code-fixable defects — hence a targeted middle-segment match
  // (`shared-hive:<kind>:<harness>` — see planSharedHiveCapture) rather than adding
  // "shared-hive" to INFRA_SIGNAL_SOURCES wholesale, which would also gate away those
  // siblings' real bugs from auto-fix.
  //
  // Without this, the watchdog re-captures the SAME incident every tick (dedupScope:
  // 'open' + a stable watchdogKey), which the D-005 default classified `code-bug` →
  // tier=auto — the exact repeat-dispatch shape `stalled-feature` was fixed for
  // (EI-805/EI-287: "burned 4 consecutive auto-implement dispatch attempts
  // re-confirming this same non-auto-fixable root cause"). Measured here: repeatCount
  // 24 on one open item before this fix landed.
  if (c.watchdogKey && /^shared-hive:peer-federation-silence:/.test(c.watchdogKey)) {
    return 'shared-hive peer federation silence (peer liveness/announce-admission, not code)';
  }
  // EI-21322935352272541: the HOST-WIDE form of the same reading — "this host
  // admits no remote log in ANY booted scope". It is the identical
  // announce/admission-path condition, so it must land in the identical
  // infra-environment lane; it simply is not harness-scoped, so it carries NO
  // trailing `:<harness>` segment and the anchored match above cannot see it.
  // Missing this reintroduces the exact regression that match was added for:
  // default D-005 classifies it `code-bug` -> tier=auto -> the watchdog
  // re-dispatches an auto-implement attempt every tick at a root cause no worker
  // can fix (measured there: repeatCount 24 before the fix).
  if (c.watchdogKey === 'shared-hive:host-admits-no-remote-logs') {
    return 'shared-hive host-wide admission outage (announce/admission path, not code)';
  }
  const infraPath = (c.paths ?? []).find((p) => INFRA_PATH_PATTERNS.some((pat) => matchGlob(pat, p)));
  if (infraPath) return `path "${infraPath}"`;
  return null;
}

/**
 * Classify a single candidate into its risk tier. The order is deliberate:
 *   0. explicit needs-human routing (improvements:resolve back-edge) → HUMAN.
 *   0.4. already triaged 'gate'/'reject' by the D-005 routing taxonomy (EI-815) → HUMAN,
 *        regardless of kind — an explicit routing decision this classifier must respect.
 *   0.5. filed by the replication-liveness detector (EI-8455) → HUMAN, regardless
 *        of kind — a "wrong tool" bar like infra-environment, not a safety bar.
 *   0.6. remote-authored / federated row (EI-15659) → HUMAN, regardless of kind —
 *        this node cannot terminal-complete a peer's work-item.
 *   1. kind gate — not an auto kind → HUMAN immediately (the common case).
 *   2. infra-environment (D-002/D-005) → HUMAN (a worker cannot fix a port mapping).
 *   3. protected paths (when known) → HUMAN (the safety surfaces).
 *   4. protected keywords (title+body) → HUMAN (the pre-paths proxy).
 *   5. otherwise → AUTO (still runs blueprint + tests + release-manager, D-005).
 */
export function classifyImprovement(
  c: ImprovementCandidate,
  policy: RiskTierPolicy = DEFAULT_RISK_TIER_POLICY,
  opts: ClassifyOptions = {},
): TierDecision {
  const reasons: string[] = [];

  if (c.needsOwnerAction) {
    reasons.push('strict owner action required (credential, physical device, or external-service action) → human');
    return { tier: 'human', reasons };
  }

  if (c.needsHuman) {
    reasons.push('legacy needsHuman compatibility flag (awaiting P-006 re-triage) → human');
    return { tier: 'human', reasons };
  }

  // EI-815: an item already triaged 'gate' (owner-escalation) or 'reject' by the D-005
  // routing taxonomy (classifyIdeaType/triageIdea in triage.ts) must never re-enter the
  // auto lane just because it also happens to be kind=bug with no infra watchdogKey,
  // no protected path, and no protected keyword — e.g. EI-402 (a Latitude-VM environment
  // fact whose title matched none of the keyword/path heuristics). The triage verdict
  // lives ONLY in payload.ideaLifecycle.triageDecision, which this classifier otherwise
  // never consults — so the auto-implement dispatcher kept re-picking it up every cadence
  // tick (implementAttempts incrementing) until a worker manually routed it needs-human
  // each time. Mirrors the needsHuman gate: an explicit routing decision this classifier
  // must respect, not re-derive from kind/paths/keywords (D-003: one verdict chain).
  if (c.ideaLifecycle?.triageDecision === 'gate' || c.ideaLifecycle?.triageDecision === 'reject') {
    const decision = c.ideaLifecycle.triageDecision;
    reasons.push(`already triaged '${decision}' (owner-escalation/rejected) — never re-enters the auto lane → human`);
    return { tier: 'human', reasons, protectedHit: `triageDecision:${decision}` };
  }

  // EI-8455: a system:replication-liveness detector EI is a RUNTIME p2p-fleet
  // condition no generic worker can verify/resolve (needs the p2p fleet live
  // in-process) — gate it here, before the kind check, since these are filed
  // kind=bug (otherwise auto-eligible) and would slip into the auto lane every
  // dispatch. Mirrors the infra-environment gate: a "wrong tool" bar, NOT lifted
  // by the owner full-autonomy grant (recursive-self-improvement doesn't make a
  // worker able to run the p2p fleet in-process).
  if (c.createdBy === REPLICATION_LIVENESS_DETECTOR_OWNER) {
    reasons.push(
      `filed by the replication-liveness detector (createdBy=${REPLICATION_LIVENESS_DETECTOR_OWNER}) — gated to the p2p-release-readiness fleet, a generic worker cannot resolve it → human`,
    );
    return { tier: 'human', reasons, protectedHit: REPLICATION_LIVENESS_DETECTOR_OWNER };
  }

  // EI-15659: a remote-authored (federated) row can never be terminal-completed on
  // THIS node — `work_items:complete` structurally refuses it (only the authoring
  // peer can resolve it; the terminal state arrives here via federation). Gate it
  // BEFORE the kind check, the same "wrong tool, not a safety call" bar as the
  // replication-liveness detector above: auto-eligibility here would place a cup on
  // an un-completable item that re-surfaces every Mug wake and burns a re-probe.
  // NOT lifted by the owner full-autonomy grant — full-autonomy is about permission
  // to touch protected surfaces, not about giving this node the ability to complete
  // a peer's work-item.
  if (c.workItemOrigin === 'remote') {
    reasons.push(
      'remote-authored (federated from the authoring peer) — this node cannot terminal-complete it; ' +
        'the authoring peer must claim/resolve it, and this node receives the terminal state through ' +
        'federation → human (never auto-placed here)',
    );
    return { tier: 'human', reasons, protectedHit: 'workItemOrigin:remote' };
  }

  if (!policy.autoKinds.includes(c.kind)) {
    reasons.push(
      `kind=${c.kind} is not auto-eligible (autoKinds: [${policy.autoKinds.join(', ') || '∅'}]) → human`,
    );
    return { tier: 'human', reasons };
  }
  reasons.push(`kind=${c.kind} is auto-eligible`);

  // Infra-environment never auto (D-002/D-005): a code-fix worker cannot fix a
  // down service / port mapping / migration drift. The infra knowledge lives in
  // the signal class + paths (not the kind), so an infra kind=bug (EI-187
  // service-down) would otherwise slip into the auto lane and burn dispatch
  // attempts on something no worker can resolve (EI-408). NOT lifted by the
  // full-autonomy grant: it is a "wrong tool" bar (a worker literally cannot fix it),
  // not a safety bar — auto-dispatching it would just burn attempts.
  const infraHit = infraEnvironmentHit(c);
  if (infraHit) {
    reasons.push(`infra-environment (${infraHit}) — D-002/D-005: infra failures escalate, never auto → human`);
    return { tier: 'human', reasons, protectedHit: infraHit };
  }

  // The OWNER FULL-AUTONOMY grant (queen-autonomy-and-selffeed-fix Phase 2) LIFTS the
  // protected-path + protected-keyword TCB bars — the owner accepted the recursive-
  // self-improvement boundary (the auto-implement loop may edit + ship the deploy gate,
  // flags, capability dispatch, migrations, and its own code). REVERSIBLE: clearing the
  // grant restores the bars. The auto lane still runs blueprint + tests + the release-
  // manager at deploy (D-005), and is still separately gated by IMPROVEMENT_AUTO_IMPLEMENT.
  if (!opts.ownerFullAutonomy) {
    for (const p of c.paths ?? []) {
      const hit = policy.protectedPathPatterns.find((pat) => matchGlob(pat, p));
      if (hit) {
        reasons.push(`touches protected path "${p}" (pattern ${hit}) → human`);
        return { tier: 'human', reasons, protectedHit: hit };
      }
    }

    // EI-16013: the keyword scan is the PRE-PATHS PROXY (so named by its own test block) — a
    // stand-in for the path check, used when we do not yet know WHICH files an item touches.
    // Once an item DECLARES paths and none of them matched a protected pattern above, we already
    // HAVE the structured answer the proxy was approximating, and an incidental prose mention
    // must not override it.
    //
    // MEASURED (papercusp-workspace/papercusp, 2026-09-05, dev:pg_query with a passing positive
    // control): of 35 items gated on the word "migration", 27 had declared a non-empty path set
    // that matched no protected pattern. The filing case, EI-11109, is a sandbox seccomp `listen`
    // syscall denial that was gated to human-only because its body listed "migration helpers" as
    // one example of an affected script type. A keyword hit sets payload.needsHuman, which is
    // claim floor #6, so such a row goes INVISIBLE to every claim queue rather than failing
    // loudly — the same silent-removal failure mode EI-19485505354981364 documents below.
    //
    // This NARROWS the proxy without disarming it — the distinction the EI-19485505354981364
    // block is emphatic about ("a narrowing could silently disarm the safety gate entirely —
    // which is the worse failure"). Three properties are preserved exactly:
    //   1. No declared paths  → the keyword gate fires verbatim (the proxy's actual purpose).
    //   2. A declared path IS protected → the path check above already returned human.
    //   3. Migrations specifically stay covered: `libs/papercusp/libs/db/sql/**` is a protected
    //      path pattern, so a real migration that declares its paths is caught by (2).
    // Only the strictly-better-evidence case changes behaviour.
    const declaredPaths = c.paths ?? [];
    if (declaredPaths.length > 0) {
      reasons.push(
        `declared ${declaredPaths.length} path(s), none protected — keyword proxy skipped (structured paths outrank a prose mention)`,
      );
    } else {
      const hay = `${c.title} ${c.body ?? ''}`.toLowerCase();
      // EI-19485505354981364: WORD-anchored, not `hay.includes(k)` — a substring test gated 96 items
      // on the word "author"/"authoritative" alone, and a keyword hit silently removes the row from
      // every claim queue (needsHuman is claim floor #6). See mentionsProtectedKeyword.
      const kw = policy.protectedKeywords.find((k) => mentionsProtectedKeyword(hay, k));
      if (kw) {
        reasons.push(
          `mentions protected keyword "${kw}" → human (no paths declared, so this is the pre-paths proxy; the deploy gate is the real backstop)`,
        );
        return { tier: 'human', reasons, protectedHit: kw };
      }
    }
  } else {
    reasons.push(
      'owner full-autonomy grant — protected-path/keyword TCB bars LIFTED (recursive-self-improvement boundary; still gated by blueprint + tests + release-manager)',
    );
  }

  reasons.push('no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)');
  return { tier: 'auto', reasons };
}

export interface TierPartition {
  auto: ImprovementCandidate[];
  human: ImprovementCandidate[];
  decisions: Record<string, TierDecision>;
}

/** Split a set of candidates into the auto lane vs the human queue. */
export function partitionByTier(
  candidates: ImprovementCandidate[],
  policy: RiskTierPolicy = DEFAULT_RISK_TIER_POLICY,
  opts: ClassifyOptions = {},
): TierPartition {
  const auto: ImprovementCandidate[] = [];
  const human: ImprovementCandidate[] = [];
  const decisions: Record<string, TierDecision> = {};
  for (const c of candidates) {
    const d = classifyImprovement(c, policy, opts);
    decisions[c.id] = d;
    (d.tier === 'auto' ? auto : human).push(c);
  }
  return { auto, human, decisions };
}
