/**
 * Interaction participants into the platform relationship graph (crm-agent-sales-onboarding-
 * apps-2026-10-06 P-002, D-011 points 2 and 5, D-013).
 *
 * Interactions (email-message, calendar-event, chat-message, call) stay in their own datatypes and
 * stores: the owner's Vault for mail and calendar, the corpus for calls. What enters the workspace
 * graph is only WHO took part. Each participant becomes a per-source `person` record
 * (`participant:<identity key>`) delivered through the same person record path a connector person
 * takes (record sink, admission, identity resolve), so the resolver merges it with every other
 * observation of that human. Subjects, bodies and descriptions never leave the interaction store.
 *
 * The bridge works on the connector DELIVERY stream, never by reading the Vault (D-011 point 5).
 * Its grant is the source's own destination policy: participants are projected only from a source
 * that routes `person` to `record`, the same rule a connector person record already obeys.
 */
import type { Sql } from 'postgres';
import { createDatatypeDestinationSinks } from '../data-sources/datatype-destination-sink';
import type { CanonicalExternalEvent, ExternalTriggerSink } from '../external-triggers/ingestion';
import { createRelationshipGraphSink } from './graph-sink';
import { type IdentityKey, type InteractionParticipant, interactionParticipants, PARTICIPANT_FIELDS } from './identity-keys';
import { PARTICIPANT_DERIVATION } from './merge';
import { PERSON_DATATYPE, type ResolverDeps } from './resolver';

export const INTERACTION_PARTICIPANT_SINK_KIND = 'relationship-graph-participants';

/** Interaction datatypes whose participants feed the graph: exactly those with participant fields. */
export const INTERACTION_DATATYPES: readonly string[] = Object.freeze(Object.keys(PARTICIPANT_FIELDS));

export function isInteractionDatatype(datatype: string): boolean {
  return INTERACTION_DATATYPES.includes(datatype);
}

/** The native id of the per-source person record one participant key projects to. */
export function participantNativeId(key: IdentityKey): string {
  return `participant:${key}`;
}

/** The person payload projected from one participant: identity fields and a pointer, no content. */
export function participantPersonPayload(
  participant: InteractionParticipant,
  interaction: { datatype: string; externalId: string; provider: string; occurredAt: string | null },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    provider: interaction.provider,
    externalId: participantNativeId(participant.key),
    emails: participant.emails,
    phones: participant.phones,
    derivedFrom: PARTICIPANT_DERIVATION,
    participantOf: { datatype: interaction.datatype, externalId: interaction.externalId },
  };
  if (participant.displayName) payload.displayName = participant.displayName;
  if (interaction.occurredAt) {
    payload.observedAt = interaction.occurredAt;
    payload.updatedAt = interaction.occurredAt;
  }
  return payload;
}

export interface ParticipantSinkDeps {
  createPersonSinks?: typeof createDatatypeDestinationSinks;
  createGraphSink?: typeof createRelationshipGraphSink;
  resolver?: ResolverDeps;
}

/**
 * The sink that projects one interaction's participants into the graph, or null when the source
 * does not route `person` to `record` (no grant: nothing from this source enters the graph).
 */
export async function createInteractionParticipantSink(
  sql: Sql,
  input: { workspaceId: string; sourceId: string; datatype: string },
  deps: ParticipantSinkDeps = {},
): Promise<ExternalTriggerSink | null> {
  if (!isInteractionDatatype(input.datatype)) return null;
  const createPersonSinks = deps.createPersonSinks ?? createDatatypeDestinationSinks;
  const createGraphSink = deps.createGraphSink ?? createRelationshipGraphSink;
  const personSinks = await createPersonSinks(sql, { workspaceId: input.workspaceId, sourceId: input.sourceId, datatype: PERSON_DATATYPE });
  if (!personSinks.some((s) => s.kind === 'data-source-record')) return null;
  const graphSink = createGraphSink(sql, { workspaceId: input.workspaceId, sourceId: input.sourceId, datatype: PERSON_DATATYPE }, deps.resolver);
  const chain = [...personSinks, graphSink];
  return {
    kind: INTERACTION_PARTICIPANT_SINK_KIND,
    ref: `${input.sourceId}:${input.datatype}`,
    async deliver(event: CanonicalExternalEvent) {
      const participants = interactionParticipants(input.datatype, event.payload ?? {});
      for (const participant of participants) {
        const nativeId = participantNativeId(participant.key);
        const personEvent: CanonicalExternalEvent = {
          ...event,
          datatypeId: PERSON_DATATYPE,
          event: 'person-observed',
          externalId: nativeId,
          dedupeKey: `${event.dedupeKey}#${nativeId}`,
          payload: participantPersonPayload(participant, {
            datatype: input.datatype,
            externalId: event.externalId,
            provider: event.source,
            occurredAt: event.occurredAt ?? null,
          }),
        };
        // In order: the record sink must store the row before admission reads it and the resolver merges it.
        for (const sink of chain) await sink.deliver(personEvent);
      }
      return { participants: participants.map((p) => p.key) };
    },
  };
}
