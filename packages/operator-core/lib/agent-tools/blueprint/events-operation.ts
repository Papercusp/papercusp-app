/** blueprint:events — cursor-paged operation event history (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { getBlueprintOperationEvents } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationEventsPageSchema, EventsArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.events,
  capability: 'work_items:read',
  description:
    'Page an operation\'s durable events (work-item, plan-run, cancel, signal, wait, resume, model-attestation) after a cursor, with the current status. Reconnect by passing the last cursor.',
  guidance: {
    when: 'Following an operation you submitted, or catching up after a disconnect.',
    notWhen: 'You only need the current state (blueprint:status).',
    chaining: 'Pass the returned cursor back while hasMore is true; the status snapshot is always current.',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: EventsArgsSchema,
  result: BlueprintOperationEventsPageSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    checkHandleScope(scope, args.handle);
    return runOperation(() => getBlueprintOperationEvents(scope.sql, args.handle, scope.callerId, {
      cursor: args.cursor, limit: args.limit,
    }));
  },
});
