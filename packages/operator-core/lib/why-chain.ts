/**
 * why-chain — "why is nothing shipping?" causal-chain explainer (EI-7349).
 *
 * During a deploy freeze the constituent facts already live in structured
 * data across several places: the green-checkpoint gate health + release-gate
 * snapshot (gitPipelineSnapshot), the recent test-run failures behind a red
 * streak (harness_shared.test_runs), and the account-pool rate-limit state
 * (accountStatus). Answering "why is nothing shipping" today means an agent
 * manually stitching those together (a real forensic exercise the 2026-07-03/
 * 04 13h freeze needed an SU session to assemble). This is the deterministic,
 * no-LLM 80% case: walk gate -> deploy -> pool top-down and render ONE causal
 * sentence per stage, naming the current blocking leaf.
 *
 * Pure composition — every data source is injectable so this is unit-testable
 * without a live DB / git checkout. Read-only: computes and returns, never
 * mutates any of the systems it reads.
 */
import { gitPipelineSnapshot, type GitPipelineSnapshot } from './git-pipeline-stats';
import { isCommitOnlyMember } from './git-pipeline-position';
import { accountStatus, type AccountStatusRow } from './deployment/account-pool-store';
import { runtimeDiagnostic, type RuntimeDiagnostic } from './runtime-diagnostic';
import { computeDiagnosticVintage, type DiagnosticVintage } from './diagnostic-vintage';
import { getBuildInfo } from './build-info';
import { gateAbortLever, gateAbortRefireClause } from './release/gate-abort-status';

/** A postgres-js-like tagged-template client; injectable so this stays unit-testable. */
type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

const FAIL_STATUSES = new Set(['fail', 'error']);
// Same restored-checkout exclusion testing-flakiness.ts applies (a checkpoint/gate
// worktree copy uses a different path scheme than a harness's own root).
const RESTORED_CHECKOUT_PREFIX = 'papercupai-workspace/papercup-';

export type WhyChainStatus = 'ok' | 'degraded' | 'blocked';

/** Live gateway ADMISSION snapshot (the subset of :8788/admin/stats the chain judges). EI-10880. */
export interface AdmissionSnapshotLite {
  running: number;
  queued: number;
  maxConcurrent: number;
  tier1Reserve?: number;
  byTier?: { tier: number; minShare: number | null; inFlight: number; queued: number }[];
  /** AIMD effective vs configured cap — a deep shrink is worth naming even when nothing is queued. */
  aimdEffective?: number;
  aimdCap?: number;
}

export interface WhyChainStage {
  stage: 'gate' | 'deploy' | 'admission' | 'pool';
  status: WhyChainStatus;
  reason: string;
  /**
   * WI-4577 — the DECISIVE next tool call for this stage, present ONLY when `status !== 'ok'`
   * (an ok stage needs no action). This is not new advice: it is the exact drill-down mapping
   * `dev:why`'s own `guidance.chaining` already spells out in prose (gate → testing:flakiness,
   * deploy → release:deploy/dev:pipeline_position, admission → gateway:status, pool →
   * accounts:status) — surfaced here as DATA on the stage that names it, so a caller parsing the
   * JSON response gets the decisive tool without a second read of this tool's own guidance text
   * (the same "derived claim without its caveat/action" gap EI-10951 named: advice that only
   * lives in prose an agent must separately notice is advice a machine-following agent can miss).
   */
  nextVerb?: string;
}

export interface WhyChainResult extends RuntimeDiagnostic<
  { stageOrder: WhyChainStage['stage'][]; workspaceId: string | null; harnessSlug: string | null },
  { status: WhyChainStatus; blockingStage: WhyChainStage['stage'] | null },
  { stages: WhyChainStage[]; recentFailingFiles: string[] },
  WhyChainStage
> {
  generatedAtMs: number;
  stages: WhyChainStage[];
  /** The upstream-most non-ok stage — the leaf an owner should look at first. */
  rootCause: WhyChainStage | null;
  /** One causal sentence per stage, joined into the full chain. */
  summary: string;
  recentFailingFiles: string[];
  /** EI-17603: see `PipelineHealth.gateVerdictDisjointFromLedger` — same check, same meaning. */
  gateVerdictDisjointFromLedger?: boolean;
  /** EI-20239342853734300: disclose whether this process is older than the tree it diagnoses. */
  diagnosticVintage: DiagnosticVintage;
}

/**
 * WI-4577: ONE source of truth for "the decisive next tool" — each stage function above already
 * names its own `nextVerb` at the exact branch that knows WHY it is non-ok (e.g. a stale verdict
 * needs a fresh checkpoint run, not the tests it names; a wedged routine needs the same). Reading
 * it back off `rootCause` here (rather than re-deriving it from `reason` text) means the top-level
 * `WhyChainResult.nextVerb` and `rootCause.nextVerb` can never disagree — they are the same field.
 */
function nextVerbForRoot(rootCause: WhyChainStage | null): string | null {
  return rootCause?.nextVerb ?? null;
}

export interface WhyChainDeps {
  loadSnapshot?: () => Promise<GitPipelineSnapshot>;
  /**
   * Explicit opt-in for the snapshot's git sidecar. Diagnostic reads default
   * to local git so importing/running this pure composition cannot boot an
   * agent-spawn transport in a short-lived verification process.
   */
  useSpawnerSidecar?: boolean;
  loadAccounts?: (ws?: string) => Promise<AccountStatusRow[]>;
  /** Test seam / override for the live gateway ADMISSION read (EI-10880). Null ⇒ gateway unreachable. */
  loadAdmission?: () => Promise<AdmissionSnapshotLite | null>;
  /** Test seam: inject a fake sql client for the recent-failures query. */
  sql?: SqlLike;
  /** Test seam for the process build identity used by the freshness disclosure. */
  loadProcessSha?: () => string | null;
  workspaceId?: string;
  harnessSlug?: string;
}

