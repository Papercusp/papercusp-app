/**
 * Statement-attestation persistence + chaining (agent-economy-flywheel-2026-08-30
 * P-047, D-031).
 *
 *   recordStatementAttestation  — validate an accountant's attestation against the
 *                                 month's PUBLISHED signed statement, store the
 *                                 public record, and chain it on
 *                                 `transparency.statement-attestations` so the
 *                                 next hourly anchor run puts it on chain
 *   statementAttestationProof   — the record + its D-024 inclusion bundle, once anchored
 *   listStatementAttestations   — the records for a workspace (optionally one month)
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { canonicalJson } from '@papercusp/hash-chain';
import { buildInclusionBundle, type LedgerAnchorStore } from './ledger-anchor';
import { pgLedgerAnchorStore } from './ledger-anchor-store';
import { pgLedgerChainLinkStore, witnessLedger, type LedgerChainLinkStore, type LedgerSource } from './ledger-chain';
import {
  STATEMENT_ATTESTATION_STREAM_ID,
  assembleStatementAttestationProof,
  attestationInputProblem,
  buildStatementAttestation,
  parseStatementAttestation,
  type StatementAttestation,
  type StatementAttestationInput,
  type StatementAttestationProof,
} from './statement-attestation';
import type { TransparencyWorker } from './transparency-publish';
import { statementDigest, verifySignedStatement } from './transparency-statement';

export interface StoredStatementAttestation {
  readonly attestationSeq: number;
  readonly record: StatementAttestation;
  readonly recordedBy: string | null;
}

export interface StatementAttestationStore {
  /** Oldest first (attestation_seq order). */
  list(workspaceId: string): Promise<readonly StoredStatementAttestation[]>;
  /** Insert unless (workspace, month, documentSha256) exists; true when a row was inserted. */
  insert(workspaceId: string, record: StatementAttestation, recordedBy: string | null): Promise<boolean>;
}

interface AttestationRow {
  attestation_seq: string | number;
  record_json: unknown;
  recorded_by: string | null;
}

function fromRow(row: AttestationRow): StoredStatementAttestation {
  const record = parseStatementAttestation(row.record_json);
  if (!record) throw new Error(`statement_attestations row ${row.attestation_seq} holds a malformed record`);
  return { attestationSeq: Number(row.attestation_seq), record, recordedBy: row.recorded_by };
}

/** `harness_shared.statement_attestations` (migration 1299, append-only by trigger). */
export function pgStatementAttestationStore(sql?: Sql): StatementAttestationStore {
  const db = (): Sql => sql ?? getOrgPg().sql;
  return {
    async list(workspaceId) {
      const rows = await db()<AttestationRow[]>`
        SELECT attestation_seq, record_json, recorded_by
          FROM harness_shared.statement_attestations
         WHERE workspace_id = ${workspaceId} ORDER BY attestation_seq`;
      return rows.map(fromRow);
    },
    async insert(workspaceId, record, recordedBy) {
      const result = await db()`
        INSERT INTO harness_shared.statement_attestations
          (workspace_id, month, document_sha256, statement_digest, attestor_name, attested_on, scope, record_json, recorded_by)
        VALUES (${workspaceId}, ${record.month}, ${record.documentSha256}, ${record.statementDigest}, ${record.attestor.name},
                ${record.attestedOn}, ${db().array([...record.scope])}, ${db().json(JSON.parse(canonicalJson(record)))}, ${recordedBy})
        ON CONFLICT (workspace_id, month, document_sha256) DO NOTHING`;
      return result.count > 0;
    },
  };
}

/** In-memory store (tests, dry runs). */
export function memoryStatementAttestationStore(): StatementAttestationStore & { readonly rows: Map<string, StoredStatementAttestation[]> } {
  const rows = new Map<string, StoredStatementAttestation[]>();
  let seq = 0;
  return {
    rows,
    async list(workspaceId) {
      return [...(rows.get(workspaceId) ?? [])];
    },
    async insert(workspaceId, record, recordedBy) {
      const mine = rows.get(workspaceId) ?? [];
      if (mine.some((r) => r.record.month === record.month && r.record.documentSha256 === record.documentSha256)) return false;
      mine.push({ attestationSeq: ++seq, record, recordedBy });
      rows.set(workspaceId, mine);
      return true;
    },
  };
}

/** Source id of an attestation's chain link: one link per (month, document). */
export const attestationSourceId = (record: Pick<StatementAttestation, 'month' | 'documentSha256'>): string =>
  `${record.month}:${record.documentSha256}`;

/** The attestations as a hash-chain ledger source: entry = the public record itself. */
export function statementAttestationsLedgerSource(workspaceId: string, store: StatementAttestationStore): LedgerSource {
  return {
    streamId: STATEMENT_ATTESTATION_STREAM_ID,
    async list() {
      return (await store.list(workspaceId)).map((r) => ({ sourceId: attestationSourceId(r.record), entry: r.record }));
    },
  };
}

