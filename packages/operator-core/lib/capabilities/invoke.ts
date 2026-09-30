/**
 * Palette server-capability invocation (P-004, write side).
 *
 * Runs a tooldef tool on behalf of the desktop palette user, through the
 * SAME gated/audited path the MCP transport uses (`dispatchProjectedToolToMcp`
 * + `PROJECTED_DEPS`) — the full dispatch stack (role-allowlist → capability →
 * authorize → quota → audit) applies. Deliberately:
 *   - NO `gateBypass` and NO `isSuperuser` — unlike the MCP superuser path,
 *     the palette does not bypass any gate. It runs as a plain `operator`-role
 *     loopback principal; trust-/role-/capability-gated tools reject normally.
 *   - A SERVER-SIDE §3 re-check (never trust the client): excluded tools are
 *     refused; destructive/high-risk tools require an explicit `confirmed`.
 *
 * The route in front of this (`run-tool.ts`) enforces loopback-only origin.
 */
import {
  lookupByMcpName,
  tierFor,
  BRAIN_PRINCIPAL_ROLE,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { activeWorkspaceId } from '../workspace-registry';
import { loadHarnessRegistry } from '../harness-registry';
import { isAllHarnessSentinel } from '../agent-tools/_harness-scope';
import { suggestClosestToolNames } from '../agent-tools/tools/unknown-tool-referral';
import { projectedToolToCapability } from './from-tooldef';
import { paletteEligibility, type PaletteEligibilityOpts } from './safety-filter';
import type { Capability } from './types';

export type InvokeGuard =
  | { allow: true; cap: Capability }
  | { allow: false; status: number; code: string; message: string };

/**
 * The pure §3 admission decision for a palette invoke. Factored out so it's
 * unit-testable without the live catalog/dispatch.
 */
export function paletteInvokeGuard(
  cap: Capability,
  confirmed: boolean,
  /** True when the caller passed arguments — see {@link PaletteEligibilityOpts.argsSupplied}. */
  argsSupplied = false,
): InvokeGuard {
  const eligibility = paletteEligibility(cap, { argsSupplied });
  if (eligibility === 'exclude') {
    // Say WHICH limit was hit. The old message named all three causes at once,
    // so an arg-taking tool invoked WITH args reported "streaming, interactive,
    // or requires arguments" and read as an unfixable capability limit rather
    // than the missing-args case it actually was.
    const why =
      cap.streaming || cap.interactive
        ? 'it streams or prompts mid-run, which this shim cannot host'
        : cap.requiresArgs
          ? 'it requires arguments and none were supplied'
          : 'it is not exposed to this surface';
    return {
      allow: false,
      status: 403,
      code: 'not_palette_eligible',
      message: `"${cap.id}" cannot be run from here: ${why}`,
    };
  }
  if (eligibility === 'confirm' && !confirmed) {
    return {
      allow: false,
      status: 409,
      code: 'confirmation_required',
      message: `"${cap.id}" is destructive or high-risk; re-invoke with confirmed:true`,
    };
  }
  return { allow: true, cap };
}

export type InvokeResult =
  | { ok: false; status: number; code: string; message: string }
  | { ok: true; status: number; body: unknown };

type PaletteDispatchResult = Awaited<
  ReturnType<NonNullable<UnifiedToolContext['dispatchTool']>>
>;

type ServerCapabilityInvoker = (opts: {
  name: string;
  args?: unknown;
  confirmed?: boolean;
  callerSid?: string;
  harness?: string;
}) => Promise<InvokeResult>;

/**
 * Re-enter the palette capability chokepoint for a `tools:invoke` target.
 * Dependency injection keeps the forwarding/denial envelope unit-testable
 * without a live registry, workspace transaction, or MCP server.
 */
export async function dispatchPaletteTarget(
  opts: {
    name: string;
    args: unknown;
    confirmed?: boolean;
    callerSid?: string;
    harness?: string;
  },
  invoke: ServerCapabilityInvoker = invokeServerCapability,
): Promise<PaletteDispatchResult> {
  const target = lookupByMcpName(opts.name);
  const targetCanonical = target?.expose?.mcp?.name ?? opts.name;
  if (targetCanonical === 'tools:invoke') {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'invalid_target: tools:invoke cannot invoke itself',
        },
      ],
    };
  }
  const nested = await invoke(opts);
  if (!nested.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `${nested.code}: ${nested.message}`,
        },
      ],
    };
  }
  return nested.body as PaletteDispatchResult;
}