/** Most recent distinct failing test files (fail/error), newest-first, capped at 5. */
export async function recentFailingFiles(deps: WhyChainDeps = {}): Promise<string[]> {
  let sql: SqlLike;
  try {
    if (deps.sql) {
      sql = deps.sql;
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql as unknown as SqlLike;
    }
  } catch {
    return [];
  }
  // WI-6055: choose the scope predicate before preparing the statement. A
  // parameterized-null OR (`$1 IS NULL OR workspace_id = $1`) cannot expose an
  // index equality to a GENERIC plan. The unscoped branch binds a plain TRUE so
  // injectable one-call SqlLike test doubles do not have to manufacture an
  // empty postgres.js fragment.
  const scopePredicate = deps.harnessSlug
    ? sql`harness_slug = ${deps.harnessSlug}`
    : deps.workspaceId
      ? sql`workspace_id = ${deps.workspaceId}`
      : true;
  try {
    const rows = (await sql`
      SELECT DISTINCT ON (file_path) file_path, status, finished_at
        FROM harness_shared.test_runs
       WHERE finished_at IS NOT NULL
         AND finished_at > now() - interval '2 hours'
         AND status IN ('fail', 'error')
         AND source <> 'mutation-probe'
         AND file_path NOT LIKE ${RESTORED_CHECKOUT_PREFIX + '%'}
         AND ${scopePredicate}
       ORDER BY file_path ASC, finished_at DESC
    `) as unknown as Array<{ file_path: string; finished_at: string }>;
    return rows
      .sort((a, b) => new Date(b.finished_at).getTime() - new Date(a.finished_at).getTime())
      .slice(0, 5)
      .map((r) => r.file_path);
  } catch {
    // best-effort: a missing table / query failure degrades to "unknown", not a throw.
    return [];
  }
}

/**
 * The gate's COLOUR as a single label — the one word an agent acts on. Derived here, next to
 * gateStage, so every consumer (dev:why's chain AND coord:orient's wake fold, WI-4533) reads the
 * SAME rule: two surfaces that disagree about whether the gate is red is worse than either being
 * silent.
 *
 * `stale-verdict` is deliberately its OWN colour, not a red — see gateStage below.
 * `inconclusive` is likewise not a verdict colour: the last checkpoint rendered no code verdict,
 * so any counters and failing tests beside it describe an older run.
 */
export type GateLabel = 'green' | 'red' | 'stalled' | 'wedged' | 'stale-verdict' | 'conflict' | 'inconclusive';

export function gateLabel(snap: GitPipelineSnapshot): GateLabel {
  const g = snap.gate;
  if (snap.openConflict) return 'conflict';
  if (g.inconclusive) return 'inconclusive';
  if (g.fireStale) return 'wedged';
  if (g.verdictStale && g.consecutiveReds > 0) return 'stale-verdict';
  if (g.stalled) return 'stalled';
  if (g.consecutiveReds > 0) return 'red';
  return 'green';
}

/**
 * WHAT IS ACTUALLY RED — the gate's own verdict first, the time-window proxy second (WI-4533).
 *
 * `gate_health.failingTests` is the checkpoint naming the tests that redded IT. `recentFailingFiles`
 * is a 2h scan of `test_runs` — a proxy that answers a *different* question ("what failed lately,
 * anywhere") and can easily be empty for a genuinely red gate. Measured live on a red gate
 * (2026-07-13): the proxy returned NOTHING while the gate's own record held all four culprits, so
 * the chain reported "gate red" and named nobody. Prefer first-hand evidence; keep the proxy as the
 * fallback for an older blob that never recorded any.
 */
export function namedFailures(snap: GitPipelineSnapshot, recentFiles: string[]): string[] {
  return snap.gate.failingTests?.length ? snap.gate.failingTests : recentFiles;
}

/** A package/workspace name (`@papercusp/operator-core`) or a build/lint step sentinel
 *  (`lint:tsc`, ...) — never a real test file, and must never be reported or dispatched
 *  against as one (EI-17603: two of six names in a real misdirected verdict were exactly this). */
function isStepShaped(entry: string): boolean {
  return /^@[^/]+\/[^/]+$/.test(entry) || entry.startsWith('lint:');
}

/** EI-17603: split a gate's named failure signature into real file paths vs package/step
 *  sentinels, so a package name can never masquerade as "the file to go fix" and so the
 *  file-shaped subset alone can be checked against the ledger below. Pure, order-preserving. */
export function splitFailingSignature(entries: string[]): { failingFiles: string[]; failingSteps: string[] } {
  const failingFiles: string[] = [];
  const failingSteps: string[] = [];
  for (const e of entries) (isStepShaped(e) ? failingSteps : failingFiles).push(e);
  return { failingFiles, failingSteps };
}

/** Distinct file(s) recorded fail/error in `harness_shared.test_runs` for the EXACT commit a
 *  gate verdict was recorded against (`gate_health.observedCandidate`, a short/12-char sha).
 *  Narrow and cheap (one indexed `commit_sha LIKE` query) — only ever called when the gate
 *  already named something file-shaped, so this never adds IO to a green (or unattributed)
 *  gate. Fail-soft: any error degrades to `[]` (unable to verify), never a throw.
 *
 *  WI-6825: requires `source = 'ci'`. This is the load-bearing filter, not a refinement.
 *  `test_runs` is dominated by `source='local'` rows — every agent's own dev runs — and they
 *  are stamped with whatever sha the SHARED TREE sat at, so a peer running tests while the
 *  gate judges commit X produces local rows stamped X that were never the gate's evidence.
 *  Without this predicate the "ledger" for a candidate is mostly peers' local runs, and a
 *  DISJOINT verdict below then clears the gate's real failing list in favour of them —
 *  telling the agent to go fix files the gate never named. Measured 2026-08-02 on candidate
 *  c3966f7316f9: 3,578 ci rows AND 3,938 local rows for the same sha.
 *
 *  This also retires the founding evidence for the disjoint check itself. It was justified by
 *  a 2026-07-25 incident where `test_runs` held "3 DIFFERENT actually-failing files" for a
 *  commit whose gate verdict named 4 passing ones — but on that date the table held 236 rows,
 *  100% `source='local'` (zero gate rows existed until EI-19307211919650123 landed a ci
 *  writer ~2026-08-02T04:00Z). Those 3 files were local dev runs, so the gate was never shown
 *  to be misdirecting. The cross-check is sound going forward precisely BECAUSE ci rows now
 *  exist; before them it could only ever have compared the gate against unrelated local runs.
 *
 *  EI-18795303393201472: excludes `worktree_dirty = true` rows. This function is used as
 *  FIRST-HAND evidence for a SPECIFIC commit sha (verifyGateVerdict below can clear the
 *  gate's own named failures when the ledger disagrees) — a row from a run that executed
 *  against an unstable shared tree can be stamped with a commit sha it never actually ran
 *  at (a torn read), which would poison exactly this cross-check for an unrelated commit
 *  that happens to share the stamp. `recentFailingFiles` above is a time-windowed proxy
 *  ("something failed recently") and deliberately keeps dirty rows — sha precision doesn't
 *  matter there. */
