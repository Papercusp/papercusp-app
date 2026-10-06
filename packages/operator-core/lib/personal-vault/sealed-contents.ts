/**
 * Reader-set labels — the sealed store for shared writes.
 * Plan personal-data-reader-set-labels-2026-10-01 P-006 (WI-10004933), D-006.
 *
 *   sealCoordEnvelope   — at the coord WRITE seam. While the sender holds an
 *                         active disclosure, move what it authored here with a
 *                         snapshot of its labels and return the stub to persist.
 *   openSealedContent   — at READ. Return the content and, in the same
 *                         transaction, record the snapshot labels on the agent
 *                         that opened it. The owner opens without a label.
 *
 * Both fail closed: a ledger read or seal write that fails refuses the write
 * (disclosure_ledger_unavailable), and an opener with no attributable identity
 * is withheld the content (D-004).
 */
import type postgres from 'postgres';
import { COORD_SEAL_STORE, splitForSeal } from './coord-seal';
import { DisclosureRefused } from './disclosure-ledger';
import type { RestrictedLevel } from './disclosure-labels';

type Db = postgres.Sql | postgres.TransactionSql;

/** One restricted document's label as it stood when the content was sealed. */
export interface SealedLabel {
  userId: string;
  documentId: string;
  source: string;
  level: RestrictedLevel;
  readerSet: string[];
}

/** The agent's active labels across every vault user in the workspace. */
export async function snapshotActiveLabels(
  sql: Db,
  params: { workspaceId: string; agentOwnerId: string },
): Promise<SealedLabel[]> {
  const rows = await sql<SealedLabel[]>`
    SELECT user_id::text AS "userId", document_id::text AS "documentId", source, level,
           reader_set AS "readerSet"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${params.workspaceId}
       AND agent_owner_id = ${params.agentOwnerId}
       AND released_at IS NULL
     ORDER BY delivered_at, id`;
  return rows.map((row) => ({ ...row, readerSet: row.readerSet ?? [] }));
}

/** Idempotent on (store, ref): a replayed write keeps the first seal. */
export async function storeSealedContent(
  sql: Db,
  params: {
    workspaceId: string;
    store: string;
    ref: string;
    writerOwnerId: string;
    content: Record<string, unknown>;
    labels: readonly SealedLabel[];
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.personal_sealed_contents
      (workspace_id, store, ref, writer_owner_id, content, labels)
    VALUES (${params.workspaceId}, ${params.store}, ${params.ref}, ${params.writerOwnerId},
            ${sql.json(params.content as postgres.JSONValue)}, ${sql.json(params.labels as unknown as postgres.JSONValue)})
    ON CONFLICT (workspace_id, store, ref) DO NOTHING`;
}

/**
 * Seal `env` if its sender holds an active disclosure in `workspaceId`; return
 * what to persist. Runs in its own short transaction on `sql` with
 * app.workspace_id set, so the read is correct under RLS whichever role the
 * handle connects as.
 */
export async function sealCoordEnvelope<E extends { msg_id: string; from: string } & Record<string, unknown>>(
  sql: postgres.Sql,
  params: { workspaceId: string; env: E },
): Promise<E> {
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${params.workspaceId}, true)`;
      const labels = await snapshotActiveLabels(tx, {
        workspaceId: params.workspaceId,
        agentOwnerId: params.env.from,
      });
      if (!labels.length) return params.env;
      const split = splitForSeal(params.env, labels.length);
      if (!split) return params.env;
      await storeSealedContent(tx, {
        workspaceId: params.workspaceId,
        store: COORD_SEAL_STORE,
        ref: params.env.msg_id,
        writerOwnerId: params.env.from,
        content: split.content,
        labels,
      });
      return split.stub;
    }) as E;
  } catch (error) {
    if (error instanceof DisclosureRefused) throw error;
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `could not check or seal ${params.env.from}'s message against its disclosure ledger (${error instanceof Error ? error.message : String(error)}); refusing rather than sending it unsealed`,
    );
  }
}

/**
 * The owner's view of many sealed rows at once (the Inbox lists a page of
 * messages). The owner is always a permitted reader, so nothing is labelled.
 */
export async function openSealedForOwner(
  sql: Db,
  params: { workspaceId: string; store: string; refs: readonly string[] },
): Promise<Map<string, Record<string, unknown>>> {
  if (!params.refs.length) return new Map();
  const rows = await sql<Array<{ ref: string; content: Record<string, unknown> }>>`
    SELECT ref, content
      FROM harness_shared.personal_sealed_contents
     WHERE workspace_id = ${params.workspaceId} AND store = ${params.store}
       AND ref = ANY(${[...params.refs]}::text[])`;
  return new Map(rows.map((row) => [row.ref, row.content]));
}

export type SealedOpenResult =
  | { found: false }
  | { found: true; withheld: true; labels: number }
  | {
      found: true;
      withheld: false;
      writerOwnerId: string;
      content: Record<string, unknown>;
      labels: SealedLabel[];
      /** Labels now active on the opener (0 for the owner). */
      labelled: number;
    };

/**
 * Open sealed content for `opener`. An agent opener carries the snapshot labels
 * from this transaction on; a null agent identity is withheld the content. The
 * owner is always a permitted reader and is not labelled.
 */
export async function openSealedContent(
  sql: Db,
  params: {
    workspaceId: string;
    store: string;
    ref: string;
    opener: { kind: 'agent'; ownerId: string | null; via: string } | { kind: 'owner' };
  },
): Promise<SealedOpenResult> {
  const [row] = await sql<Array<{ writerOwnerId: string; content: Record<string, unknown>; labels: SealedLabel[] }>>`
    SELECT writer_owner_id AS "writerOwnerId", content, labels
      FROM harness_shared.personal_sealed_contents
     WHERE workspace_id = ${params.workspaceId} AND store = ${params.store} AND ref = ${params.ref}`;
  if (!row) return { found: false };
  if (params.opener.kind === 'owner') {
    return { found: true, withheld: false, writerOwnerId: row.writerOwnerId, content: row.content, labels: row.labels, labelled: 0 };
  }
  const agentOwnerId = params.opener.ownerId?.trim();
  if (!agentOwnerId) return { found: true, withheld: true, labels: row.labels.length };

  for (const label of row.labels) {
    // Same upsert as discloseDocuments: an active row only ever tightens.
    await sql`
      INSERT INTO harness_shared.personal_disclosures
        (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via)
      VALUES (${params.workspaceId}, ${label.userId}::uuid, ${agentOwnerId}, ${label.documentId}::uuid,
              ${label.source}, ${label.level}, ${label.readerSet}::text[], ${params.opener.via})
      ON CONFLICT (workspace_id, user_id, agent_owner_id, document_id) WHERE released_at IS NULL
      DO UPDATE SET level = EXCLUDED.level, reader_set = EXCLUDED.reader_set
            WHERE personal_disclosures.level = 'participants' AND EXCLUDED.level = 'sender-only'`;
  }
  return {
    found: true,
    withheld: false,
    writerOwnerId: row.writerOwnerId,
    content: row.content,
    labels: row.labels,
    labelled: row.labels.length,
  };
}
