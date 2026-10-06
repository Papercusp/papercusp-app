/**
 * D1 storage for the public transparency report (P-044, D-028; migration
 * 042_transparency.sql). The live row only moves forward in time; a monthly
 * statement is immutable once stored. Statement attestations (P-047, D-031;
 * migration 043_transparency_attestations.sql) keep their first record and
 * their first proof.
 */
import { canonicalJson } from '@papercusp/hash-chain';
import type { StatementAttestation, StatementAttestationProof } from '@papercusp/operator-core/lib/cupboard/statement-attestation.ts';
import type { LiveTransparencyPush, SignedStatement, StatementStatus } from '@papercusp/operator-core/lib/cupboard/transparency-statement.ts';

export interface LiveReportRow {
  readonly month: string;
  readonly report: LiveTransparencyPush['report'];
  readonly statementStatus: StatementStatus;
  readonly generatedAtMs: number;
}

export async function recordLiveReport(db: D1Database, push: LiveTransparencyPush, receivedAtMs: number): Promise<'stored' | 'stale'> {
  const r = await db
    .prepare(
      `INSERT INTO transparency_live (workspace_id, month, report_json, statement_status_json, generated_at_ms, received_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (workspace_id) DO UPDATE SET
         month = excluded.month, report_json = excluded.report_json,
         statement_status_json = excluded.statement_status_json,
         generated_at_ms = excluded.generated_at_ms, received_at_ms = excluded.received_at_ms
       WHERE excluded.generated_at_ms >= transparency_live.generated_at_ms`,
    )
    .bind(push.workspaceId, push.month, JSON.stringify(push.report), JSON.stringify(push.statementStatus), push.generatedAtMs, receivedAtMs)
    .run();
  return (r.meta?.changes ?? 0) > 0 ? 'stored' : 'stale';
}

export async function readLiveReport(db: D1Database, workspaceId: string): Promise<LiveReportRow | null> {
  const row = await db
    .prepare(`SELECT month, report_json, statement_status_json, generated_at_ms FROM transparency_live WHERE workspace_id = ?1`)
    .bind(workspaceId)
    .first<{ month: string; report_json: string; statement_status_json: string; generated_at_ms: number }>();
  return row
    ? {
        month: row.month,
        report: JSON.parse(row.report_json) as LiveReportRow['report'],
        statementStatus: JSON.parse(row.statement_status_json) as StatementStatus,
        generatedAtMs: Number(row.generated_at_ms),
      }
    : null;
}

export type StatementWrite = 'created' | 'unchanged' | { readonly conflict: string };

/** First publication wins: an identical digest is a no-op, a different one is refused. */
export async function publishStatement(db: D1Database, signed: SignedStatement, nowMs: number): Promise<StatementWrite> {
  const { workspaceId, month } = signed.statement.report;
  const inserted = await db
    .prepare(
      `INSERT INTO transparency_statements (workspace_id, month, digest, signature, signer, signed_json, published_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (workspace_id, month) DO NOTHING`,
    )
    .bind(workspaceId, month, signed.digest, signed.signature, signed.signer, JSON.stringify(signed), nowMs)
    .run();
  if ((inserted.meta?.changes ?? 0) > 0) return 'created';
  const existing = await db
    .prepare(`SELECT digest FROM transparency_statements WHERE workspace_id = ?1 AND month = ?2`)
    .bind(workspaceId, month)
    .first<{ digest: string }>();
  return existing?.digest === signed.digest ? 'unchanged' : { conflict: existing?.digest ?? 'unknown' };
}

export async function readStatement(db: D1Database, workspaceId: string, month: string): Promise<SignedStatement | null> {
  const row = await db
    .prepare(`SELECT signed_json FROM transparency_statements WHERE workspace_id = ?1 AND month = ?2`)
    .bind(workspaceId, month)
    .first<{ signed_json: string }>();
  return row ? (JSON.parse(row.signed_json) as SignedStatement) : null;
}

export async function listStatements(
  db: D1Database,
  workspaceId: string,
): Promise<{ month: string; digest: string; signer: string; publishedAtMs: number }[]> {
  const rows = await db
    .prepare(
      `SELECT month, digest, signer, published_at_ms FROM transparency_statements
        WHERE workspace_id = ?1 ORDER BY month DESC LIMIT 120`,
    )
    .bind(workspaceId)
    .all<{ month: string; digest: string; signer: string; published_at_ms: number }>();
  return (rows.results ?? []).map((r) => ({ month: r.month, digest: r.digest, signer: r.signer, publishedAtMs: Number(r.published_at_ms) }));
}