export async function ledgerFilesForCandidate(
  candidateShort: string | null,
  deps: WhyChainDeps = {},
): Promise<string[]> {
  if (!candidateShort || candidateShort.length < 7) return [];
  let sql: SqlLike;
  try {
    if (deps.sql) {
      sql = deps.sql;
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      sql = getOrgPg().sql as unknown as SqlLike;
    }
  } catch {
    return [];
  }
  // WI-6055: keep the prepared statement's scope arm as a direct equality;
  // see recentFailingFiles for why the nullable-parameter OR is not used.
  const scopePredicate = deps.harnessSlug
    ? sql`harness_slug = ${deps.harnessSlug}`
    : deps.workspaceId
      ? sql`workspace_id = ${deps.workspaceId}`
      : true;
  try {
    const rows = (await sql`
      SELECT DISTINCT file_path
        FROM harness_shared.test_runs
       WHERE commit_sha LIKE ${candidateShort + '%'}
         AND status IN ('fail', 'error')
         AND source = 'ci'
         AND file_path NOT LIKE ${RESTORED_CHECKOUT_PREFIX + '%'}
         AND worktree_dirty = false
         AND ${scopePredicate}
       LIMIT 50
    `) as unknown as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  } catch {
    return []; // best-effort — a query failure degrades to "unable to verify", not a throw.
  }
}

/** Pure verdict: does the gate's own file-shaped `failingTests` hold up against first-hand
 *  ledger evidence for the SAME commit? `unverifiable` (no ledger rows at all for that commit —
 *  an old blob predating `observedCandidate`, a writer that never tagged commit_sha, or the run
 *  simply hasn't landed in the ledger yet) deliberately leaves the gate's own record untouched:
 *  absence of ledger evidence is not evidence the record is wrong. Only a genuine, non-empty
 *  DISJOINT set (ledger has fail/error rows for this commit, and NONE match the gate's names) is
 *  distrusted — that is the live-observed misdirection (EI-17603): the gate named 4 files that
 *  all passed while 3 different files were the real, ledger-recorded reds for that same commit. */
export function verifyGateFailingFiles(
  failingFiles: string[],
  ledgerFiles: string[],
): 'confirmed' | 'disjoint' | 'unverifiable' {
  if (failingFiles.length === 0) return 'confirmed';
  if (ledgerFiles.length === 0) return 'unverifiable';
  const ledgerSet = new Set(ledgerFiles);
  return failingFiles.some((f) => ledgerSet.has(f)) ? 'confirmed' : 'disjoint';
}

/**
 * WI-6529 — PER-FILE reconciliation of a checkpoint's named file-shaped failures against
 * first-hand ledger evidence for the SAME commit, correcting BOTH directions at once:
 *
 *  - DROPS any named file the ledger does NOT confirm failed (a false positive — the
 *    checkpoint named a file that in fact passed).
 *  - ADDS any file the ledger shows really failed but the checkpoint never named (a false
 *    negative — an entire failing file/workspace silently missing from the recorded
 *    signature).
 *
 * `verifyGateFailingFiles` above answers a coarser question ("does the named list overlap
 * the ledger AT ALL") and — by design — treats ANY overlap as fully 'confirmed', leaving the
 * whole list untouched. That is exactly how a REAL live verdict shipped both defects at once
 * (2026-07-27, filed as WI-6529): `failingTests` named one file that had already gone green
 * (false positive) alongside one file that was genuinely red (the overlap that made the old
 * check call it "confirmed"), while omitting an entirely different, also genuinely-red file in
 * another workspace (false negative) — an any-overlap check cannot see either defect once the
 * two co-occur with a shared true positive.
 *
 * `ledgerFiles` empty ⇒ no first-hand evidence for this commit at all ⇒ returns `failingFiles`
 * unchanged (`corrected: false`) — absence of ledger evidence is not evidence the record is
 * wrong (same "unverifiable" principle `verifyGateFailingFiles` already applies).
 */
export function reconcileFailingFiles(
  failingFiles: string[],
  ledgerFiles: string[],
): { files: string[]; corrected: boolean } {
  if (ledgerFiles.length === 0) return { files: failingFiles, corrected: false };
  const ledgerSet = new Set(ledgerFiles);
  const confirmed = failingFiles.filter((f) => ledgerSet.has(f));
  const missing = ledgerFiles.filter((f) => !failingFiles.includes(f));
  const corrected = confirmed.length !== failingFiles.length || missing.length > 0;
  if (!corrected) return { files: failingFiles, corrected: false };
  return { files: [...confirmed, ...missing].sort(), corrected: true };
}

/**
 * EI-17603 (WI-4533 follow-up) — cross-check the gate's own named `failingTests` against the
 * test-run ledger for the EXACT commit under verdict, before any consumer trusts it as "the
 * tests to go fix". Observed live 2026-07-25: a real verdict named 6 "failures" (4 test files —
 * all PASSING both standalone and per the ledger — plus 2 build-sentinel package names) while
 * `harness_shared.test_runs` held 3 DIFFERENT actually-failing files for that exact commit, never
 * named. The report had fully decoupled from the system it describes.
 *
 * When disjoint: clears `snap.gate.failingTests` on a shallow-cloned snapshot (never mutates the
 * input) so `namedFailures`/`gateStage` naturally fall back to a proxy — the caller passes the
 * already-fetched `ledgerFiles` for that purpose, which is both cheaper (no second query) and
 * more precise (scoped to the exact commit) than the generic 2h scan. Skips the query entirely
 * — zero added IO — unless the gate already named something file-shaped AND we know which commit
 * it pertains to; a stale verdict (WI-4489) is out of scope here (it already names nobody).
 */
