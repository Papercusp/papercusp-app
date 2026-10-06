/**
 * Team vs personal disclosure: what the shared CRM may read from one person's Personal Vault
 * (plan crm-agent-sales-onboarding-apps-2026-10-06 P-004).
 *
 * The CRM is shared: teammates and the sales/onboarding agents read it. An interaction (an email,
 * a calendar event, a call, a chat message) stays in its owner's Vault (D-011 point 2); the CRM
 * reads it through this module and nowhere else. Two tiers:
 *
 *   METADATA, the default: participants, time, channel and subject. No grant is needed beyond the
 *     owner's Vault being on and the reader not being a coding or review role (the D-001 fence in
 *     authorization.ts applies to the metadata tier too).
 *
 *   CONTENT, by explicit grant only: the body text and every other stored field (snippets, HTML,
 *     descriptions, locations, transcripts, recording links). It is returned only while the reading
 *     principal holds a live `personal_grants` row whose scopes cover the document's source, which is
 *     the same check `personal:search` makes. Revoking the grant ends access on the next read;
 *     nothing here caches an authorization.
 *
 * Every content delivery to an agent identity goes through `discloseDocuments`, so a document the
 * owner's privacy rules restrict lands in the disclosure ledger and binds that agent's outbound
 * sinks to its reader set. Restricted content with no attributable agent identity is withheld,
 * exactly as `personal:search` withholds it.
 *
 * A restricted document's subject counts as content: without a content grant, a document the owner's
 * privacy rules label shows participants, time and channel only.
 *
 * The metadata projection is an ALLOW-LIST (`TEAM_METADATA_FIELDS`). A new column or a new key in a
 * document's `metadata` jsonb is content until someone deliberately adds it here.
 */
import type postgres from 'postgres';
import { isCodingAgentRole, authorizePersonalAccess, type PersonalAuthorization } from './authorization';
import { labelDocument, type LabelableDocument } from './disclosure-labels';
import { discloseDocuments, loadPrivacyRules } from './disclosure-ledger';
import { isPersonalVaultEnabled, personalScope } from './store';
import type { PersonalToolContext } from './types';

type Db = postgres.Sql | postgres.TransactionSql;

/** The ledger's `delivered_via` for content the CRM hands to an agent. */
export const TEAM_DISCLOSURE_VIA = 'crm:interaction';

/** The only fields the shared CRM sees by default. Everything else is content. */
export const TEAM_METADATA_FIELDS = Object.freeze([
  'documentId',
  'source',
  'channel',
  'occurredAt',
  'subject',
  'participants',
] as const);

export interface InteractionMetadata {
  documentId: string;
  /** The Vault source the interaction came from (`gmail`, `gcal`, `phone`, ...). */
  source: string;
  /** The document kind: `email`, `calendar-event`, `call`, `chat-message`, ... */
  channel: string;
  occurredAt: string | null;
  /** Null when the document has no subject, or when it is withheld (restricted, no content grant). */
  subject: string | null;
  participants: string[];
}

export interface InteractionContent {
  text: string | null;
  /** The document's full stored metadata: snippets, HTML, descriptions, locations, and so on. */
  metadata: Record<string, unknown>;
}

export type ContentWithheldReason =
  | 'not_requested'
  | Exclude<PersonalAuthorization['reason'], undefined>
  | 'restricted_unattributed';

export interface TeamInteractionView {
  metadata: InteractionMetadata;
  content: InteractionContent | null;
  /** Why `content` is null; null when content was delivered. */
  contentWithheld: ContentWithheldReason | null;
  /** True when the subject was dropped because the owner's privacy rules restrict this document. */
  subjectWithheld: boolean;
}

export type TeamReadRefusal = 'coding_agent_denied' | 'vault_disabled';

export type TeamInteractionRead =
  | { allowed: true; interactions: TeamInteractionView[] }
  | { allowed: false; reason: TeamReadRefusal; interactions: [] };

