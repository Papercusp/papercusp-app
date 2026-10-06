/**
 * Reader-set labels — the Postgres half.
 * Plan personal-data-reader-set-labels-2026-10-01 P-003/P-004 (WI-10004864), D-002/D-003.
 *
 * Two operations, both inside the caller's transaction:
 *
 *   discloseDocuments       — at DELIVERY. Label each document from the owner's
 *                             rules and append a ledger row for every restricted
 *                             one handed to this agent identity.
 *   assertDisclosurePermits — at every outbound SINK. Refuse any recipient outside
 *                             owner ∪ ⋂ reader sets of the agent's active rows.
 *
 * Both fail closed. Restricted content whose delivery cannot be attributed to an
 * agent identity is WITHHELD, never returned unlabelled; and a sink that cannot
 * read the ledger refuses rather than sending unchecked. Together those make a
 * null identity at a sink sound: nothing restricted can have reached it.
 *
 * Rows are keyed by agent identity across every user in the workspace: content
 * read for one user and sent through another user's account is still a leak.
 * Rows have no TTL and survive compaction (D-003); only an owner-directed
 * release clears one (D-002, P-005).
 */
import type postgres from 'postgres';
import { listOwnedExternalTriggerSources } from '../external-triggers/source-store';
import {
  allowedRecipients,
  checkRecipients,
  labelDocument,
  type ActiveDisclosure,
  type DocumentLabel,
  type LabelableDocument,
  type PrivacyLevel,
  type PrivacyRule,
  type PrivacyRuleMatch,
  type RestrictedLevel,
} from './disclosure-labels';

type Db = postgres.Sql | postgres.TransactionSql;

export type DisclosureRefusalCode = 'disclosure_reader_set_violation' | 'disclosure_ledger_unavailable';

export class DisclosureRefused extends Error {
  readonly code: DisclosureRefusalCode;
  /** Recipients outside the allowed set; the sink label when its audience cannot be enumerated. */
  readonly violating: string[];
  readonly allowed: string[];
  readonly constraining: ActiveDisclosure[];
  constructor(
    code: DisclosureRefusalCode,
    detail: string,
    fields: { violating?: string[]; allowed?: string[]; constraining?: ActiveDisclosure[] } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'DisclosureRefused';
    this.code = code;
    this.violating = fields.violating ?? [];
    this.allowed = fields.allowed ?? [];
    this.constraining = fields.constraining ?? [];
  }
}

/** The structured refusal a tool returns instead of throwing — same shape as the addressee rail's. */
export function disclosureRefusalData(error: DisclosureRefused) {
  return {
    ok: false,
    refused: true,
    code: error.code,
    violating: error.violating,
    allowedRecipients: error.allowed,
    constrainingDisclosures: error.constraining.map((row) => ({ documentId: row.documentId, level: row.level })),
    detail: error.message,
  } as const;
}

export async function loadPrivacyRules(sql: Db, workspaceId: string, userId: string): Promise<PrivacyRule[]> {
  const rows = await sql<Array<{ matchKind: PrivacyRuleMatch; matchValue: string; level: PrivacyLevel }>>`
    SELECT match_kind AS "matchKind", match_value AS "matchValue", level
      FROM harness_shared.personal_privacy_rules
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid`;
  return rows.map((row) => ({ matchKind: row.matchKind, matchValue: row.matchValue, level: row.level }));
}

export interface PrivacyRuleRow extends PrivacyRule {
  id: string;
  createdBy: string;
  updatedBy: string;
  updatedAt: Date;
  /** The owner directive that authorized the last LOOSENING edit, if any. */
  authorityRef: string | null;
}

export async function listPrivacyRuleRows(sql: Db, workspaceId: string, userId: string): Promise<PrivacyRuleRow[]> {
  return sql<PrivacyRuleRow[]>`
    SELECT id::text, match_kind AS "matchKind", match_value AS "matchValue", level,
           created_by AS "createdBy", updated_by AS "updatedBy", updated_at AS "updatedAt",
           authority_ref AS "authorityRef"
      FROM harness_shared.personal_privacy_rules
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid
     ORDER BY match_kind, match_value`;
}

/**
 * Create or replace the rule for (kind, value). `authorityRef` is set only by a
 * loosening edit; a tightening edit keeps the last loosening's reference.
 */