export async function verifyGateVerdict(
  snap: GitPipelineSnapshot,
  deps: WhyChainDeps = {},
): Promise<{ snap: GitPipelineSnapshot; disjoint: boolean; ledgerFiles: string[] }> {
  // An inconclusive tick rendered no code verdict. Its failingTests/candidate fields, when
  // present, are inherited from the previous verdict and must never be reconciled into a new
  // dispatch target (the same containment rule as a stale verdict, but a distinct label).
  if (snap.gate.verdictStale || snap.gate.inconclusive) return { snap, disjoint: false, ledgerFiles: [] };
  const { failingFiles, failingSteps } = splitFailingSignature(snap.gate.failingTests ?? []);
  if (failingFiles.length === 0 || !snap.gate.observedCandidate) {
    return { snap, disjoint: false, ledgerFiles: [] };
  }
  const ledgerFiles = await ledgerFilesForCandidate(snap.gate.observedCandidate, deps);
  // WI-6529: reconcile PER FILE (drops false positives, adds false negatives) rather than the
  // coarse any-overlap check — see reconcileFailingFiles for why any-overlap alone misses the
  // two-defects-at-once case. Package/step sentinels (failingSteps) have no ledger row to check
  // against (the ledger only ever records real test FILES), so they always ride back through
  // untouched — they were never part of what this cross-check verifies.
  const { files: reconciledFiles, corrected } = reconcileFailingFiles(failingFiles, ledgerFiles);
  if (!corrected) {
    return { snap, disjoint: false, ledgerFiles };
  }
  const reconciledSignature = [...failingSteps, ...reconciledFiles];
  return {
    snap: { ...snap, gate: { ...snap.gate, failingTests: reconciledSignature } },
    disjoint: true,
    ledgerFiles,
  };
}

function gateStage(snap: GitPipelineSnapshot, failingFiles: string[]): WhyChainStage {
  const g = snap.gate;
  const named = namedFailures(snap, failingFiles);
  const filesNote = named.length ? ` — failing: ${named.slice(0, 6).join(', ')}` : '';
  if (snap.openConflict) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `an OPEN merge conflict is unresolved (scopes: ${snap.openConflict.scopes.join(', ') || 'unknown'}) — git-sync cannot advance staging until it resolves`,
      // Resolution is a coordination hand-off (merge-resolver), not a single diagnostic call —
      // no nextVerb: naming one here would misrepresent a routing decision as a tool call.
    };
  }
  // The latest checkpoint attempt rendered NO verdict. This must outrank fire freshness,
  // stale-verdict, stalled, and the historical red counter: an aborting routine can be firing
  // on schedule while the counters beside the abort remain frozen on an older candidate.
  if (g.inconclusive) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason:
        `gate verdict is INCONCLUSIVE — the last green-checkpoint run ABORTED before judging ` +
        `(${g.inconclusive.status}) and rendered NO verdict${gateAbortRefireClause(g.inconclusive.status)} ` +
        `${g.inconclusive.detail ?? 'See the green-checkpoint log for the blocking condition.'}` +
        (g.consecutiveReds > 0
          ? ` ⚠ The gate counters still show ${g.consecutiveReds} historical red(s)${
              g.observedCandidate ? ` on ${g.observedCandidate}` : ''
            } — those belong to the PREVIOUS verdict, not this run; do not chase its failing tests.`
          : ''),
      nextVerb: gateAbortLever(g.inconclusive.status),
    };
  }
  if (g.fireStale) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `green-checkpoint gate is WEDGED — not firing (${g.fireStaleReason ?? 'stale'})`,
      // A non-firing routine needs a fresh run, not a position read (matches nextVerbForRoot).
      nextVerb: 'release:checkpoint-run',
    };
  }
  // WI-4533: a STALE red is not a red — it is an UNKNOWN, and it must never be rendered as the
  // gate's colour. The snapshot has carried `verdictStale` since WI-4489 ("a stale red must never
  // be reported as the gate's colour, nor dispatch anyone at the tests it names") but this chain —
  // the very read an agent uses to decide what to go fix — never consulted it, so it kept
  // reporting a confident RED off a verdict the system already knew was superseded. That is the
  // exact 3.5h phantom WI-4489 documented: a starved `gate_health` blob reporting 4 reds while
  // every real run was green, which dispatched the release-fixer at 8 tests that all passed — and
  // whose manual runs then held the lock that kept the blob stale. Naming the files here would
  // re-arm precisely that loop, so the stale branch names NONE of them.
  //
  // Ordered ABOVE `stalled`/`consecutiveReds` on purpose: both of those read the same untrusted
  // streak. Freshness is only ever judged for a RED (a stale GREEN misdirects nobody — see
  // gate-verdict-freshness.ts), so a green verdict can never land here.
  if (g.verdictStale && g.consecutiveReds > 0) {
    return {
      stage: 'gate',
      status: 'degraded',
      reason:
        `gate verdict is STALE (${g.verdictStaleReason ?? 'superseded/unverified'}) — the recorded ` +
        `${g.consecutiveReds} red(s) are NOT current, so the gate's colour is UNKNOWN. Do not dispatch ` +
        `anyone at the test(s) it names; re-run the checkpoint to get a real verdict (WI-4489).`,
      // The decisive action for a STALE verdict is a fresh verdict, never the named tests.
      nextVerb: 'release:checkpoint-run',
    };
  }
  if (g.stalled) {
    return {
      stage: 'gate',
      status: 'blocked',
      reason: `green-checkpoint gate STALLED after ${g.consecutiveReds} consecutive reds${filesNote}`,
      nextVerb: 'testing:flakiness',
    };
  }
  if (g.consecutiveReds > 0) {
    return {
      stage: 'gate',
      status: 'degraded',
      reason: `gate red (${g.consecutiveReds} consecutive, not yet stalled)${filesNote}`,
      nextVerb: 'testing:flakiness',
    };
  }
  return { stage: 'gate', status: 'ok', reason: 'green-checkpoint gate is green' };
}

