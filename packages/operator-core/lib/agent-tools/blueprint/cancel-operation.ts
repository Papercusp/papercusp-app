/** blueprint:cancel — durable cancellation request (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { cancelBlueprintOperation } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationCancelReceiptSchema, CancelArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.cancel,
  capability: 'work_items:write',
  idempotent: true,
  description:
    'Request cancellation of an operation you submitted. Returns a durable receipt; effected is true only once canonical state reads cancelled. A terminal operation is refused.',
  guidance: {
    when: 'Stopping a non-terminal blueprint operation you own.',
    notWhen: 'Dropping ordinary work (work_items:set_state).',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: CancelArgsSchema,
  result: BlueprintOperationCancelReceiptSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    checkHandleScope(scope, args.handle);
    return runOperation(() => cancelBlueprintOperation(scope.sql, args.handle, scope.callerId, {
      requestKey: args.requestKey, reason: args.reason,
    }));
  },
});
