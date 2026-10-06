/**
 * The operator's transparency pass (agent-economy-flywheel-2026-08-30 P-044,
 * D-028 §3–5): transparency-publish.ts wired to its production sources.
 *
 *   journal         harness_shared.money_journal_entries (P-042)
 *   reconciliation  the latest final run and open breaks (P-043)
 *   anchors         the workspace's stored anchored roots (P-041)
 *   Worker          the reconciliation config (D-025): the same origin and HMAC
 *                   secret (PAPERCUSP_RECONCILIATION_GATE_SECRET_REF); without a
 *                   secret nothing is pushed
 *   signing key     the anchor key file (PAPERCUSP_LEDGER_ANCHOR_KEY_FILE, D-021)
 *   drift           one deduplicated bug per (workspace, month)
 *
 * The DBOS anchor tick (dbos/ledger-anchor-workflow.ts) and
 * `cupboard:ledger-anchor-run` both call `runTransparencyPass` after anchoring.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { StoredAnchor } from './ledger-anchor';
import { DEFAULT_ANCHOR_KEY_FILE, readAnchorPrivateKey } from './ledger-anchor-eas';
import { pgLedgerAnchorStore } from './ledger-anchor-store';
import type { JournalEntry } from './money-journal';
import { readMoneyJournalEntries } from './money-journal-store';
import { readReconciliationRuntimeConfig, reconciliationWorkspaces, type ReconciliationRuntimeConfig } from './reconciliation-runtime';
import { readReconciliationStatus } from './reconciliation-store';
import { listStatementAttestations, statementAttestationProof } from './statement-attestation-store';
import type { StatementAttestationPush } from './statement-attestation-push';
import { treasuryFigure, type TreasuryFigure } from './transparency-report';
import {
  TREASURY_NOT_MEASURED,
  cupboardTransparencyWorker,
  publishTransparency,
  statementDriftWatchdogKey,
  type DriftSink,
  type SigningKeyRead,
  type TransparencyPassResult,
  type TransparencyReconciliationView,
  type TransparencyWorker,
} from './transparency-publish';

const errorText = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0]! : String(error));

/** Files one deduplicated bug per (workspace, month). */
export function workItemDriftSink(): DriftSink {
  return async (d) => {
    const { captureImprovement } = await import('../harness/improvements/capture-core');
    await captureImprovement({
      title: `Transparency statement drift: ${d.month} (workspace ${d.workspaceId}) no longer matches the journal`,
      kind: 'bug',
      severity: 'major',
      body: [
        `The published ${d.month} statement for workspace ${d.workspaceId} has digest ${d.publishedDigest}.`,
        `Re-deriving it from the money journal now gives ${d.recomputedDigest}.`,
        '',
        'The Worker keeps the first publication (D-028 §4), so readers still see the original figures.',
        'A closed month should not change: find the entry posted into it after its final reconciliation run.',
      ].join('\n'),
      watchdogKey: statementDriftWatchdogKey(d.workspaceId, d.month),
      workspaceId: d.workspaceId,
      scope: 'harness:papercusp',
      sourceRole: 'system',
      filedByRole: 'transparency',
      createdBy: 'system:transparency',
      paths: ['packages/operator-core/lib/cupboard/transparency-publish.ts'],
    });
  };
}

