/**
 * Pure policy for the green-checkpoint's serialized frozen-candidate repair queue.
 *
 * The gate and the routine metadata writer both need the same answer to four safety
 * questions: whether a fixer may be dispatched, whether a live/unknown fixer makes the
 * current tick inconclusive, which exact repair head must be verified, and whether the
 * tested patch is present on staging before promotion. Keeping those answers here avoids
 * recreating a second queue in either caller. This module deliberately performs no git,
 * filesystem, database, or process work.
 */

import {
  applyRepairLegMeasurements,
  parseRepairLegStates,
  summarizeRepairLegs,
  type FrozenRepairLegState,
  type RepairLegMeasurement,
  type RepairLegShrinkSummary,
} from './repair-leg-lifecycle';
// P-021: a runtime cycle by design (repair-manifest.ts imports `normalizeRepoPath` from here);
// neither side touches the other at module-evaluation time, so ESM resolves it cleanly.
import {
  parseRepairManifest,
  summarizeRepairManifest,
  type RepairManifest,
  type RepairManifestSummary,
} from './repair-manifest';
import type { FixPrecheckVerdict } from './admission-fix-precheck';

/**
 * Schema 4 (P-006, frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): the row
 * carries a TYPED `signature` beside the flat `failingTests` projection. Older rows (1–3)
 * still parse — their signature is DERIVED from `failingTests` on read (the P-014 migration
 * for the live queue, so a candidate-vs-staging parser skew can never strand an open queue).
 */
export const FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION = 4 as const;
export const FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE = 'repair-staging-mismatch';

/**
 * ── P-006 / D-004: THE TYPED FAILURE SIGNATURE ─────────────────────────────────────────
 *
 * `failingTests` was one flat `string[]` holding three populations at once — vitest test
 * paths, npm workspace names / `<ws> :: <script>` task ids, and non-test gate leg ids — and
 * every consumer re-guessed which was which from the string's SHAPE (`inferFailingFilesFromEntries`,
 * `nonTestGateIdsFrom`, `partitionRepairSignatures`, …). The typed signature names the kind
 * ONCE, at the moment the judging run measured it, and carries the recipe that re-measures
 * it. `failingTests` survives as the PROJECTION `signature.map(e => e.id)` so nothing that
 * reads the flat list (cells, the owner brief, the fixer prompt, collision detection) is
 * stranded — the two are written together and never disagree.
 *
 * Kinds, by which runner re-measures them at the repair head:
 *  - `test-file`      — a vitest file (workspace-relative); `runTestsAtRef`.
 *  - `workspace-task` — a `<ws> :: <script>` task id or a bare `@scope/pkg` workspace name;
 *                       `runGateAtRef` (a `test` task is covered by its files' re-run).
 *  - `lint-leg`       — a NON_TEST_GATE_SCRIPTS registry id or a root `lint:*` script;
 *                       `runGateAtRef` through the registry.
 *  - `post-suite-leg` — a post-suite phase outcome no selective runner can narrow (the SPA
 *                       build sentinel, a corrupt-tree sentinel, an unmapped crash id): only
 *                       the FULL gate at the repair head re-measures it.
 *  - `seed`           — a `seed:*:check` guard the affected-tests selector attaches
 *                       (`<ws> :: seed:substitutions:check`); `runGateAtRef` in its workspace.
 *
 * EXTEND, NOT REPLACE (rule 2 of ./repair-leg-lifecycle, now enforced on the signature
 * itself): a red re-measures only the kinds the judging run actually ran — a suite-red run
 * defers the post-suite legs, so its verdict says NOTHING about the lint legs already in
 * the signature. Those carry forward with their original `admittedRound`; only a kind that
 * WAS measured is replaced by its fresh result. Unmeasured is never passing.
 */
export type RepairSignatureKind = 'test-file' | 'workspace-task' | 'lint-leg' | 'post-suite-leg' | 'seed';

export const REPAIR_SIGNATURE_KINDS: readonly RepairSignatureKind[] = Object.freeze([
  'test-file',
  'workspace-task',
  'lint-leg',
  'post-suite-leg',
  'seed',
]);

export interface RepairSignatureEntry {
  kind: RepairSignatureKind;
  /** The correlation key — byte-identical to the `failingTests` entry it projects to. */
  id: string;
  /**
   * How to re-measure THIS entry at a ref, from the repo root. Informational: the gate's
   * runners resolve their own invocations from `kind` + `id`; this is what a fixer or an
   * owner reads without reverse-engineering the id.
   */
  recipe: string;
  /** `test-file` / `workspace-task` / `seed`: the owning npm workspace when it is known. */
  workspace?: string;
  /**
   * The convergence round (see `convergenceRounds`) at which this entry FIRST entered the
   * signature. Kept across an extend so a regression cannot reset the shrink baseline —
   * the same reason `capConvergenceRounds` always keeps round 1.
   */
  admittedRound: number;
  /** The head this entry was most recently measured red at. */
  measuredHead: string;
}

/** The judge-supplied half of an entry: everything but the round/head bookkeeping the
 * queue fills in itself. */
export type RepairSignatureInput = Pick<RepairSignatureEntry, 'kind' | 'id' | 'recipe' | 'workspace'>;

/** What the caller knows about the gate's vocabulary. Both fields optional: a bare
 * classification (no context) is shape-only and lands every entry in a SAFE kind. */
export interface RepairSignatureContext {
  /**
   * The gate's NON_TEST_GATE_SCRIPTS registry (id → root scripts). With it a registry id's
   * recipe is its exact expansion; without it a `lint:*` id still classifies as a lint leg
   * with the single-script recipe `npm run <id>`.
   */
  gateRegistry?: Readonly<Record<string, readonly string[]>>;
  /** Ids the judging run's POST-SUITE phase measured red that are NOT lint legs. */
  postSuiteLegIds?: readonly string[];
}

/** The SPA build-break sentinel `checkpointFailureSignature` pushes when the build, not
 * the suite, is what failed. A package name, but never a test workspace. */
export const REPAIR_SIGNATURE_BUILD_SENTINEL = '@papercusp/operator-vite';

/** Recipe for an entry only the full gate can re-measure. Rendered, never parsed. */
export const REPAIR_SIGNATURE_FULL_GATE_RECIPE =
  'not selectively re-runnable: the full gate at the repair head re-measures it';

/** Post-suite sentinels that name a TREE condition, not a script: nothing re-runs them. */
const NON_RERUNNABLE_SENTINELS: ReadonlySet<string> = new Set([
  FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE,
  'package.json-unreadable',
  'lint:tsc-missing',
]);

const WORKSPACE_NAME_SHAPE = /^@[^/\s]+\/[^/\s]+$/;
const TEST_FILE_SHAPE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** `<workspace> :: <script>` — the affected runner's task id. Same grammar as the gate's
 * `parseFailingTaskId`; duplicated here (two regex lines) so this module stays free of
 * the apps/operator import direction. */
export function parseRepairTaskId(entry: string): { workspace: string; script: string } | null {
  const m = /^(\S+)\s+::\s+(\S+)$/.exec(entry.trim());
  return m ? { workspace: m[1] as string, script: m[2] as string } : null;
}

function isSeedScript(script: string): boolean {
  return script === 'seed' || script.startsWith('seed:');
}

/**
 * PURE: classify ONE flat entry. `workspaceHint` is the single test workspace the whole
 * list names (see `classifyRepairSignature`), so a workspace-relative test path can be
 * paired with the cwd that re-runs it — the same pairing `inferFailingFilesFromEntries`
 * performs in the gate, done once and persisted instead of re-derived on every read.
 */
export function classifyRepairSignatureEntry(
  rawId: string,
  ctx: RepairSignatureContext & { workspaceHint?: string | null } = {},
): RepairSignatureInput {
  const id = rawId.trim();
  const task = parseRepairTaskId(id);
  if (task) {
    const recipe = `npm run ${task.script} -w ${task.workspace}`;
    return isSeedScript(task.script)
      ? { kind: 'seed', id, recipe, workspace: task.workspace }
      : { kind: 'workspace-task', id, recipe, workspace: task.workspace };
  }
  if (id === REPAIR_SIGNATURE_BUILD_SENTINEL) {
    return { kind: 'post-suite-leg', id, recipe: `npm --workspace ${id} run build` };
  }
  if (WORKSPACE_NAME_SHAPE.test(id)) {
    return { kind: 'workspace-task', id, recipe: `npm run test -w ${id}`, workspace: id };
  }
  if (NON_RERUNNABLE_SENTINELS.has(id)) {
    return { kind: 'post-suite-leg', id, recipe: REPAIR_SIGNATURE_FULL_GATE_RECIPE };
  }
  if (isSeedScript(id)) return { kind: 'seed', id, recipe: `npm run ${id}` };
  const registered = ctx.gateRegistry?.[id];
  if (registered && registered.length > 0) {
    return { kind: 'lint-leg', id, recipe: registered.map((script) => `npm run ${script}`).join(' && ') };
  }
  if (id.startsWith('lint:')) return { kind: 'lint-leg', id, recipe: `npm run ${id}` };
  if (TEST_FILE_SHAPE.test(id) || (id.includes('/') && !id.startsWith('@'))) {
    return {
      kind: 'test-file',
      id,
      recipe: `npm run test:file -- ${id}`,
      ...(ctx.workspaceHint ? { workspace: ctx.workspaceHint } : {}),
    };
  }
  // An id the post-suite phase named, or anything else we cannot place: only the full gate
  // can re-measure it. Naming the ignorance beats guessing a runner (the P-006 bug class).
  return { kind: 'post-suite-leg', id, recipe: REPAIR_SIGNATURE_FULL_GATE_RECIPE };
}

/**
 * PURE: classify a whole flat list. The test workspace hint is the ONE bare workspace name
 * the list carries (the build sentinel excluded); two or more means the pairing is
 * ambiguous and no test-file entry gets a workspace — the gate's `inferFailingFilesFromEntries`
 * makes the same fail-closed call. Duplicates collapse on id, first occurrence wins.
 */
export function classifyRepairSignature(
  failingTests: readonly string[] | undefined,
  ctx: RepairSignatureContext = {},
): RepairSignatureInput[] {
  const ids = [...new Set((failingTests ?? []).filter(nonBlank).map((id) => id.trim()))];
  const workspaces = ids.filter((id) => WORKSPACE_NAME_SHAPE.test(id) && id !== REPAIR_SIGNATURE_BUILD_SENTINEL);
  const workspaceHint = workspaces.length === 1 ? (workspaces[0] as string) : null;
  return ids.map((id) => classifyRepairSignatureEntry(id, { ...ctx, workspaceHint }));
}

/** The judge's contribution to a red: the fresh measurement, in either form, plus WHICH
 * kinds that measurement covered. Absent `measuredKinds` means "every kind" — a full
 * replacement, which is right for a full gate that measured suite AND post-suite. */
export interface RepairSignatureRedInput {
  /** Legacy flat form; classified with `signatureContext`. */
  failingTests?: readonly string[];
  /** Typed form from a judge that already knows the kinds (verifyRepairHead). Wins on id. */
  signature?: readonly RepairSignatureInput[];
  /** Kinds this run MEASURED. Prior entries of any OTHER kind carry forward unchanged. */
  measuredKinds?: readonly RepairSignatureKind[];
  signatureContext?: RepairSignatureContext;
}

function boundedSignature(entries: readonly RepairSignatureEntry[]): RepairSignatureEntry[] {
  return entries.slice(0, MAX_PERSISTED_FAILURES).map((entry) => ({
    ...entry,
    id: entry.id.slice(0, MAX_PERSISTED_FAILURE_CHARS),
    recipe: entry.recipe.slice(0, MAX_PERSISTED_FAILURE_CHARS),
  }));
}

/**
 * PURE: the signature after a red at `head` in `round`.
 *
 * Fresh entries (typed first, then the classified flat list) REPLACE prior entries of a
 * measured kind; prior entries of an UNMEASURED kind carry forward; an entry present before
 * keeps its `admittedRound`. The flat projection is always `signature.map(id)`.
 */
export function nextRepairSignature(
  prior: readonly RepairSignatureEntry[] | undefined,
  input: RepairSignatureRedInput & { head: string; round: number },
): { signature: RepairSignatureEntry[]; failingTests: string[] } {
  const priorById = new Map((prior ?? []).map((entry) => [entry.id, entry] as const));
  const fresh = new Map<string, RepairSignatureInput>();
  for (const entry of input.signature ?? []) {
    if (!nonBlank(entry.id)) continue;
    const id = entry.id.trim();
    if (!fresh.has(id)) fresh.set(id, { ...entry, id });
  }
  for (const entry of classifyRepairSignature(input.failingTests, input.signatureContext)) {
    if (!fresh.has(entry.id)) fresh.set(entry.id, entry);
  }
  const measured = new Set<RepairSignatureKind>(input.measuredKinds ?? REPAIR_SIGNATURE_KINDS);
  const next: RepairSignatureEntry[] = [];
  for (const entry of fresh.values()) {
    const before = priorById.get(entry.id);
    next.push({
      ...entry,
      admittedRound: before?.admittedRound ?? input.round,
      measuredHead: input.head,
    });
  }
  for (const entry of prior ?? []) {
    if (fresh.has(entry.id)) continue;
    if (measured.has(entry.kind)) continue;
    next.push(entry);
  }
  const signature = boundedSignature(next);
  return { signature, failingTests: signature.map((entry) => entry.id) };
}

/** PURE: interpret a persisted `signature` array against the row's flat list. Malformed
 * ENTRIES are dropped individually; an entry the flat list names but the array lacks is
 * classified in (so a row written by an older build reads as a complete v4 row), and the
 * flat projection is rebuilt from the result so the two can never disagree on read. */
function parseRepairSignature(
  raw: unknown,
  failingTests: readonly string[],
  fallback: { head: string; round: number },
): { signature: RepairSignatureEntry[]; failingTests: string[] } {
  const parsed: RepairSignatureEntry[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (!nonBlank(row.id)) continue;
      if (!(REPAIR_SIGNATURE_KINDS as readonly string[]).includes(row.kind as string)) continue;
      parsed.push({
        kind: row.kind as RepairSignatureKind,
        id: (row.id as string).trim(),
        recipe: nonBlank(row.recipe) ? (row.recipe as string) : REPAIR_SIGNATURE_FULL_GATE_RECIPE,
        ...(nonBlank(row.workspace) ? { workspace: row.workspace as string } : {}),
        admittedRound:
          Number.isInteger(row.admittedRound) && (row.admittedRound as number) >= 1
            ? (row.admittedRound as number)
            : fallback.round,
        measuredHead: nonBlank(row.measuredHead) ? (row.measuredHead as string) : fallback.head,
      });
    }
  }
  const known = new Set(parsed.map((entry) => entry.id));
  const missing = failingTests.filter((id) => nonBlank(id) && !known.has(id.trim()));
  const derived = classifyRepairSignature(missing).map((entry) => ({
    ...entry,
    admittedRound: fallback.round,
    measuredHead: fallback.head,
  }));
  const signature = boundedSignature([...parsed, ...derived]);
  return { signature, failingTests: signature.map((entry) => entry.id) };
}

/** These bounds stop unattended fixer churn. Exhaustion retains the candidate at the queue
 * head and NEVER authorizes a newer moving-tip candidate — D-005 of
 * frozen-candidate-stays-frozen-through-all-fixes-2026-09-03 (owner-ratified 2026-09-03). The
 * P-048/P-008 `maxCandidateEscapes` recut hatch that briefly existed (0 → 1/day on 2026-09-01)
 * was deleted outright: every automatic retire observed since 2026-08-19 was a re-cut in
 * disguise, and a re-cut is the treadmill the freeze exists to stop. An exhausted pin BLOCKS
 * and escalates; an admission through the one door (repair-head-admission.ts) un-blocks it. */
/* HISTORY of the DELETED `maxAgeMs` (P-010 / D-011 of
 * frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, 2026-09-04): it was 4h until
 * 2026-08-27 [owner 2026-08-27, approved in-session], then 8h, then gone.
 * WHY IT MOVED (WI-85288): the 4h budget was calibrated against fixers that never ran.
 * From 2026-08-24 16:57Z to 2026-08-27, EVERY dispatched release-fixer was SIGTERM'd at
 * exactly 300000ms by the release-fixer first-turn guard — measured lifetimes 301/301/300/301s
 * across four consecutive attempts, versus 31 healthy 'exited' runs averaging 1118s before
 * that cutoff. So a repair could burn all 3 attempts in ~15 minutes of wall clock and still
 * never produce a commit, and 4h never had to accommodate a fixer that actually worked.
 * With that guard fixed, a real fixer needs ~17min and the queue must outlive: dispatch +
 * fixer run + the NEXT hourly gate tick that verifies its commit. 4h could not: the
 * d513ccbc repair opened 09:24:23Z, its budget expired 13:24:23Z, and a live, healthy fixer
 * dispatched at 13:23:19Z was already inside a queue reading `hold-exhausted` — its commit
 * would have been discarded unverified at the 14:22:37Z evaluation.
 * 8h covers dispatch + a full fixer run + up to two hourly verification ticks.
 * WHY IT WAS DELETED (P-010): whatever the number, an age budget is an automatic retirement in
 * disguise — before D-005 an expired pin was re-cut at tip, after it the pin was BLOCKED from
 * verification, and on 2026-09-04 the restored 97c0b102 lineage (opened 22:23Z the day before)
 * would have been held `wall-clock-exhausted` on its first tick, unverifiable however many fixes
 * were admitted. The owner's directive is that a frozen candidate stays frozen until it is green
 * or an owner retires it, so AGE IS NOT AN INPUT to any queue decision. What the clock used to
 * do — make a long-held pin loud — is `FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS` below: the gate
 * escalates when the queue crosses 8h and again at every further 8h rung, clearing nothing.
 * NOT CHANGED: maxAttempts. */
export const DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS = Object.freeze({
  maxAttempts: 3,
});

/**
 * P-010: the cadence at which a still-open queue's AGE is escalated — at 8h, then every further
 * 8h. An alert cadence only: nothing reads it to clear, block or retire a queue.
 */
export const FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS = 8 * 60 * 60 * 1_000;

/** PURE: how many 8h rungs the queue's age has crossed (0 while it is under 8h old). */
export function frozenRepairAgeEscalationRung(
  queue: Pick<FrozenCandidateRepairQueue, 'openedAtMs'>,
  nowMs: number,
): number {
  const ageMs = Math.max(0, nowMs - queue.openedAtMs);
  return Math.floor(ageMs / FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS);
}

/**
 * A queue dispatch is an external side effect, so the metadata row needs a short-lived
 * ownership lease around the read -> launch -> finalize window.  The lease is deliberately
 * much shorter than the four-hour repair budget: a crashed launcher can be recovered on the
 * next checkpoint tick without permanently wedging the frozen queue.
 */
