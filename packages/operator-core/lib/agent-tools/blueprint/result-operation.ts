/** blueprint:result — settled outcome and validated output (P-017, D-009/D-012). */
import { defineTool } from '@papercusp/agent-mcp';
import { getBlueprintOperationResult } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationResultSchema, HandleArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.result,
  capability: 'work_items:read',
  description:
    'Read an operation result: pending, failed/cancelled/dropped/unavailable with a reason, or ready with validated output and evidence. Only ready carries output.',
  guidance: {
    when: 'After blueprint:status reports terminal, or to wait-check a handle you submitted.',
    notWhen: 'Treating a settled work item as success — failed/dropped settlements never carry output.',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: HandleArgsSchema,
  result: BlueprintOperationResultSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    checkHandleScope(scope, args.handle);
    return runOperation(() => getBlueprintOperationResult(scope.sql, args.handle, scope.callerId));
  },
});
