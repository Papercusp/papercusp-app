/**
 * The one current-caller dispatch wrapper for recipe-script execution.
 *
 * Inline code:run, saved-recipe replay, and future durable execution must all
 * enter this wrapper before the real projected-tool dispatcher. It reproduces
 * the workspace/principal/transaction binding of a direct MCP call for every
 * nested dispatch and forces lossless in-process result semantics. A recipe
 * carries source and revision metadata only; no author privilege reaches here.
 */
import { withWorkspace, getOrgPg } from '@papercusp/db-org';
import {
  boundWorkspaceTx,
  type UnifiedToolContext,
  type WrapDispatch,
} from '@papercusp/agent-mcp';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { runWithoutAmbientArgPeeling } from '../ambient-args-scope';
import {
  dispatchNeedsTx,
  effectiveDispatchWorkspace,
  synthesizeDispatchPrincipal,
  synthesizeTransportPrincipal,
} from '../../endpoint-route/routes/transport/role-principal-caps';
import { ToolDispatchError } from '@papercusp/tooldef';
import {
  applyNestedProjection,
  nestedProjectionContext,
  nestedProjectionInvalidMessage,
  prepareNestedProjection,
} from '../../result-projection';

/**
 * Rebind one nested orchestration call exactly as a direct MCP dispatch would.
 *
 * The common concrete-workspace path reuses an already-correct outer
 * transaction. Unscoped-superuser workspace hops, cross-workspace tools, and
 * transaction-free tools receive the same per-call binding they get outside a
 * recipe script. Every path gets code-mode, full-payload, transport-cap-exempt
 * semantics because intermediate values stay inside the script runtime.
 */
const rebindCurrentCallerDispatch: WrapDispatch = async (tool, _toolName, args, ctx, next) => {
  const spawnCtxLike = {
    workspaceId: ctx.workspaceId ?? '',
    role: ctx.role ?? '',
    isSuperuser: ctx.isSuperuser,
  };
  const effectiveWs = effectiveDispatchWorkspace(spawnCtxLike, args);

  const baseCtx: UnifiedToolContext = {
    ...ctx,
    contextTier: undefined,
    transportCapExempt: true,
    codeMode: true,
  };

  if (tool.crossWorkspace === true) {
    const { sql: adminTx } = getOrgPg();
    const callCtx: UnifiedToolContext = {
      ...baseCtx,
      workspaceId: effectiveWs,
      tx: adminTx,
      principal: await synthesizeDispatchPrincipal(adminTx, { ...spawnCtxLike, workspaceId: effectiveWs }),
    };
    return runWithWorkspaceIfConcrete(effectiveWs, () => next(callCtx));
  }

  const outerTx = boundWorkspaceTx(ctx);
  if (
    tool.needsWorkspaceTx === true &&
    effectiveWs === spawnCtxLike.workspaceId &&
    outerTx !== undefined
  ) {
    return next({ ...baseCtx, tx: outerTx });
  }

  const callSpawnCtx = { ...spawnCtxLike, workspaceId: effectiveWs };
  if (!dispatchNeedsTx(callSpawnCtx)) {
    return runWithWorkspaceIfConcrete(effectiveWs, () => next({ ...baseCtx, workspaceId: effectiveWs }));
  }

  // A concrete-workspace superuser principal is fully derivable from transport
  // context: it has the system/operator identity and capability bypass, never a
  // provisioned per-workspace capability set. Opening `withWorkspace` merely to
  // synthesize that principal retained an org-app pool slot for every nested
  // transaction-free capability and made hermetic orchestration tests attempt a
  // real Postgres connection. Direct transaction-free SU dispatch needs neither.
  if (tool.needsWorkspaceTx !== true && callSpawnCtx.isSuperuser === true) {
    return runWithWorkspaceIfConcrete(effectiveWs, () =>
      next({
        ...baseCtx,
        workspaceId: effectiveWs,
        tx: undefined,
        principal: synthesizeTransportPrincipal(callSpawnCtx) ?? undefined,
      }),
    );
  }

  if (tool.needsWorkspaceTx !== true) {
    return runWithWorkspaceIfConcrete(effectiveWs, () =>
      withWorkspace(effectiveWs, async (tx) => {
        const principal = await synthesizeDispatchPrincipal(tx, callSpawnCtx);
        return next({ ...baseCtx, workspaceId: effectiveWs, tx: undefined, principal });
      }),
    );
  }

  return runWithWorkspaceIfConcrete(effectiveWs, () =>
    withWorkspace(effectiveWs, async (tx) => {
      const callCtx: UnifiedToolContext = {
        ...baseCtx,
        workspaceId: effectiveWs,
        tx,
        principal: await synthesizeDispatchPrincipal(tx, callSpawnCtx),
      };
      return next(callCtx);
    }),
  );
};

/**
 * The wrapper every nested orchestration call actually enters.
 *
 * Adds one fact to the rebinding above: this dispatch peels NO ambient dispatch-level
 * args (EI-22295290349236847). Only the MCP transport strips `projection`/`view`, so a
 * nested call reaches the target schema with both intact and an invalid-args rejection
 * here must not advertise them as accepted — see `../ambient-args-scope.ts`.
 *
 * The scope wraps the WHOLE rebinding rather than each `next(...)` because that function
 * has seven return paths and a per-path wrap is one refactor away from silently missing
 * one. Argument validation runs inside `next` (orchestrate.ts's `call` → `realDispatch`),
 * so it is covered by this scope.
 */
export const bindCurrentCallerDispatch: WrapDispatch = (tool, toolName, args, ctx, next) => {
  const prepared = prepareNestedProjection(args);
  if (prepared.error) {
    return Promise.reject(new ToolDispatchError(toolName, 'invalid_input', nestedProjectionInvalidMessage(prepared.error)));
  }

  const projectedNext = async (callCtx: UnifiedToolContext): Promise<unknown> => {
    const materializedCtx = nestedProjectionContext(callCtx, prepared.args, prepared.spec);
    const result = await next(materializedCtx, prepared.args);
    return applyNestedProjection(result, prepared.spec, { toolName, effect: tool.effect });
  };

  return runWithoutAmbientArgPeeling(() =>
    rebindCurrentCallerDispatch(tool, toolName, prepared.args, ctx, projectedNext),
  );
};