export const FROZEN_REPAIR_DISPATCH_RESERVATION_TTL_MS = 5 * 60 * 1_000;

/**
 * A freshly-created queue can legitimately spend a short interval at zero attempts while the
 * checkpoint moves from the red verdict to dispatch. Past this bound, zero attempts means no
 * fixer ever started — categorically different from a fixer that ran and failed.
 */
export const FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS = 15 * 60 * 1_000;

/**
 * WI-2141736: how long a frozen candidate may be HELD, past the zero-attempt stall, while a
 * measured provider wall outlasts that stall window — i.e. while the only available repair
 * path is agent/human convergence rather than an auto-fixer dispatch.
 *
 * 4h matched the queue's former `maxAgeMs` budget (deleted in P-010 — the queue now carries
 * no age bound at all, so this is simply the re-check cadence). Without this hold the 15-minute stall retires every
 * queue against a multi-day wall, which is how freeze-and-converge went silently off for a
 * full day (20 retirements, 0 resumes, 2026-09-02).
 */
export const FROZEN_REPAIR_CONVERGENCE_HOLD_MS = 4 * 60 * 60 * 1_000;

const MAX_PERSISTED_FAILURES = 50;
const MAX_PERSISTED_FAILURE_CHARS = 500;

export type FrozenCandidateRepairPhase =
  | 'ready-to-test'
  | 'awaiting-fixer'
  | 'ready-to-verify'
  | 'ready-to-promote'
  | 'blocked';
/**
 * P-010: `'wall-clock-exhausted'` is no longer a member — no decision can produce it. A row still
 * PERSISTED with it (blocked by the deleted 8h hold) is returned to `ready-to-verify` on parse.
 */
export type FrozenCandidateBlockedReason = 'attempts-exhausted' | 'dispatch-infeasible';

export interface FrozenRepairDispatchReservation {
  token: string;
  claimedAtMs: number;
  expiresAtMs: number;
}

/**
 * A confirmed admission's long R6 test leg.  The tool call returns after this marker is
 * persisted; a later call publishes only after `status:'passed'`.  Keeping the marker on the
 * queue makes `op:get` distinguish "still deciding" from "nothing landed", including across
 * MCP request boundaries.  The background leg never publishes the lineage ref itself.
 */
export interface FrozenRepairAdmissionPrecheck {
  schemaVersion: 1;
  operationId: string;
  status: 'running' | 'passed' | 'deferred' | 'failed';
  candidate: string;
  repairHead: string;
  builtCommit: string;
  sourceCommit?: string;
  /** Immutable content identity; unlike builtCommit, it excludes provenance-only message changes. */
  builtTree?: string;
  files: string[];
  actor: string;
  /** Process that owns the in-memory runner; absent on legacy R6 markers. */
  runnerPid?: number;
  /** Boot id + /proc start ticks, so a recycled PID cannot masquerade as the runner. */
  runnerPidIdentity?: string;
  /** WI-10006003: task-manager identity for a runner that outlives its serving host process. */
  runnerTaskId?: string;
  startedAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  /** File currently being measured; absent only on legacy rows written before R6 progress. */
  currentFile?: string | null;
  /** Number of files whose test process has completed. */
  completedCount?: number;
  /** Total files in the pre-check population, retained so readers need no reconstruction. */
  totalCount?: number;
  /** Last time the detached runner reported progress. */
  heartbeatAtMs?: number;
  verdict?: FixPrecheckVerdict;
}

export interface FrozenCandidateRepairQueue {
  /** Every version the parser accepts; a parsed row is always re-stamped with the current one. */
  schemaVersion: 1 | 2 | 3 | typeof FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION;
  phase: FrozenCandidateRepairPhase;
  /** The fixed C persisted before its first suite. Never moves for this queue entry. */
  candidate: string;
  /**
   * Durable logical qualification that created this queue. A later, distinct
   * qualification may retire only a safe, unstarted queue bearing the exact
   * predecessor id; legacy queues omit it and therefore remain fail-closed.
   */
  qualificationAttemptId?: string | null;
  /** The green pin observed when C was selected. */
  base: string | null;
  /** The head fixes move FORWARD from. Verification and promotion target this exact SHA. */
  repairHead: string;
  /** Initial gate process's PAPERCUSP_TEST_RUN_GROUP. Later verifiers keep their own runId;
   * this stable identity is only for affected-task proof reuse. Null means execute fully. */
  affectedTestProofGroup?: string | null;
  /** Number of fixer attempts actually dispatched (not reds observed or suites run). */
  attempts: number;
  /**
   * P-005 (gate-verdict-liveness): how many attempt REFUNDS this queue has granted for
   * fixers that died of INFRASTRUCTURE (spawn failure, provider-capacity rejection,
   * permission fault, first-turn guillotine — proven by zero recorded tool invocations)
   * without advancing the repair worktree. Measured 2026-08-31: 130/130 dispatches died
   * this way, each silently burning one of 3 attempts — repair budgets exhausted by
   * launches that never did repair. A refunded death is a FREE retry; the refund count is
   * bounded (maxFreeRetries) so a misclassification can never spin forever, and the
   * wall-clock budget still terminates the queue regardless. Optional and additive:
   * legacy rows parse with it absent (reads as 0); an older deployed build's whole-row
   * write drops it, which only resets the refund bookkeeping — never wedges (the P-008
   * CAS lesson).
   */
  freeRetries?: number;
  openedAtMs: number;
  updatedAtMs: number;
  /**
   * P-003 cross-plan integration: timestamp for the CURRENT fixer-succession state.
   * Unlike `updatedAtMs` (the generic row/version clock), this moves only when the queue
   * enters or replaces an `awaiting-fixer` state. Optional and additive so legacy rows
   * remain readable; the classifier falls back to `updatedAtMs` when it is absent.
   */
  fixerStateChangedAtMs?: number;
  /**
   * green-gate-zero-wait P-007 (R-7): the four clocks the latency projection reads, so idle
   * time on the repair path is MEASURED rather than anecdotal. Each is optional + additive
   * (legacy rows stay readable) and is stamped only by the transition that owns the event:
   * `fixerSpawnedAtMs` by fixer dispatch, `lastAdmittedAtMs` by admission onto the head,
   * `lastResumeRunStartedAtMs` when verification begins at the admitted repair head, and
   * `lastVerdictAtMs` by every verdict (candidate red, repair-head red, repair-head green).
   * Derive latencies with `frozenRepairLatency`; never hand-compute from `updatedAtMs`.
   */
  fixerSpawnedAtMs?: number;
  lastAdmittedAtMs?: number;
  lastResumeRunStartedAtMs?: number;
  lastVerdictAtMs?: number;
  /** Current/last spawn. A completion from any other spawn is stale and rejected. */
  fixerSpawnId: string | null;
  /** Automation may stop, but the queue head remains immutable until it is green. */
  blockedReason?: FrozenCandidateBlockedReason;
  /**
   * P-010: the highest 8h age rung the gate has already escalated for this queue (absent = none
   * yet). A monotone high-water mark so the age alert fires once per rung, never per tick.
   */
  ageEscalatedRung?: number;
  /** Short-lived CAS lease held only while one process launches this queue's fixer. */
  dispatchReservation?: FrozenRepairDispatchReservation;
  /** Observable, bounded R6 admission pre-check; publication requires a later confirmed call. */
  admissionPrecheck?: FrozenRepairAdmissionPrecheck;
  /**
   * P-006: the flat PROJECTION of `signature` (`signature.map(e => e.id)`), kept for every
   * consumer that correlates by id. Written together with `signature`; never diverges.
   */
  failingTests: string[];
  /**
   * P-006 / D-004: the TYPED failure signature — every red leg the judging run measured,
   * with its kind and the recipe that re-measures it. See the module docblock at
   * `RepairSignatureKind`. Required on schema 4; derived from `failingTests` for older rows.
   */
  signature: RepairSignatureEntry[];
  /**
   * P-013 / D-007 observability. `failingTests` is REPLACED on every red, so by the time a
   * reader asks "is this cycle converging?" the only evidence that it was ever larger is
   * gone. Each red appends one round here so the shrink across a convergence cycle survives.
   *
   * Optional and additive: legacy queues (and any queue that has not yet taken a red under
   * this build) parse with it absent, which reads as "no rounds recorded" — never as a
   * cycle that failed to converge.
   */
  convergenceRounds?: readonly FrozenRepairConvergenceRound[];
  /** Complete selective measurement, not a green/promotion certificate. Old readers may
   * drop it safely: the next verifier falls back to the cumulative admission radius. */
  selectiveCoverage?: FrozenRepairSelectiveCoverage;
  /** Once this cycle loses failure identities to a bound, a later smaller signature
   * does not recover them. Disable selective reuse for the rest of this cycle. */
  selectiveCoverageBlocked?: true;
  /**
   * P-002 — the NON-TEST gate legs (lint / perf / desktop / delta) as first-class members of
   * this cycle, with the same lifecycle a test file has: named, admitted by their own
   * measured result, and tracked as they resolve.
   *
   * A leg CANNOT live in `failingTests` and work: everything that correlates that list to
   * repair work correlates BY PATH, and a leg id is not a path. See `./repair-leg-lifecycle`
   * for the correlation-key ruling (D-005).
   *
   * Optional and additive, exactly like `convergenceRounds`: a legacy queue parses with it
   * absent, which reads as "no leg measurement recorded" — never as "no legs are failing".
   */
  legs?: readonly FrozenRepairLegState[];
  /**
   * P-001 / D-002 / D-006 — the ADMISSION LEDGER: every plumbing commit that advanced
   * `repairHead`, in order. Under D-002 `repairHead` moves ONLY by an entry here (fast-forward
   * to tip is gone), so this is both the audit trail ("what exactly is being judged, and who
   * put it there?") and the completion evidence P-022 reads. Optional and additive like `legs`:
   * a legacy queue parses with it absent, which reads as "no admission recorded".
   */
  admissions?: readonly FrozenRepairAdmission[];
  /**
   * green-gate-zero-wait P-001: the newest admitted head the currently-running checkpoint
   * process may not have seen. The admission writer persists this marker in the SAME row write
   * that advances repairHead. A checkpoint clears it only after completing a pass at this exact
   * head; a pass at an older head leaves it intact and self-refires in-process. Optional and
   * additive so a pre-P-001 row keeps parsing and simply relies on the ordinary routine tick.
   */
  retestRequested?: FrozenRepairRetestRequest;
  /**
   * WI-10003213: the repairHead at which the gate already spent its ONE free re-verification
   * for an UNMEASURED red — a red whose legs were killed/timed out/errored without any test
   * reporting a failure (`gate_health.failingTestsMeasured:false`). Such a red leaves the queue
   * in awaiting-fixer, where the fixer dispatcher correctly refuses ("nothing to reproduce")
   * and no other path runs a suite — so without this re-verification the queue deadlocks until
   * someone admits an unrelated change. Equal to `repairHead` ⇒ the retest is spent at this
   * head; a second unmeasured red there stays on the ordinary (dispatch-refused) path rather
   * than burning a full suite every tick. Optional and additive: a legacy row parses without it.
   */
  unmeasuredRetestHead?: string;
  /**
   * P-021 (D-007 #1): the per-leg REPAIR MANIFEST derived from this row — subject paths, red /
   * admitted / green status, the exact admit command, leg claims. Rebuilt by
   * `withRepairManifest` inside the ONE production write path (`writeFrozenCandidateRepairQueue`),
   * so it cannot describe a different row than the one it sits on. Optional so a pre-P-021 row
   * still parses; a malformed blob reads as absent, never as a partial manifest.
   */
  manifest?: RepairManifest;
}

/**
 * A persisted queue read whose FAILURE cannot be mistaken for ABSENCE (P-025).
 *
 * `parseFrozenCandidateRepairQueue()` remains the compatibility parser for callers whose
 * only safe response to any bad shape is `null`. Safety-critical readers use this union
 * instead: a JSONB null/missing key is genuinely absent, while a present row that this
 * build cannot understand is explicitly unreadable. In particular, a newer writer's
 * schema must never look like permission to cut a fresh candidate at staging tip.
 */
export type FrozenCandidateRepairQueueRead =
  | { status: 'value'; queue: FrozenCandidateRepairQueue }
  | { status: 'absent' }
  | {
      status: 'unreadable';
      reason: 'schema-newer-than-reader' | 'invalid-shape';
      /** Integer schema observed on the row, or null when the shape did not carry one. */
      schemaVersion: number | null;
      /**
       * Best-effort identity from the raw row. A newer writer can add fields this reader
       * cannot validate, but these stable coordinates still tell operators WHICH frozen
       * queue was preserved rather than collapsing it to "none".
       */
      candidate?: string | null;
      repairHead?: string | null;
      phase?: string | null;
    };

/**
 * One admission (see ./repair-head-admission.ts): the source commit the entries came from,
 * the head it was built on, the head it produced, and exactly which paths changed.
 */
export interface FrozenRepairAdmission {
  atMs: number;
  /** The agent (ownerId) that admitted — attribution lives here, never in git identity. */
  actor: string;
  /** The ref the caller named and the commit it resolved to at admission time. */
  source: { ref: string; sha: string };
  fromRepairHead: string;
  toRepairHead: string;
  /** Paths whose content changed on the lineage (== the proved diff-tree name set). */
  paths: string[];
  /** Allowlisted paths whose source content already equalled repairHead's — no diff, idempotent. */
  unchanged: string[];
  /** path -> blob/gitlink sha at the source, null for a deletion. */
  blobs: Record<string, string | null>;
  reason?: string;
  /**
   * P-020 (D-008 layers 2–3): HOW the source was built. `hunk-exact` (the default) replayed
   * only the ledgered hunks of `actor` (∪ `includeHunksFrom`) onto repairHead's blobs;
   * `whole-blob` admitted the integration branch's blob and may carry foreign work — then
   * `foreignHunksAccepted` / `foreignAgents` say how much and whose, and `reason` says why.
   * Absent on a pre-P-020 entry (which was whole-blob by construction).
   */
  mode?: 'hunk-exact' | 'whole-blob' | 'committed-patch';
  /**
   * P-006 / R6 (D-002): what the admission pre-check established at the built commit BEFORE
   * publication. `ran:true` carries the measured population; `ran:false` names why it did not
   * run (`checkpoint-tree-busy` = a gate run held the tree, accepted loud; `skipped` = the
   * caller opted out with `skipPrecheck` + `precheckReason`; `nothing-to-run`; `runner-failed`).
   */
  precheck?: {
    ran: boolean;
    reason?: string;
    detail?: string;
    precheckReason?: string;
    commit?: string;
    /** What the pre-check WOULD run (dry-run / skipped / busy) — the population it did not measure. */
    wouldRun?: string[];
    fixes?: string[];
    passing?: string[];
    failing?: string[];
    unmeasured?: string[];
  };
  /** Explicit reviewed commit delta; provenance is NOT hook or agent authorship. */
  patch?: { commit: string; parent: string; sha256: string };
  /** hunk-exact: per admitted path, how many ledgered hunks were replayed and by whom. */
  hunks?: Record<string, { applied: number; agents: string[] }>;
  /** whole-blob: the number of ledgered hunks by OTHER agents the admitted blobs may carry. */
  foreignHunksAccepted?: number;
  foreignAgents?: string[];
  /**
   * P-027 (D-014): HOW this ledger row came to exist. Absent ⇒ written by the admit door in the
   * same call that advanced the lineage ref. `reconciled-from-ref` ⇒ the row was REBUILT from
   * the admission commit itself (its `%P` parent, `%ct` time, diff-tree and trailers) by
   * `reconcileFrozenRepairQueueWithLineageRef`, because a lost-update had dropped the door's
   * row while the ref kept the commit. The entry is derived from the commit, never guessed.
   */
  provenance?: 'reconciled-from-ref';
}

/** Durable admission-to-checkpoint handoff. Identity is explicit so a stale process can never
 * clear a request belonging to another frozen candidate or a newer repair head. */
export interface FrozenRepairRetestRequest {
  candidate: string;
  repairHead: string;
  requestedAtMs: number;
}

export interface FrozenRepairSelectiveCoverage {
  schemaVersion: 1;
  candidate: string;
  head: string;
}

/** Invalid optional proof never invalidates the queue itself; it only disables reuse. */
export function parseFrozenRepairSelectiveCoverage(
  value: unknown,
  candidate: string,
): FrozenRepairSelectiveCoverage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const sha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40,64}$/.test(s);
  if (v.schemaVersion !== 1 || v.candidate !== candidate || !sha(v.candidate) || !sha(v.head)) return undefined;
  return { schemaVersion: 1, candidate: v.candidate, head: v.head };
}

function losslessFailureFrontier(input: {
  failingTests?: readonly string[];
  signature?: readonly { id: string; recipe?: string }[];
}): boolean {
  // Equality may be the result of an older writer's cap; never infer "exactly 50"
  // from a list whose writer keeps at most 50.
  return (input.failingTests?.length ?? 0) < MAX_PERSISTED_FAILURES &&
    (input.signature?.length ?? 0) < MAX_PERSISTED_FAILURES &&
    (input.failingTests ?? []).every((id) => id.length < MAX_PERSISTED_FAILURE_CHARS) &&
    (input.signature ?? []).every((entry) =>
      entry.id.length < MAX_PERSISTED_FAILURE_CHARS &&
      (entry.recipe?.length ?? 0) < MAX_PERSISTED_FAILURE_CHARS);
}

/** The compatibility parser may repair legacy data, but a proof cannot inherit that
 * lossy repair as evidence. Validate the RAW population before filtering/defaulting. */
function completeRawRepairSignature(value: unknown, failingTests: readonly string[]): value is RepairSignatureEntry[] {
  if (!Array.isArray(value) || value.length !== failingTests.length) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !nonBlank(entry.id) || entry.id !== entry.id.trim() ||
        !nonBlank(entry.recipe) ||
        !(REPAIR_SIGNATURE_KINDS as readonly string[]).includes(entry.kind) ||
        !Number.isInteger(entry.admittedRound) || entry.admittedRound < 1 ||
        !nonBlank(entry.measuredHead) || seen.has(entry.id) ||
        (entry.workspace !== undefined && !nonBlank(entry.workspace))) return false;
    seen.add(entry.id);
  }
  return new Set(failingTests).size === failingTests.length && failingTests.every((id) => seen.has(id));
}