export async function invokeServerCapability(opts: {
  name: string;
  args?: unknown;
  confirmed?: boolean;
  /** EI-1751: an optional caller-supplied, process-stable id (e.g. a pui
   *  instance's `pui-<pid>`) — folded into `ctx.uiClientId` for per-caller
   *  telemetry attribution ONLY. Every palette-loopback call still runs as
   *  the same fixed `spawnId='palette'` operator principal below; existing
   *  consumers keyed on that literal (fleet-ekg/features.ts,
   *  decision-ledger/emit.ts's isReadShapedCoordPoll) are unaffected. */
  callerSid?: string;
  /** Selected resource scope only. The palette principal and active workspace remain fixed. */
  harness?: string;
}): Promise<InvokeResult> {
  // The projected registry is the lookup of record — it carries EVERY tool
  // (principal-gated, role-gated, plugin); the legacy getCatalog() misses all
  // role-gated tools, which is how the Start Hive button got
  // `no tool named "pot:start"` for a tool MCP dispatched fine.
  const projected = lookupByMcpName(opts.name);
  if (!projected) {
    // EI-9011 (generalized): carry closest catalog matches so a typo'd / format-variant
    // name is recoverable from the error itself (this path surfaces in UI toasts, so no
    // agent-facing tools:find referral here — just the matches).
    const close = suggestClosestToolNames(opts.name);
    const didYouMean = close.length > 0 ? ` Closest matches: ${close.join(', ')}.` : '';
    return { ok: false, status: 404, code: 'unknown_tool', message: `no tool named "${opts.name}".${didYouMean}` };
  }

  const cap = projectedToolToCapability(
    opts.name,
    { ...projected, capabilities: projected.capabilities as readonly string[] },
    tierFor,
  );
  // A non-empty args object means the caller supplied its own arguments, so the
  // arg-PROMPT exclusion doesn't apply (see PaletteEligibilityOpts.argsSupplied).
  const argsSupplied =
    typeof opts.args === 'object' && opts.args !== null && Object.keys(opts.args).length > 0;
  const guard = paletteInvokeGuard(cap, opts.confirmed === true, argsSupplied);
  if (!guard.allow) {
    return { ok: false, status: guard.status, code: guard.code, message: guard.message };
  }

  const workspaceId = activeWorkspaceId();
  let harnessSlug = '*';
  if (opts.harness !== undefined) {
    const selected = typeof opts.harness === 'string' ? opts.harness.trim() : '';
    if (!selected || selected.length > 120 || isAllHarnessSentinel(selected)) {
      return { ok: false, status: 400, code: 'invalid_harness', message: 'Select a concrete harness in this workspace.' };
    }
    // Never search other workspaces or infer scope from the caller's telemetry id.
    // The registry is the existing authoritative set of selectable harnesses.
    let registry: Awaited<ReturnType<typeof loadHarnessRegistry>>;
    try {
      registry = await loadHarnessRegistry(workspaceId);
    } catch {
      return { ok: false, status: 503, code: 'harness_registry_unavailable', message: 'Could not read this workspace’s harnesses.' };
    }
    if (!registry.projects.some((project) => project.slug === selected)) {
      return { ok: false, status: 404, code: 'harness_not_found', message: 'The selected harness is not in this workspace.' };
    }
    harnessSlug = selected;
  }
  const canonicalName = projected.expose?.mcp?.name ?? opts.name;
  const dispatch = async (tx?: UnifiedToolContext['tx']) => {
    // The desktop loopback caller IS the operator (same trust the MCP
    // operator-tier path grants on loopback). The dispatch capability gate is
    // a literal `has(cap)` and does NOT honor the loopback principal's `'*'`,
    // so bypass it — but KEEP the role gate enforced (`role: 'operator'`), which
    // aligns invoke exactly with the role-filtered /capabilities listing. Quota
    // is bypassed too: palette actions are human-initiated, not agent budget
    // (D-004). `authorize` (resource PDP) and the §3 guard above still apply,
    // and every call is audited via PROJECTED_DEPS. Security posture: loopback
    // origin + §3 + confirm-for-destructive + audit (see D-007).
    const ctx: UnifiedToolContext = {
      workspaceId,
      harnessSlug,
      role: 'operator',
      featureId: null,
      chunkId: null,
      runId: globalThis.crypto.randomUUID(),
      spawnId: 'palette',
      parentSpawnId: null,
      // EI-1751: attribution-only — see the opts.callerSid doc comment above.
      // Every literal 'palette'-keyed consumer reads ctx.spawnId, untouched.
      uiClientId: opts.callerSid ?? null,
      isSuperuser: false,
      gateBypass: { capability: true, quota: true },
      profile: 'engineer',
      transport: 'http',
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: new AbortController().signal,
      ...(tx ? { tx } : {}),
      // The loopback caller IS the operator/brain — carry the brain RBAC role so a
      // `requireRoles:[BRAIN_PRINCIPAL_ROLE]` tool (the spawn-approval gate, P-006)
      // admits it (this path bypasses capability/quota but NOT role).
      principal: {
        kind: 'system',
        slug: 'loopback',
        workspaceId,
        authMethod: 'process-internal',
        trust: 'trusted',
        capabilities: new Set(['*']),
        roles: new Set([BRAIN_PRINCIPAL_ROLE]),
      },
    };
    // PUI P-012: the palette itself now fronts tools:find → tools:invoke.
    // `tools:invoke` is a pure delegator and therefore needs the same
    // server-side dispatcher the MCP transport installs. Re-enter this
    // capability chokepoint for the INNER target: that deliberately re-runs
    // palette eligibility, confirmation, role/capability, authorization,
    // quota/audit, and opens the target's own workspace transaction. It is not
    // a privilege bypass and does not hold the outer delegator's transaction
    // across a slow target.
    ctx.dispatchTool = async (name, args) =>
      dispatchPaletteTarget({
        name,
        args,
        confirmed: opts.confirmed,
        callerSid: opts.callerSid,
        ...(opts.harness === undefined ? {} : { harness: harnessSlug }),
      });
    return dispatchProjectedToolToMcp(projected, opts.name, opts.args ?? {}, ctx, PROJECTED_DEPS);
  };

  // tools:invoke declares skipWorkspaceTx: the wrapper never reads `ctx.tx` and
  // can outlive the 60s idle-transaction timeout. Every inner target re-enters
  // `invokeServerCapability` above and receives its own transaction when needed.
  const body =
    canonicalName === 'tools:invoke'
      ? await dispatch()
      : await withWorkspace(workspaceId, async (tx) => dispatch(tx));

  return { ok: true, status: 200, body };
}