export async function upsertPrivacyRule(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    matchKind: PrivacyRuleMatch;
    matchValue: string;
    level: PrivacyLevel;
    actor: string;
    authorityRef: string | null;
  },
): Promise<PrivacyRuleRow> {
  const [row] = await sql<PrivacyRuleRow[]>`
    INSERT INTO harness_shared.personal_privacy_rules
      (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by, authority_ref)
    VALUES (${params.workspaceId}, ${params.userId}::uuid, ${params.matchKind}, ${params.matchValue},
            ${params.level}, ${params.actor}, ${params.actor}, ${params.authorityRef})
    ON CONFLICT (workspace_id, user_id, match_kind, match_value)
    DO UPDATE SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = now(),
                  authority_ref = COALESCE(EXCLUDED.authority_ref, personal_privacy_rules.authority_ref)
    RETURNING id::text, match_kind AS "matchKind", match_value AS "matchValue", level,
              created_by AS "createdBy", updated_by AS "updatedBy", updated_at AS "updatedAt",
              authority_ref AS "authorityRef"`;
  return row;
}

export async function deletePrivacyRule(
  sql: Db,
  params: { workspaceId: string; userId: string; matchKind: PrivacyRuleMatch; matchValue: string },
): Promise<PrivacyRuleRow | null> {
  const [row] = await sql<PrivacyRuleRow[]>`
    DELETE FROM harness_shared.personal_privacy_rules
     WHERE workspace_id = ${params.workspaceId} AND user_id = ${params.userId}::uuid
       AND match_kind = ${params.matchKind} AND match_value = ${params.matchValue}
    RETURNING id::text, match_kind AS "matchKind", match_value AS "matchValue", level,
              created_by AS "createdBy", updated_by AS "updatedBy", updated_at AS "updatedAt",
              authority_ref AS "authorityRef"`;
  return row ?? null;
}

export interface ReleasableDisclosure extends ActiveDisclosure {
  deliveredAt: Date;
}

/** This agent's active disclosures, optionally narrowed to `documentIds`, across every user. */
export async function loadReleasableDisclosures(
  sql: Db,
  params: { workspaceId: string; agentOwnerId: string; documentIds: readonly string[] | null },
): Promise<ReleasableDisclosure[]> {
  const ids = params.documentIds ? [...params.documentIds] : null;
  const rows = await sql<Array<{ id: string; documentId: string; level: RestrictedLevel; readerSet: string[]; deliveredAt: Date }>>`
    SELECT id::text, document_id::text AS "documentId", level, reader_set AS "readerSet", delivered_at AS "deliveredAt"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${params.workspaceId}
       AND agent_owner_id = ${params.agentOwnerId}
       AND released_at IS NULL
       AND (${ids}::uuid[] IS NULL OR document_id = ANY(${ids}::uuid[]))
     ORDER BY delivered_at, id`;
  return rows.map((row) => ({ ...row, readerSet: row.readerSet ?? [] }));
}

/**
 * Release the listed ledger rows. Only rows delivered BEFORE the authorizing
 * owner turn are touched: a disclosure that landed after the owner typed the
 * release cannot be what they agreed to release.
 */
export async function releaseDisclosures(
  sql: Db,
  params: {
    workspaceId: string;
    agentOwnerId: string;
    ids: readonly string[];
    deliveredBefore: Date;
    releasedBy: string;
    releaseRef: string;
  },
): Promise<string[]> {
  if (!params.ids.length) return [];
  const rows = await sql<Array<{ documentId: string }>>`
    UPDATE harness_shared.personal_disclosures
       SET released_at = now(), released_by = ${params.releasedBy}, release_ref = ${params.releaseRef}
     WHERE workspace_id = ${params.workspaceId}
       AND agent_owner_id = ${params.agentOwnerId}
       AND released_at IS NULL
       AND id = ANY(${[...params.ids]}::uuid[])
       AND delivered_at < ${params.deliveredBefore}
    RETURNING document_id::text AS "documentId"`;
  return rows.map((row) => row.documentId);
}

export async function loadActiveDisclosures(
  sql: Db,
  params: { workspaceId: string; agentOwnerId: string },
): Promise<ActiveDisclosure[]> {
  const rows = await sql<Array<{ id: string; documentId: string; level: RestrictedLevel; readerSet: string[] }>>`
    SELECT id::text, document_id::text AS "documentId", level, reader_set AS "readerSet"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${params.workspaceId}
       AND agent_owner_id = ${params.agentOwnerId}
       AND released_at IS NULL
     ORDER BY delivered_at, id`;
  return rows.map((row) => ({
    id: row.id,
    documentId: row.documentId,
    level: row.level,
    readerSet: row.readerSet ?? [],
  }));
}

/**
 * The owner's own addresses: the provider accounts of every source they have
 * connected. Mail they send to themselves cannot leak anything, so these are
 * always permitted.
 */
export async function loadOwnerAddresses(sql: Db, workspaceId: string, userId: string): Promise<string[]> {
  const owned = await listOwnedExternalTriggerSources(sql as postgres.Sql, workspaceId, userId);
  const addresses = new Set<string>();
  for (const row of owned) {
    const account = row.providerAccountId?.trim().toLowerCase();
    if (account && account.includes('@')) addresses.add(account);
  }
  return [...addresses].sort();
}

