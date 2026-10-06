/**
 * Participant backfill (crm-agent-sales-onboarding-apps-2026-10-06 P-003, D-017 point 2): projects
 * the participants of interactions ALREADY stored in an owner's Personal Vault into the
 * relationship graph, through the same participant chain live delivery uses.
 *
 * Live delivery only sees interactions as they arrive, so a source that gained its
 * `person -> record` grant after its mail was imported would otherwise never contribute those
 * people. App contact tables (Email's sender-derived contacts) are re-derived this way instead
 * of being copied: they were a projection of the same senders.
 *
 * Reads go through D-014's metadata path (readTeamInteractions): participant addresses only, never
 * subjects or bodies. Each source's grant is re-checked by createParticipantChain; a source without
 * it is reported as ungranted and contributes nothing.
 */
import type { Sql } from 'postgres';
import { isCodingAgentRole } from '../personal-vault/coding-roles';
import { readTeamInteractions } from '../personal-vault/team-disclosure';
import type { PersonalToolContext } from '../personal-vault/types';
import type { CanonicalExternalEvent } from '../external-triggers/ingestion';
import { participantOf, type IdentityKey, type InteractionParticipant } from './identity-keys';
import { createParticipantChain, INTERACTION_DATATYPES, isInteractionDatatype, type ParticipantSinkDeps } from './participants';

export interface ParticipantBackfillInput {
  workspaceId: string;
  /** The Vault owner whose stored interactions are read. */
  userId: string;
  /** The reader context; coding/review roles are refused by readTeamInteractions. */
  ctx: PersonalToolContext;
  /** Restrict to these data sources; default every source holding interactions. */
  sourceIds?: readonly string[];
  batchSize?: number;
}

export interface ParticipantBackfillSourceResult {
  sourceId: string;
  datatype: string;
  granted: boolean;
  documents: number;
  participants: number;
}

export type ParticipantBackfillResult =
  | { ok: true; sources: ParticipantBackfillSourceResult[]; documents: number; participants: number }
  | { ok: false; reason: 'coding_agent_denied' | 'vault_disabled'; sources: ParticipantBackfillSourceResult[] };

/** The interaction datatype a source delivers: the interaction key of its destination policy. */
export function interactionDatatypeOfPolicy(policy: Record<string, unknown> | null | undefined): string | null {
  return Object.keys(policy ?? {}).sort().find((datatype) => isInteractionDatatype(datatype)) ?? null;
}

/** Participants of one stored interaction from its team metadata (addresses only), keyed and deduped. */
export function participantsFromAddresses(addresses: readonly string[]): InteractionParticipant[] {
  const byKey = new Map<IdentityKey, InteractionParticipant>();
  for (const address of addresses) {
    const participant = participantOf(address);
    if (participant && !byKey.has(participant.key)) byKey.set(participant.key, participant);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function backfillInteractionParticipants(
  sql: Sql,
  input: ParticipantBackfillInput,
  deps: ParticipantSinkDeps = {},
): Promise<ParticipantBackfillResult> {
  // D-001 fence up front: the refusal must not depend on whether a granted source has documents.
  if (isCodingAgentRole(input.ctx.role)) return { ok: false, reason: 'coding_agent_denied', sources: [] };
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, 2000));
  const groups = await sql<Array<{ source_id: string; kind: string; source: string; policy: Record<string, unknown> | null }>>`
    SELECT d.source_id::text AS source_id, d.kind, min(d.source) AS source, s.destination_policy AS policy
      FROM harness_shared.personal_documents d
      JOIN harness_shared.data_sources s ON s.id::text = d.source_id::text
     WHERE d.workspace_id = ${input.workspaceId} AND d.user_id = ${input.userId}::uuid
       ${input.sourceIds?.length ? sql`AND d.source_id::text = ANY(${sql.array([...input.sourceIds])}::text[])` : sql``}
     GROUP BY d.source_id, d.kind, s.destination_policy
     ORDER BY d.source_id, d.kind`;
  const sources: ParticipantBackfillSourceResult[] = [];
  let documents = 0;
  let participants = 0;
  for (const group of groups) {
    const datatype = interactionDatatypeOfPolicy(group.policy);
    if (!datatype) continue;
    const result: ParticipantBackfillSourceResult = { sourceId: group.source_id, datatype, granted: false, documents: 0, participants: 0 };
    sources.push(result);
    const chain = await createParticipantChain(sql, { workspaceId: input.workspaceId, sourceId: group.source_id, datatype }, deps);
    if (!chain) continue;
    result.granted = true;
    let afterId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await sql<Array<{ id: string; external_id: string | null }>>`
        SELECT id::text AS id, external_id FROM harness_shared.personal_documents
         WHERE workspace_id = ${input.workspaceId} AND user_id = ${input.userId}::uuid
           AND source_id::text = ${group.source_id} AND kind = ${group.kind} AND id > ${afterId}::uuid
         ORDER BY id LIMIT ${batchSize}`;
      if (!page.length) break;
      afterId = page[page.length - 1]!.id;
      const read = await readTeamInteractions(sql, {
        ctx: input.ctx,
        workspaceId: input.workspaceId,
        userId: input.userId,
        documentIds: page.map((row) => row.id),
        agentOwnerId: null,
      });
      if (!read.allowed) return { ok: false, reason: read.reason, sources };
      const externalIds = new Map(page.map((row) => [row.id, row.external_id ?? row.id]));
      for (const view of read.interactions) {
        const metadata = view.metadata;
        const found = participantsFromAddresses(metadata.participants);
        const externalId = externalIds.get(metadata.documentId) ?? metadata.documentId;
        const event: CanonicalExternalEvent = {
          key: `backfill:${group.source_id}:${externalId}`,
          workspaceId: input.workspaceId,
          sourceId: group.source_id,
          source: metadata.source ?? group.source,
          event: 'interaction-backfill',
          datatypeId: datatype,
          externalId,
          dedupeKey: `${group.source_id}:${datatype}:${externalId}`,
          occurredAt: metadata.occurredAt,
          payload: {},
        };
        await chain.deliverParticipants(event, found);
        result.documents += 1;
        result.participants += found.length;
      }
    }
    documents += result.documents;
    participants += result.participants;
  }
  return { ok: true, sources, documents, participants };
}

