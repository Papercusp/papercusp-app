/**
 * Bug reproduction receipts (observation-candidate-acceptance-promotion-2026-09-30
 * D-023 / D-024, P-013).
 *
 * D-023: a bug becomes accepted work only with a REPRODUCTION RECEIPT — a failing
 * test, a scripted repro, or a log/ledger observation — that names the build sha it
 * was observed on. Without one, the bulk review records `investigate` (a bounded
 * repro task), `reject` (it no longer reproduces) or `retain` (keep as evidence).
 *
 * D-024: an agent that ENCOUNTERED the failure files the encounter as the receipt,
 * so the bug is born verified for the reproduction requirement only. Where the
 * encounter is machine-checkable (`test_runs:<id>` / `tool_invocations:<id>`) the
 * intake resolves the ledger row and confirms it shows a failure on the cited build
 * instead of trusting the filer's text. Human-filed reports and caller-classified
 * tool failures never skip review.
 *
 * Reused, not forked: the receipt rides on the existing intake decision
 * (`BulkIntakeDecision.reproduction`) and on the work-item payload; the ledger rows
 * it cites already exist (`harness_shared.test_runs`, `harness_shared.tool_invocations`).
 * The vocabulary and validation here are pure; ledger reads go through
 * {@link ReproductionLedgerDeps} so the browser-shared dispositions module can
 * import the types without pulling in Postgres.
 */

export const BUG_REPRODUCTION_SCHEMA_VERSION = 'bug-reproduction-v1' as const;

/** D-023 receipt kinds, plus D-024's filing-time `encounter`. */
export const BUG_REPRODUCTION_KINDS = [
  'failing-test',
  'scripted-repro',
  'current-build-observation',
  'encounter',
] as const;

export type BugReproductionKind = (typeof BUG_REPRODUCTION_KINDS)[number];

export interface BugReproductionReceipt {
  kind: BugReproductionKind;
  /** `test_runs:<id>`, `tool_invocations:<id>`, a test path, a script, or a quoted log line. */
  ref: string;
  /** The build the failure was observed on (git sha, 7–40 hex). */
  buildSha: string;
}

const BUILD_SHA_RE = /^[0-9a-f]{7,40}$/i;
const REF_MAX = 2000;

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function isBugReproductionKind(value: unknown): value is BugReproductionKind {
  return typeof value === 'string' && (BUG_REPRODUCTION_KINDS as readonly string[]).includes(value);
}

/**
 * Validate a receipt. Refuses (never defaults) an unknown kind, a blank ref or a
 * missing/malformed build sha: a receipt that does not name its build cannot show
 * the bug reproduces on the CURRENT build. `defaultKind` lets the filing door omit
 * `kind` (an encounter is the only filing-time kind that means anything).
 */
export function parseBugReproductionReceipt(
  raw: unknown,
  opts: { defaultKind?: BugReproductionKind } = {},
): { ok: true; receipt: BugReproductionReceipt } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'reproduction must be an object { kind, ref, buildSha }' };
  }
  const v = raw as Record<string, unknown>;
  const kind = v.kind === undefined || v.kind === null ? opts.defaultKind : v.kind;
  if (!isBugReproductionKind(kind)) {
    return {
      ok: false,
      error: `reproduction.kind must be one of ${BUG_REPRODUCTION_KINDS.join(', ')} (got ${JSON.stringify(v.kind)})`,
    };
  }
  const ref = nonBlank(v.ref);
  if (!ref) {
    return {
      ok: false,
      error: 'reproduction.ref is required: the failing test, the repro script, test_runs:<id>, tool_invocations:<id>, or the log line observed',
    };
  }
  const buildSha = nonBlank(v.buildSha);
  if (!buildSha || !BUILD_SHA_RE.test(buildSha)) {
    return {
      ok: false,
      error: `reproduction.buildSha must be the git sha of the build the failure was observed on (7-40 hex; got ${JSON.stringify(v.buildSha ?? null)})`,
    };
  }
  return { ok: true, receipt: { kind, ref: ref.slice(0, REF_MAX), buildSha: buildSha.toLowerCase() } };
}

/** Tolerant read of a persisted receipt; null when it would not parse today. */
export function readBugReproductionReceipt(raw: unknown): BugReproductionReceipt | null {
  const parsed = parseBugReproductionReceipt(raw);
  return parsed.ok ? parsed.receipt : null;
}