export interface TeamInteractionRow {
  id: string;
  source: string;
  kind: string;
  occurred_at: Date | string | null;
  participants: string[] | null;
  title: string | null;
  text: string | null;
  metadata: Record<string, unknown> | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The default-tier view of one Vault document: exactly `TEAM_METADATA_FIELDS`, nothing else. */
export function teamMetadataView(row: TeamInteractionRow, opts: { withholdSubject: boolean }): InteractionMetadata {
  const subject = row.title?.trim() ? row.title : null;
  return {
    documentId: row.id,
    source: row.source,
    channel: row.kind,
    occurredAt: isoOrNull(row.occurred_at),
    subject: opts.withholdSubject ? null : subject,
    participants: [...(row.participants ?? [])],
  };
}

function labelable(row: TeamInteractionRow): LabelableDocument & { row: TeamInteractionRow } {
  return { id: row.id, source: row.source, participants: row.participants ?? [], metadata: row.metadata ?? {}, row };
}

/**
 * Read interactions from one owner's Vault for the shared CRM.
 *
 * `wantContent` asks for the content tier; it is still granted per source, per call. Results keep the
 * order of `documentIds`; an id that is not one of this owner's documents is omitted.
 */
export async function readTeamInteractions(
  sql: Db,
  params: {
    ctx: PersonalToolContext;
    workspaceId: string;
    /** The Vault owner. */
    userId: string;
    documentIds: readonly string[];
    /** The agent identity the content is delivered to; null for a caller with none. */
    agentOwnerId: string | null;
    wantContent?: boolean;
  },
): Promise<TeamInteractionRead> {
  if (isCodingAgentRole(params.ctx.role)) return { allowed: false, reason: 'coding_agent_denied', interactions: [] };
  if (!(await isPersonalVaultEnabled(sql as postgres.Sql, params.workspaceId, params.userId))) {
    return { allowed: false, reason: 'vault_disabled', interactions: [] };
  }
  const ids = [...new Set(params.documentIds)];
  if (!ids.length) return { allowed: true, interactions: [] };

  const rows = await sql<TeamInteractionRow[]>`
    SELECT id::text AS id, source, kind, occurred_at, participants, title, text, metadata
      FROM harness_shared.personal_documents
     WHERE workspace_id = ${params.workspaceId}
       AND user_id = ${params.userId}::uuid
       AND id = ANY(${ids}::uuid[])`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row): row is TeamInteractionRow => Boolean(row));

  const rules = await loadPrivacyRules(sql, params.workspaceId, params.userId);
  const restricted = new Set(
    rules.length ? ordered.filter((row) => labelDocument(labelable(row), rules) !== null).map((row) => row.id) : [],
  );

  // Content tier: authorize each distinct source once, then hand the granted documents to the
  // ledger so restricted ones are recorded against the agent (or withheld without one).
  const content = new Map<string, InteractionContent>();
  const withheld = new Map<string, ContentWithheldReason>();
  if (params.wantContent) {
    const sources = [...new Set(ordered.map((row) => row.source))];
    const verdicts = new Map<string, PersonalAuthorization>();
    for (const source of sources) {
      verdicts.set(
        source,
        await authorizePersonalAccess(sql as postgres.Sql, params.ctx, params.workspaceId, params.userId, [
          personalScope(source),
        ]),
      );
    }
    const granted = ordered.filter((row) => {
      const verdict = verdicts.get(row.source);
      if (verdict?.allowed) return true;
      withheld.set(row.id, verdict?.reason ?? 'no_live_grant');
      return false;
    });
    const disclosed = await discloseDocuments(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      agentOwnerId: params.agentOwnerId,
      documents: granted.map(labelable),
      via: TEAM_DISCLOSURE_VIA,
    });
    const delivered = new Set(disclosed.documents.map((doc) => doc.id));
    for (const row of granted) {
      if (delivered.has(row.id)) content.set(row.id, { text: row.text, metadata: { ...(row.metadata ?? {}) } });
      else withheld.set(row.id, 'restricted_unattributed');
    }
  }

  return {
    allowed: true,
    interactions: ordered.map((row) => {
      const delivered = content.get(row.id) ?? null;
      const withholdSubject = restricted.has(row.id) && !delivered;
      return {
        metadata: teamMetadataView(row, { withholdSubject }),
        content: delivered,
        contentWithheld: delivered ? null : (withheld.get(row.id) ?? 'not_requested'),
        subjectWithheld: withholdSubject,
      };
    }),
  };
}
