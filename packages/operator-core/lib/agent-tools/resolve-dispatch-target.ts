/**
 * Flag-gated tool-name resolution for DISPATCH seams (plan fuzzy-tool-name-resolution-2026-07-02,
 * P-006 / D-010 AUTO-DISPATCH layer).
 *
 * `resolveMcpNameTagged` (tooldef) is the mechanism; this is the policy hook a dispatch seam calls
 * so typo recovery has ONE runtime kill-switch (`FLAGS.TOOL_NAME_FUZZY_RESOLVE`, default ON). With
 * the flag OFF the seam sees exactly today's behaviour — exact + canonical fold via the unchanged
 * `resolveMcpName`, a typo is a miss — and only the fuzzy stage is withheld. Callers that DERIVE
 * AUTHORITY from the resolved tool (identity grants, sibling-arg owner) must keep calling
 * `resolveMcpName` directly: they never act on a guess, flag or no flag.
 *
 * A `via:'fuzzy'` result obliges the seam to annotate its reply (D-008) — P-007.
 */
import {
  resolveMcpName,
  resolveMcpNameTagged,
  type ResolveMcpNameOptions,
  type ResolvedMcpName,
} from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

export interface ResolveDispatchTargetDeps {
  /** Injected for tests; defaults to the live flag read (fail-OPEN to ON like every default-ON flag). */
  readonly fuzzyEnabled?: () => Promise<boolean>;
}

const defaultFuzzyEnabled = (): Promise<boolean> =>
  getFlag(FLAGS.TOOL_NAME_FUZZY_RESOLVE, 'system').catch(() => true);

export async function resolveDispatchTarget(
  name: string,
  opts: ResolveMcpNameOptions = {},
  deps: ResolveDispatchTargetDeps = {},
): Promise<ResolvedMcpName> {
  const enabled = await (deps.fuzzyEnabled ?? defaultFuzzyEnabled)();
  if (enabled) return resolveMcpNameTagged(name, opts);
  // Kill-switch OFF: the canonical-only lookup, re-shaped into the tagged result. `visible` still
  // applies so a hidden tool is never returned just because the flag is off.
  const tool = resolveMcpName(name);
  if (!tool || (opts.visible && !opts.visible(tool))) return { input: name, alternatives: [] };
  const resolvedName = tool.expose.mcp?.name;
  return {
    tool,
    via: resolvedName === name ? 'exact' : 'canonical',
    input: name,
    ...(resolvedName !== undefined ? { resolvedName } : {}),
    distance: 0,
    alternatives: resolvedName !== undefined ? [resolvedName] : [],
  };
}