function admissionSuffixPaths(queue: FrozenCandidateRepairQueue, from: string):
  { ok: true; paths: string[] } | { ok: false; reason: string } {
  const admissions = queue.admissions ?? [];
  const refused = (reason: string) => ({ ok: false as const, reason });
  if (from === queue.repairHead) return { ok: true, paths: [] };
  const start = admissions.findIndex((entry) => entry.fromRepairHead === from);
  if (start < 0) return refused('coverage-head-not-in-ledger');
  let head = from;
  const seen = new Set([head]);
  const paths = new Set<string>();
  for (const entry of admissions.slice(start)) {
    if (entry.fromRepairHead !== head || !/^[0-9a-f]{40,64}$/.test(entry.toRepairHead) ||
        seen.has(entry.toRepairHead)) return refused('admission-chain-discontinuous');
    if (entry.paths.length === 0 || entry.paths.some((p) =>
      !p || normalizeRepoPath(p) !== p || p.startsWith('/') ||
      p.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Object.prototype.hasOwnProperty.call(entry.blobs, p) ||
      (entry.blobs[p] !== null && !/^[0-9a-f]{40,64}$/.test(entry.blobs[p] ?? '')),
    )) return refused('admission-path-proof-incomplete');
    for (const p of entry.paths) paths.add(p);
    head = entry.toRepairHead;
    seen.add(head);
  }
  if (head !== queue.repairHead) return refused('admission-chain-wrong-head');
  return { ok: true, paths: [...paths].sort() };
}

/** A fallback over retained admissions is not necessarily COMPLETE coverage: the ledger
 * may have lost its prefix. Only a full candidate chain or an earlier complete receipt
 * joined to an exact suffix permits recording another receipt. */
export function selectFrozenRepairAdmissionPaths(queue: FrozenCandidateRepairQueue): {
  paths: string[];
  mode: 'delta' | 'cumulative';
  reason: string;
  coverageComplete: boolean;
} {
  const lossless = !queue.selectiveCoverageBlocked && losslessFailureFrontier(queue);
  const fallback = (reason: string) => ({
    paths: [...new Set((queue.admissions ?? []).flatMap((entry) => entry.paths))].sort(),
    mode: 'cumulative' as const,
    reason,
    coverageComplete: lossless && admissionSuffixPaths(queue, queue.candidate).ok,
  });
  if (!lossless) return fallback('failure-frontier-possibly-truncated');
  const coverage = parseFrozenRepairSelectiveCoverage(queue.selectiveCoverage, queue.candidate);
  if (!coverage) return fallback('no-complete-coverage');
  const suffix = admissionSuffixPaths(queue, coverage.head);
  if (!suffix.ok) return fallback(suffix.reason);
  return {
    paths: suffix.paths,
    mode: 'delta',
    reason: coverage.head === queue.repairHead ? 'head-already-covered' : 'complete-admission-suffix',
    coverageComplete: true,
  };
}

export type FrozenRepairRetestDecision =
  | { kind: 'none'; queue: FrozenCandidateRepairQueue; request: null }
  | { kind: 'settled'; queue: FrozenCandidateRepairQueue; request: FrozenRepairRetestRequest }
  | { kind: 'refire'; queue: FrozenCandidateRepairQueue; request: FrozenRepairRetestRequest };

/** Ledger cap: a runaway admission loop cannot grow the persisted queue without bound. The
 * NEWEST entries are kept — the ledger's job is "what is on the lineage now", and every
 * dropped entry's content is still reachable from the commits themselves. */
export const FROZEN_REPAIR_ADMISSION_CAP = 200;

function parseAdmissions(raw: unknown): FrozenRepairAdmission[] {
  if (!Array.isArray(raw)) return [];
  const out: FrozenRepairAdmission[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const source = e.source as Record<string, unknown> | null | undefined;
    if (!validTimestamp(e.atMs) || !nonBlank(e.actor) || !nonBlank(e.fromRepairHead) || !nonBlank(e.toRepairHead)) continue;
    if (!source || typeof source !== 'object' || Array.isArray(source) || !nonBlank(source.ref) || !nonBlank(source.sha)) continue;
    if (!Array.isArray(e.paths) || !e.paths.every((p) => typeof p === 'string')) continue;
    const unchanged =
      Array.isArray(e.unchanged) && e.unchanged.every((p) => typeof p === 'string') ? (e.unchanged as string[]) : [];
    const blobs: Record<string, string | null> = {};
    if (e.blobs && typeof e.blobs === 'object' && !Array.isArray(e.blobs)) {
      for (const [k, val] of Object.entries(e.blobs as Record<string, unknown>)) {
        if (val === null || typeof val === 'string') blobs[k] = val;
      }
    }
    // P-020 provenance fields: carried when well-formed, dropped (never guessed) otherwise.
    const strings = (v: unknown): string[] | null =>
      Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null;
    const hunks: Record<string, { applied: number; agents: string[] }> = {};
    let hunksValid = false;
    if (e.hunks && typeof e.hunks === 'object' && !Array.isArray(e.hunks)) {
      hunksValid = true;
      for (const [k, val] of Object.entries(e.hunks as Record<string, unknown>)) {
        const h = val as Record<string, unknown> | null;
        const agents = h ? strings(h.agents) : null;
        if (h && typeof h.applied === 'number' && Number.isFinite(h.applied) && agents) {
          hunks[k] = { applied: h.applied, agents };
        }
      }
    }
    const foreignAgents = strings(e.foreignAgents);
    const patch = e.patch as Record<string, unknown> | null | undefined;
    const validPatch = e.mode === 'committed-patch' && patch &&
      typeof patch.commit === 'string' && /^[0-9a-f]{40,64}$/.test(patch.commit) &&
      typeof patch.parent === 'string' && /^[0-9a-f]{40,64}$/.test(patch.parent) &&
      typeof patch.sha256 === 'string' && /^[0-9a-f]{64}$/.test(patch.sha256);
    out.push({
      atMs: e.atMs as number,
      actor: e.actor as string,
      source: { ref: source.ref as string, sha: source.sha as string },
      fromRepairHead: e.fromRepairHead as string,
      toRepairHead: e.toRepairHead as string,
      paths: e.paths as string[],
      unchanged,
      blobs,
      ...(nonBlank(e.reason) ? { reason: e.reason as string } : {}),
      ...(e.mode === 'hunk-exact' || e.mode === 'whole-blob' || e.mode === 'committed-patch' ? { mode: e.mode } : {}),
      ...(validPatch ? { patch: { commit: patch.commit as string, parent: patch.parent as string, sha256: patch.sha256 as string } } : {}),
      ...(hunksValid ? { hunks } : {}),
      ...(typeof e.foreignHunksAccepted === 'number' && Number.isFinite(e.foreignHunksAccepted)
        ? { foreignHunksAccepted: e.foreignHunksAccepted }
        : {}),
      ...(foreignAgents ? { foreignAgents } : {}),
      ...(e.provenance === 'reconciled-from-ref' ? { provenance: e.provenance } : {}),
    });
  }
  return out.slice(-FROZEN_REPAIR_ADMISSION_CAP);
}

/**
 * One observed red for a single frozen-candidate convergence cycle. Deliberately a COUNT and
 * not the failing set: the full set already lives in `failingTests` for the current round,
 * and persisting N copies of a 50-entry list is how a metadata blob becomes unbounded.
 */
export interface FrozenRepairConvergenceRound {
  /** 1-based position within this queue's cycle. Stable across cap-trimming (see below). */
  round: number;
  /** The head that was verified red for this round. */
  head: string;
  /** Size of the failing set observed at this round. */
  failingCount: number;
  atMs: number;
}

/**
 * Rounds are capped so a long cycle cannot grow the persisted queue without bound. The FIRST
 * round is retained on purpose even when trimming: it is the baseline every shrink figure is
 * measured against, so dropping it (the obvious ring-buffer behaviour) would silently destroy
 * the one number this field exists to produce.
 */
export const FROZEN_REPAIR_CONVERGENCE_ROUND_CAP = 24;

export interface FrozenRepairQueueLimits {
  maxAttempts: number;
  /**
   * P-005: cap on attempt refunds for unproductive infrastructure fixer deaths (see
   * FrozenCandidateRepairQueue.freeRetries). OPTIONAL so existing limit constructors are
   * not stranded; absence applies DEFAULT_FROZEN_REPAIR_MAX_FREE_RETRIES.
   */
  maxFreeRetries?: number;
}

/**
 * P-005: default refund budget. Six free retries ≈ one hour of ~10-min dispatch cycles —
 * enough to ride out a transient provider wall or a host restart window, small enough
 * that a persistently-failing spawn plane exhausts within the queue's 8h wall clock and
 * pages through the normal exhaustion path instead of churning silently.
 */
export const DEFAULT_FROZEN_REPAIR_MAX_FREE_RETRIES = 6;

export type FrozenRepairQueueDecision =
  | {
      kind: 'run-normal-gate';
      runSuite: true;
      recordVerdict: true;
    }
  | {
      kind: 'test-candidate';
      candidate: string;
      gateDisposition: 'initial-candidate';
      runSuite: true;
      recordVerdict: true;
    }
  | {
      kind: 'dispatch-fixer';
      reason: 'unassigned' | 'fixer-dead';
      nextAttempt: number;
      repairHead: string;
      runSuite: false;
      recordVerdict: false;
    }
  | FrozenRepairDispatchInfeasibleDecision
  | FrozenRepairDispatchPendingDecision
  | {
      kind: 'recover-dead-fixer';
      fixerSpawnId: string;
      repairHead: string;
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'wait-for-fixer';
      fixerSpawnId: string;
      liveness: 'live' | 'unknown';
      gateDisposition: 'inconclusive';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'wait-for-dispatch-reservation';
      reservationToken: string;
      reservationExpiresAtMs: number;
      gateDisposition: 'inconclusive';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'verify-repair';
      candidate: string;
      originalCandidate: string;
      gateDisposition: 'repair-verification';
      runSuite: true;
      recordVerdict: true;
    }
  | {
      kind: 'inspect-staging-patch';
      candidate: string;
      originalCandidate: string;
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'hold-staging-mismatch';
      candidate: string;
      originalCandidate: string;
      gateDisposition: 'inconclusive';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'promote-repair';
      candidate: string;
      originalCandidate: string;
      runSuite: false;
      recordVerdict: false;
    }
  | {
      /**
       * D-005 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): the ONLY answer to an
       * exhausted pin. The P-048 `recut-at-tip` escape was deleted — every automatic retire seen
       * since 2026-08-19 was a re-cut in disguise. The row, candidate and repairHead stay; the
       * gate escalates ONCE; an admission through the one door (P-001) un-blocks it.
       */
      kind: 'hold-exhausted';
      reason: FrozenCandidateBlockedReason;
      candidate: string;
      repairHead: string;
      gateDisposition: 'blocked';
      runSuite: false;
      recordVerdict: false;
    };

export interface FrozenRepairDispatchInfeasibleDecision {
  /** D-005: a measured, LASTING dispatch wall BLOCKS the queue (row/candidate/repairHead intact)
   * and escalates; it never retires or re-cuts. Agents converge onto it through admission. */
  kind: 'hold-dispatch-infeasible';
  reason: 'dispatch-infeasible';
  candidate: string;
  repairHead: string;
  attempts: number;
  ageMs: number;
  zeroAttemptStalled: boolean;
  zeroAttemptStallMs: number;
  gateDisposition: 'blocked';
  runSuite: false;
  recordVerdict: false;
}

/**
 * WI-2141736 Layer 2: a single measured capacity wall on a zero-attempt queue is not proof the
 * fixer's real provider is durably unreachable — this workspace pools many accounts behind a
 * rate governor specifically because a momentary wall is common and routinely clears within
 * minutes (see repo playbook: "a true quota wall is rare... verify before giving up"). Treating
 * the very first such reading as a structural dead end (the pre-Layer-2 behavior) discards the
 * frozen candidate and re-cuts at tip for a reason that has nothing to do with the code under
 * test — reinstating exactly the re-cut-at-tip treadmill D-007's freeze-and-converge exists to
 * stop. This decision holds the candidate — inconclusive, no verdict recorded — until the wall
 * has genuinely persisted past `zeroAttemptStallMs` AND the convergence hold; only then does
 * `hold-dispatch-infeasible` (a BLOCK, never a re-cut — D-005) fire.
 */
interface FrozenRepairDispatchPendingBase {
  kind: 'wait-for-dispatch-capacity';
  repairHead: string;
  attempts: number;
  ageMs: number;
  zeroAttemptStallMs: number;
  gateDisposition: 'inconclusive';
  runSuite: false;
  recordVerdict: false;
}

/**
 * DISCRIMINATED on `zeroAttemptStalled`, deliberately: the two holds carry different
 * evidence, and making that a type-level fact is what stops a consumer rendering a
 * long-wall field on the momentary hold (where it is genuinely absent) or hand-defaulting
 * it to a number the decision never measured. `capacityRetryAtMs` and `convergenceHoldMs`
 * exist EXACTLY when the hold is the long-wall one — that is not a convention to remember,
 * it is what the union says.
 */
export type FrozenRepairDispatchPendingDecision =
  | (FrozenRepairDispatchPendingBase & {
      /**
       * The momentary-churn hold: the stall window has NOT elapsed, so it is simply too
       * early to judge. Nothing about a provider wall's duration has been established.
       */
      zeroAttemptStalled: false;
      capacityRetryAtMs?: undefined;
      convergenceHoldMs?: undefined;
    })
  | (FrozenRepairDispatchPendingBase & {
      /**
       * The LONG-WALL hold: the stall window HAS elapsed, but the measured wall outlasts
       * it, so retiring would buy nothing and cost the freeze. Held for agent convergence
       * instead — which is why both bounds below are guaranteed here and only here.
       */
      zeroAttemptStalled: true;
      /** When the measured provider wall is expected to lift (null = the probe knew none). */
      capacityRetryAtMs: number | null;
      /** The age past which the hold gives up and retires anyway. */
      convergenceHoldMs: number;
    });

/**
 * WI-2141347: the dispatch-infeasible retire, but for a queue whose movable `repairHead` has
 * already ADVANCED past its frozen `candidate` (a path-exact admission — P-001 — only ever
 * commits admitted fix blobs onto the frozen lineage). Retiring that queue and
 * re-cutting at whatever staging tip happens to be NOW discards the converged lineage untested
 * and re-admits the full last-green radius for no reason: the repairHead is itself a perfectly
 * good candidate to test. The caller treats this exactly like a fresh `test-candidate` (abandon
 * the old queue's bookkeeping, test this sha as if newly cut) — never like a repair-in-progress.
 */
export type FrozenRepairDispatchInfeasibleOutcome =
  | FrozenRepairDispatchInfeasibleDecision
  | FrozenRepairDispatchPendingDecision
  | Extract<FrozenRepairQueueDecision, { kind: 'test-candidate' }>;

export interface FrozenRepairQueueObservation {
  nowMs: number;
  /** `null` means the liveness read failed; fail closed against duplicate dispatch. */
  fixerAlive?: boolean | null;
  /** `false` is a fresh, measured proof that no fixer can be dispatched right now. */
  dispatchFeasible?: boolean | null;
  /** Required only after a repair verified green. `null` means not measured yet. */
  stagingContainsRepair?: boolean | null;
  /**
   * P-009: repo-relative paths currently EDITED in the canonical shared checkout, as the
   * caller measured them (e.g. `git status --porcelain` over the staging tree).
   *
   * Optional and nullable on purpose, and the two mean DIFFERENT things: `undefined`/`null`
   * is "not measured" and must never render as "no collision". A missing measurement that
   * reads as a clean zero is precisely how a report-only guard becomes a false all-clear.
   */
  sharedTreeEditedPaths?: readonly string[] | null;
}

/**
 * P-009 (REPORT-ONLY): a frozen-candidate repair is in flight AND its failing paths are being
 * edited in the shared checkout.
 *
 * Why this is a hazard rather than a style complaint: the gate promotes an isolated repair only
 * after the exact patch is observed on staging (release-actions.ts:3831). So a shared-tree edit
 * to one of the frozen candidate's failing paths that diverges from the repair worktree does not
 * fail loudly — it silently withholds promotion, which reads as "the repair did not work".
 */
export interface FrozenRepairSharedTreeCollision {
  /** false ⇒ the caller supplied no measurement. NOT the same as zero colliding paths. */
  measured: boolean;
  /** Whether a repair is actually in flight; a collision is only meaningful when it is. */
  repairInFlight: boolean;
  /** Sorted intersection of the queue's failing paths with the edited shared-tree paths. */
  collidingPaths: string[];
  /** Full intersection size, independent of the `collidingPaths` display cap. */
  collisionCount: number;
  /** True when `collidingPaths` was capped and therefore under-lists `collisionCount`. */
  truncated: boolean;
  /** The loud line, or null when there is nothing to say. */
  detail: string | null;
}

export interface FrozenRepairQueueDiagnostic {
  /**
   * Explicit identity for the immutable pin. `candidate` is retained as the
   * compatibility spelling used by older consumers, but status surfaces should
   * prefer this field whenever they need to distinguish it from `repairHead`.
   */
  frozenCandidate?: string;
  phase: FrozenCandidateRepairPhase;
  candidate: string;
  repairHead: string;
  attempts: number;
  openedAtMs: number;
  updatedAtMs: number;
  ageMs: number;
  /**
   * P-010: the queue's age in 8h escalation rungs (0 under 8h) and the rung width. An alert
   * cadence the gate reads to re-surface a long-held pin — never a clear, block or retire input.
   */
  ageEscalationRung: number;
  ageEscalationIntervalMs: number;
  /** True only after an unassigned zero-attempt queue outlives the normal dispatch window. */
  zeroAttemptStalled: boolean;
  zeroAttemptStallMs: number;
  fixerSpawnId: string | null;
  fixerAlive: boolean | null;
  /** P-007 (R-7): red→fixer-spawn, fix→admit and admit→verdict latencies derived from the row. */
  repairLatency: FrozenRepairLatency;
  dispatchReservation: {
    token: string;
    claimedAtMs: number;
    expiresAtMs: number;
    active: boolean;
  } | null;
  /** Durable R6 work visible to `release:repair-queue { op:'get' }`; null means no decision is in flight. */
  admissionPrecheck?: FrozenRepairAdmissionPrecheck | null;
  decision: FrozenRepairQueueDecision['kind'];
  /**
   * Provenance for a no-suite repair status. `suiteRan:false` is the critical
   * discriminator: the mutable repair head is work in progress, not a judged
   * candidate. A status surface may still expose `candidate` for compatibility,
   * but must not imply that `repairHead` advanced the frozen pin.
   */
  /**
   * P-002/P-003 — the cycle's per-leg lifecycle, carried through so a diagnostic reader can
   * name WHICH non-test leg is failing and whether its own re-run has passed. Always present:
   * an empty array means this valid queue has no recorded leg measurement, never that the
   * diagnostic forgot to project the ledger.
   */
  legs: readonly FrozenRepairLegState[];
  /** P-006: the typed signature — WHAT is red, by kind, with the recipe that re-measures it.
   * The same population as `failingTests`, so the two never disagree. */
  signature: readonly RepairSignatureEntry[];
  /** P-011: every path-exact advance of repairHead, bounded by FROZEN_REPAIR_ADMISSION_CAP. */
  admissions: readonly FrozenRepairAdmission[];
  /** Why automation is blocked, or null while the queue remains actionable. */
  blockedReason: FrozenCandidateBlockedReason | null;
  verdictProvenance?: {
    frozenCandidate: string;
    repairHead: string;
    phase: FrozenCandidateRepairPhase;
    frozenCandidateVerdict: 'not-judged' | 'full-gate-red';
    repairHeadVerdict:
      | 'not-judged'
      | 'same-as-frozen-full-gate-red'
      | 'full-gate-red'
      | 'isolated-repair-green';
  };
  retireAllowed: boolean;
  retireRefusal: 'live-fixer' | 'liveness-unknown' | 'active-dispatch-reservation' | 'unsafe-phase' | null;
  nextAction: string | null;
  /**
   * P-009, REPORT-ONLY. This field is reported and nothing else: it must never feed `decision`,
   * `retireAllowed`, `retireRefusal` or `nextAction`. The plan asks for detection first so the
   * signal can be trusted before anything is allowed to block on it.
   */
  sharedTreeCollision: FrozenRepairSharedTreeCollision;
  /**
   * P-021 (D-007 #1): the per-leg repair manifest persisted on the row, carried onto the ONE
   * read model so release:repair-queue, dev:pipeline_position, the owner brief and /admin/git
   * render the same rows. `null` for a row written before P-021 (never a fabricated manifest).
   */
  manifest: RepairManifest | null;
  manifestSummary: RepairManifestSummary | null;
}

