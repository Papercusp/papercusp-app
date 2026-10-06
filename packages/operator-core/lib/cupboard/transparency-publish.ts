/**
 * The transparency pass, minus its I/O defaults (agent-economy-flywheel-2026-08-30
 * P-044, D-028 §3–5). transparency-runtime.ts wires it to Postgres, the anchor key
 * file and work items; this module takes every source as an argument, so it has
 * no database or filesystem imports and the Cupboard Worker's tests can drive it
 * against the real Worker app.
 *
 * Per workspace with a money journal:
 *   1. LIVE. Build the open month's report from the journal (every fiat figure
 *      provisional), pointing at the latest stored anchored root, and push it to
 *      the Worker with where the last closed month's statement stands.
 *   2. STATEMENT. When the closed month's FINAL reconciliation run is clean and an
 *      anchored root covers the month end, build the statement and publish it
 *      once, signed with the anchor key. A month already published is re-derived
 *      and compared: a different digest means the journal changed after
 *      publication. That is reported as drift; the Worker keeps what readers saw.
 *
 * The statement pins the FIRST anchored root whose window ends at or after the
 * month end, never the newest one, so recomputing it later yields the same digest
 * unless the journal itself changed.
 */
import type { Hex } from 'viem';
import type { StoredAnchor } from './ledger-anchor';
import type { JournalEntry } from './money-journal';
import { reconciliationPeriod, type InvariantVerdict, type ReconciliationInvariant } from './reconciliation';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSPARENCY_ATTESTATION_PATH,
  TRANSPARENCY_LIVE_PATH,
  TRANSPARENCY_STATEMENT_PATH,
  signReconciliationRequest,
} from './reconciliation-hmac';
import type { StatementAttestationPush } from './statement-attestation-push';
import {
  buildMonthlyStatement,
  buildTransparencyReport,
  monthPeriod,
  statementWithheldBy,
  type ReportAnchor,
  type TreasuryFigure,
} from './transparency-report';
import {
  parseSignedStatement,
  signStatement,
  type LiveTransparencyPush,
  type SignedStatement,
  type StatementStatus,
} from './transparency-statement';

/** WI-10004708 owns the on-chain Safe source; until it lands the figure is not measured. */
export const TREASURY_NOT_MEASURED = 'the DAO Safe balance is not read on chain yet (WI-10004708)';

const errorText = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0]! : String(error));

// ---------------------------------------------------------------------------
// Anchors.
// ---------------------------------------------------------------------------

export function reportAnchor(a: StoredAnchor): ReportAnchor {
  return {
    logId: a.logId,
    logRoot: a.logRoot,
    treeSize: a.treeSize,
    windowEnd: a.windowEnd,
    backend: a.backend,
    chainId: a.chainId,
    ref: a.ref,
    txHash: a.txHash,
  };
}

/** The newest stored anchor (highest anchorSeq), or null. */
export function latestAnchor(anchors: readonly StoredAnchor[]): StoredAnchor | null {
  return anchors.reduce<StoredAnchor | null>((best, a) => (!best || a.anchorSeq > best.anchorSeq ? a : best), null);
}

/** The first anchor whose window ends at or after `untilMs`: the root that commits to every link up to the month end. */
export function anchorCovering(anchors: readonly StoredAnchor[], untilMs: number): StoredAnchor | null {
  return anchors
    .filter((a) => a.windowEnd * 1000 >= untilMs)
    .reduce<StoredAnchor | null>((best, a) => (!best || a.anchorSeq < best.anchorSeq ? a : best), null);
}

// ---------------------------------------------------------------------------
// The Worker.
// ---------------------------------------------------------------------------

export type StatementPublish = 'created' | 'unchanged' | { readonly conflict: string } | { readonly failed: string };

/** `proof-added`: the record was already public and this push added its first inclusion proof. */
export type AttestationPublish = 'created' | 'unchanged' | 'proof-added' | { readonly refused: string } | { readonly failed: string };

export interface TransparencyWorker {
  pushLive(push: LiveTransparencyPush): Promise<{ readonly ok: true; readonly stored: 'stored' | 'stale' } | { readonly ok: false; readonly detail: string }>;
  /** The published statement, null when the month has none. Throws when the Worker cannot be read. */
  readStatement(workspaceId: string, month: string): Promise<SignedStatement | null>;
  publishStatement(signed: SignedStatement): Promise<StatementPublish>;
  /** P-047 (D-031): an attestation record, with its inclusion proof once anchored. */
  publishAttestation(push: StatementAttestationPush): Promise<AttestationPublish>;
}

