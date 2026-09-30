/** blueprint:submit — admit one declared blueprint operation (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { submitBlueprintOperation } from '../../blueprint/operation-service';
import { BLUEPRINT_OPERATION_TOOLS, SubmitArgsSchema, SubmitResultSchema } from '../../blueprint/operation-contract';
import { OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.submit,
  capability: 'work_items:write',
  idempotent: true,
  description:
    'Submit a declared blueprint operation under a request key; returns its durable handle. Same key + same input replays one execution; different input is refused. Accepted is not completed.',
  guidance: {
    when: 'Starting a task that the harness blueprint declares as an operation.',
    notWhen: 'Plain ad-hoc work (work_items:create) or running a plan by hand (plans:*).',
    chaining: 'Keep the handle; poll blueprint:status or page blueprint:events, then read blueprint:result.',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: SubmitArgsSchema,
  result: SubmitResultSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    return runOperation(async () => ({
      handle: await submitBlueprintOperation(scope.sql, {
        workspaceId: scope.workspaceId, harnessSlug: args.harness, callerId: scope.callerId,
        operationId: args.operationId, requestKey: args.requestKey, input: args.input,
        title: args.title, summary: args.summary,
      }),
    }));
  },
});