/**
 * The DEPLOY stage asks exactly one question: is code that ALREADY PASSED the gate sitting
 * un-shipped? That is `deployedBehindGreenPin` — the green pin (`main`) is ahead of what runs
 * on :3070.
 *
 * ⚠ EI-11012 — it deliberately does NOT fire on `greenPinBehindStaging` (the STAGING BUFFER:
 * staging ahead of the green pin). This stage used to, believing that field meant "the tip
 * hasn't been promoted". It doesn't — it is the normal steady state of this fleet: git-sync
 * commits `staging` continuously while the green-checkpoint FFs `main` only hourly and only
 * when green, so the buffer is essentially ALWAYS > 0. Firing on it made the deploy stage
 * report `degraded` permanently, which is worse than noise on TWO counts:
 *   1. computeWhyChain() reports the FIRST non-ok stage as the rootCause, so a permanently
 *      degraded deploy stage SHADOWED every real downstream cause (admission, pool, ...);
 *   2. it told agents their code wasn't live when it was — inviting a pointless force-deploy
 *      (a real :3070 restart) or a phantom chase.
 * A buffer that stays large for a long time IS worth knowing about, but that is a GATE/promotion
 * question ("is the gate still advancing main?"), time-thresholded — not a `> 0` boolean here.
 * The gate stage above already owns it (consecutiveReds / stall detection).
 */
function deployStage(snap: GitPipelineSnapshot): WhyChainStage {
  const d = snap.deploy;
  // WI-37998: origin/staging divergence means opposite things on the two supported
  // git topologies. A pushing member owns that ref and a gap is a stuck push. A
  // commit-only bridged member never pushes it at all; its durability signal is the
  // p2p own-head-publish leg. dev:pipeline_position has enforced this distinction
  // since EI-18812945811758018, but dev:why re-derived the old unconditional rule
  // below and repeatedly sent agents to git-sync:run — a lever that cannot move the
  // bridged leg. Reuse the same mode predicate and only make the bridge's own fault
  // signals actionable here.
  const gitSync = snap.gitSync;
  const commitOnly = isCommitOnlyMember({ pushMode: gitSync?.pushMode ?? null });
  const ownHeadPublish = commitOnly ? (gitSync?.ownHeadPublish ?? null) : null;
  if (commitOnly && ownHeadPublish?.refused) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason:
        `the commit-only bridge publish leg is REFUSING origin publication (${ownHeadPublish.refused}); ` +
        'raw origin/staging divergence is expected on this member and git-sync:run cannot fix this refusal',
      nextVerb: 'dev:pipeline_position',
    };
  }
  if (commitOnly && ownHeadPublish?.backlogRemains === true) {
    const trail =
      ownHeadPublish.publishedSha && ownHeadPublish.sha
        ? ` (published ${ownHeadPublish.publishedSha.slice(0, 8)} trails ${ownHeadPublish.sha.slice(0, 8)})`
        : '';
    return {
      stage: 'deploy',
      status: 'degraded',
      reason:
        `the commit-only bridge publish leg has an undrained backlog${trail}; ` +
        'raw origin/staging divergence is expected on this member and git-sync:run cannot drain this leg',
      nextVerb: 'dev:pipeline_position',
    };
  }
  // EI-19341938682536275: the UNPUSHED leg is checked FIRST and independently of the local
  // gate/deploy pipeline below (which never touches origin at all) — a "DEPLOY: ok" verdict
  // about what's live on :3070 says nothing about whether the work is backed up off this box.
  // Unlike `greenPinBehindStaging` (checked further down), git-sync commits AND pushes in the
  // SAME tick, so this sits at 0 in healthy operation; nonzero here is NEVER "normal buffer" —
  // it means pushing itself is stuck. This is the exact "DEPLOY: ok … 99 commits … normal" gloss
  // that read green through a 6h origin-freeze while ~82 commits existed only on one box's disk.
  if (!commitOnly && d.stagingAheadOfOrigin != null && d.stagingAheadOfOrigin > 0) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `${d.stagingAheadOfOrigin} commit(s) on \`${d.integrationBranch}\` have NOT reached \`origin\` — NOT backed up off this box (this is never "normal", however small the count; git-sync pushes on every commit tick, so a stuck push is the only way this stays nonzero)`,
      nextVerb: 'dev:pipeline_position',
    };
  }
  if (d.deployedBehindGreenPin != null && d.deployedBehindGreenPin > 0) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `the green pin (\`main\`) is green and ${d.deployedBehindGreenPin} commit(s) ahead of what's live on :3070 — gated but not yet deployed/restarted`,
      nextVerb: 'release:deploy',
    };
  }
  if (d.errors.length) {
    return {
      stage: 'deploy',
      status: 'degraded',
      reason: `deploy snapshot incomplete: ${d.errors.join('; ')}`,
      nextVerb: 'dev:pipeline_position',
    };
  }
  const buffer =
    d.greenPinBehindStaging != null && d.greenPinBehindStaging > 0
      ? ` (${d.greenPinBehindStaging} commit(s) of staging buffer await the next gate run — normal)`
      : '';
  return {
    stage: 'deploy',
    status: 'ok',
    reason: `deployed :3070 matches the green pin (\`main\`) — everything that passed the gate is live${buffer}`,
  };
}

/**
 * ADMISSION stage (EI-10880) — the layer between "the pool has capacity" and "a request runs".
 *
 * WHY THIS STAGE EXISTS. WI-4541: the gateway serialized the ENTIRE fleet through ONE admission
 * slot (untagged traffic → the bottom tier, whose cap the AIMD shed had driven to its floor of 1)
 * while 9-10 of 12 concurrency slots sat IDLE. Every agent was slow; the owner's voice turns hung
 * ("processing forever"). Walking gate → deploy → pool would have found all three OK and named NO
 * root cause — and worse, the pool stage would have reported "accounts available, none
 * sustained-limited", which actively supports the WRONG conclusion ("must just be load"). The
 * causal chain has to be able to see the queue itself, not just the capacity feeding it.
 *
 * THE DECISIVE TEST — queued while idle. If anything is QUEUED while the pool still has free
 * shared slots (running < maxConcurrent - tier1Reserve), that is DEFINITIONALLY a bug: work is
 * waiting on capacity that exists. No account is walled, no rate limit is involved, and adding
 * pool headroom cannot fix it. It is an admission-path defect, and it is cheap to check.
 *
 * Ordered BEFORE `pool` deliberately: when both are unhappy, the admission defect is the root
 * cause and the pool pressure is downstream of it (requests pile up because they can't get in).
 * A genuinely walled pool with a healthy queue still falls through to poolStage below.
 */