/**
 * The principal the platform backfill reads under (D-018 point 1). A platform step, not an agent
 * identity, and deliberately NOT a coding role: readTeamInteractions' D-001 fence still applies to
 * every agent session, which is why an agent never runs this by hand.
 */
export const PARTICIPANT_BACKFILL_ROLE = 'relationship-graph';

export interface PendingParticipantBackfill {
  sourceId: string;
  outcome: 'backfilled' | 'vault_disabled' | 'failed';
  documents: number;
  participants: number;
  error?: string;
}

/**
 * D-018: backfill every granted source of this workspace whose participant_backfill_at marker is
 * NULL (migration 1394 clears it when a source newly grants person -> record), then stamp it. Run by
 * the system:connector-sync routine each tick; independent of whether the source's own sync
 * succeeds, because the stored interactions it reads are already in the owner's Vault.
 *
 * A source whose owner has the Vault disabled stays pending and is retried on a later tick; a
 * failure is reported and also stays pending. Bounded by `maxSources` per call.
 */
export async function runPendingParticipantBackfills(
  sql: Sql,
  input: { workspaceId: string; maxSources?: number; batchSize?: number },
  deps: ParticipantSinkDeps = {},
): Promise<PendingParticipantBackfill[]> {
  const pending = await sql<Array<{ id: string; owner_user_id: string }>>`
    SELECT id::text AS id, owner_user_id::text AS owner_user_id
      FROM harness_shared.data_sources
     WHERE workspace_id = ${input.workspaceId}
       AND owner_user_id IS NOT NULL
       AND participant_backfill_at IS NULL
       AND coalesce(destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb
       AND destination_policy ?| ${sql.array([...INTERACTION_DATATYPES])}::text[]
     ORDER BY created_at, id
     LIMIT ${Math.max(1, Math.min(input.maxSources ?? 4, 50))}`;
  const out: PendingParticipantBackfill[] = [];
  for (const source of pending) {
    try {
      const result = await backfillInteractionParticipants(
        sql,
        {
          workspaceId: input.workspaceId,
          userId: source.owner_user_id,
          ctx: { workspaceId: input.workspaceId, role: PARTICIPANT_BACKFILL_ROLE },
          sourceIds: [source.id],
          batchSize: input.batchSize,
        },
        deps,
      );
      if (!result.ok) {
        // coding_agent_denied cannot happen under PARTICIPANT_BACKFILL_ROLE; vault_disabled is the
        // owner's choice and is re-checked on a later tick.
        out.push({ sourceId: source.id, outcome: result.reason === 'vault_disabled' ? 'vault_disabled' : 'failed', documents: 0, participants: 0, ...(result.reason === 'vault_disabled' ? {} : { error: result.reason }) });
        continue;
      }
      // Stamp only while the grant still holds: a revocation during the run leaves it pending.
      await sql`
        UPDATE harness_shared.data_sources
           SET participant_backfill_at = now()
         WHERE id = ${source.id}::uuid
           AND participant_backfill_at IS NULL
           AND coalesce(destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb`;
      out.push({ sourceId: source.id, outcome: 'backfilled', documents: result.documents, participants: result.participants });
    } catch (cause) {
      out.push({ sourceId: source.id, outcome: 'failed', documents: 0, participants: 0, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return out;
}
