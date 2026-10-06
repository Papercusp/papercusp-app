/**
 * agent-economy-flywheel-2026-08-30 P-016, decision D-012: the RESTART door of
 * the identity activation gate.
 *
 * A restart (SU persona refresh on a carry-respawn, Codex home repair) rebuilds
 * the launch artifact from the persisted launch record. Its caller is fail-soft:
 * when the rebuild throws, the host keeps the INHERITED render. A restart that
 * merely threw on an unfunded priced identity would therefore keep that identity
 * running, so "revocation stops the next activation" would not hold.
 *
 * This helper never hands back an unfunded priced layer. It rebuilds, admits the
 * stack, and on a refusal rebuilds once more with the refused stack entries
 * removed. Callers persist the returned artifact exactly as they do today, so the
 * refused entries leave the launch record too (a detach). They return through a
 * re-attach, which is the gated switch door. When removing stack entries cannot
 * cure a refusal (a priced layer that arrives some other way), it throws the
 * typed IdentityActivationRefusedError instead of returning a render.
 *
 * Coord rebind does not recompile the artifact; its next activation is this door.
 */
import type { RebuildSuLaunchArtifactInput, RebuiltSuLaunchArtifact } from '../su-persona-render';
import {
  IdentityActivationRefusedError,
  type IdentityActivationDecision,
} from './identity-activation-gate';
import type { IdentityActivationRequest } from './identity-activation-gate-io';

export type IdentityActivationRefusal = Extract<IdentityActivationDecision, { ok: false }>;

/**
 * The SU persona-refresh `reason` for a refusal that removing stack entries cannot
 * cure. The pty host refuses the respawn on it instead of keeping the inherited
 * render (D-012 point 2). Mirrors IDENTITY_ACTIVATION_REFUSED_REASON in
 * apps/operator/scripts/psu-pty-host.mjs.
 */
export const IDENTITY_ACTIVATION_REFUSED_REASON = 'identity-activation-refused' as const;

export interface FundedSuLaunchRebuild {
  readonly rebuilt: RebuiltSuLaunchArtifact;
  /** The refusal that removed stack entries; null when every priced layer was funded. */
  readonly identityActivationRefusal: IdentityActivationRefusal | null;
  /** Stack entries removed from the rebuilt stack because their priced layers were refused. */
  readonly removedLayerRefs: readonly string[];
}

export interface FundedRebuildDeps {
  readonly rebuild?: (input: RebuildSuLaunchArtifactInput) => Promise<RebuiltSuLaunchArtifact>;
  readonly admit?: (request: IdentityActivationRequest) => Promise<IdentityActivationDecision>;
}

/** `<slot>:<id>` with the id trimmed, the form the gate reports layer refs in. */
function normalizeRef(ref: string): string {
  const i = ref.indexOf(':');
  return i <= 0 ? ref : `${ref.slice(0, i)}:${ref.slice(i + 1).trim()}`;
}

export async function rebuildSuLaunchArtifactFunded(
  input: RebuildSuLaunchArtifactInput,
  deps: FundedRebuildDeps = {},
): Promise<FundedSuLaunchRebuild> {
  const rebuild = deps.rebuild ?? (await import('../su-persona-render')).rebuildSuLaunchArtifact;
  const admit = deps.admit ?? (await import('./identity-activation-gate-io')).admitIdentityActivation;
  const requestFor = (rebuilt: RebuiltSuLaunchArtifact): IdentityActivationRequest => ({
    stack: rebuilt.artifact.stack,
    repoDir: rebuilt.spec.cwd,
    workspaceId: input.record.workspaceId,
  });

  const first = await rebuild(input);
  const decision = await admit(requestFor(first));
  if (decision.ok) return { rebuilt: first, identityActivationRefusal: null, removedLayerRefs: [] };

  const refused = new Set(decision.refused.map((layer) => normalizeRef(layer.layerRef)));
  const priorStack = [...(input.stack ?? input.record.stack ?? [])];
  const removedLayerRefs = priorStack.filter((ref) => refused.has(normalizeRef(ref)));
  if (removedLayerRefs.length === 0) throw new IdentityActivationRefusedError(decision);

  const second = await rebuild({
    ...input,
    stack: priorStack.filter((ref) => !refused.has(normalizeRef(ref))),
  });
  const recheck = await admit(requestFor(second));
  if (!recheck.ok) throw new IdentityActivationRefusedError(recheck);
  return { rebuilt: second, identityActivationRefusal: decision, removedLayerRefs };
}