/** The Cupboard Worker over HTTP: signed PUTs, public GETs. */
export function cupboardTransparencyWorker(input: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): TransparencyWorker {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  async function signedPut(pathname: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const signature = await signReconciliationRequest({ secret: input.secret, method: 'PUT', pathname, body, nowMs: now() });
    return fetchImpl(`${input.baseUrl}${pathname}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  }
  return {
    async pushLive(push) {
      try {
        const res = await signedPut(TRANSPARENCY_LIVE_PATH, push);
        const text = await res.text();
        if (!res.ok) return { ok: false, detail: `the Worker answered ${res.status}: ${text.slice(0, 200)}` };
        const stored = (JSON.parse(text) as { stored?: unknown }).stored;
        return { ok: true, stored: stored === 'stale' ? 'stale' : 'stored' };
      } catch (error) {
        return { ok: false, detail: errorText(error) };
      }
    },
    async readStatement(workspaceId, month) {
      const res = await fetchImpl(
        `${input.baseUrl}/transparency/${encodeURIComponent(workspaceId)}/statements/${encodeURIComponent(month)}`,
        { method: 'GET', signal: AbortSignal.timeout(20_000) },
      );
      if (res.status === 404) return null;
      const text = await res.text();
      if (!res.ok) throw new Error(`reading the published ${month} statement: status ${res.status}: ${text.slice(0, 200)}`);
      const signed = parseSignedStatement(JSON.parse(text));
      if (!signed) throw new Error(`the published ${month} statement is not a signed statement`);
      return signed;
    },
    async publishStatement(signed) {
      try {
        const res = await signedPut(TRANSPARENCY_STATEMENT_PATH, signed);
        const text = await res.text();
        if (res.status === 409) return { conflict: text.slice(0, 300) };
        if (!res.ok) return { failed: `the Worker answered ${res.status}: ${text.slice(0, 200)}` };
        return (JSON.parse(text) as { published?: unknown }).published === 'unchanged' ? 'unchanged' : 'created';
      } catch (error) {
        return { failed: errorText(error) };
      }
    },
    async publishAttestation(push) {
      try {
        const res = await signedPut(TRANSPARENCY_ATTESTATION_PATH, push);
        const text = await res.text();
        // 400 / 409: the Worker judged the push and refused it; retrying the same push cannot succeed.
        if (res.status === 400 || res.status === 409) return { refused: `${res.status}: ${text.slice(0, 300)}` };
        if (!res.ok) return { failed: `the Worker answered ${res.status}: ${text.slice(0, 200)}` };
        const published = (JSON.parse(text) as { published?: unknown }).published;
        return published === 'unchanged' || published === 'proof-added' ? published : 'created';
      } catch (error) {
        return { failed: errorText(error) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Drift: a published statement the journal no longer reproduces.
// ---------------------------------------------------------------------------

export interface StatementDrift {
  readonly workspaceId: string;
  readonly month: string;
  readonly publishedDigest: string;
  readonly recomputedDigest: string;
}

export type DriftSink = (drift: StatementDrift) => Promise<void>;

export const statementDriftWatchdogKey = (workspaceId: string, month: string): string => `transparency:statement-drift:${workspaceId}:${month}`;

// ---------------------------------------------------------------------------
// One workspace.
// ---------------------------------------------------------------------------

/** What the pass reads about reconciliation; reconciliation-store's ReconciliationStatus satisfies it. */
export interface TransparencyReconciliationView {
  readonly latestFinal: {
    readonly runId: string;
    readonly mode: 'provisional' | 'final';
    readonly month: string;
    readonly finishedAt: string;
    readonly verdicts: readonly InvariantVerdict[];
  } | null;
  readonly openBreaks: readonly { readonly invariant: ReconciliationInvariant }[];
}

/** The signing key, or why there is none (the anchor key file, D-021). */
export type SigningKeyRead = { readonly ok: true; readonly privateKey: Hex } | { readonly ok: false; readonly reason: string; readonly detail: string };

/** What happened to the workspace's statement attestations this pass (P-047, D-031). */
export interface AttestationPushResult {
  /** Records the pass read and offered to the Worker. */
  readonly offered: number;
  /** Accepted pushes (created, unchanged or proof-added). */
  readonly accepted: number;
  /** One line per refused or failed push, or why none could be offered. */
  readonly problems: readonly string[];
}

export interface WorkspaceTransparency {
  readonly workspaceId: string;
  readonly month: string;
  readonly live: { readonly pushed: true; readonly stored: 'stored' | 'stale' } | { readonly pushed: false; readonly detail: string };
  readonly statement: StatementStatus;
  readonly drift: StatementDrift | null;
  readonly attestations: AttestationPushResult;
  readonly error: string | null;
}

const NO_ATTESTATIONS: AttestationPushResult = { offered: 0, accepted: 0, problems: [] };

/** Offer every attestation (and its proof, once anchored) to the Worker. The Worker keeps the first record and proof. */
export async function pushAttestations(input: {
  readonly workspaceId: string;
  readonly worker: TransparencyWorker | null;
  readonly attestations: (workspaceId: string) => Promise<readonly StatementAttestationPush[]>;
}): Promise<AttestationPushResult> {
  if (!input.worker) return NO_ATTESTATIONS;
  let pushes: readonly StatementAttestationPush[];
  try {
    pushes = await input.attestations(input.workspaceId);
  } catch (error) {
    return { offered: 0, accepted: 0, problems: [`reading the attestations failed: ${errorText(error)}`] };
  }
  let accepted = 0;
  const problems: string[] = [];
  for (const push of pushes) {
    const r = await input.worker.publishAttestation(push);
    if (typeof r === 'string') accepted += 1;
    else problems.push(`${push.attestation.month} ${push.attestation.documentSha256.slice(0, 12)}: ${'refused' in r ? `refused ${r.refused}` : r.failed}`);
  }
  return { offered: pushes.length, accepted, problems };
}

/** Where the last closed month's statement stands, publishing it when it is ready. */
export async function settleStatement(input: {
  readonly workspaceId: string;
  readonly nowMs: number;
  readonly entries: readonly JournalEntry[];
  readonly reconciliation: TransparencyReconciliationView;
  readonly anchors: readonly StoredAnchor[];
  readonly treasury: TreasuryFigure;
  readonly worker: TransparencyWorker | null;
  readonly signingKey: () => SigningKeyRead;
}): Promise<{ statement: StatementStatus; drift: StatementDrift | null }> {
  const closedMonth = reconciliationPeriod('final', input.nowMs).month;
  const status = (s: StatementStatus['status'], month: string | null, detail: string, extra: Partial<StatementStatus> = {}) => ({
    statement: { status: s, month, digest: null, withheldBy: [], detail, ...extra } satisfies StatementStatus,
    drift: null,
  });

  const final = input.reconciliation.latestFinal;
  if (!final || final.month < closedMonth) {
    const currentStart = monthPeriod(reconciliationPeriod('provisional', input.nowMs).month).fromMs;
    if (!final && !input.entries.some((e) => e.occurredAtMs < currentStart)) {
      return status('none', null, 'no month has closed with journal activity yet');
    }
    return status('pending', closedMonth, `awaiting the month-close (final) reconciliation run for ${closedMonth}`);
  }

  const month = final.month;
  const withheldBy = statementWithheldBy(final.verdicts);
  if (withheldBy.length > 0) {
    const open = input.reconciliation.openBreaks.map((b) => b.invariant);
    return status(
      'withheld',
      month,
      `final run ${final.runId} did not reconcile${open.length ? `; open breaks: ${open.join(', ')}` : ''}`,
      { withheldBy },
    );
  }

  const period = monthPeriod(month);
  const anchor = anchorCovering(input.anchors, period.untilMs);
  if (!anchor) {
    return status('pending', month, `awaiting an anchored root whose window ends at or after ${new Date(period.untilMs).toISOString()}`);
  }
  const build = buildMonthlyStatement({
    workspaceId: input.workspaceId,
    entries: input.entries,
    run: { runId: final.runId, mode: final.mode, month, finishedAt: final.finishedAt, verdicts: final.verdicts },
    treasury: input.treasury,
    latestAnchor: reportAnchor(anchor),
  });
  if (!build.ok) return status('withheld', month, build.detail, { withheldBy: build.withheldBy });
  if (!input.worker) return status('pending', month, 'no Worker is configured; nothing can be published');

  let published: SignedStatement | null;
  try {
    published = await input.worker.readStatement(input.workspaceId, month);
  } catch (error) {
    return status('pending', month, `the Worker could not be read: ${errorText(error)}`);
  }
  if (published) {
    if (published.digest === build.digest) return status('published', month, 'published', { digest: published.digest });
    return {
      statement: {
        status: 'published',
        month,
        digest: published.digest,
        withheldBy: [],
        detail: `published digest ${published.digest} differs from the journal's ${build.digest}; the published statement stands`,
      },
      drift: { workspaceId: input.workspaceId, month, publishedDigest: published.digest, recomputedDigest: build.digest },
    };
  }

  const key = input.signingKey();
  if (!key.ok) return status('pending', month, `no signing key (${key.reason}: ${key.detail})`);
  const signed = await signStatement(build.statement, key.privateKey);
  const write = await input.worker.publishStatement(signed);
  if (write === 'created' || write === 'unchanged') return status('published', month, `published (${write})`, { digest: signed.digest });
  if ('conflict' in write) {
    // Lost a publication race: report what the Worker holds on the next tick.
    return status('published', month, `another statement for ${month} was published first: ${write.conflict}`);
  }
  return status('pending', month, `publishing failed: ${write.failed}`);
}