function admissionStage(adm: AdmissionSnapshotLite | null): WhyChainStage {
  if (!adm) {
    return {
      stage: 'admission',
      status: 'degraded',
      reason:
        'inference gateway unreachable on :8788 (admission state unknown — is papercup-inference-gateway.service running?)',
      nextVerb: 'gateway:status',
    };
  }
  const reserve = adm.tier1Reserve ?? 0;
  // Free SHARED capacity — what a tier > 1 is actually allowed to occupy. The tier-1 reserve is
  // held open on purpose, so it is NOT "idle capacity" for this test; excluding it keeps the
  // check honest (no false alarm just because the interactive floor is being held).
  const freeShared = Math.max(0, adm.maxConcurrent - reserve - adm.running);

  if (adm.queued > 0 && freeShared > 0) {
    const perTier = (adm.byTier ?? [])
      .filter((t) => t.queued > 0)
      .map((t) => `tier ${t.tier} (min share ${t.minShare ?? 'none'}, ${t.inFlight} in flight, ${t.queued} queued)`)
      .join(', ');
    return {
      stage: 'admission',
      status: 'blocked',
      reason:
        `${adm.queued} request(s) QUEUED at the gateway while ${freeShared} shared slot(s) sit IDLE ` +
        `(running ${adm.running}/${adm.maxConcurrent}, tier-1 reserve ${reserve})` +
        (perTier ? ` — waiting: ${perTier}` : '') +
        `. This is an ADMISSION-PATH DEFECT, not a capacity shortage: the work is waiting on capacity that already exists, ` +
        `so more pool headroom will NOT fix it. Suspect a per-tier cap refusing an idle slot, or a tier whose cap the AIMD shed drove to its floor (WI-4541). ` +
        `Read gateway:status for the per-tier detail.`,
      nextVerb: 'gateway:status',
    };
  }
  // A deep AIMD shrink is not itself a bug (it is the gateway protecting upstream from sustained
  // 429s) but it IS the thing that makes a low tier cap collapse, so name it before it bites.
  if (adm.aimdCap != null && adm.aimdEffective != null && adm.aimdEffective < adm.aimdCap / 2) {
    return {
      stage: 'admission',
      status: 'degraded',
      reason: `gateway AIMD has shrunk effective concurrency to ${adm.aimdEffective}/${adm.aimdCap} under sustained upstream pressure — throughput is throttled on purpose, but a shed this deep also squeezes the bottom tiers' caps toward their floor of 1 (the WI-4541 precondition); watch for queued-while-idle`,
      nextVerb: 'gateway:status',
    };
  }
  if (adm.queued > 0) {
    return {
      stage: 'admission',
      status: 'degraded',
      reason: `${adm.queued} request(s) queued, but the pool is genuinely FULL (running ${adm.running}/${adm.maxConcurrent}) — admission is behaving correctly; this is real saturation, look at the pool stage`,
      // Admission is behaving correctly here — the decisive next read is the pool it's saturated on.
      nextVerb: 'accounts:status',
    };
  }
  return {
    stage: 'admission',
    status: 'ok',
    reason: `gateway admission healthy — ${adm.running}/${adm.maxConcurrent} in flight, nothing queued`,
  };
}

function poolStage(accounts: AccountStatusRow[]): WhyChainStage {
  if (accounts.length === 0) {
    return {
      stage: 'pool',
      status: 'degraded',
      reason: 'no accounts registered in the pool (unable to assess)',
      nextVerb: 'accounts:status',
    };
  }
  const available = accounts.filter((a) => a.available);
  const sustained = accounts.filter((a) => a.sustainedlyLimited);
  if (available.length === 0) {
    // WI-3310: name the usage wall distinctly — "rate-limited/paused" clears in minutes, a
    // usage-walled account cannot serve until its (possibly days-away) window reset.
    const walled = accounts.filter((a) => a.usageWalled).length;
    return {
      stage: 'pool',
      status: 'blocked',
      reason: `all ${accounts.length} account(s) in the pool are currently unavailable (${walled} usage-walled until their window resets, ${accounts.length - walled} rate-limited/paused) — no spawn capacity`,
      nextVerb: 'accounts:status',
    };
  }
  if (sustained.length > 0) {
    return {
      stage: 'pool',
      status: 'degraded',
      reason: `${sustained.length}/${accounts.length} account(s) sustained-limited (${available.length} still available)`,
      nextVerb: 'accounts:status',
    };
  }
  return {
    stage: 'pool',
    status: 'ok',
    reason: `${available.length}/${accounts.length} accounts available, none sustained-limited`,
  };
}