export function buildFrozenRepairStatusIdentity(queue: FrozenCandidateRepairQueue): {
  frozenCandidate: string;
  repairHead: string;
  phase: FrozenCandidateRepairPhase;
  verdictProvenance: NonNullable<FrozenRepairQueueDiagnostic['verdictProvenance']>;
} {
  // EI-22767271786772554: phase describes what the queue should do NEXT; it is not a
  // history of what this exact repair head has already measured. Every canonical red
  // writer appends a convergence round at the SHA it judged, so consult that durable
  // provenance before calling a distinct repair head "not-judged". A later green still
  // wins because ready-to-promote is the current, terminal verdict for this head.
  const repairHeadWasJudgedRed = (queue.convergenceRounds ?? []).some(
    (round) => round.head === queue.repairHead,
  );
  return {
    frozenCandidate: queue.candidate,
    repairHead: queue.repairHead,
    phase: queue.phase,
    verdictProvenance: {
      frozenCandidate: queue.candidate,
      repairHead: queue.repairHead,
      phase: queue.phase,
      // WI-10000287: there is deliberately NO `currentStatus` field here. It used to carry
      // `'no-suite' | 'isolated-suite-result'`, computed as `phase === 'ready-to-promote'` —
      // the SAME predicate as `repairHeadVerdict === 'isolated-repair-green'` three lines below,
      // so it never carried information that field does not. What it DID carry was a false
      // implicature: `currentStatus: 'no-suite'` reads as "no suite is running right now", and
      // during a live verifying run (phase `ready-to-verify`) that was exactly the value emitted
      // while a suite WAS running on this repairHead. Nothing in this read model observes process
      // liveness — it is a DB projection — so no field here may be named as though it does.
      // Liveness is answered by `node scripts/proc-guard.mjs check green-checkpoint`.
      frozenCandidateVerdict: queue.phase === 'ready-to-test' ? 'not-judged' : 'full-gate-red',
      repairHeadVerdict:
        queue.phase === 'ready-to-promote'
          ? 'isolated-repair-green'
          : queue.phase !== 'ready-to-test' && queue.repairHead === queue.candidate
            ? 'same-as-frozen-full-gate-red'
            : repairHeadWasJudgedRed
              ? 'full-gate-red'
              : 'not-judged',
    },
  };
}

/**
 * Measured dispatch infeasibility is not a candidate verdict. A momentary wall waits; a wall
 * that outlasts the convergence hold BLOCKS the queue (D-005) — the caller escalates once and
 * holds the frozen lineage for admission. It never retires and never reads the staging tip.
 */
export function decideFrozenRepairDispatchInfeasible(
  queue: FrozenCandidateRepairQueue,
  observation: {
    nowMs: number;
    zeroAttemptStallMs?: number;
    /**
     * When the measured provider wall is expected to lift, from the capacity preflight's
     * own `retryAtMs`. Absent/null = unknown, which keeps the pre-existing behaviour.
     */
    capacityRetryAtMs?: number | null;
    /**
     * How long a long-wall hold may keep the freeze while waiting for agent/human
     * convergence, before giving up and retiring anyway. Defaults to
     * FROZEN_REPAIR_CONVERGENCE_HOLD_MS.
     */
    convergenceHoldMs?: number;
  },
): FrozenRepairDispatchInfeasibleOutcome {
  assertTimestamp(observation.nowMs, 'nowMs');
  const zeroAttemptStallMs = observation.zeroAttemptStallMs ?? FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;
  if (!Number.isFinite(zeroAttemptStallMs) || zeroAttemptStallMs <= 0) {
    throw new Error('zeroAttemptStallMs must be a positive finite duration');
  }
  if (queue.phase !== 'awaiting-fixer' || queue.fixerSpawnId !== null || queue.dispatchReservation !== undefined) {
    throw new Error('dispatch infeasibility requires an unassigned awaiting-fixer queue without a reservation');
  }
  // WI-2141347: a repairHead that already moved past the frozen candidate (an admitted fix,
  // i.e. a commit ON the frozen lineage) is a structurally sound candidate to test even though
  // no fixer can be dispatched right now. Test it, exactly like a fresh candidate — the caller
  // abandons this queue's own bookkeeping, and a red there freezes a new queue at that same
  // in-lineage sha, never at the staging tip.
  if (queue.repairHead !== queue.candidate) {
    return {
      kind: 'test-candidate',
      candidate: queue.repairHead,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    };
  }
  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  const zeroAttemptStalled = queue.attempts === 0 && ageMs >= zeroAttemptStallMs;
  if (!zeroAttemptStalled) {
    // A momentary capacity wall on a queue that just opened (or has been open only briefly)
    // is not yet distinguishable from ordinary pool churn. Hold the candidate and report
    // inconclusive so the next tick re-measures rather than discarding it outright.
    return {
      kind: 'wait-for-dispatch-capacity',
      repairHead: queue.repairHead,
      attempts: queue.attempts,
      ageMs,
      zeroAttemptStalled: false,
      zeroAttemptStallMs,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }
  // WI-2141736: the stall window has elapsed — but retiring is only the right answer when
  // waiting could plausibly help. Measured 2026-09-02: the fixer's provider was walled for
  // SIX DAYS, so every queue stalled out after 15 minutes, retired, and re-cut at tip — 20
  // retirements, 0 resumes in one day, and freeze-and-converge was silently off fleet-wide.
  // Retiring bought nothing (the next queue hit the same wall 15 minutes later) and cost the
  // whole convergence property.
  //
  // "The AUTO-FIXER cannot be dispatched" is NOT "this queue is unreachable-green": agents
  // and humans converge onto frozen candidates routinely, and the `test-candidate` branch
  // above exists precisely to test a repairHead one of them advanced. So when the wall
  // OUTLASTS the stall window, hold the freeze and let convergence do the repair — bounded by
  // convergenceHoldMs so a candidate nobody converges still cannot pin the gate forever.
  const convergenceHoldMs = observation.convergenceHoldMs ?? FROZEN_REPAIR_CONVERGENCE_HOLD_MS;
  if (!Number.isFinite(convergenceHoldMs) || convergenceHoldMs <= 0) {
    throw new Error('convergenceHoldMs must be a positive finite duration');
  }
  const retryAtMs = observation.capacityRetryAtMs ?? null;
  const wallOutlastsStallWindow =
    retryAtMs !== null && Number.isFinite(retryAtMs) && retryAtMs - observation.nowMs > zeroAttemptStallMs;
  if (wallOutlastsStallWindow && ageMs < convergenceHoldMs) {
    return {
      kind: 'wait-for-dispatch-capacity',
      repairHead: queue.repairHead,
      attempts: queue.attempts,
      ageMs,
      zeroAttemptStalled: true,
      zeroAttemptStallMs,
      capacityRetryAtMs: retryAtMs,
      convergenceHoldMs,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }
  // D-005: the wall outlasted the convergence hold. BLOCK — row, candidate and repairHead
  // intact — and let the caller escalate once. Never retire, never re-cut: an admission
  // through the one door (P-001 / markFrozenRepairAdmitted) is what un-blocks this queue.
  return {
    kind: 'hold-dispatch-infeasible',
    reason: 'dispatch-infeasible',
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    attempts: queue.attempts,
    ageMs,
    zeroAttemptStalled: true,
    zeroAttemptStallMs,
    gateDisposition: 'blocked',
    runSuite: false,
    recordVerdict: false,
  };
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parse liveness metadata fail-soft: a malformed marker must not make the safety-critical
 * frozen queue unreadable. Dropping it costs only the ordinary scheduled backstop. */
function parseFrozenRepairRetestRequest(
  value: unknown,
  candidate: string,
  updatedAtMs: number,
): FrozenRepairRetestRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    row.candidate !== candidate ||
    !nonBlank(row.repairHead) ||
    !validTimestamp(row.requestedAtMs) ||
    row.requestedAtMs > updatedAtMs
  ) {
    return undefined;
  }
  return {
    candidate,
    repairHead: row.repairHead,
    requestedAtMs: row.requestedAtMs,
  };
}

function parseDispatchReservation(value: unknown): FrozenRepairDispatchReservation | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!nonBlank(row.token) || !validTimestamp(row.claimedAtMs) || !validTimestamp(row.expiresAtMs)) return null;
  if ((row.expiresAtMs as number) < (row.claimedAtMs as number)) return null;
  return {
    token: row.token,
    claimedAtMs: row.claimedAtMs as number,
    expiresAtMs: row.expiresAtMs as number,
  };
}

function parseAdmissionPrecheck(value: unknown): FrozenRepairAdmissionPrecheck | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1) return undefined;
  if (row.status !== 'running' && row.status !== 'passed' && row.status !== 'deferred' && row.status !== 'failed') return undefined;
  const files = Array.isArray(row.files) ? row.files : null;
  if (
    !nonBlank(row.operationId) ||
    !nonBlank(row.candidate) ||
    !nonBlank(row.repairHead) ||
    !nonBlank(row.builtCommit) ||
    (row.sourceCommit !== undefined &&
      (typeof row.sourceCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(row.sourceCommit))) ||
    (row.builtTree !== undefined && !nonBlank(row.builtTree)) ||
    !nonBlank(row.actor) ||
    (row.runnerPid !== undefined && (!Number.isInteger(row.runnerPid) || (row.runnerPid as number) <= 0)) ||
    (row.runnerPidIdentity !== undefined && (!nonBlank(row.runnerPidIdentity) || row.runnerPid === undefined)) ||
    (row.runnerTaskId !== undefined && !nonBlank(row.runnerTaskId)) ||
    !files ||
    !files.every(nonBlank) ||
    !validTimestamp(row.startedAtMs) ||
    !validTimestamp(row.updatedAtMs) ||
    !validTimestamp(row.expiresAtMs) ||
    (row.updatedAtMs as number) < (row.startedAtMs as number) ||
    (row.expiresAtMs as number) < (row.startedAtMs as number)
  ) return undefined;
  const hasProgress = 'currentFile' in row || 'completedCount' in row || 'totalCount' in row || 'heartbeatAtMs' in row;
  let progress: Pick<FrozenRepairAdmissionPrecheck, 'currentFile' | 'completedCount' | 'totalCount' | 'heartbeatAtMs'> | undefined;
  if (hasProgress) {
    const currentFile = row.currentFile === null ? null : row.currentFile;
    if (
      (currentFile !== null && !nonBlank(currentFile)) ||
      (typeof currentFile === 'string' && !files.includes(currentFile)) ||
      !Number.isInteger(row.completedCount) ||
      (row.completedCount as number) < 0 ||
      (row.completedCount as number) > files.length ||
      !Number.isInteger(row.totalCount) ||
      row.totalCount !== files.length ||
      !validTimestamp(row.heartbeatAtMs) ||
      (row.heartbeatAtMs as number) > (row.updatedAtMs as number)
    ) return undefined;
    progress = {
      currentFile: currentFile as string | null,
      completedCount: row.completedCount as number,
      totalCount: row.totalCount as number,
      heartbeatAtMs: row.heartbeatAtMs as number,
    };
  }
  const verdict = row.verdict;
  if (row.status === 'running' && verdict !== undefined) return undefined;
  if (
    row.status !== 'running' &&
    (!verdict || typeof verdict !== 'object' || Array.isArray(verdict) ||
      typeof (verdict as Record<string, unknown>).ok !== 'boolean')
  ) return undefined;
  return {
    schemaVersion: 1,
    operationId: row.operationId as string,
    status: row.status,
    candidate: row.candidate as string,
    repairHead: row.repairHead as string,
    builtCommit: row.builtCommit as string,
    ...(typeof row.sourceCommit === 'string' ? { sourceCommit: row.sourceCommit } : {}),
    ...(nonBlank(row.builtTree) ? { builtTree: row.builtTree } : {}),
    files: [...(row.files as string[])],
    actor: row.actor as string,
    ...(typeof row.runnerPid === 'number' ? { runnerPid: row.runnerPid } : {}),
    ...(typeof row.runnerPidIdentity === 'string' ? { runnerPidIdentity: row.runnerPidIdentity } : {}),
    ...(typeof row.runnerTaskId === 'string' ? { runnerTaskId: row.runnerTaskId } : {}),
    startedAtMs: row.startedAtMs as number,
    updatedAtMs: row.updatedAtMs as number,
    expiresAtMs: row.expiresAtMs as number,
    ...(progress ?? {}),
    ...(verdict ? { verdict: verdict as FixPrecheckVerdict } : {}),
  };
}

function assertTimestamp(value: number, label: string): void {
  if (!validTimestamp(value)) throw new Error(`${label} must be a finite non-negative timestamp`);
}

function assertLimits(limits: FrozenRepairQueueLimits): void {
  if (!Number.isInteger(limits.maxAttempts) || limits.maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (
    limits.maxFreeRetries !== undefined &&
    (!Number.isInteger(limits.maxFreeRetries) || limits.maxFreeRetries < 0)
  ) {
    throw new Error('maxFreeRetries must be a non-negative integer when provided');
  }
}

function boundedFailures(values: readonly string[]): string[] {
  return values
    .filter(nonBlank)
    .slice(0, MAX_PERSISTED_FAILURES)
    .map((value) => value.slice(0, MAX_PERSISTED_FAILURE_CHARS));
}

function parseConvergenceRounds(value: unknown): FrozenRepairConvergenceRound[] {
  if (!Array.isArray(value)) return [];
  const rounds: FrozenRepairConvergenceRound[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!Number.isInteger(row.round) || (row.round as number) < 1) continue;
    if (!nonBlank(row.head)) continue;
    if (!Number.isInteger(row.failingCount) || (row.failingCount as number) < 0) continue;
    if (!validTimestamp(row.atMs)) continue;
    rounds.push({
      round: row.round as number,
      head: row.head,
      failingCount: row.failingCount as number,
      atMs: row.atMs as number,
    });
  }
  return capConvergenceRounds(rounds);
}

/**
 * Trim to the cap while ALWAYS retaining the first round. A plain `.slice(-cap)` would drop
 * the baseline the shrink is measured against, so a long cycle would report `shrinkTotal:
 * null` exactly when the convergence question matters most.
 */
function capConvergenceRounds(rounds: readonly FrozenRepairConvergenceRound[]): FrozenRepairConvergenceRound[] {
  if (rounds.length <= FROZEN_REPAIR_CONVERGENCE_ROUND_CAP) return [...rounds];
  const first = rounds[0] as FrozenRepairConvergenceRound;
  return [first, ...rounds.slice(-(FROZEN_REPAIR_CONVERGENCE_ROUND_CAP - 1))];
}

/**
 * Append the round this red represents. `round` numbers keep counting from the highest one
 * already recorded, so cap-trimming never renumbers history or makes two rounds share an
 * index.
 */
function appendConvergenceRound(
  queue: FrozenCandidateRepairQueue,
  input: { head: string; failingTests: readonly string[]; nowMs: number },
): FrozenRepairConvergenceRound[] {
  const existing = queue.convergenceRounds ?? [];
  const highest = existing.reduce((max, entry) => (entry.round > max ? entry.round : max), 0);
  return capConvergenceRounds([
    ...existing,
    {
      round: highest + 1,
      head: input.head,
      failingCount: boundedFailures(input.failingTests).length,
      atMs: input.nowMs,
    },
  ]);
}

function requirePhase(queue: FrozenCandidateRepairQueue, phase: FrozenCandidateRepairPhase, operation: string): void {
  if (queue.phase !== phase) {
    throw new Error(`${operation} requires phase ${phase}; found ${queue.phase}`);
  }
}

function requireCurrentHead(queue: FrozenCandidateRepairQueue, repairHead: string): void {
  if (queue.repairHead !== repairHead) {
    throw new Error(`stale repair result for ${repairHead}; queue expects ${queue.repairHead}`);
  }
}

/** Persist the immutable candidate before its first suite. A process crash or moving staging
 * tip cannot replace it; the next gate invocation resumes this exact SHA. */
export function createFrozenCandidateQueue(
  input: RepairSignatureRedInput & {
    candidate: string;
    qualificationAttemptId?: string | null;
    base: string | null;
    affectedTestProofGroup?: string | null;
    nowMs: number;
  },
): FrozenCandidateRepairQueue {
  if (!nonBlank(input.candidate)) throw new Error('candidate must be non-empty');
  if (input.base !== null && !nonBlank(input.base)) throw new Error('base must be null or non-empty');
  assertTimestamp(input.nowMs, 'nowMs');
  // A queue persisted BEFORE its first suite carries no signature yet; a compatibility caller
  // that learned about the candidate at its red hands the failing set in here, and it is
  // typed from the start (round 1, measured at the candidate itself).
  const { signature, failingTests } = nextRepairSignature([], {
    ...input,
    head: input.candidate,
    round: 1,
  });
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: 'ready-to-test',
    candidate: input.candidate,
    qualificationAttemptId: nonBlank(input.qualificationAttemptId) ? input.qualificationAttemptId : null,
    base: input.base,
    repairHead: input.candidate,
    affectedTestProofGroup: nonBlank(input.affectedTestProofGroup) ? input.affectedTestProofGroup : null,
    attempts: 0,
    openedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    fixerSpawnId: null,
    failingTests: boundedFailures(failingTests),
    signature,
  };
}

