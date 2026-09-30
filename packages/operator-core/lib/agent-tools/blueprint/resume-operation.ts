/** blueprint:resume — answer an outstanding declared wait (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { resumeBlueprintOperation } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationInputReceiptSchema, ResumeArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.resume,
  capability: 'work_items:write',
  idempotent: true,
  description:
    'Answer the outstanding declared wait of an operation you submitted, by its wait token. Stale, foreign or already-answered tokens are refused; the response is schema-validated.',
  guidance: {
    when: 'blueprint:status shows phase waiting with a wait token you can answer.',
    notWhen: 'No outstanding wait, or sending an unsolicited input (blueprint:signal).',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: ResumeArgsSchema,
  result: BlueprintOperationInputReceiptSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    checkHandleScope(scope, args.handle);
    return runOperation(() => resumeBlueprintOperation(scope.sql, args.handle, scope.callerId, {
      token: args.token, response: args.response, requestKey: args.requestKey,
    }));
  },
});
