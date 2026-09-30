/** blueprint:status — canonical lifecycle state of one operation (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { getBlueprintOperationStatus } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationStatusSchema, HandleArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.status,
  capability: 'work_items:read',
  description:
    'Read the phase (accepted/dispatched/waiting/terminal), outcome, items, plan run, cancellation and outstanding wait of an operation you submitted.',
  guidance: {
    when: 'Checking progress of a blueprint operation handle you hold.',
    notWhen: 'Reading the output — terminal is not success; use blueprint:result.',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: HandleArgsSchema,
  result: BlueprintOperationStatusSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    checkHandleScope(scope, args.handle);
    return runOperation(() => getBlueprintOperationStatus(scope.sql, args.handle, scope.callerId));
  },
});