/** Compatibility constructor for callers that first learn about the candidate at its red
 * verdict. New production orchestration persists through createFrozenCandidateQueue earlier. */
export function createFrozenCandidateRepairQueue(
  input: Parameters<typeof createFrozenCandidateQueue>[0],
): FrozenCandidateRepairQueue {
  return markFrozenCandidateVerificationRed(createFrozenCandidateQueue(input), {
    failingTests: input.failingTests,
    signature: input.signature,
    measuredKinds: input.measuredKinds,
    signatureContext: input.signatureContext,
    nowMs: input.nowMs,
  });
}

/** Parse a JSONB metadata value without letting a malformed queue steer the release gate. */
export function parseFrozenCandidateRepairQueue(value: unknown): FrozenCandidateRepairQueue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 &&
    row.schemaVersion !== 2 &&
    row.schemaVersion !== 3 &&
    row.schemaVersion !== FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION
  )
    return null;
  if (
    row.phase !== 'ready-to-test' &&
    row.phase !== 'awaiting-fixer' &&
    row.phase !== 'ready-to-verify' &&
    row.phase !== 'ready-to-promote' &&
    row.phase !== 'blocked'
  )
    return null;
  if (!nonBlank(row.candidate) || !nonBlank(row.repairHead)) {
    return null;
  }
  if (row.qualificationAttemptId != null && !nonBlank(row.qualificationAttemptId)) return null;
  if (row.base !== null && !nonBlank(row.base)) return null;
  if (!Number.isInteger(row.attempts) || (row.attempts as number) < 0) return null;
  if (!validTimestamp(row.openedAtMs) || !validTimestamp(row.updatedAtMs)) return null;
  if ((row.updatedAtMs as number) < (row.openedAtMs as number)) return null;
  if (row.fixerSpawnId !== null && !nonBlank(row.fixerSpawnId)) return null;
  const dispatchReservation = parseDispatchReservation(row.dispatchReservation);
  if (dispatchReservation === null) return null;
  const admissionPrecheck = parseAdmissionPrecheck(row.admissionPrecheck);
  if (!Array.isArray(row.failingTests) || !row.failingTests.every((v) => typeof v === 'string')) {
    return null;
  }
  // P-001 / D-010: a verification phase is reached EITHER by a dispatched fixer (attempts ≥ 1
  // and a spawn id) OR by an admission through the one door — an admitted fix from any agent
  // needs no fixer bookkeeping. A legacy row with no admissions keeps the old invariant exactly.
  const admissions = parseAdmissions(row.admissions);
  const retestRequested = parseFrozenRepairRetestRequest(
    row.retestRequested,
    row.candidate,
    row.updatedAtMs as number,
  );
  // WI-10003213: the once-per-head unmeasured-red retest is the third legitimate route into a
  // verification phase (no fixer, no admission — the gate itself re-verifies a head whose red
  // measured no failing test). Only a marker naming the CURRENT head vouches for that.
  const unmeasuredRetestHead =
    nonBlank(row.unmeasuredRetestHead) ? (row.unmeasuredRetestHead as string) : undefined;
  if (row.phase === 'ready-to-verify' || row.phase === 'ready-to-promote') {
    const viaFixer = (row.attempts as number) >= 1 && nonBlank(row.fixerSpawnId);
    const viaUnmeasuredRetest = unmeasuredRetestHead !== undefined && unmeasuredRetestHead === row.repairHead;
    if (!viaFixer && admissions.length === 0 && !viaUnmeasuredRetest) return null;
  }
  /**
   * Rounds are OBSERVABILITY, not safety, so a malformed value is dropped rather than
   * failing the whole parse. The queue itself is the gate's safety state — refusing to
   * parse a live queue because a display-only history entry is corrupt would discard the
   * frozen head and let the treadmill D-007 exists to stop resume. Losing the history is
   * the strictly smaller failure, and it is visible (rounds read as absent).
   */
  const convergenceRounds = parseConvergenceRounds(row.convergenceRounds);
  const rawSignature = row.signature;
  const rawSignatureComplete = completeRawRepairSignature(rawSignature, row.failingTests as string[]);
  const selectiveCoverageBlocked = row.selectiveCoverageBlocked === true ||
    (row.signature !== undefined && !rawSignatureComplete) ||
    (row.selectiveCoverage !== undefined && !rawSignatureComplete) ||
    !losslessFailureFrontier({
      failingTests: row.failingTests as string[],
      signature: rawSignatureComplete ? rawSignature : undefined,
    });
  const selectiveCoverage = selectiveCoverageBlocked
    ? undefined : parseFrozenRepairSelectiveCoverage(row.selectiveCoverage, row.candidate);
  // P-002 legs are observability on the same terms as rounds above: malformed entries are
  // dropped individually, never failing the parse of a live queue.
  const legs = parseRepairLegStates(row.legs);
  const manifest = parseRepairManifest(row.manifest);
  // P-010: a row PERSISTED as blocked by the deleted 8h wall-clock hold is returned to
  // verification on read. The hold no longer exists, so no decision could ever un-wedge such a
  // row; leaving it blocked behind a reason nothing produces any more is the fossil P-010 removed.
  const wallClockLegacyHold = row.phase === 'blocked' && row.blockedReason === 'wall-clock-exhausted';
  const blockedReason =
    row.blockedReason === 'attempts-exhausted' || row.blockedReason === 'dispatch-infeasible'
      ? row.blockedReason
      : undefined;
  if (row.phase === 'blocked' && !blockedReason && !wallClockLegacyHold) return null;
  const ageEscalatedRung =
    Number.isInteger(row.ageEscalatedRung) && (row.ageEscalatedRung as number) > 0
      ? (row.ageEscalatedRung as number)
      : undefined;
  // P-003 cross-plan integration: malformed/forward-skewed clock state is observability
  // metadata, not a reason to discard the queue. Accept it only when it is a sane timestamp
  // no newer than the row version; the classifier falls back to `updatedAtMs` otherwise.
  const fixerStateChangedAtMs =
    validTimestamp(row.fixerStateChangedAtMs) &&
    (row.fixerStateChangedAtMs as number) <= (row.updatedAtMs as number)
      ? (row.fixerStateChangedAtMs as number)
      : undefined;
  // P-006 / P-014: a pre-schema-4 row (or a v4 row an older build rewrote without the array)
  // gets its typed signature DERIVED from the flat list — the live queue keeps parsing across
  // the bump, and the flat projection is rebuilt from the result so the two agree on read.
  const highestRound = convergenceRounds.reduce((max, entry) => (entry.round > max ? entry.round : max), 0);
  const typed = parseRepairSignature(row.signature, row.failingTests as string[], {
    head: row.repairHead,
    round: highestRound || 1,
  });
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: wallClockLegacyHold ? 'ready-to-verify' : row.phase,
    candidate: row.candidate,
    qualificationAttemptId: nonBlank(row.qualificationAttemptId) ? row.qualificationAttemptId : null,
    base: row.base as string | null,
    repairHead: row.repairHead,
    // v1/missing/malformed proof state keeps the queue valid but forces full execution.
    affectedTestProofGroup: nonBlank(row.affectedTestProofGroup) ? row.affectedTestProofGroup : null,
    attempts: row.attempts as number,
    // P-005 refund bookkeeping is observability-adjacent: malformed values read as absent
    // (0 refunds granted) rather than failing the parse — same rationale as rounds above.
    ...(Number.isInteger(row.freeRetries) && (row.freeRetries as number) > 0
      ? { freeRetries: row.freeRetries as number }
      : {}),
    openedAtMs: row.openedAtMs,
    updatedAtMs: row.updatedAtMs,
    ...(fixerStateChangedAtMs !== undefined ? { fixerStateChangedAtMs } : {}),
    ...parseRepairLatencyStamps(row as Record<string, unknown>),
    fixerSpawnId: row.fixerSpawnId as string | null,
    ...(blockedReason ? { blockedReason } : {}),
    ...(ageEscalatedRung !== undefined ? { ageEscalatedRung } : {}),
    ...(dispatchReservation ? { dispatchReservation } : {}),
    ...(admissionPrecheck ? { admissionPrecheck } : {}),
    ...(convergenceRounds.length > 0 ? { convergenceRounds } : {}),
    ...(selectiveCoverage ? { selectiveCoverage } : {}),
    ...(selectiveCoverageBlocked ? { selectiveCoverageBlocked: true as const } : {}),
    ...(legs.length > 0 ? { legs } : {}),
    ...(admissions.length > 0 ? { admissions } : {}),
    ...(retestRequested ? { retestRequested } : {}),
    ...(unmeasuredRetestHead !== undefined ? { unmeasuredRetestHead } : {}),
    ...(manifest ? { manifest } : {}),
    failingTests: boundedFailures(typed.failingTests),
    signature: typed.signature,
  };
}

/**
 * Parse the persisted repair queue without collapsing a present-but-unreadable row into
 * absence. The current parser accepts legacy schemas 1–4; a schema above that range is a
 * version-skew signal, not evidence that no candidate is frozen.
 */
export function parseFrozenCandidateRepairQueueRead(
  value: unknown,
): FrozenCandidateRepairQueueRead {
  if (value == null) return { status: 'absent' };
  const queue = parseFrozenCandidateRepairQueue(value);
  if (queue) return { status: 'value', queue };

  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const schemaVersion =
    raw && Number.isSafeInteger(raw.schemaVersion)
      ? (raw.schemaVersion as number)
      : null;
  const rawString = (key: string): string | null => {
    const candidate = raw?.[key];
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
  };
  const identity = {
    candidate: rawString('candidate'),
    repairHead: rawString('repairHead'),
    phase: rawString('phase'),
  };
  return schemaVersion !== null && schemaVersion > FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION
    ? { status: 'unreadable', reason: 'schema-newer-than-reader', schemaVersion, ...identity }
    : { status: 'unreadable', reason: 'invalid-shape', schemaVersion, ...identity };
}

/** One bounded, shared explanation for every fail-closed unreadable-queue surface. */
export function describeUnreadableFrozenCandidateRepairQueue(
  read: Extract<FrozenCandidateRepairQueueRead, { status: 'unreadable' }>,
): string {
  const schema = read.schemaVersion === null ? 'unknown' : String(read.schemaVersion);
  const identity = [
    read.candidate ? `candidate ${read.candidate.slice(0, 12)}` : null,
    read.repairHead ? `repairHead ${read.repairHead.slice(0, 12)}` : null,
    read.phase ? `phase ${read.phase}` : null,
  ].filter((part): part is string => part !== null);
  return (
    `a persisted frozen repair queue is unreadable (${read.reason}, schema ${schema}; ` +
    `reader supports through ${FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION})` +
    (identity.length > 0 ? `; raw identity: ${identity.join(', ')}` : '')
  );
}

/** Decide the next orchestration step. A queue always wins over a moving staging tip. */
/**
 * The ONE policy point for "this pin is exhausted; now what?" — centralized so the answer
 * cannot differ between the three exhaustion sites.
 *
 * D-005 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): exhaustion BLOCKS and
 * escalates; it never re-cuts. An exhausted pin is not a deadlock any more: the queue stays
 * addressable, and an admission (markFrozenRepairAdmitted, via repair-head-admission.ts) lands
 * a fix ON the frozen lineage and returns the queue to verification. The P-048/P-008 escape
 * hatch that used to answer `recut-at-tip` here was deleted — every automatic retire seen
 * since 2026-08-19 was a re-cut in disguise, and the owner wants the candidate held until it
 * is green.
 */
function decideExhaustedPin(
  queue: FrozenCandidateRepairQueue,
  reason: FrozenCandidateBlockedReason,
): FrozenRepairQueueDecision {
  return {
    kind: 'hold-exhausted',
    reason,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    gateDisposition: 'blocked',
    runSuite: false,
    recordVerdict: false,
  };
}