/** `proof-added`: the record was stored before and this write added its first proof. */
export type AttestationWrite = 'created' | 'unchanged' | 'proof-added' | { readonly conflict: string };

/**
 * Store an attestation record, and its proof when given. The record is immutable
 * (a different record for the same (workspace, month, document) is a conflict);
 * the proof is write-once. The caller has already verified both.
 */
export async function recordAttestation(
  db: D1Database,
  attestation: StatementAttestation,
  proof: StatementAttestationProof | null,
  nowMs: number,
): Promise<AttestationWrite> {
  const recordJson = canonicalJson(attestation);
  const proofJson = proof ? canonicalJson(proof) : null;
  const inserted = await db
    .prepare(
      `INSERT INTO transparency_attestations
         (workspace_id, month, document_sha256, statement_digest, record_json, proof_json, recorded_at_ms, proof_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (workspace_id, month, document_sha256) DO NOTHING`,
    )
    .bind(
      attestation.workspaceId,
      attestation.month,
      attestation.documentSha256,
      attestation.statementDigest,
      recordJson,
      proofJson,
      nowMs,
      proofJson ? nowMs : null,
    )
    .run();
  if ((inserted.meta?.changes ?? 0) > 0) return 'created';
  const existing = await db
    .prepare(`SELECT record_json FROM transparency_attestations WHERE workspace_id = ?1 AND month = ?2 AND document_sha256 = ?3`)
    .bind(attestation.workspaceId, attestation.month, attestation.documentSha256)
    .first<{ record_json: string }>();
  if (existing?.record_json !== recordJson) return { conflict: existing ? 'a different record is stored for this document' : 'unknown' };
  if (!proofJson) return 'unchanged';
  const added = await db
    .prepare(
      `UPDATE transparency_attestations SET proof_json = ?4, proof_at_ms = ?5
        WHERE workspace_id = ?1 AND month = ?2 AND document_sha256 = ?3 AND proof_json IS NULL`,
    )
    .bind(attestation.workspaceId, attestation.month, attestation.documentSha256, proofJson, nowMs)
    .run();
  return (added.meta?.changes ?? 0) > 0 ? 'proof-added' : 'unchanged';
}

export interface StoredAttestation {
  readonly record: StatementAttestation;
  readonly hasProof: boolean;
}

/** A workspace's attestation records, oldest first, grouped by month. */
export async function listAttestations(db: D1Database, workspaceId: string): Promise<Map<string, StoredAttestation[]>> {
  const rows = await db
    .prepare(
      `SELECT month, record_json, proof_json IS NOT NULL AS has_proof FROM transparency_attestations
        WHERE workspace_id = ?1 ORDER BY recorded_at_ms, document_sha256 LIMIT 1000`,
    )
    .bind(workspaceId)
    .all<{ month: string; record_json: string; has_proof: number }>();
  const byMonth = new Map<string, StoredAttestation[]>();
  for (const r of rows.results ?? []) {
    const mine = byMonth.get(r.month) ?? [];
    mine.push({ record: JSON.parse(r.record_json) as StatementAttestation, hasProof: Number(r.has_proof) === 1 });
    byMonth.set(r.month, mine);
  }
  return byMonth;
}

export async function readAttestationProof(
  db: D1Database,
  workspaceId: string,
  month: string,
  documentSha256: string,
): Promise<StatementAttestationProof | null> {
  const row = await db
    .prepare(
      `SELECT proof_json FROM transparency_attestations
        WHERE workspace_id = ?1 AND month = ?2 AND document_sha256 = ?3 AND proof_json IS NOT NULL`,
    )
    .bind(workspaceId, month, documentSha256)
    .first<{ proof_json: string }>();
  return row ? (JSON.parse(row.proof_json) as StatementAttestationProof) : null;
}

/** The digest of the month's published statement, or null when none is published. */
export async function publishedStatementDigest(db: D1Database, workspaceId: string, month: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT digest FROM transparency_statements WHERE workspace_id = ?1 AND month = ?2`)
    .bind(workspaceId, month)
    .first<{ digest: string }>();
  return row?.digest ?? null;
}