/** A machine-checkable ledger citation inside a receipt's `ref`. */
export interface ReproductionLedgerRef {
  table: 'test_runs' | 'tool_invocations';
  id: number;
}

const LEDGER_REF_RE = /^(test_runs|tool_invocations)[:#](\d{1,18})$/;

/** `test_runs:<id>` / `tool_invocations:<id>` (also `#`); anything else is free text. */
export function parseReproductionLedgerRef(ref: string): ReproductionLedgerRef | null {
  const match = LEDGER_REF_RE.exec(ref.trim());
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { table: match[1] as ReproductionLedgerRef['table'], id };
}

/** Two shas name the same build when the shorter is a prefix of the longer. */
export function sameBuildSha(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase();
  const y = (b ?? '').trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * `verified`   — a ledger row shows the failure on the cited build.
 * `attested`   — free-text evidence (a log line, a script) the filer/reviewer observed;
 *                nothing machine-checkable to resolve (D-024 §5 applies only to refs).
 * `refuted`    — the cited row exists but does not show a failure on the cited build.
 * `unresolved` — the cited row is missing or the ledger could not be read.
 * `not-eligible` — the filing route may not skip review (human-filed, caller-classified).
 */
export type ReproductionVerificationStatus = 'verified' | 'attested' | 'refuted' | 'unresolved' | 'not-eligible';

export interface ReproductionVerification {
  status: ReproductionVerificationStatus;
  detail: string;
  checkedAt: string;
  /** What the ledger row actually said, when one was read. */
  observed?: { status: string | null; buildSha: string | null } | null;
}

/** Receipt statuses that satisfy D-023 without another review step. */
export function isAcceptedReproductionStatus(status: unknown): boolean {
  return status === 'verified' || status === 'attested';
}

export interface ReproductionLedgerDeps {
  readTestRun(id: number): Promise<{ status: string | null; commitSha: string | null; worktreeDirty: boolean | null } | null>;
  readToolInvocation(id: number): Promise<{ status: string | null; servingBuildSha: string | null } | null>;
  now(): Date;
}

const FAILING_TEST_STATUSES = new Set(['fail', 'error']);
/** tool_invocations statuses that are not a failure of the tool. */
const NON_FAILING_INVOCATION_STATUSES = new Set(['ok', 'replayed']);

/**
 * Resolve a receipt's ledger citation (D-024 §5). Free-text refs are `attested`:
 * there is nothing to resolve, and the receipt still names its build.
 */
export async function verifyBugReproductionReceipt(
  receipt: BugReproductionReceipt,
  deps: ReproductionLedgerDeps,
): Promise<ReproductionVerification> {
  const checkedAt = deps.now().toISOString();
  const ref = parseReproductionLedgerRef(receipt.ref);
  if (!ref) {
    return { status: 'attested', detail: 'free-text evidence; no ledger row to resolve', checkedAt };
  }
  try {
    if (ref.table === 'test_runs') {
      const row = await deps.readTestRun(ref.id);
      if (!row) return { status: 'unresolved', detail: `test_runs:${ref.id} does not exist`, checkedAt };
      const observed = { status: row.status, buildSha: row.commitSha };
      if (!FAILING_TEST_STATUSES.has(String(row.status))) {
        return { status: 'refuted', detail: `test_runs:${ref.id} is ${row.status ?? 'unknown'}, not a failure`, checkedAt, observed };
      }
      if (!sameBuildSha(row.commitSha, receipt.buildSha)) {
        return {
          status: 'refuted',
          detail: `test_runs:${ref.id} ran on ${row.commitSha ?? 'an unrecorded commit'}, not the cited build ${receipt.buildSha}`,
          checkedAt,
          observed,
        };
      }
      if (row.worktreeDirty === true) {
        return {
          status: 'refuted',
          detail: `test_runs:${ref.id} ran on a dirty worktree, so it does not show the failure on build ${receipt.buildSha}`,
          checkedAt,
          observed,
        };
      }
      return { status: 'verified', detail: `test_runs:${ref.id} failed on ${receipt.buildSha}`, checkedAt, observed };
    }
    const row = await deps.readToolInvocation(ref.id);
    if (!row) return { status: 'unresolved', detail: `tool_invocations:${ref.id} does not exist`, checkedAt };
    const observed = { status: row.status, buildSha: row.servingBuildSha };
    if (row.status == null || NON_FAILING_INVOCATION_STATUSES.has(row.status)) {
      return { status: 'refuted', detail: `tool_invocations:${ref.id} is ${row.status ?? 'unknown'}, not a failure`, checkedAt, observed };
    }
    if (!sameBuildSha(row.servingBuildSha, receipt.buildSha)) {
      return {
        status: 'refuted',
        detail: `tool_invocations:${ref.id} was served by ${row.servingBuildSha ?? 'an unrecorded build'}, not the cited build ${receipt.buildSha}`,
        checkedAt,
        observed,
      };
    }
    return { status: 'verified', detail: `tool_invocations:${ref.id} failed (${row.status}) on ${receipt.buildSha}`, checkedAt, observed };
  } catch (error) {
    return {
      status: 'unresolved',
      detail: `could not read ${ref.table}:${ref.id}: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
  }
}

/** What a filing stores at `payload.reproduction`. */
export interface StoredBugReproduction {
  schemaVersion: typeof BUG_REPRODUCTION_SCHEMA_VERSION;
  receipt: BugReproductionReceipt;
  filedBy: string;
  verification: ReproductionVerification;
}

/**
 * Stamp a filing-time encounter receipt (D-024). Any caller-supplied verification is
 * discarded: only `kind`, `ref` and `buildSha` are read, and the verdict is computed
 * here. `ineligibleReason` (human filer, caller-classified tool failure) stores the
 * receipt as evidence without letting it skip review.
 */
export async function stampFiledBugReproduction(
  raw: unknown,
  ctx: { filedBy: string; ineligibleReason?: string | null },
  deps: ReproductionLedgerDeps,
): Promise<{ ok: true; stored: StoredBugReproduction } | { ok: false; error: string }> {
  const parsed = parseBugReproductionReceipt(raw, { defaultKind: 'encounter' });
  if (!parsed.ok) return parsed;
  const filedBy = nonBlank(ctx.filedBy);
  if (!filedBy) return { ok: false, error: 'a reproduction receipt needs an attributable filer' };
  const verification: ReproductionVerification = ctx.ineligibleReason
    ? { status: 'not-eligible', detail: ctx.ineligibleReason, checkedAt: deps.now().toISOString() }
    : await verifyBugReproductionReceipt(parsed.receipt, deps);
  return {
    ok: true,
    stored: { schemaVersion: BUG_REPRODUCTION_SCHEMA_VERSION, receipt: parsed.receipt, filedBy, verification },
  };
}

/** The stored filing record, when it is a current-version one. */
export function readStoredBugReproduction(payload: unknown): StoredBugReproduction | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const stored = (payload as Record<string, unknown>).reproduction;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const v = stored as Record<string, unknown>;
  if (v.schemaVersion !== BUG_REPRODUCTION_SCHEMA_VERSION) return null;
  const receipt = readBugReproductionReceipt(v.receipt);
  const verification = v.verification as Record<string, unknown> | null | undefined;
  const filedBy = nonBlank(v.filedBy);
  if (!receipt || !filedBy || !verification || typeof verification.status !== 'string') return null;
  return {
    schemaVersion: BUG_REPRODUCTION_SCHEMA_VERSION,
    receipt,
    filedBy,
    verification: {
      status: verification.status as ReproductionVerificationStatus,
      detail: String(verification.detail ?? ''),
      checkedAt: String(verification.checkedAt ?? ''),
    },
  };
}

/**
 * D-024: the receipt a filing carries when the bug is born verified — the encounter
 * was filed with it and it resolved (or is free-text attested). Null otherwise, so
 * an unverified, refuted or ineligible filing goes through review like any other.
 */
export function readBornVerifiedReproduction(payload: unknown): BugReproductionReceipt | null {
  const stored = readStoredBugReproduction(payload);
  return stored && isAcceptedReproductionStatus(stored.verification.status) ? stored.receipt : null;
}

/** The refusal text a bug promote without a receipt gets (D-023 §2). */
export function bugReproductionMissingText(subject: string): string {
  return (
    `${subject} is a bug, and a bug is accepted only with a reproduction on the current build (D-023): ` +
    'add reproduction { kind: failing-test | scripted-repro | current-build-observation, ref, buildSha }. ' +
    'If you cannot reproduce it quickly, record investigate (a bounded repro task); if it no longer reproduces, record reject, or retain it as evidence'
  );
}
