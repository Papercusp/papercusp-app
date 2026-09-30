/** blueprint:signal — send a declared signal to an operation (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { signalBlueprintOperation } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationInputReceiptSchema, SignalArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.signal,
  capability: 'work_items:write',
  idempotent: true,
  description:
    'Send a payload on a channel the operation declares; validated against its schema and durably accepted. handled:false — acceptance is not handling.',
  guidance: {
    when: 'Feeding a running operation you submitted an input it declares.',
    notWhen: 'Answering a declared wait (blueprint:resume) or an undeclared channel (refused).',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: SignalArgsSchema,
  result: BlueprintOperationInputReceiptSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    checkHandleScope(scope, args.handle);
    return runOperation(() => signalBlueprintOperation(scope.sql, args.handle, scope.callerId, {
      channel: args.channel, payload: args.payload, requestKey: args.requestKey,
    }));
  },
});