/** Read the live gateway admission snapshot (:8788/admin/stats). Fail-soft: null when unreachable. */
async function loadAdmissionDefault(): Promise<AdmissionSnapshotLite | null> {
  const port = Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/stats`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      admission?: {
        running?: number;
        queued?: number;
        maxConcurrent?: number;
        tier1Reserve?: number;
        byTier?: AdmissionSnapshotLite['byTier'];
      };
      aimd?: { effective?: number; cap?: number };
    };
    const a = d.admission;
    if (!a || typeof a.running !== 'number' || typeof a.maxConcurrent !== 'number') return null;
    return {
      running: a.running,
      queued: a.queued ?? 0,
      maxConcurrent: a.maxConcurrent,
      tier1Reserve: a.tier1Reserve,
      byTier: a.byTier,
      aimdEffective: d.aimd?.effective,
      aimdCap: d.aimd?.cap,
    };
  } catch {
    return null; // gateway down / not running — admissionStage reports it as degraded, never throws
  }
}

/**
 * PIPELINE HEALTH — the gate + deploy legs only (WI-4533 / P-006).
 *
 * WHY A SECOND ENTRY POINT rather than just calling computeWhyChain: this one is folded into
 * `coord:orient`, the hottest read in the fleet (2256 calls / 425 agents / 7d), so it must be
 * CHEAP and it must be SILENT when it has nothing to say:
 *
 *   - it skips the ADMISSION leg (an HTTP fetch to the gateway) and the POOL leg (accountStatus)
 *     — those answer "why is everything slow", which is not what a waking agent needs to know
 *     before touching code. Gate + deploy answer "will my change ship, and is the tree healthy",
 *     which is;
 *   - it fetches the recent failing FILES only when the gate is not green — no red, no query;
 *   - it reports `known: false` (rather than a cheerful green) for a harness that has no
 *     green-checkpoint routine at all. A detector with no data must say UNKNOWN, never OK — the
 *     same rule the stale-verdict branch above enforces. A false green at wake is worse than
 *     silence: it is an agent shipping into a pipeline it believes is healthy.
 *
 * It shares gateStage/deployStage/gateLabel VERBATIM with dev:why, so the wake fold and the
 * causal chain can never drift into disagreeing about the gate's colour.
 */
export interface PipelineHealth {
  generatedAtMs: number;
  /** false ⇒ this harness has no green-checkpoint routine: nothing is known, report NOTHING. */
  known: boolean;
  gate: WhyChainStage;
  deploy: WhyChainStage;
  gateLabel: GateLabel;
  consecutiveReds: number;
  lastGreenAtMs: number | null;
  /** WI-4489: the recorded red is superseded/unverified — its colour is UNKNOWN, not red. */
  verdictStale: boolean;
  /** EI-18669342433807110: which freshness rule fired (see GateVerdictFreshness.reasonCode) —
   *  `refire-in-flight` means a fresh verdict is imminent (do not even re-fire the checkpoint);
   *  null whenever `verdictStale` is false. */
  verdictStaleReasonCode?: GitPipelineSnapshot['gate']['verdictStaleReasonCode'];
  /** The latest checkpoint attempt rendered no code verdict; counters and failing tests are historical. */
  inconclusive: GitPipelineSnapshot['gate']['inconclusive'];
  /** Commits on `main` not yet promoted to the green pin (`ready`). */
  greenPinBehindStaging: number | null;
  /** Commits on the green pin not yet live on :3070. */
  deployedBehindGreenPin: number | null;
  recentFailingFiles: string[];
  /** EI-17603: the gate's OWN `failingTests` (checked against the ledger for the exact commit
   *  it was recorded against) was CONTRADICTED — none of its named files have a matching
   *  fail/error row in `harness_shared.test_runs` for that commit. `recentFailingFiles` above is
   *  then ledger-derived instead of the (distrusted) checkpoint record. Present only when true. */
  gateVerdictDisjointFromLedger?: boolean;
  /** EI-20239342853734300: disclose whether this process is older than the tree it diagnoses. */
  diagnosticVintage: DiagnosticVintage;
  /** The upstream-most non-ok leg of THIS chain (gate, then deploy) — null when both are ok. */
  rootCause: WhyChainStage | null;
}

/** Appends the disjoint-verdict disclosure to a gate stage's reason. A post-hoc wrap (rather
 *  than threading a flag through `gateStage` itself) so that function's signature and its
 *  existing unit tests stay untouched by this EI-17603 addition. */
function withDisjointNote(stage: WhyChainStage, disjoint: boolean): WhyChainStage {
  if (!disjoint || stage.stage !== 'gate') return stage;
  return {
    ...stage,
    reason:
      `${stage.reason} [the checkpoint's OWN failingTests record for this commit was ` +
      `CONTRADICTED by the test ledger (harness_shared.test_runs) — the file(s) named above are ` +
      `RECONCILED against the ledger (false positive(s) dropped, any missing failing file(s) ` +
      `added), not the checkpoint's raw (wrong) list; see EI-17603/WI-6529]`,
  };
}

export async function computePipelineHealth(deps: WhyChainDeps & { slug?: string } = {}): Promise<PipelineHealth> {
  const loadSnapshot =
    deps.loadSnapshot ?? (() => gitPipelineSnapshot(deps.slug, { useSpawnerSidecar: deps.useSpawnerSidecar ?? false }));
  const rawSnap = await loadSnapshot();
  const now = Date.now();
  const diagnosticVintage = computeDiagnosticVintage({
    processSha: deps.loadProcessSha?.() ?? getBuildInfo().sha,
    stagingHeadSha: rawSnap.deploy.stagingHead?.sha,
    greenPinSha: rawSnap.deploy.greenPin?.sha,
  });

  // No green-checkpoint routine for this harness ⇒ there IS no gate to report on. Say so; a
  // zero-red `gate_health` on a harness that never runs a checkpoint would otherwise render as a
  // confident "green" (the snapshot defaults consecutiveReds to 0).
  if (!rawSnap.routines.greenCheckpoint) {
    const unknown: WhyChainStage = {
      stage: 'gate',
      status: 'degraded',
      reason: 'no green-checkpoint routine for this harness — gate state unknown',
    };
    return {
      generatedAtMs: now,
      known: false,
      gate: unknown,
      deploy: deployStage(rawSnap),
      gateLabel: 'green',
      consecutiveReds: 0,
      lastGreenAtMs: null,
      verdictStale: false,
      verdictStaleReasonCode: null,
      inconclusive: null,
      greenPinBehindStaging: null,
      deployedBehindGreenPin: null,
      recentFailingFiles: [],
      diagnosticVintage,
      rootCause: null,
    };
  }

  // EI-17603: cross-check the gate's own `failingTests` against the ledger for the EXACT commit
  // it was recorded against, BEFORE anything below trusts it. Zero added IO unless the gate
  // already named something file-shaped and we know which commit — see `verifyGateVerdict`.
  const { snap, disjoint, ledgerFiles } = await verifyGateVerdict(rawSnap, deps);

  // The failing-files query is the only extra IO, and it is skipped TWICE over: a GREEN gate never
  // pays for it, and neither does a red gate that already NAMED its own failures (the common case
  // — see namedFailures). The proxy scan is the last resort, not the first read.
  const provisional = gateStage(snap, []);
  // `?? []` (not `?.length === 0`): a blob written before failingTests existed has the field
  // UNDEFINED, and `undefined === 0` is false — which would have silently skipped the fallback
  // scan for exactly the old gates that most need it.
  const needsProxy =
    !snap.gate.inconclusive && provisional.status !== 'ok' && (snap.gate.failingTests ?? []).length === 0;
  // Disjoint ⇒ we already have the precise, commit-scoped ledger files; reuse them instead of
  // paying for a second (broader, less precise) 2h scan.
  const proxyFiles = needsProxy ? (disjoint ? ledgerFiles : await recentFailingFiles(deps)) : [];
  const gate = withDisjointNote(proxyFiles.length ? gateStage(snap, proxyFiles) : provisional, disjoint);
  const deploy = deployStage(snap);
  // `recentFailingFiles` is documented (and consumed) as FILES to go fix — never a package/step
  // sentinel (`isStepShaped` exists precisely because a build-step name must never masquerade as
  // a file to dispatch a fix at). `namedFailures` can legitimately return sentinels mixed in with
  // files (they still belong in the human-readable `gate.reason` above), so strip them here for
  // the STRUCTURED field.
  const failingFiles = snap.gate.inconclusive
    ? []
    : splitFailingSignature(namedFailures(snap, proxyFiles)).failingFiles;

  return {
    generatedAtMs: now,
    known: true,
    gate,
    deploy,
    gateLabel: gateLabel(snap),
    consecutiveReds: snap.gate.consecutiveReds,
    lastGreenAtMs: snap.gate.lastGreenAtMs,
    verdictStale: snap.gate.verdictStale,
    verdictStaleReasonCode: snap.gate.verdictStaleReasonCode,
    inconclusive: snap.gate.inconclusive,
    greenPinBehindStaging: snap.deploy.greenPinBehindStaging ?? null,
    deployedBehindGreenPin: snap.deploy.deployedBehindGreenPin ?? null,
    recentFailingFiles: failingFiles,
    diagnosticVintage,
    ...(disjoint ? { gateVerdictDisjointFromLedger: true } : {}),
    rootCause: [gate, deploy].find((s) => s.status !== 'ok') ?? null,
  };
}

