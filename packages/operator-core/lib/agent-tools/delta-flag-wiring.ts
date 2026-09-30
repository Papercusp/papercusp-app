/**
 * Wire tooldef's semantic-delta gate to FLAGS.TOOL_DELTA_PROTOCOL
 * (agent-tool-delta-protocol-2026-06-22, the flag-bite — D-007/D-008).
 *
 * `@papercusp/tooldef` `defineTool` upgrades a `changed` view-response to a
 * `mode:'delta'` body only when this resolver returns true. The default
 * resolver is `() => true` (the library can't see host flags); the HOST owns
 * the policy. tooldef is host-agnostic and agent-mcp doesn't depend on
 * `@papercusp/flags`, so the flag-reading resolver is registered here, on the
 * operator side, and imported as a side-effect at startup (see
 * `agent-tools/index.ts`) — same shape as `pre-prompt-registry-config`.
 *
 * The flag is DEFAULT ON (owner-directed flip 2026-06-22).
 *
 * ⚠ NO LONGER INERT — and THIS COMMENT'S PREDECESSOR IS WHY THAT WENT UNNOTICED
 * FOR A MONTH (WI-3153, measured 2026-08-04). It used to read "INERT until a
 * delta-aware CLIENT exists (WI-514 — nothing sends `_meta.delta` yet)". The MCP
 * transport's delta proxy (`_mcp-handler.ts` `maybeRunWithDeltaProxy`) was defined
 * AND on the dispatch path from 2026-07-05 — one day BEFORE EI-7923 cited THIS LINE
 * as its evidence that no client sends `_meta.delta`, and that false premise then
 * propagated into WI-3153 and survived 29 days. Verify against the dispatch path,
 * never against this comment.
 *
 * What actually happens: the proxy holds a per-session `DeltaToolClient`, sends
 * `_meta.delta` on the model's behalf, applies + checksum-verifies the delta, and
 * returns RECONSTRUCTED full rows (mode:'full', reason:'proxy_reconstructed'); on
 * any checksum/parse failure it forgets the view and refetches full. The MODEL
 * never merges. In-process callers set no cursor at all, so `negotiateDelta`
 * returns full (reason:'no_request'). OFF reverts every tool to the
 * unconditionally-safe Lane-B behaviour (full | not_modified) — a real,
 * runtime-flippable kill-switch (`/admin/features`), not a no-op.
 *
 * The gate read is fail-OPEN to the flag DEFAULT: `getFlag` already returns
 * `FLAG_DEFAULTS[key]` when there's no PostHog client / stored override (the
 * embedded/dev path), and we swallow any unexpected throw back to that default
 * too, so a flag-subsystem hiccup never silently disables a shipped-ON feature.
 * Keyed on `ctx.workspaceId` (the natural delta scope) so the flag can be
 * targeted per-workspace; falls back to a stable id when absent.
 */

import { setSemanticDeltaEnabledResolver } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

const TOOL_DELTA_DEFAULT = true; // mirrors FLAG_DEFAULTS[TOOL_DELTA_PROTOCOL]

setSemanticDeltaEnabledResolver(async (ctx: unknown): Promise<boolean> => {
  const distinctId =
    (ctx as { workspaceId?: string } | null | undefined)?.workspaceId ?? 'global';
  try {
    return await getFlag(FLAGS.TOOL_DELTA_PROTOCOL, distinctId);
  } catch {
    // Fail open to the flag default — never let a flag-read fault disable a
    // shipped-ON capability (and never throw out of the delta-negotiation path).
    return TOOL_DELTA_DEFAULT;
  }
});
