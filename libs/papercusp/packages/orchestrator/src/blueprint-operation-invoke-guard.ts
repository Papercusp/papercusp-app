/** Keep accepted operations off the legacy autonomous invoke authority path. */
import type { OrchestratorPg } from './invoke.js';

export async function assertNoUnboundAcceptedOperation(input: {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
}): Promise<void> {
  const rows = await input.pg<Array<{ payload: unknown }>>`
    SELECT payload FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND feature_id = ${input.featureId}
     LIMIT 2
  `;
  if (rows.length > 1) throw new Error('accepted operation worker has multiple canonical work items');
  const payload = rows[0]?.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) &&
      Object.prototype.hasOwnProperty.call(payload, 'blueprintOperation')) {
    throw new Error(
      `accepted blueprint operation ${input.featureId} requires an identity-bound worker launch; ` +
      'legacy autonomous invoke cannot establish its grant receipt',
    );
  }
}