// ---------------------------------------------------------------------------
// One pass.
// ---------------------------------------------------------------------------

export interface TransparencySources {
  readonly workspaces: readonly string[];
  /** `null` pushes nothing; `workerUnavailable` says why. */
  readonly worker: TransparencyWorker | null;
  readonly workerUnavailable: string | null;
  readonly readEntries: (workspaceId: string) => Promise<readonly JournalEntry[]>;
  readonly readReconciliation: (workspaceId: string) => Promise<TransparencyReconciliationView>;
  readonly anchors: (workspaceId: string) => Promise<readonly StoredAnchor[]>;
  readonly treasury: (workspaceId: string) => Promise<TreasuryFigure>;
  /** The workspace's statement attestations as Worker pushes, each with its proof or null (P-047, D-031). */
  readonly attestations: (workspaceId: string) => Promise<readonly StatementAttestationPush[]>;
  readonly signingKey: () => SigningKeyRead;
  readonly drift: DriftSink;
  readonly now: () => number;
}

export interface TransparencyPassResult {
  /** Why nothing is pushed, when nothing is. */
  readonly workerUnavailable: string | null;
  readonly workspaces: readonly WorkspaceTransparency[];
}

export async function publishTransparency(src: TransparencySources): Promise<TransparencyPassResult> {
  const results: WorkspaceTransparency[] = [];
  for (const workspaceId of src.workspaces) {
    const nowMs = src.now();
    const month = reconciliationPeriod('provisional', nowMs).month;
    try {
      const [entries, reconciliation, anchors, treasury] = await Promise.all([
        src.readEntries(workspaceId),
        src.readReconciliation(workspaceId),
        src.anchors(workspaceId),
        src.treasury(workspaceId),
      ]);
      const settled = await settleStatement({ workspaceId, nowMs, entries, reconciliation, anchors, treasury, worker: src.worker, signingKey: src.signingKey });
      if (settled.drift) {
        try {
          await src.drift(settled.drift);
        } catch (error) {
          console.warn(`[transparency] filing statement drift for ${workspaceId} ${settled.drift.month} failed: ${errorText(error)}`);
        }
      }
      const latest = latestAnchor(anchors);
      const report = buildTransparencyReport({
        workspaceId,
        kind: 'live',
        entries,
        period: monthPeriod(month),
        provisional: true,
        treasury,
        latestAnchor: latest ? reportAnchor(latest) : null,
      });
      const push: LiveTransparencyPush = { workspaceId, month, generatedAtMs: nowMs, report, statementStatus: settled.statement };
      let live: WorkspaceTransparency['live'] = { pushed: false, detail: src.workerUnavailable ?? 'no Worker configured' };
      if (src.worker) {
        const r = await src.worker.pushLive(push);
        live = r.ok ? { pushed: true, stored: r.stored } : { pushed: false, detail: r.detail };
      }
      // After the statement settled: the Worker accepts an attestation only for its published statement.
      const attestations = await pushAttestations({ workspaceId, worker: src.worker, attestations: src.attestations });
      results.push({ workspaceId, month, live, statement: settled.statement, drift: settled.drift, attestations, error: null });
    } catch (error) {
      results.push({
        workspaceId,
        month,
        live: { pushed: false, detail: 'the pass failed before pushing' },
        statement: { status: 'pending', month: null, digest: null, withheldBy: [], detail: 'the pass failed' },
        drift: null,
        attestations: NO_ATTESTATIONS,
        error: errorText(error),
      });
    }
  }
  return { workerUnavailable: src.workerUnavailable, workspaces: results };
}