export interface StatementAttestationDeps {
  readonly sql?: Sql;
  readonly store?: StatementAttestationStore;
  readonly chain?: LedgerChainLinkStore;
  readonly anchors?: LedgerAnchorStore;
}

export type RecordStatementAttestationResult =
  | {
      readonly ok: true;
      readonly attestation: StatementAttestation;
      /** false when the same (month, document) was already recorded; the stored record is returned. */
      readonly created: boolean;
      /** Links appended to the attestation chain by this call. */
      readonly chained: number;
    }
  | {
      readonly ok: false;
      readonly error: 'invalid-input' | 'statement-not-published' | 'statement-signature-invalid' | 'statement-digest-mismatch' | 'statement-has-no-month-root';
      readonly detail: string;
    };

/**
 * Record an accountant's attestation of `input.month`. The month's statement must
 * be published on the Worker; when `expectedStatementDigest` is given it must
 * equal the published digest, so the accountant attests exactly what was published.
 */
export async function recordStatementAttestation(
  workspaceId: string,
  input: StatementAttestationInput & { readonly expectedStatementDigest?: string; readonly recordedBy?: string | null },
  deps: StatementAttestationDeps & { readonly worker: Pick<TransparencyWorker, 'readStatement'> },
): Promise<RecordStatementAttestationResult> {
  const problem = attestationInputProblem(input);
  if (problem) return { ok: false, error: 'invalid-input', detail: problem };
  const signed = await deps.worker.readStatement(workspaceId, input.month);
  if (!signed) return { ok: false, error: 'statement-not-published', detail: `no signed statement is published for ${input.month}` };
  const signature = await verifySignedStatement(signed);
  if (!signature.ok) return { ok: false, error: 'statement-signature-invalid', detail: signature.reason };
  const digest = statementDigest(signed.statement);
  if (input.expectedStatementDigest !== undefined && input.expectedStatementDigest.toLowerCase() !== digest) {
    return {
      ok: false,
      error: 'statement-digest-mismatch',
      detail: `the attestation names statement ${input.expectedStatementDigest}, but the published ${input.month} statement is ${digest}`,
    };
  }
  if (!signed.statement.report.latestAnchor) {
    return { ok: false, error: 'statement-has-no-month-root', detail: `the published ${input.month} statement names no anchored root` };
  }
  const record = buildStatementAttestation({ workspaceId, attestation: input, statement: signed.statement, statementDigest: digest });
  const store = deps.store ?? pgStatementAttestationStore(deps.sql);
  const chain = deps.chain ?? pgLedgerChainLinkStore(deps.sql);
  const created = await store.insert(workspaceId, record, input.recordedBy ?? null);
  const stored = created
    ? record
    : ((await store.list(workspaceId)).find((r) => attestationSourceId(r.record) === attestationSourceId(record))?.record ?? record);
  const witnessed = await witnessLedger(workspaceId, statementAttestationsLedgerSource(workspaceId, store), chain);
  return { ok: true, attestation: stored, created, chained: witnessed.appended };
}

export type StatementAttestationProofResult =
  | { readonly ok: true; readonly proof: StatementAttestationProof }
  | { readonly ok: false; readonly error: 'unknown-attestation' | 'not-chained' | 'not-in-log' | 'not-yet-anchored' };

/** The proof for one attestation (the newest for the month when `documentSha256` is omitted). */
export async function statementAttestationProof(
  workspaceId: string,
  month: string,
  documentSha256: string | undefined,
  deps: StatementAttestationDeps = {},
): Promise<StatementAttestationProofResult> {
  const store = deps.store ?? pgStatementAttestationStore(deps.sql);
  const chain = deps.chain ?? pgLedgerChainLinkStore(deps.sql);
  const anchors = deps.anchors ?? pgLedgerAnchorStore(deps.sql);
  const candidates = (await store.list(workspaceId)).filter(
    (r) => r.record.month === month && (documentSha256 === undefined || r.record.documentSha256 === documentSha256.toLowerCase()),
  );
  const row = candidates[candidates.length - 1];
  if (!row) return { ok: false, error: 'unknown-attestation' };
  const sourceId = attestationSourceId(row.record);
  const stored = (await chain.links(workspaceId, STATEMENT_ATTESTATION_STREAM_ID)).find((l) => l.sourceId === sourceId);
  if (!stored) return { ok: false, error: 'not-chained' };
  const bundle = await buildInclusionBundle({ workspaceId, link: stored.link, entry: row.record, store: anchors });
  if ('error' in bundle) return { ok: false, error: bundle.error };
  return { ok: true, proof: assembleStatementAttestationProof({ attestation: row.record, bundle }) };
}

/** The records for a workspace, newest first, optionally for one month. */
export async function listStatementAttestations(
  workspaceId: string,
  month: string | undefined,
  deps: StatementAttestationDeps = {},
): Promise<readonly StoredStatementAttestation[]> {
  const store = deps.store ?? pgStatementAttestationStore(deps.sql);
  return (await store.list(workspaceId)).filter((r) => month === undefined || r.record.month === month).reverse();
}
