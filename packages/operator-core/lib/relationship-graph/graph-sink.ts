/**
 * The connector-delivery hook of the platform relationship graph (crm-agent-sales-onboarding-
 * apps-2026-10-06 P-002, D-011). Appended after the datatype destination sinks for `person` and
 * `organization` records, it re-resolves the identity cluster of the record just stored.
 *
 * It is its own sink, like admission, so a failed resolve is recorded on its own delivery
 * ledger row (and retried with the delivery) without undoing the stored record.
 */
import type { Sql } from 'postgres';
import { dataSourceRecordId } from '../data-sources/datatype-destination-sink';
import type { CanonicalExternalEvent, ExternalTriggerSink } from '../external-triggers/ingestion';
import {
  type GraphEntityDatatype,
  ORGANIZATION_DATATYPE,
  relinkPersonsForOrganizations,
  resolveIdentities,
  type ResolverDeps,
} from './resolver';

export const RELATIONSHIP_GRAPH_SINK_KIND = 'relationship-graph-resolve';

export function createRelationshipGraphSink(
  sql: Sql,
  input: { workspaceId: string; sourceId: string; datatype: GraphEntityDatatype },
  deps: ResolverDeps = {},
): ExternalTriggerSink {
  return {
    kind: RELATIONSHIP_GRAPH_SINK_KIND,
    ref: `${input.sourceId}:${input.datatype}`,
    async deliver(event: CanonicalExternalEvent) {
      const recordId = dataSourceRecordId(input.workspaceId, input.sourceId, input.datatype, event.externalId);
      const result = await resolveIdentities(sql, { workspaceId: input.workspaceId, datatype: input.datatype, recordIds: [recordId] }, deps);
      if (input.datatype === ORGANIZATION_DATATYPE) {
        // A new or changed organization can become the employer of persons already in the graph.
        await relinkPersonsForOrganizations(sql, { workspaceId: input.workspaceId, organizationIds: result.canonical.map((c) => c.id) }, deps);
      }
      return result;
    },
  };
}