export interface TransparencyPassDeps {
  readonly sql?: Sql;
  readonly config?: ReconciliationRuntimeConfig;
  readonly resolveSecret?: (ref: string) => Promise<string>;
  /** `null` pushes nothing. */
  readonly worker?: TransparencyWorker | null;
  readonly workspaces?: readonly string[];
  readonly readEntries?: (workspaceId: string) => Promise<readonly JournalEntry[]>;
  readonly readReconciliation?: (workspaceId: string) => Promise<TransparencyReconciliationView>;
  readonly anchors?: (workspaceId: string) => Promise<readonly StoredAnchor[]>;
  readonly treasury?: (workspaceId: string) => Promise<TreasuryFigure>;
  readonly attestations?: (workspaceId: string) => Promise<readonly StatementAttestationPush[]>;
  readonly signingKey?: () => SigningKeyRead;
  readonly drift?: DriftSink;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

/** The Cupboard Worker client (signed PUTs, public GETs), or why there is none. Shared by the pass and cupboard:statement-attestation. */
export async function openTransparencyWorker(
  deps: Pick<TransparencyPassDeps, 'config' | 'resolveSecret' | 'fetchImpl' | 'now' | 'env'> = {},
): Promise<{ readonly worker: TransparencyWorker; readonly unavailable: null } | { readonly worker: null; readonly unavailable: string }> {
  const config = deps.config ?? readReconciliationRuntimeConfig(deps.env ?? process.env);
  if (!config.gateSecretRef) return { worker: null, unavailable: 'PAPERCUSP_RECONCILIATION_GATE_SECRET_REF is not configured' };
  try {
    const resolve =
      deps.resolveSecret ?? (async (ref: string) => (await import('../inference-gateway/egress-providers/secret-ref')).resolveSecretRef(ref));
    const secret = await resolve(config.gateSecretRef);
    return {
      worker: cupboardTransparencyWorker({ baseUrl: config.cupboardUrl, secret, fetchImpl: deps.fetchImpl, now: deps.now ?? Date.now }),
      unavailable: null,
    };
  } catch (error) {
    return { worker: null, unavailable: `the reconciliation gate secret could not be resolved: ${errorText(error)}` };
  }
}

/** The workspace's attestation records (P-047, D-031) as Worker pushes, each with its anchored proof or null. */
export async function statementAttestationPushes(workspaceId: string, sql: Sql): Promise<StatementAttestationPush[]> {
  const pushes: StatementAttestationPush[] = [];
  for (const row of await listStatementAttestations(workspaceId, undefined, { sql })) {
    const proof = await statementAttestationProof(workspaceId, row.record.month, row.record.documentSha256, { sql });
    pushes.push({ workspaceId, attestation: row.record, proof: proof.ok ? proof.proof : null });
  }
  return pushes;
}

export async function runTransparencyPass(deps: TransparencyPassDeps = {}): Promise<TransparencyPassResult> {
  const sql = (): Sql => deps.sql ?? getOrgPg().sql;
  const env = deps.env ?? process.env;
  const config = deps.config ?? readReconciliationRuntimeConfig(env);
  const now = deps.now ?? Date.now;

  let worker: TransparencyWorker | null = null;
  let workerUnavailable: string | null = null;
  if (deps.worker !== undefined) {
    worker = deps.worker;
    if (!worker) workerUnavailable = 'no Worker configured';
  } else {
    const opened = await openTransparencyWorker({ config, resolveSecret: deps.resolveSecret, fetchImpl: deps.fetchImpl, now });
    worker = opened.worker;
    workerUnavailable = opened.unavailable;
  }

  return publishTransparency({
    workspaces: deps.workspaces ?? (await reconciliationWorkspaces(sql(), [config.stripeJournalWorkspace, config.treasuryWorkspace])),
    worker,
    workerUnavailable,
    readEntries: deps.readEntries ?? ((ws) => readMoneyJournalEntries(ws, { sql: sql() })),
    readReconciliation: deps.readReconciliation ?? ((ws) => readReconciliationStatus(ws, { limit: 1, sql: sql() })),
    anchors: deps.anchors ?? ((ws) => pgLedgerAnchorStore(sql()).anchors(ws)),
    treasury: deps.treasury ?? (async () => treasuryFigure(null, TREASURY_NOT_MEASURED)),
    attestations: deps.attestations ?? ((ws) => statementAttestationPushes(ws, sql())),
    signingKey: deps.signingKey ?? (() => readAnchorPrivateKey(env.PAPERCUSP_LEDGER_ANCHOR_KEY_FILE?.trim() || DEFAULT_ANCHOR_KEY_FILE)),
    drift: deps.drift ?? workItemDriftSink(),
    now,
  });
}