/** Compute the full why-chain (gate -> deploy -> admission -> pool), pure + read-only. */
export async function computeWhyChain(deps: WhyChainDeps = {}): Promise<WhyChainResult> {
  const loadSnapshot =
    deps.loadSnapshot ??
    (() => gitPipelineSnapshot(deps.harnessSlug, { useSpawnerSidecar: deps.useSpawnerSidecar ?? false }));
  const loadAccounts = deps.loadAccounts ?? ((ws?: string) => accountStatus(ws));
  const loadAdmission = deps.loadAdmission ?? loadAdmissionDefault;

  const [rawSnap, accounts, admission, broadProxyFiles] = await Promise.all([
    loadSnapshot(),
    loadAccounts(deps.workspaceId).catch(() => [] as AccountStatusRow[]),
    loadAdmission().catch(() => null),
    recentFailingFiles(deps),
  ]);

  // EI-17603: same cross-check as computePipelineHealth, applied here too so `dev:why` and
  // `coord:orient` can never drift into disagreeing about which files are actually red.
  const { snap, disjoint, ledgerFiles } = await verifyGateVerdict(rawSnap, deps);
  const diagnosticVintage = computeDiagnosticVintage({
    processSha: deps.loadProcessSha?.() ?? getBuildInfo().sha,
    stagingHeadSha: rawSnap.deploy.stagingHead?.sha,
    greenPinSha: rawSnap.deploy.greenPin?.sha,
  });
  // Fed to gateStage as the FALLBACK proxy when `snap.gate.failingTests` is empty — `snap` is
  // already reconciled by verifyGateVerdict when the ledger corrected it, so this branch only
  // matters for a blob that named nothing file-shaped to begin with.
  const proxyFiles = disjoint ? ledgerFiles : broadProxyFiles;

  const stages: WhyChainStage[] = [
    withDisjointNote(gateStage(snap, proxyFiles), disjoint),
    deployStage(snap),
    admissionStage(admission),
    poolStage(accounts),
  ];
  const rootCause = stages.find((s) => s.status !== 'ok') ?? null;
  // WI-6529: the top-level `recentFailingFiles` field MUST be DERIVED FROM exactly what the gate
  // stage's own `reason` text names — the same `namedFailures` precedence (the reconciled
  // first-hand record beats the proxy) computeWhyChain's stage above already applies. Returning
  // the raw proxy here instead (the pre-fix bug) is how a real verdict shipped `reason` text
  // naming two failing files while this field reported `[]` in the SAME response. Package/step
  // sentinels are stripped (see the matching comment in computePipelineHealth) — this field is
  // documented as FILES, never a build-step name to (mis)dispatch a fix at.
  const failingFiles = snap.gate.inconclusive
    ? []
    : splitFailingSignature(namedFailures(snap, proxyFiles)).failingFiles;

  const chainLine = stages.map((s) => `${s.stage.toUpperCase()}: ${s.status} (${s.reason})`).join(' → ');
  const summary = rootCause
    ? `${chainLine}\n\nROOT CAUSE: ${rootCause.stage} — ${rootCause.reason}`
    : `${chainLine}\n\nAll stages nominal — nothing in the gate/deploy/pool chain appears to be blocking shipping right now.`;

  const diagnostic = runtimeDiagnostic({
    configured: {
      stageOrder: stages.map((s) => s.stage),
      workspaceId: deps.workspaceId ?? null,
      harnessSlug: deps.harnessSlug ?? null,
    },
    effective: {
      status: rootCause?.status ?? 'ok',
      blockingStage: rootCause?.stage ?? null,
    },
    evidence: { stages, recentFailingFiles: failingFiles },
    rootCause,
    nextVerb: nextVerbForRoot(rootCause),
  });

  return {
    generatedAtMs: Date.now(),
    stages,
    summary,
    recentFailingFiles: failingFiles,
    diagnosticVintage,
    ...(disjoint ? { gateVerdictDisjointFromLedger: true } : {}),
    ...diagnostic,
  };
}