export interface DisclosedDocuments<T extends LabelableDocument> {
  /** What may be returned to the agent; restricted entries carry their label. */
  documents: Array<T & { privacy: DocumentLabel | null }>;
  /** Restricted documents dropped because the delivery had no attributable agent identity. */
  withheld: number;
  /** Restricted documents now on this agent's ledger. */
  disclosed: number;
}

/**
 * Label `documents` and record a disclosure for every restricted one. Call it
 * in the SAME transaction that reads the documents, before they are returned:
 * a delivery whose ledger row did not commit must not reach the agent either.
 */
export async function discloseDocuments<T extends LabelableDocument>(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    agentOwnerId: string | null;
    documents: readonly T[];
    /** The tool that delivered them, e.g. `personal:search`. */
    via: string;
  },
): Promise<DisclosedDocuments<T>> {
  if (!params.documents.length) return { documents: [], withheld: 0, disclosed: 0 };
  const rules = await loadPrivacyRules(sql, params.workspaceId, params.userId);
  const labelled = params.documents.map((doc) => ({ ...doc, privacy: rules.length ? labelDocument(doc, rules) : null }));
  const restricted = labelled.filter((doc) => doc.privacy !== null);
  if (!restricted.length) return { documents: labelled, withheld: 0, disclosed: 0 };

  const agentOwnerId = params.agentOwnerId?.trim();
  if (!agentOwnerId) {
    return {
      documents: labelled.filter((doc) => doc.privacy === null),
      withheld: restricted.length,
      disclosed: 0,
    };
  }

  for (const doc of restricted) {
    const label = doc.privacy!;
    // A re-read of the same document is not a new disclosure. The one update an
    // active row accepts is a TIGHTENING (participants → sender-only, whose
    // reader set is a subset); a rule loosened since delivery never widens a
    // label the agent is already carrying.
    await sql`
      INSERT INTO harness_shared.personal_disclosures
        (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via)
      VALUES (${params.workspaceId}, ${params.userId}::uuid, ${agentOwnerId}, ${doc.id}::uuid,
              ${doc.source}, ${label.level}, ${label.readerSet}::text[], ${params.via})
      ON CONFLICT (workspace_id, user_id, agent_owner_id, document_id) WHERE released_at IS NULL
      DO UPDATE SET level = EXCLUDED.level, reader_set = EXCLUDED.reader_set
            WHERE personal_disclosures.level = 'participants' AND EXCLUDED.level = 'sender-only'`;
  }
  return { documents: labelled, withheld: 0, disclosed: restricted.length };
}

/**
 * Refuse an outbound whose audience reaches beyond what this agent may tell.
 *
 * `recipients: null` declares an audience that cannot be enumerated as
 * mailboxes — a chat channel, a public post. While any disclosure is active
 * that is refused outright: nobody can show its readers are permitted.
 *
 * A null `agentOwnerId` is a caller with no attributable identity; delivery
 * withholds restricted content from such a caller, so there is nothing to check.
 */
export async function assertDisclosurePermits(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    agentOwnerId: string | null;
    recipients: readonly string[] | null;
    /** The sink, for the refusal message, e.g. `mail:send` or `slack:C0123`. */
    sink: string;
  },
): Promise<void> {
  const agentOwnerId = params.agentOwnerId?.trim();
  if (!agentOwnerId) return;
  let disclosures: ActiveDisclosure[];
  let ownerAddresses: string[] = [];
  try {
    disclosures = await loadActiveDisclosures(sql, { workspaceId: params.workspaceId, agentOwnerId });
    if (disclosures.length) ownerAddresses = await loadOwnerAddresses(sql, params.workspaceId, params.userId);
  } catch (error) {
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `could not read this agent's disclosure ledger before ${params.sink} (${error instanceof Error ? error.message : String(error)}); refusing rather than sending unchecked`,
    );
  }
  if (!disclosures.length) return;

  const allowed = allowedRecipients(disclosures, ownerAddresses);
  if (!allowed.restricted) return;
  if (params.recipients === null) {
    throw new DisclosureRefused(
      'disclosure_reader_set_violation',
      `${params.sink} reaches an audience that cannot be enumerated, and this agent holds ${disclosures.length} restricted disclosure(s); only these recipients may be sent to: ${allowed.allowed.join(', ') || '(the owner only)'}`,
      { violating: [params.sink], allowed: allowed.allowed, constraining: allowed.constraining },
    );
  }
  const check = checkRecipients(params.recipients, allowed);
  if (!check.ok) {
    throw new DisclosureRefused(
      'disclosure_reader_set_violation',
      `${check.violating.join(', ')} may not receive content from the ${disclosures.length} restricted document(s) this agent has read; permitted recipients: ${check.allowed.join(', ') || '(the owner only)'}`,
      { violating: check.violating, allowed: check.allowed, constraining: check.constraining },
    );
  }
}