export function decideFrozenCandidateRepairQueue(
  queue: FrozenCandidateRepairQueue | null,
  observation: FrozenRepairQueueObservation,
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenRepairQueueDecision {
  assertTimestamp(observation.nowMs, 'nowMs');
  assertLimits(limits);
  if (!queue) return { kind: 'run-normal-gate', runSuite: true, recordVerdict: true };

  if (queue.phase === 'ready-to-test') {
    return {
      kind: 'test-candidate',
      candidate: queue.candidate,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    };
  }
  if (queue.phase === 'blocked') {
    // A queue PERSISTED as blocked is the steady state of the hold: it re-decides to the same
    // hold every tick (the caller escalates only on the open→blocked transition) until an
    // admission moves the phase back to ready-to-verify.
    return decideExhaustedPin(queue, queue.blockedReason!);
  }

  // A dispatch lease serializes launchers; it is not liveness authority for a fixer that
  // already exists. Recover the definitively-dead fixer first so a stale lease cannot hide
  // its finished worktree or wedge the queue until expiry. The caller persists the recovered
  // state, then re-runs this policy so the normal age/attempt limits still decide whether a
  // replacement may launch.
  if (queue.phase === 'awaiting-fixer' && queue.fixerSpawnId && observation.fixerAlive === false) {
    return {
      kind: 'recover-dead-fixer',
      fixerSpawnId: queue.fixerSpawnId,
      repairHead: queue.repairHead,
      runSuite: false,
      recordVerdict: false,
    };
  }

  // P-010 / D-011: the queue's AGE is deliberately NOT an input here. The 8h `maxAgeMs` hold
  // that used to sit at this point was an automatic retirement in disguise (a re-cut at tip
  // before D-005, an unverifiable block after it). A frozen candidate is held until it is green
  // or an owner retires it; its age is escalated by the gate on an 8h cadence instead
  // (`frozenRepairAgeEscalationRung`), which clears nothing.

  if (queue.phase === 'awaiting-fixer') {
    // A measured provider wall with no fixer ever dispatched is a structural dead end, not an
    // inconclusive repair. Retire this queue and let the caller re-triage the current tip. A
    // queue with prior attempts remains on the ordinary bounded-repair path; those attempts are
    // evidence that dispatch was feasible at least once and must not be silently discarded.
    if (
      observation.dispatchFeasible === false &&
      queue.attempts === 0 &&
      queue.fixerSpawnId === null &&
      !queue.dispatchReservation
    ) {
      return decideFrozenRepairDispatchInfeasible(queue, observation);
    }
    if (queue.dispatchReservation && queue.dispatchReservation.expiresAtMs > observation.nowMs) {
      return {
        kind: 'wait-for-dispatch-reservation',
        reservationToken: queue.dispatchReservation.token,
        reservationExpiresAtMs: queue.dispatchReservation.expiresAtMs,
        gateDisposition: 'inconclusive',
        runSuite: false,
        recordVerdict: false,
      };
    }
    if (!queue.fixerSpawnId || observation.fixerAlive === false) {
      if (queue.attempts >= limits.maxAttempts) {
        return decideExhaustedPin(queue, 'attempts-exhausted');
      }
      return {
        kind: 'dispatch-fixer',
        reason: queue.fixerSpawnId ? 'fixer-dead' : 'unassigned',
        nextAttempt: queue.attempts + 1,
        repairHead: queue.repairHead,
        runSuite: false,
        recordVerdict: false,
      };
    }
    return {
      kind: 'wait-for-fixer',
      fixerSpawnId: queue.fixerSpawnId,
      liveness: observation.fixerAlive === true ? 'live' : 'unknown',
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }

  if (queue.phase === 'ready-to-verify') {
    return {
      kind: 'verify-repair',
      candidate: queue.repairHead,
      originalCandidate: queue.candidate,
      gateDisposition: 'repair-verification',
      runSuite: true,
      recordVerdict: true,
    };
  }

  if (observation.stagingContainsRepair == null) {
    return {
      kind: 'inspect-staging-patch',
      candidate: queue.repairHead,
      originalCandidate: queue.candidate,
      runSuite: false,
      recordVerdict: false,
    };
  }
  if (!observation.stagingContainsRepair) {
    return {
      kind: 'hold-staging-mismatch',
      candidate: queue.repairHead,
      originalCandidate: queue.candidate,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }
  return {
    kind: 'promote-repair',
    candidate: queue.repairHead,
    originalCandidate: queue.candidate,
    runSuite: false,
    recordVerdict: false,
  };
}

/** One normalized, bounded read model shared by every release diagnostic surface. */
/** How many colliding paths the report lists inline before it says it capped them. */
export const FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP = 20;

/**
 * Compare paths without tripping over `./` prefixes or Windows separators.
 *
 * EXPORTED because the P-004 edit-time hook must classify an edited path the SAME way the
 * gate does. The hook is plain `.mjs` installed outside the repo and cannot import this
 * module, so it carries its own copy — pinned against this one by
 * `frozen-repair-edit-hook-parity.test.ts`, which fails the build if the two ever disagree.
 * A hook that normalized differently would stay silent on exactly the edits that red the gate.
 */
export function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * P-009 (REPORT-ONLY): does a repair in flight overlap edits in the shared checkout?
 *
 * "In flight" is every phase EXCEPT `ready-to-test`. `ready-to-test` is deliberately excluded
 * because no repair exists yet — the candidate has not even had its first suite, so an edit
 * there races nothing. `blocked` is deliberately INCLUDED: automation has stopped but the queue
 * head remains immutable until it is green, so an edit to a failing path is if anything more
 * dangerous there, because no fixer is watching for it.
 *
 * Exported so the collision rule is unit-testable without constructing a whole diagnostic.
 */
export function detectFrozenRepairSharedTreeCollision(
  queue: FrozenCandidateRepairQueue | null,
  editedPaths: readonly string[] | null | undefined,
): FrozenRepairSharedTreeCollision {
  const repairInFlight = queue !== null && queue.phase !== 'ready-to-test';
  // Distinguish "not measured" from "measured, found nothing" — a guard that cannot tell
  // those apart reports a false all-clear exactly when the measurement broke.
  if (editedPaths === null || editedPaths === undefined) {
    return {
      measured: false,
      repairInFlight,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: repairInFlight
        ? `frozen-repair collision: NOT MEASURED — a repair is in flight for ${queue!.candidate.slice(0, 12)} ` +
          `but no shared-checkout edit set was supplied, so this is not an all-clear.`
        : null,
    };
  }

  if (!repairInFlight) {
    return {
      measured: true,
      repairInFlight: false,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: null,
    };
  }

  const edited = new Set(editedPaths.map(normalizeRepoPath).filter((p) => p.length > 0));
  const colliding = [
    ...new Set(queue!.failingTests.map(normalizeRepoPath).filter((p) => p.length > 0 && edited.has(p))),
  ].sort();

  if (colliding.length === 0) {
    return {
      measured: true,
      repairInFlight: true,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: null,
    };
  }

  const shown = colliding.slice(0, FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP);
  const truncated = colliding.length > shown.length;
  return {
    measured: true,
    repairInFlight: true,
    collidingPaths: shown,
    collisionCount: colliding.length,
    truncated,
    detail:
      `⚠ FROZEN-REPAIR COLLISION: ${colliding.length} of the frozen candidate's failing path(s) ` +
      `are edited in the SHARED checkout while repair ${queue!.candidate.slice(0, 12)} is in flight ` +
      `at head ${queue!.repairHead.slice(0, 12)} (phase ${queue!.phase}). ` +
      `The gate judges ONLY the frozen lineage (candidate + admitted fix blobs), so a shared-tree edit ` +
      `that is never admitted does not fail loudly — it silently withholds promotion and reads as ` +
      `"the repair did not work". Editing the shared checkout is authoring, NOT admission: land the fix ` +
      `with release:repair-queue { op: 'admit', paths: [...] }. Colliding: ${shown.join(', ')}` +
      (truncated
        ? ` …and ${colliding.length - shown.length} more (list capped at ${FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP})`
        : ''),
  };
}

/**
 * green-gate-zero-wait P-007 (R-7): the repair path's latencies, DERIVED from the row's
 * own clocks so idle time is measurable instead of anecdotal. Every figure is `null` when
 * its interval has not closed yet; the `*AwaitingMs` figures are the LIVE waits (how long
 * the newest red has sat with no fixer / the newest admission has sat with no verdict),
 * which is what a watchdog reads. `stamps` carries the sources so a reader can re-derive.
 */
export interface FrozenRepairLatency {
  /** Newest red (`openedAtMs`, or the newest round recorded before the dispatch) → newest fixer dispatch. */
  redToFixerSpawnMs: number | null;
  /** Newest fixer dispatch → the admission that followed it. An admission with NO fixer since the
   *  newest red (an auto-convergence such as P-008 / P-005) reports 0: the admission IS the fix. */
  fixToAdmitMs: number | null;
  /** Newest admission → start of the run that verifies that admitted head. */
  admitToResumeRunStartMs: number | null;
  /** Newest admission → the verdict that judged it; null while that verdict is still pending. */
  admitToVerdictMs: number | null;
  /** Live wait: ms the newest red has waited for a fixer dispatch; null once one was dispatched. */
  redAwaitingFixerMs: number | null;
  /** Live wait: ms the newest admission has waited for its verification run to start. */
  admitAwaitingResumeRunStartMs: number | null;
  /** Live wait: ms the newest admission has waited for its verdict; null once judged. */
  admitAwaitingVerdictMs: number | null;
  stamps: {
    openedAtMs: number;
    lastRedAtMs: number;
    fixerSpawnedAtMs: number | null;
    lastAdmittedAtMs: number | null;
    lastResumeRunStartedAtMs: number | null;
    lastVerdictAtMs: number | null;
  };
}

export type FrozenRepairLatencySource = Pick<FrozenCandidateRepairQueue, 'openedAtMs' | 'phase'> &
  Partial<
    Pick<
      FrozenCandidateRepairQueue,
      'convergenceRounds' | 'fixerSpawnedAtMs' | 'lastAdmittedAtMs' | 'lastResumeRunStartedAtMs' | 'lastVerdictAtMs'
    >
  >;

export function frozenRepairLatency(queue: FrozenRepairLatencySource, nowMs: number): FrozenRepairLatency {
  const rounds = queue.convergenceRounds ?? [];
  const redAt = (upTo: number | null): number =>
    rounds.reduce(
      (max, round) => (round.atMs > max && (upTo === null || round.atMs <= upTo) ? round.atMs : max),
      queue.openedAtMs,
    );
  const lastRedAtMs = redAt(null);
  const fixerSpawnedAtMs = queue.fixerSpawnedAtMs ?? null;
  const lastAdmittedAtMs = queue.lastAdmittedAtMs ?? null;
  const lastResumeRunStartedAtMs = queue.lastResumeRunStartedAtMs ?? null;
  const lastVerdictAtMs = queue.lastVerdictAtMs ?? null;
  const redToFixerSpawnMs =
    fixerSpawnedAtMs === null ? null : Math.max(0, fixerSpawnedAtMs - redAt(fixerSpawnedAtMs));
  const fixerSinceLastRed = fixerSpawnedAtMs !== null && fixerSpawnedAtMs >= lastRedAtMs;
  const fixToAdmitMs =
    lastAdmittedAtMs === null
      ? null
      : fixerSpawnedAtMs === null
        ? 0
        : fixerSpawnedAtMs <= lastAdmittedAtMs
          ? lastAdmittedAtMs - fixerSpawnedAtMs
          : null;
  const admissionStarted =
    lastAdmittedAtMs !== null &&
    lastResumeRunStartedAtMs !== null &&
    lastResumeRunStartedAtMs >= lastAdmittedAtMs;
  const admitToResumeRunStartMs = admissionStarted
    ? (lastResumeRunStartedAtMs as number) - (lastAdmittedAtMs as number)
    : null;
  const admissionJudged =
    lastAdmittedAtMs !== null && lastVerdictAtMs !== null && lastVerdictAtMs >= lastAdmittedAtMs;
  const admitToVerdictMs = admissionJudged ? (lastVerdictAtMs as number) - (lastAdmittedAtMs as number) : null;
  const redAwaitingFixerMs =
    queue.phase === 'awaiting-fixer' && !fixerSinceLastRed ? Math.max(0, nowMs - lastRedAtMs) : null;
  const admitAwaitingResumeRunStartMs =
    queue.phase === 'ready-to-verify' && lastAdmittedAtMs !== null && !admissionStarted
      ? Math.max(0, nowMs - lastAdmittedAtMs)
      : null;
  const admitAwaitingVerdictMs =
    lastAdmittedAtMs !== null && !admissionJudged ? Math.max(0, nowMs - lastAdmittedAtMs) : null;
  return {
    redToFixerSpawnMs,
    fixToAdmitMs,
    admitToResumeRunStartMs,
    admitToVerdictMs,
    redAwaitingFixerMs,
    admitAwaitingResumeRunStartMs,
    admitAwaitingVerdictMs,
    stamps: { openedAtMs: queue.openedAtMs, lastRedAtMs, fixerSpawnedAtMs, lastAdmittedAtMs, lastResumeRunStartedAtMs, lastVerdictAtMs },
  };
}

/** P-007: the four optional latency clocks, each read only when it is a timestamp no newer
 *  than the row clock — the same admissibility rule as `fixerStateChangedAtMs`. */
function parseRepairLatencyStamps(
  row: Record<string, unknown>,
): Pick<FrozenCandidateRepairQueue, 'fixerSpawnedAtMs' | 'lastAdmittedAtMs' | 'lastResumeRunStartedAtMs' | 'lastVerdictAtMs'> {
  const out: Record<string, number> = {};
  for (const key of ['fixerSpawnedAtMs', 'lastAdmittedAtMs', 'lastResumeRunStartedAtMs', 'lastVerdictAtMs'] as const) {
    const value = row[key];
    if (validTimestamp(value) && value <= (row.updatedAtMs as number)) out[key] = value;
  }
  return out;
}

export function diagnoseFrozenCandidateRepairQueue(
  queue: FrozenCandidateRepairQueue | null,
  observation: FrozenRepairQueueObservation,
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenRepairQueueDiagnostic | null {
  if (!queue) return null;
  const decision = decideFrozenCandidateRepairQueue(queue, observation, limits);
  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  const reservation = queue.dispatchReservation
    ? {
        ...queue.dispatchReservation,
        active: queue.dispatchReservation.expiresAtMs > observation.nowMs,
      }
    : null;
  const fixerAlive = queue.fixerSpawnId ? (observation.fixerAlive ?? null) : null;
  const zeroAttemptStalled =
    queue.phase === 'awaiting-fixer' &&
    queue.attempts === 0 &&
    queue.fixerSpawnId === null &&
    !(reservation?.active ?? false) &&
    ageMs >= FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;
  const safePhase = queue.phase === 'awaiting-fixer' || queue.phase === 'blocked';
  const retireRefusal = !safePhase
    ? 'unsafe-phase'
    : reservation?.active
      ? 'active-dispatch-reservation'
      : queue.fixerSpawnId && fixerAlive === true
        ? 'live-fixer'
        : queue.fixerSpawnId && fixerAlive === null
          ? 'liveness-unknown'
          : null;
  const retireAllowed = retireRefusal === null;
  // WI-1586801: `retireAllowed` answers "is retiring PERMITTED?" — a safety predicate, never a
  // recommendation. Rendering the paste-ready retire recipe whenever retirement is merely
  // permitted advertises the DESTRUCTIVE verb for a queue the mechanism is about to recover on
  // its own: `recover-dead-fixer` sets retireAllowed:true with retireRefusal:null, and agents
  // that copied this string destroyed recoverable queues. Only a decision that is genuinely
  // terminal for this candidate earns the retire recipe; every other decision keeps the SAFE
  // verb advertised. `retireAllowed`/`retireRefusal` are deliberately left untouched — the
  // permission and the recommendation are different questions and other callers read the former.
  // D-005: the terminal decisions are HOLDS now (never a re-cut); retire stays owner-only.
  const retirementIsTheDecision =
    decision.kind === 'hold-exhausted' || decision.kind === 'hold-dispatch-infeasible';
  const identity = buildFrozenRepairStatusIdentity(queue);
  const nextAction = !retireAllowed
    ? null
    : retirementIsTheDecision
      ? `release:repair-queue { op: 'retire', expectedCandidate: '${queue.candidate}', expectedRepairHead: '${queue.repairHead}', expectedUpdatedAtMs: ${queue.updatedAtMs}, reason: '<why this exact non-live queue is terminal>', confirm: true }`
      : `decision '${decision.kind}': this queue is still recoverable — do NOT retire it. Land your fix on the judged lineage with release:repair-queue { op: 'admit', paths: ['<your changed path>'] } (path-exact; never the tip).`;
  return {
    ...identity,
    candidate: queue.candidate,
    // P-002/P-003: carried onto the diagnostic so a reader holding it can answer "which
    // non-test leg, and did its fix land" without re-parsing the raw queue blob.
    legs: queue.legs ?? [],
    signature: queue.signature,
    // P-011: the normalized diagnostic is the ONE read model behind release:repair-queue,
    // gitPipelineSnapshot and the owner brief. Dropping these two fields here forced each
    // surface to re-parse the raw persisted row (or, in practice, omit the answer entirely).
    admissions: queue.admissions ?? [],
    // P-021: the manifest rides the same read model — see the field's doc above.
    manifest: queue.manifest ?? null,
    manifestSummary: queue.manifest ? summarizeRepairManifest(queue.manifest) : null,
    blockedReason: queue.blockedReason ?? null,
    attempts: queue.attempts,
    openedAtMs: queue.openedAtMs,
    updatedAtMs: queue.updatedAtMs,
    ageMs,
    ageEscalationRung: frozenRepairAgeEscalationRung(queue, observation.nowMs),
    ageEscalationIntervalMs: FROZEN_REPAIR_AGE_ESCALATION_INTERVAL_MS,
    zeroAttemptStalled,
    zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
    fixerSpawnId: queue.fixerSpawnId,
    fixerAlive,
    repairLatency: frozenRepairLatency(queue, observation.nowMs),
    dispatchReservation: reservation,
    admissionPrecheck: queue.admissionPrecheck ?? null,
    decision: decision.kind,
    retireAllowed,
    retireRefusal,
    nextAction,
    // P-009 REPORT-ONLY: computed from the queue + observation and attached to the report.
    // Deliberately NOT consulted by `decision`, `retireAllowed`, `retireRefusal` or
    // `nextAction` above — all four are already final by this point.
    sharedTreeCollision: detectFrozenRepairSharedTreeCollision(queue, observation.sharedTreeEditedPaths),
  };
}

/** The round the NEXT red will be recorded as: one past the highest recorded round. */
function nextConvergenceRound(queue: FrozenCandidateRepairQueue): number {
  return (queue.convergenceRounds ?? []).reduce((max, entry) => (entry.round > max ? entry.round : max), 0) + 1;
}

/** A first red transitions the already-persisted candidate into repair without changing C.
 * P-006: the red's measurement (flat or typed) becomes the typed signature; a queue opened by
 * a lint-only red (suite green, one post-suite leg red) opens on exactly that leg. */
export function markFrozenCandidateVerificationRed(
  queue: FrozenCandidateRepairQueue,
  input: RepairSignatureRedInput & { nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-test', 'initial candidate red');
  assertTimestamp(input.nowMs, 'nowMs');
  const round = nextConvergenceRound(queue);
  const { signature, failingTests } = nextRepairSignature(queue.signature, {
    ...input,
    head: queue.repairHead,
    round,
  });
  return {
    ...queue,
    phase: 'awaiting-fixer',
    updatedAtMs: input.nowMs,
    fixerStateChangedAtMs: input.nowMs,
    lastVerdictAtMs: input.nowMs,
    convergenceRounds: appendConvergenceRound(queue, {
      head: queue.repairHead,
      failingTests,
      nowMs: input.nowMs,
    }),
    failingTests: boundedFailures(failingTests),
    signature,
  };
}

/** Stop automated churn while preserving the same immutable queue head. */
export function markFrozenRepairExhausted(
  queue: FrozenCandidateRepairQueue,
  input: { reason: FrozenCandidateBlockedReason; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'blocked',
    blockedReason: input.reason,
    updatedAtMs: input.nowMs,
    fixerSpawnId: null,
  };
}

/**
 * P-010: record that the gate escalated the queue's age at `rung` — a monotone high-water mark
 * so the 8h-cadence alert fires once per rung and never per tick (the per-tick spam EI-7472
 * fixed). The queue's phase, head and budget are untouched: this is bookkeeping, not a decision.
 */
export function markFrozenRepairAgeEscalated(
  queue: FrozenCandidateRepairQueue,
  input: { rung: number; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  if (!Number.isInteger(input.rung) || input.rung < 1) throw new Error('rung must be a positive integer');
  if ((queue.ageEscalatedRung ?? 0) >= input.rung) return queue;
  return { ...queue, ageEscalatedRung: input.rung, updatedAtMs: input.nowMs };
}

/** Record a successful launch. Replacing a dead spawn is allowed; the decision helper owns the
 * liveness check and this transition owns the monotonically increasing attempt count. */
export function markFrozenRepairFixerDispatched(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; nowMs: number },
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'fixer dispatch');
  if (!nonBlank(input.spawnId)) throw new Error('spawnId must be non-empty');
  assertTimestamp(input.nowMs, 'nowMs');
  assertLimits(limits);
  if (queue.attempts >= limits.maxAttempts) {
    throw new Error('repair queue attempt budget is exhausted');
  }
  return {
    ...queue,
    attempts: queue.attempts + 1,
    updatedAtMs: input.nowMs,
    fixerStateChangedAtMs: input.nowMs,
    fixerSpawnedAtMs: input.nowMs,
    fixerSpawnId: input.spawnId,
  };
}

/**
 * Persist recovery of a definitively-dead fixer before age/reservation policy runs again.
 *
 * P-005 refund semantics: when the death is classified as an UNPRODUCTIVE INFRASTRUCTURE
 * death (`unproductiveInfrastructureDeath` supplied — the fixer never made a tool call:
 * spawn failure, provider-capacity rejection, permission fault, first-turn guillotine),
 * the attempt burned at dispatch is REFUNDED so the retry is free — an attempt should
 * measure a fixer that actually attempted repair, not a launch that died at the door.
 * The refund is bounded by `limits.maxFreeRetries` (a classification bug must not spin
 * forever) and the wall-clock budget still terminates the queue regardless. A fixer that
 * DID work (made tool calls) and then died keeps its burned attempt — losing its edits is
 * P-006's axis, not this one.
 */
export function markFrozenRepairFixerDead(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; nowMs: number; unproductiveInfrastructureDeath?: { reason: string } },
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'mark fixer dead');
  assertTimestamp(input.nowMs, 'nowMs');
  if (queue.fixerSpawnId !== input.spawnId) {
    throw new Error(`stale fixer death for ${input.spawnId}; queue expects ${queue.fixerSpawnId ?? 'none'}`);
  }
  const { dispatchReservation: _reservation, ...withoutReservation } = queue;
  const maxFreeRetries = limits.maxFreeRetries ?? DEFAULT_FROZEN_REPAIR_MAX_FREE_RETRIES;
  const refund =
    input.unproductiveInfrastructureDeath != null &&
    queue.attempts > 0 &&
    (queue.freeRetries ?? 0) < maxFreeRetries;
  return {
    ...withoutReservation,
    ...(refund ? { attempts: queue.attempts - 1, freeRetries: (queue.freeRetries ?? 0) + 1 } : {}),
    fixerSpawnId: null,
    updatedAtMs: input.nowMs,
    fixerStateChangedAtMs: input.nowMs,
  };
}

/** Move forward only from the current spawn's completion. Late completions from replaced/dead
 * fixers cannot retarget verification onto a stale head. */
export function markFrozenRepairFixerFinished(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; repairHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'fixer completion');
  if (!nonBlank(input.repairHead)) throw new Error('repairHead must be non-empty');
  assertTimestamp(input.nowMs, 'nowMs');
  if (!queue.fixerSpawnId || queue.fixerSpawnId !== input.spawnId) {
    throw new Error(`stale fixer completion from ${input.spawnId}`);
  }
  return {
    ...queue,
    phase: 'ready-to-verify',
    repairHead: input.repairHead,
    updatedAtMs: input.nowMs,
  };
}

/**
 * P-001 / D-002 — record one admission on the row and advance `repairHead` to the commit it
 * produced. This is the ONLY function that moves `repairHead` forward by content (the fixer
 * completion above is the other mover and is retired with the worktree under D-010).
 *
 * Phase: an admitted fix is content to VERIFY. `ready-to-test` stays — the candidate's own
 * suite has not judged yet and its red is what seeds the signature; the verification tick
 * after it judges the new head. Every other phase moves to `ready-to-verify`, INCLUDING
 * `blocked` (an admission is precisely the agent/human convergence a blocked queue is waiting
 * for — D-005 blocks automatic dispatch, never verification of a landed fix) and
 * `ready-to-promote` (new content invalidates the promotion proof).
 *
 * The primitive's compare-and-swap on the lineage ref already refused a stale build; the
 * `fromRepairHead` check here is the row-level echo of that, so a caller that re-read the
 * queue after admitting cannot splice a ledger entry onto the wrong head.
 */
export function markFrozenRepairAdmitted(
  queue: FrozenCandidateRepairQueue,
  entry: FrozenRepairAdmission,
): FrozenCandidateRepairQueue {
  assertTimestamp(entry.atMs, 'atMs');
  if (!nonBlank(entry.toRepairHead)) throw new Error('admission toRepairHead must be non-empty');
  if (entry.fromRepairHead !== queue.repairHead) {
    throw new Error(
      `admission was built onto ${entry.fromRepairHead.slice(0, 12)} but the queue's repairHead is ` +
        `${queue.repairHead.slice(0, 12)}: re-read the queue and admit onto its current head`,
    );
  }
  if (entry.paths.length === 0) throw new Error('an admission with no changed paths is not an admission');
  const admissions = [...(queue.admissions ?? []), entry].slice(-FROZEN_REPAIR_ADMISSION_CAP);
  const phase: FrozenCandidateRepairPhase = queue.phase === 'ready-to-test' ? 'ready-to-test' : 'ready-to-verify';
  const {
    blockedReason: _leavingBlocked,
    lastResumeRunStartedAtMs: _priorResumeStart,
    admissionPrecheck: _completedPrecheck,
    ...rest
  } = queue;
  void _leavingBlocked;
  void _priorResumeStart;
  void _completedPrecheck;
  return {
    ...rest,
    phase,
    repairHead: entry.toRepairHead,
    admissions,
    retestRequested: {
      candidate: queue.candidate,
      repairHead: entry.toRepairHead,
      requestedAtMs: entry.atMs,
    },
    updatedAtMs: Math.max(queue.updatedAtMs, entry.atMs),
    lastAdmittedAtMs: entry.atMs,
  };
}

/**
 * WI-10003213 — may the gate spend its once-per-head re-verification on this queue?
 *
 * An UNMEASURED red (every red leg was killed, timed out or errored without a single test
 * reporting a failure — `gate_health.failingTestsMeasured:false`) parks the queue in
 * `awaiting-fixer`. The fixer dispatcher then refuses by design (`frozenRepairHasNoMeasuredFailures`:
 * a reproduce-style fixer has no target), and `decideFrozenCandidateRepairQueue` offers nothing
 * else in that phase — so every tick decided `dispatch-fixer`, got no spawn, and ran no suite,
 * forever (measured 2026-09-26 on candidate 55b22f4e / head 1a044fb6: ~2h of `repair-in-progress`
 * inconclusives while the red it waited on was a watchdog SIGKILL already fixed in gate code).
 *
 * Pure. The caller supplies the measured-failures verdict; this only answers the queue-shape
 * half: an unassigned awaiting-fixer queue (no live fixer, no dispatch lease) whose current head
 * has not already had its unmeasured retest. Bounded to ONE per head so a persistently
 * unmeasured red cannot burn a full suite every tick.
 */
export function frozenRepairUnmeasuredRetestEligible(queue: FrozenCandidateRepairQueue | null | undefined): boolean {
  if (!queue) return false;
  return (
    queue.phase === 'awaiting-fixer' &&
    queue.fixerSpawnId === null &&
    !queue.dispatchReservation &&
    queue.unmeasuredRetestHead !== queue.repairHead
  );
}

/**
 * WI-10003213 — move an unassigned awaiting-fixer queue whose red measured no failing test back
 * to verification of the SAME head, spending that head's one unmeasured retest.
 *
 * Idempotent and race-tolerant for the CAS seam: a row that is no longer eligible (a fixer was
 * dispatched, a lease appeared, an admission moved the head/phase, or the retest is already
 * spent at this head) is returned unchanged. `retestRequested` is stamped exactly as an
 * admission stamps it, so the existing P-001 settle/refire machinery treats the verification
 * like any other requested retest; `attempts` is untouched (no fixer was spent).
 */
export function markFrozenRepairUnmeasuredRetest(
  queue: FrozenCandidateRepairQueue,
  input: { nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  if (!frozenRepairUnmeasuredRetestEligible(queue)) return queue;
  return {
    ...queue,
    phase: 'ready-to-verify',
    unmeasuredRetestHead: queue.repairHead,
    retestRequested: {
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      requestedAtMs: input.nowMs,
    },
    updatedAtMs: Math.max(queue.updatedAtMs, input.nowMs),
  };
}

/** Record the first verification-run start for the current admitted repair head.
 *
 * The reducer is deliberately race-tolerant: a newer admission or phase transition returns
 * the fresh row unchanged, so callers may apply it through the queue CAS seam without
 * overwriting concurrent progress. Re-entry for the same admission preserves the first start.
 */
export function markFrozenRepairVerificationStarted(
  queue: FrozenCandidateRepairQueue,
  input: { repairHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  if (queue.phase !== 'ready-to-verify' || queue.repairHead !== input.repairHead) return queue;
  const admittedAt = queue.lastAdmittedAtMs;
  if (admittedAt === undefined) return queue;
  if (
    queue.lastResumeRunStartedAtMs !== undefined &&
    queue.lastResumeRunStartedAtMs >= admittedAt
  ) {
    return queue;
  }
  const startedAt = Math.max(admittedAt, input.nowMs);
  return {
    ...queue,
    lastResumeRunStartedAtMs: startedAt,
    updatedAtMs: Math.max(queue.updatedAtMs, startedAt),
  };
}

/**
 * Settle the durable P-001 marker after one checkpoint pass.
 *
 * A pass at the requested head consumes the marker. A pass at any older/different head returns
 * `refire` WITHOUT changing the row: the marker remains durable until the recursive pass really
 * completes, so a crash between the decision and recursion cannot lose the wake. The CAS writer
 * re-runs this reducer on conflict, which also preserves an admission that races the clear.
 */
export function settleFrozenRepairRetestRequest(
  queue: FrozenCandidateRepairQueue,
  judgedRepairHead: string,
): FrozenRepairRetestDecision {
  const request = queue.retestRequested;
  if (!request) return { kind: 'none', queue, request: null };
  if (request.repairHead !== judgedRepairHead) {
    return { kind: 'refire', queue, request };
  }
  const { retestRequested: _settled, ...rest } = queue;
  void _settled;
  return { kind: 'settled', queue: rest, request };
}

/**
 * WI-212675 — a fixer that CHANGED NOTHING at a head the suite has NEVER JUDGED is reporting
 * "nothing left to change", not "I failed".
 *
 * A fix reaches the judged lineage through admission: an agent lands it on staging and
 * `release:repair-queue { op:'admit', paths }` replays exactly those paths onto the movable
 * `repairHead` (`markFrozenRepairAdmitted` moves the phase to ready-to-verify). Before D-004
 * the same verb fast-forwarded `repairHead` to the tip WITHOUT touching the phase, and on that
 * route the next fixer was dispatched at a head where every named red already passes,
 * correctly changes nothing, and exits — and the recover-dead-fixer branch read that as a
 * death: attempt spent, replacement dispatched, suite never run. Measured 2026-09-03 17:23Z on
 * frozen candidate d165d753: repairHead 46dd13e4 had all 13 named reds passing and the queue
 * re-dispatched instead of verifying. Same false-silence class as P-012 ("measured empty"
 * rendered as "nothing happened").
 *
 * The predicate that separates the two readings is whether `repairHead` has ever been
 * VERIFIED RED. Every red appends a `convergenceRounds` entry at the head it judged — the
 * opening red seeds round 1 at the candidate itself — so a repairHead absent from every round
 * is one the suite has never been run against. A no-op fixer THERE means the converged head
 * is ready to verify. A no-op fixer at a head already verified red is the ordinary failed
 * attempt and must stay on the dead-fixer path: that is what stops a red verification from
 * re-entering the suite for free (verify → red → dispatch → no-op → verify … would burn a
 * full suite every tick).
 *
 * A legacy queue with no rounds recorded falls back to `repairHead !== candidate`: the
 * candidate is red by construction, and a moved head with no round errs toward spending ONE
 * suite on it rather than never verifying it — the smaller failure, and self-limiting, since
 * its red appends the round that routes the next no-op fixer onto the dead path.
 */
export function frozenRepairHeadAwaitsVerification(queue: FrozenCandidateRepairQueue): boolean {
  if (queue.repairHead === queue.candidate) return false;
  const rounds = queue.convergenceRounds ?? [];
  return !rounds.some((round) => round.head === queue.repairHead);
}

/** A red verification retries FORWARD from the head that was just tested; it never retreats to
 * a historical prefix and never adopts the moving staging tip. */
export function markFrozenRepairVerificationRed(
  queue: FrozenCandidateRepairQueue,
  input: RepairSignatureRedInput & {
    repairHead: string;
    nowMs: number;
    selectiveCoverage?: FrozenRepairSelectiveCoverage;
  },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-verify', 'red repair verification');
  requireCurrentHead(queue, input.repairHead);
  assertTimestamp(input.nowMs, 'nowMs');
  const round = nextConvergenceRound(queue);
  // P-006 EXTEND: prior entries of a kind this run did not measure carry forward (a
  // suite-red run never re-measured the lint legs), entries it did measure are replaced by
  // the fresh result, and an entry present before keeps its admittedRound.
  const { signature, failingTests } = nextRepairSignature(queue.signature, {
    ...input,
    head: input.repairHead,
    round,
  });
  const coverage = parseFrozenRepairSelectiveCoverage(input.selectiveCoverage, queue.candidate);
  if (input.selectiveCoverage && (!coverage || coverage.head !== input.repairHead)) {
    throw new Error('selective coverage must describe the exact measured repair head');
  }
  const selectiveCoverageBlocked = queue.selectiveCoverageBlocked === true ||
    !losslessFailureFrontier(queue) || !losslessFailureFrontier(input) ||
    !losslessFailureFrontier({ failingTests, signature });
  const usableCoverage = !selectiveCoverageBlocked && selectFrozenRepairAdmissionPaths(queue).coverageComplete
    ? coverage : undefined;
  return {
    ...queue,
    phase: 'awaiting-fixer',
    updatedAtMs: input.nowMs,
    fixerStateChangedAtMs: input.nowMs,
    lastVerdictAtMs: input.nowMs,
    fixerSpawnId: null,
    convergenceRounds: appendConvergenceRound(queue, {
      head: input.repairHead,
      failingTests,
      nowMs: input.nowMs,
    }),
    failingTests: boundedFailures(failingTests),
    signature,
    selectiveCoverage: selectiveCoverageBlocked ? undefined : usableCoverage ?? queue.selectiveCoverage,
    ...(selectiveCoverageBlocked ? { selectiveCoverageBlocked: true as const } : {}),
  };
}

/**
 * WI-10000741 (D-014's second half) — RECORD a red the suite measured at a head the row no
 * longer carries, without moving anything the newer admission owns.
 *
 * D-014 rules that a verdict measured behind a fresh `repairHead` "records its legs but never
 * overwrites the newer admission or phase". The gate honoured only the second clause: on a
 * head mismatch `verdictTransitionAtHead` returned the fresh row untouched, so an hour-long
 * suite whose red landed behind a mid-suite admission left NOTHING on the row — no round, no
 * signature, no failing set — and the queue read as "never verified at that head" (measured
 * 2026-09-08: candidate 2682c91d, ten manual whole-blob admissions, every superseded red
 * discarded). This reducer is the missing first clause.
 *
 * What moves: `convergenceRounds` gains a round AT `measuredHead` (so the shrink series sees
 * the measurement and `frozenRepairHeadAwaitsVerification` still answers true for the newer
 * head, which has no round of its own), `signature`/`failingTests` take the fresh measurement
 * with `measuredHead` stamped on each entry (the next selective verification at the newer head
 * re-runs exactly what was red one admission ago — the best available estimate). What does
 * NOT move: `phase`, `repairHead`, `admissions`, `fixerSpawnId`, `dispatchReservation`,
 * `attempts` — those belong to the admission that superseded this verdict.
 *
 * Refuses when the head is NOT superseded (`repairHead === measuredHead`): that verdict is the
 * row's own and belongs to `markFrozenRepairVerificationRed`, which also moves the phase.
 */
export function recordFrozenRepairSupersededRed(
  queue: FrozenCandidateRepairQueue,
  input: RepairSignatureRedInput & { measuredHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  if (!nonBlank(input.measuredHead)) throw new Error('measuredHead is required to record a superseded red');
  if (queue.repairHead === input.measuredHead) {
    throw new Error(
      `red at ${input.measuredHead.slice(0, 12)} is not superseded — it is the queue's own repairHead; ` +
        `record it with markFrozenRepairVerificationRed`,
    );
  }
  const round = nextConvergenceRound(queue);
  const { signature, failingTests } = nextRepairSignature(queue.signature, {
    ...input,
    head: input.measuredHead,
    round,
  });
  const selectiveCoverageBlocked = queue.selectiveCoverageBlocked === true ||
    !losslessFailureFrontier(queue) || !losslessFailureFrontier(input) ||
    !losslessFailureFrontier({ failingTests, signature });
  return {
    ...queue,
    updatedAtMs: input.nowMs,
    convergenceRounds: appendConvergenceRound(queue, {
      head: input.measuredHead,
      failingTests,
      nowMs: input.nowMs,
    }),
    failingTests: boundedFailures(failingTests),
    signature,
    ...(selectiveCoverageBlocked
      ? { selectiveCoverage: undefined, selectiveCoverageBlocked: true as const } : {}),
  };
}

/**
 * P-002 — fold one tick's NON-TEST leg measurements into the queue.
 *
 * A SEPARATE seam from the red/green markers on purpose. Those take a flat `failingTests`
 * list, which cannot say which entry is a leg or whether a leg passed; a leg's lifecycle is
 * moved only by that leg's own measured result (D-005). Keeping it separate also means no
 * existing caller signature changes, so nothing is stranded by adding legs.
 *
 * The round is read from the convergence history so leg rounds and convergence rounds are
 * the SAME rounds — two shrink series over one cycle, never two clocks.
 *
 * ⚠ Legs absent from `measurements` are left exactly as they are. This function never
 * removes a leg and never infers a pass from silence.
 */
export function recordFrozenRepairLegMeasurement(
  queue: FrozenCandidateRepairQueue,
  input: { measurements: readonly RepairLegMeasurement[]; head: string; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  if (!nonBlank(input.head)) throw new Error('head is required to record a leg measurement');
  const rounds = queue.convergenceRounds ?? [];
  const round = rounds.reduce((max, entry) => (entry.round > max ? entry.round : max), 0) || 1;
  const legs = applyRepairLegMeasurements(queue.legs, {
    measurements: input.measurements,
    head: input.head,
    round,
    nowMs: input.nowMs,
    // EI-23917645695738835: the signature is the OTHER population that names a leg failing.
    // Without it, a leg red at the candidate but never measured failing by a tick has no
    // prior state, so its first passing measurement is discarded and the manifest re-derives
    // `red-at-candidate` from that silence forever.
    signatureIds: (queue.signature ?? []).map((entry) => entry.id),
  });
  if (legs.length === 0) return queue;
  return { ...queue, legs, updatedAtMs: input.nowMs };
}

/**
 * P-002 — the leg shrink reading for a queue. Re-exported through this module so a caller
 * holding a queue never has to know which file the lifecycle lives in.
 */
export function summarizeFrozenRepairLegs(queue: FrozenCandidateRepairQueue | null): RepairLegShrinkSummary {
  return summarizeRepairLegs(queue?.legs);
}

export {
  applyRepairLegMeasurements,
  parseRepairLegStates,
  partitionRepairSignatures,
  summarizeRepairLegs,
  FROZEN_REPAIR_LEG_CAP,
  type FrozenRepairLegState,
  type RepairLegMeasurement,
  type RepairLegShrinkSummary,
  type RepairLegStatus,
  type RepairSignaturePartition,
} from './repair-leg-lifecycle';

/** A green verification makes only the exact tested head promotable. The separate staging-patch
 * decision remains mandatory before the caller can advance main. */
export function markFrozenRepairVerificationGreen(
  queue: FrozenCandidateRepairQueue,
  input: { repairHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-verify', 'green repair verification');
  requireCurrentHead(queue, input.repairHead);
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'ready-to-promote',
    updatedAtMs: input.nowMs,
    lastVerdictAtMs: input.nowMs,
    failingTests: [],
    signature: [],
  };
}

/**
 * P-013 / D-007: what a reader needs to answer "is this convergence cycle actually
 * converging, or is it a treadmill wearing a queue's clothes?" — projected into
 * `gate_health` so it is legible without reconstructing the queue's history by hand.
 *
 * PURE and derived: every field is computed from the queue that is already persisted, so
 * this cannot disagree with the queue, and adding it stores no new authority.
 */
export interface FrozenRepairConvergenceSummary {
  /** When this cycle opened — the D-007 "cycle opened-at". */
  openedAtMs: number;
  ageMs: number;
  /** Fixer dispatches actually made (mirrors `queue.attempts`). */
  attempts: number;
  /** Recorded red rounds. 0 means none observed under this build, NOT a stalled cycle. */
  admissionRounds: number;
  /** Failing-set size at the first recorded round; null when no round is recorded. */
  failingFirst: number | null;
  /** Failing-set size right now, straight off the live queue. */
  failingNow: number;
  /** failingFirst - failingNow. Positive = shrinking. Null when there is no baseline. */
  shrinkTotal: number | null;
  /** Per-round size and the delta from the previous round (negative = shrank). */
  shrinkPerRound: readonly { round: number; failingCount: number; delta: number | null }[];
  /**
   * True only when every recorded round is <= the one before it AND the set actually got
   * smaller overall. Null when fewer than two rounds are recorded — deliberately NOT false,
   * because "not yet knowable" and "not converging" are different answers and a reader that
   * conflates them will call a healthy new cycle a treadmill.
   */
  converging: boolean | null;
}

export function summarizeFrozenRepairConvergence(
  queue: FrozenCandidateRepairQueue,
  nowMs: number,
): FrozenRepairConvergenceSummary {
  const rounds = queue.convergenceRounds ?? [];
  const failingNow = queue.failingTests.length;
  const failingFirst = rounds.length > 0 ? (rounds[0] as FrozenRepairConvergenceRound).failingCount : null;
  const shrinkPerRound = rounds.map((entry, index) => ({
    round: entry.round,
    failingCount: entry.failingCount,
    delta: index === 0 ? null : entry.failingCount - (rounds[index - 1] as FrozenRepairConvergenceRound).failingCount,
  }));
  const monotonic = shrinkPerRound.every((entry) => entry.delta === null || entry.delta <= 0);
  const shrinkTotal = failingFirst === null ? null : failingFirst - failingNow;
  return {
    openedAtMs: queue.openedAtMs,
    ageMs: Math.max(0, nowMs - queue.openedAtMs),
    attempts: queue.attempts,
    admissionRounds: rounds.length,
    failingFirst,
    failingNow,
    shrinkTotal,
    shrinkPerRound,
    converging: rounds.length < 2 ? null : monotonic && (shrinkTotal ?? 0) > 0,
  };
}

/**
 * The D-007 default and its owner-visible off switch, as one pure decision.
 *
 * `freeze-and-converge` — a first REAL red freezes that candidate and converges it — is
 * ALREADY the deployed default (verified in green-checkpoint.ts: a red with no live queue
 * calls `createFrozenCandidateRepairQueue` with no streak threshold in front of it). So this
 * does not flip a default ON; it gives the owner a way to turn it OFF, which is the half
 * D-007 asked for and the half that did not exist.
 *
 * OFF restores the pre-D-001 behaviour: a red does not open a cycle, and the gate re-cuts at
 * tip. That is the treadmill D-007 diagnosed, which is exactly why the switch is explicit,
 * owner-visible, and defaults ON rather than being a quiet constant.
 */
export type FrozenConvergenceCycleEntry =
  | { kind: 'open-cycle'; reason: 'first-real-red' }
  | { kind: 'advance-existing-cycle'; reason: 'queue-already-open' }
  | { kind: 'suppressed'; reason: 'off-switch-disabled' };

export function decideFrozenConvergenceCycleEntry(input: {
  /** FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT, read by the caller's io seam. */
  flagEnabled: boolean;
  hasOpenQueue: boolean;
}): FrozenConvergenceCycleEntry {
  // An ALREADY-OPEN cycle is never suppressed by the switch. Turning the default off must
  // stop NEW cycles opening; abandoning a frozen candidate that is mid-convergence would
  // strand its repair worktree and un-freeze a head the gate already committed to.
  if (input.hasOpenQueue) return { kind: 'advance-existing-cycle', reason: 'queue-already-open' };
  if (!input.flagEnabled) return { kind: 'suppressed', reason: 'off-switch-disabled' };
  return { kind: 'open-cycle', reason: 'first-real-red' };
}

/**
 * The shape persisted at `gate_health.convergence` — {@link FrozenRepairConvergenceSummary}
 * plus the identity and write-time stamp a READER needs, which the summary alone cannot
 * supply.
 *
 * Both additions exist to kill a specific misreading:
 *
 * - `candidate` / `repairHead` / `phase`: `gate_health` is a long-lived blob whose fields are
 *   written by several code paths at different times. Convergence figures with no cycle
 *   identity on them read as describing whatever candidate the reader is currently looking
 *   at, which is exactly wrong the moment a cycle is retired and a new one opens.
 * - `observedAtMs`: a shrink figure is a measurement, and a measurement with no timestamp
 *   cannot be told apart from a current one. Readers that care about freshness compare it
 *   themselves; nothing here expires it, because a stale reading that is LABELLED stale is
 *   useful and one that silently disappears is not.
 */
export interface StoredFrozenRepairConvergence extends FrozenRepairConvergenceSummary {
  candidate: string;
  repairHead: string;
  phase: FrozenCandidateRepairPhase;
  observedAtMs: number;
}

/**
 * PURE: the exact object the queue writer projects into `gate_health.convergence`.
 *
 * Derived wholly from the queue that is being persisted in the same statement, so the
 * projection cannot disagree with the queue it describes and stores no new authority — it is
 * a rendering of `repair_queue`, not a second copy of it. See the derived-truth ladder in the
 * repo guide: this is rung 1 (DERIVE), which is why there is no separate writer for it.
 */
export function buildFrozenRepairConvergenceGateHealth(
  queue: FrozenCandidateRepairQueue,
  nowMs: number,
): StoredFrozenRepairConvergence {
  return {
    ...summarizeFrozenRepairConvergence(queue, nowMs),
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    phase: queue.phase,
    observedAtMs: nowMs,
  };
}

/**
 * PURE: interpret the raw `gate_health.convergence` value a snapshot read got back from PG.
 *
 * Returns `null` for anything not trustworthy — absent, JSON null (how the writer CLEARS it
 * when a cycle retires), or a shape this reader does not recognize. A partially-recognized
 * blob is rejected outright rather than rendered with holes: a convergence panel showing
 * `failingFirst: undefined` invites the reader to treat "unreadable" as "no baseline", which
 * is the false all-clear this whole item exists to prevent.
 */
export function parseFrozenRepairConvergence(raw: unknown): StoredFrozenRepairConvergence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const num = (key: string): number | null => (typeof row[key] === 'number' ? (row[key] as number) : null);
  const str = (key: string): string | null => (typeof row[key] === 'string' ? (row[key] as string) : null);
  const openedAtMs = num('openedAtMs');
  const ageMs = num('ageMs');
  const attempts = num('attempts');
  const admissionRounds = num('admissionRounds');
  const failingNow = num('failingNow');
  const observedAtMs = num('observedAtMs');
  const candidate = str('candidate');
  const repairHead = str('repairHead');
  const phase = str('phase');
  if (
    openedAtMs === null ||
    ageMs === null ||
    attempts === null ||
    admissionRounds === null ||
    failingNow === null ||
    observedAtMs === null ||
    candidate === null ||
    repairHead === null ||
    phase === null
  ) {
    return null;
  }
  if (!Array.isArray(row.shrinkPerRound)) return null;
  const shrinkPerRound: { round: number; failingCount: number; delta: number | null }[] = [];
  for (const entry of row.shrinkPerRound) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.round !== 'number' || typeof e.failingCount !== 'number') return null;
    if (e.delta !== null && typeof e.delta !== 'number') return null;
    shrinkPerRound.push({ round: e.round, failingCount: e.failingCount, delta: (e.delta as number | null) ?? null });
  }
  // `converging` and `failingFirst` are DELIBERATELY tri-state (null = not yet knowable / no
  // baseline). `null` is a legitimate stored value for both, so neither can be required above
  // — but a wrong TYPE still rejects the whole blob rather than being coerced to null, which
  // would turn a corrupt reading into a confident "not yet knowable".
  const failingFirstRaw = row.failingFirst ?? null;
  if (failingFirstRaw !== null && typeof failingFirstRaw !== 'number') return null;
  const shrinkTotalRaw = row.shrinkTotal ?? null;
  if (shrinkTotalRaw !== null && typeof shrinkTotalRaw !== 'number') return null;
  const convergingRaw = row.converging ?? null;
  if (convergingRaw !== null && typeof convergingRaw !== 'boolean') return null;
  return {
    openedAtMs,
    ageMs,
    attempts,
    admissionRounds,
    failingFirst: failingFirstRaw as number | null,
    failingNow,
    shrinkTotal: shrinkTotalRaw as number | null,
    shrinkPerRound,
    converging: convergingRaw as boolean | null,
    candidate,
    repairHead,
    phase: phase as FrozenCandidateRepairPhase,
    observedAtMs,
  };
}

/**
 * The branchable reading of a convergence record — main-green-status-visible-2026-09-03 P-004.
 *
 * ⚠ THE WHOLE POINT IS THAT "NOT CONVERGING" AND "NOT YET KNOWABLE" ARE DIFFERENT ANSWERS.
 * `converging` is tri-state precisely because a cycle with fewer than two recorded rounds
 * has no trend to report; rendering that as "not converging" calls a healthy new freeze a
 * treadmill, which is how a working mechanism gets switched off.
 *
 * `no-attempts` is the code this session's incident earned. A queue can sit at
 * `attempts: 0` for hours — every tick withheld by a provider wall or a dispatch
 * reservation — while `consecutiveReds` climbs and the failing list stays frozen at its
 * last real measurement. From outside, that is indistinguishable from a genuine regression,
 * and the natural (wrong) response is to go hunting for the commit that broke it. It is a
 * DISPATCH fact, not a code fact, so it gets its own code rather than being folded into
 * `not-yet-knowable`.
 */
export type FrozenRepairConvergenceCode =
  /**
   * No readable convergence record. NEVER "healthy" and never "stuck".
   *
   * ⚠ Deliberately NOT the word `not-measured`: that belongs to the read-health vocabulary
   * (`CellUnknownCode`), and the cell registry REFUSES a domain enum that reuses it, so an
   * apparatus failure can never masquerade as a finding about the subject. Read-health for
   * this cell is carried separately, by the `unmeasured` hoist.
   */
  | 'no-cycle-recorded'
  /** A cycle is open but no fixer has ever run — nothing has been MEASURED to converge. */
  | 'no-attempts'
  /** Fewer than two recorded rounds: there is no trend yet. Not a verdict of failure. */
  | 'not-yet-knowable'
  /** Every round is <= the one before AND the set actually shrank. */
  | 'converging'
  /** Rounds recorded, but the failing set is not shrinking. This is the treadmill. */
  | 'not-converging';

/**
 * PURE: what should a reader conclude about this repair cycle?
 *
 * Order matters and is deliberate: an unmeasured record outranks everything, then the
 * dispatch fact (`no-attempts`) outranks the trend, because a trend computed over zero
 * fixer runs describes nothing that happened.
 */
export function assessFrozenRepairConvergence(
  record: StoredFrozenRepairConvergence | null,
): FrozenRepairConvergenceCode {
  if (!record) return 'no-cycle-recorded';
  if (record.attempts === 0) return 'no-attempts';
  if (record.converging === null) return 'not-yet-knowable';
  return record.converging ? 'converging' : 'not-converging';
}

/**
 * P-006 / D-004 — WHAT `failingNow` COUNTS, AND WHAT IT MUST NEVER BE SUBTRACTED FROM.
 *
 * `convergence.failingNow` and `gate_health.repairTickLegs.failingSignatures` read as the
 * same number and are not. They disagree on all three axes at once: SUBJECT (a set ADMITTED
 * to the queue row vs what ONE tick measured), VINTAGE (this record's own stamp vs the tick's
 * `atMs`), and HEAD (this record's `repairHead` vs the tick's own `head`). The measured
 * instance was 1 vs 2 — nowhere near the 50-entry persistence bound (`MAX_PERSISTED_FAILURES`),
 * so it was never truncation, and there is no undercount in `failingNow` to fix.
 *
 * D-004 rules out the two repairs that look reasonable and are not:
 *  - RENAMING the persisted field — a label adjustment that hides the scope difference
 *    instead of stating it, which P-006 forbids by name.
 *  - STORING the scope — a new required field on `StoredFrozenRepairConvergence` would fail
 *    `parseFrozenRepairConvergence` on every pre-existing row and silently drop the cell to
 *    unmeasured. That is the same false-absence class this plan exists to end.
 *
 * So it is DERIVED here, at projection time, from fields the stored record already carries.
 */
export interface FrozenRepairConvergenceScope {
  /** WHAT `failingNow` counts. A literal, so a reader can branch on it rather than parse prose. */
  population: 'queue-admitted-failing-set' | 'nothing-counted';
  /** The sha the admitted set describes — this record's `repairHead`, full length. */
  subject: string | null;
  /**
   * The NEWEST instant `failingNow` can describe (this record's `observedAtMs`). The admission
   * itself happened at or before it: the queue's own `updatedAtMs` is not carried in the stored
   * record, so this is an upper BOUND on the admission, never the admission instant. Stating a
   * bound as a bound is the point — a precise-looking timestamp derived from the wrong field
   * would invite exactly the cross-population comparison this object exists to block.
   */
  admittedAtOrBeforeMs: number | null;
  /** The OLDEST instant it can describe — when this cycle opened. */
  admittedAtOrAfterMs: number | null;
  /** Readings this count must never be differenced against, each with its reason. */
  notComparableTo: readonly { reading: string; why: string }[];
  /** The scope sentence. Rendered, not derived by the reader. */
  summary: string;
}

/**
 * The sibling readings a `failingNow` reader is most likely to subtract it from. Constant
 * because the incomparability is STRUCTURAL — it holds for every record, including an
 * unmeasured one, so it is published on the unmeasured branch too.
 */
const CONVERGENCE_NOT_COMPARABLE_TO: readonly { reading: string; why: string }[] = [
  {
    reading: 'gate_health.repairTickLegs.failingSignatures',
    why:
      'A DIFFERENT observation: what the most recent repair tick measured, carrying its own `atMs` ' +
      'and its own `head`. It differs from failingNow in subject, vintage AND head at once, so a ' +
      'gap between the two is not a shrink, a leak, or an undercount — it is two populations being ' +
      'subtracted.',
  },
  {
    reading: 'gate.greenCheckpoint.candidateFailures.stillBrokenCount',
    why:
      'Counts FILES still broken in the affected radius the gate judged for the candidate, decided ' +
      'by blob containment. failingNow counts the admitted failing SIGNATURES on the queue row, and ' +
      'those include non-test legs (e.g. "lint:tsc") that are not files at all.',
  },
];

/**
 * PURE: derive the scope object that must accompany `failingNow` wherever it is published.
 *
 * ⚠ Every field comes from the stored record; nothing here is measured, fetched, or stored.
 */
export function projectFrozenRepairConvergenceScope(
  record: StoredFrozenRepairConvergence | null,
): FrozenRepairConvergenceScope {
  if (!record) {
    return {
      population: 'nothing-counted',
      subject: null,
      admittedAtOrBeforeMs: null,
      admittedAtOrAfterMs: null,
      notComparableTo: CONVERGENCE_NOT_COMPARABLE_TO,
      summary:
        'No readable convergence record, so failingNow counts NOTHING — it is null, not zero, and ' +
        'not a measured "nothing is failing". Do not compare it with any other failing count.',
    };
  }
  return {
    population: 'queue-admitted-failing-set',
    subject: record.repairHead,
    admittedAtOrBeforeMs: record.observedAtMs,
    admittedAtOrAfterMs: record.openedAtMs,
    notComparableTo: CONVERGENCE_NOT_COMPARABLE_TO,
    summary:
      `failingNow counts the ${record.failingNow} signature(s) ADMITTED to this repair queue row for ` +
      `repairHead ${record.repairHead.slice(0, 12)}, at or before ` +
      `${new Date(record.observedAtMs).toISOString()}. It is an admitted set, not a fresh ` +
      'measurement, and it is NOT comparable with gate_health.repairTickLegs.failingSignatures — ' +
      'different subject, different vintage, different head. A difference between them is not a shrink.',
  };
}

/** The celled projection: the record, its reading, and the vintage behind both. */
export interface FrozenRepairConvergenceCellProjection {
  code: FrozenRepairConvergenceCode;
  /**
   * Axis-2 HOIST: true when there is no readable convergence record. Result-level and
   * boolean because the alternative reading of an all-null record — "nothing is failing,
   * so nothing had to converge" — is the precise false all-clear this cell exists to stop.
   */
  unmeasured: boolean;
  openedAtMs: number | null;
  ageMs: number | null;
  attempts: number | null;
  admissionRounds: number | null;
  failingFirst: number | null;
  failingNow: number | null;
  shrinkTotal: number | null;
  shrinkPerRound: readonly { round: number; failingCount: number; delta: number | null }[];
  converging: boolean | null;
  candidate: string | null;
  repairHead: string | null;
  phase: FrozenCandidateRepairPhase | null;
  observedAtMs: number | null;
  /**
   * P-006 / D-004: what `failingNow` counts and when that population was admitted, published
   * BESIDE it so a reader cannot difference it against a sibling failing count. Always
   * present — the incomparability is structural, so the unmeasured branch carries it too.
   */
  scope: FrozenRepairConvergenceScope;
}

/**
 * PURE: project the stored convergence record into the shape
 * `gate.greenCheckpoint.convergence` publishes.
 *
 * Emitted UNCONDITIONALLY, for the same two reasons as the freeze disposition's projection:
 * the cell contract requires the declared assessment path to be present in every live
 * payload, and "not measured" is an answer a reader must be able to branch on rather than
 * infer from an absence. Every field is null rather than zero — a `shrinkTotal: 0` invented
 * for an unmeasured cycle is a claim that it is not shrinking.
 */
export function projectFrozenRepairConvergenceCell(
  record: StoredFrozenRepairConvergence | null,
): FrozenRepairConvergenceCellProjection {
  const code = assessFrozenRepairConvergence(record);
  if (!record) {
    return {
      code,
      unmeasured: true,
      openedAtMs: null,
      ageMs: null,
      attempts: null,
      admissionRounds: null,
      failingFirst: null,
      failingNow: null,
      shrinkTotal: null,
      shrinkPerRound: [],
      converging: null,
      candidate: null,
      repairHead: null,
      phase: null,
      observedAtMs: null,
      scope: projectFrozenRepairConvergenceScope(null),
    };
  }
  return { code, unmeasured: false, ...record, scope: projectFrozenRepairConvergenceScope(record) };
}

/**
 * PURE: is the sha a verdict judged the head of a DELIBERATELY PINNED, still-active repair lineage?
 *
 * Plan D-004. The fossil rules exist to catch an ACCIDENTALLY stale candidate, whose red "can
 * dispatch agents against code the gate never judged as current". That rationale INVERTS for a
 * frozen repair head: the repair is working that exact immutable sha ON PURPOSE, so its red IS the
 * failing-test signature the queue needs in order to advance. Suppressing it is what produced the
 * measured 6-day freeze (`main` frozen at a2d69cef, 44 consecutive reds, `gate_health.failingTests`
 * empty throughout — no signature was EVER published, so no fixer could be dispatched).
 *
 * Lives HERE, in the module owning the queue row, because BOTH sides of the gate need the same
 * judgement: the WRITE side (green-checkpoint's withholding rule, which re-exports this) and the
 * READ side ({@link reconcileGateVerdictFreshnessWithPinnedRepair}, via its caller). D-004 records
 * that the withholding rule and the fossil release are a COUPLED PAIR and that fixing either alone
 * re-creates the livelock; a second copy of this predicate is precisely how the two would drift
 * back apart, so there is exactly one definition (WI-10002121).
 *
 * A queue that has GIVEN UP is deliberately NOT exempt: `blocked`/`blockedReason` means no repair
 * is advancing, so the red stops being anybody's working signature and the ordinary rules apply.
 */
export function isJudgingPinnedActiveRepair(input: {
  candidate: string;
  /**
   * Accepts BOTH spellings of a queue row on purpose, because both sides feed this one predicate:
   * the WRITE side passes `FrozenCandidateRepairQueue`, whose `blockedReason?` is optional and
   * never `null`; the READ side passes `FrozenRepairQueueDiagnostic`, whose `blockedReason` is
   * required and nullable. Deriving the other three fields from the owning type keeps them honest
   * (derived-truth ladder) while widening only that one field's nullability — the runtime test
   * below is `== null`, which already covers both. Narrowing this back to a bare `Pick<…>` makes
   * the read side un-callable and is what a second, drifting copy of the predicate would grow from.
   */
  repairQueue?:
    | (Pick<FrozenCandidateRepairQueue, 'candidate' | 'repairHead' | 'phase'> & {
        blockedReason?: FrozenCandidateBlockedReason | null;
      })
    | null;
}): boolean {
  const { candidate, repairQueue } = input;
  if (repairQueue == null || repairQueue.repairHead !== candidate) return false;
  if (repairQueue.phase === 'blocked') return false;
  return repairQueue.blockedReason == null;
}
