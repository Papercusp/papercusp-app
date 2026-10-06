/**
 * The operator side of the STACK-MUTATION PRIMITIVE (`identities-v1-2026-08-30` P-012,
 * D-022) — a live session's stack binding as CONTROL STATE, delivered through the
 * existing mode-flip channel.
 *
 * TWO HALVES.
 *
 *   1. `stackRefsForRoute` — the binding is DERIVED, never a new table. The fleet posture
 *      a session runs is presence's `fleet_role` (already projected into the control
 *      anchor as `route.role`); the mode axes are `agent_modes` (already `modes`), each
 *      ACTIVE mode binding its definition identity (`stackRefsForModes`, P-021 / D-008:
 *      `auto` → `autonomy:su.mode-auto`, …). `stackRefsForSession` projects both facts
 *      into the anchor's `stack` — bound-layer refs `slot:id` — so a posture change bumps
 *      the anchor generation exactly like a mode flip does, and a mode flip now carries a
 *      layer attach / detach through the same channel.
 *
 *   2. `renderStackTransitionContext` — at turn start the hook prepares the pending
 *      `⟦CTRL:transition⟧` (turn-start-memory.ts); this renders, as a SEPARATE context
 *      block outside the anchor's 384-token budget, the inject-now payloads for every
 *      mutation between the transition's `stackBefore` and its `state.stack`, over the
 *      REAL su stack (`composeSuStackMutation`: the next render is composed under the
 *      seal first, so a layer that would BLOCK is never injected). A transition without
 *      `stackBefore` (a full-resync) re-delivers every bound layer — the anchor's
 *      replace-full-never-merge-behind rule applied to the stack. The result-bearing
 *      companion lets the endpoint acknowledge the generation only after this render
 *      succeeds, so a fail-soft render does not consume the pending transition.
 *
 * The orchestrator barrel is imported LAZILY (it pulls the blueprint loader and its
 * harness-path resolution), and every failure degrades to an EMPTY block: a broken
 * layer render must never block the prompt, exactly like the control anchor itself.
 */
import type { ControlAnchorState, ControlTransition } from './agent-tools/coordination/control-anchor';
import type { ModeCatalogSnapshot, StackMutationActivation, StackActivationContext, StackDocument } from '@papercusp/orchestrator/blueprint';
import { BUILTIN_MODE_COMPONENTS } from '@papercusp/orchestrator/mode-catalog';

/**
 * The su posture layer refs. Inlined here (see the lazy-import note above) and PINNED
 * to the orchestrator's `suPostureLayer` by `stack-binding-channel.test.ts`, so the two
 * copies cannot drift.
 */
export const SU_POSTURE_REFS = {
  member: 'fleet-posture:su.fleet-member',
  leader: 'fleet-posture:su.fleet-leader',
} as const;

/** The bound-layer refs a session's route implies (the fleet posture). */
export function stackRefsForRoute(route: ControlAnchorState['route']): string[] {
  if (route.kind !== 'fleet') return [];
  const role = (route.role ?? '').trim().toLowerCase();
  if (role === 'leader' || role === 'member') return [SU_POSTURE_REFS[role]];
  return [];
}

/**
 * P-021 (D-008 as amended): the mode-axis identity a registry mode binds — `agent_modes`
 * rows are the STATE, these are the DEFINITION layers the state projects. The
 * generated catalog is plain data and safe to import without the blueprint loader.
 * The cold-auto runtime policy shares AUTO's authored document.
 */
export const SU_MODE_REFS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(BUILTIN_MODE_COMPONENTS.map((entry) => [entry.id, `${entry.slot}:${entry.sourceId}`])),
  'cold-auto': 'autonomy:su.mode-auto',
});

/**
 * The bound-layer refs a session's ACTIVE modes imply — one per axis (auto + cold-auto
 * share the autonomy axis and the same document). The implication closure is not applied
 * here: `setMode` already wrote the implied rows, so the `modes` read from `agent_modes`
 * carries `drain` AND `auto`.
 */
export function stackRefsForModes(
  modes: readonly string[] | null | undefined,
  modeCatalog?: ModeCatalogSnapshot,
): string[] {
  const out: string[] = [];
  for (const m of modes ?? []) {
    const key = String(m).trim().toLowerCase();
    const entry = modeCatalog?.entries.find((candidate) => candidate.id === (key === 'cold-auto' ? 'auto' : key));
    const ref = modeCatalog ? (entry ? `${entry.slot}:${entry.sourceId}` : undefined) : SU_MODE_REFS[key];
    if (ref && !out.some((prior) => prior.split(':', 1)[0] === ref.split(':', 1)[0])) out.push(ref);
  }
  return out;
}

/**
 * The whole binding of a live session: explicit launch-spec layers plus the
 * registry-derived fleet posture and mode axes. The launch record is the mutable
 * authority for user-selected layers; route/mode state remains independently
 * authoritative and is appended on every reconciliation. Exact repeats collapse.
 */
export function stackRefsForSession(input: {
  route: ControlAnchorState['route'];
  modes: readonly string[] | null | undefined;
  explicit?: readonly string[] | null;
  modeCatalog?: ModeCatalogSnapshot;
}): string[] {
  return [...new Set([...(input.explicit ?? []), ...stackRefsForRoute(input.route), ...stackRefsForModes(input.modes, input.modeCatalog)])];
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

type Blueprint = typeof import('@papercusp/orchestrator/blueprint');

export interface StackTransitionContextOptions {
  /** The harness install dir (default: `harnessRoot()`). */
  harnessDir?: string;
  /** Selected session cwd, so a harness-local identity override resolves first. */
  repoDir?: string;
  /** DI seam: the orchestrator blueprint module (tests pass the real one loaded eagerly). */
  blueprint?: Pick<
    Blueprint,
    'stackBindingFromRefs' | 'emptyStackBinding' | 'diffStackBindings' | 'composeSuStackMutation' | 'slotSpec' | 'suEffectiveBinding' | 'normalizeStackBinding'
  >;
  /**
   * portable-identity P-003: where this session's addressed Project-guide parts live
   * (`guideTargetFromLaunchSpec` over the gate-selected launch record). When set, a stack
   * change also delivers the guide sections the NEW stack reaches and names the ones it no
   * longer does — the same parts a launch with the new stack composes. Omit ⇒ layer text only.
   */
  guide?: import('./doc-projection/addressed-project-guide').AddressedGuideTarget | null;
  /**
   * P-009 / D-022: the wearer's pack-doc resource keys on each side of the transition —
   * `before` = the applied installation's, `after` = the one the desired revision leaves it
   * holding. A pack upgrade moves these without moving a layer ref, so the channel does not
   * early-return while they differ. Resolved lazily; a failure is surfaced in the delivered
   * text like a guide read failure. Needs `guide` (its target) to deliver anything.
   */
  packageResources?: () => Promise<{ before: readonly string[]; after: readonly string[] }>;
  /** Optional desired revision to stamp on a prepared mutation payload. */
  activation?: {
    specificationRevision: string;
    stateRevision: string;
    idempotencyKey?: string;
    context?: Partial<StackActivationContext>;
  };
  /** Where a compose failure is reported (default: console.warn). */
  warn?: (message: string) => void;
}

export interface StackTransitionContextResult {
  /** The inject-now context, empty when the stack did not move. */
  text: string;
  /** False only when rendering threw and the caller should retain the transition. */
  rendered: boolean;
  /** True when the changed slot requires a successor host before acknowledgement. */
  requiresFreshContext: boolean;
  /** Prepared activation, acknowledged separately after host acceptance. */
  activation?: StackMutationActivation;
}

/**
 * The inject-now context for a control transition — '' when the stack did not move.
 * An empty full-resync emits a revocation notice because its prior runtime binding is
 * unknown, and still composes the addressed-guide replacement when a guide target exists.
 * Never throws.
 */
export async function renderStackTransitionContextResult(
  delivery: Partial<Pick<ControlTransition, 'state' | 'stackBefore'>> | null | undefined,
  opts: StackTransitionContextOptions = {},
): Promise<StackTransitionContextResult> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  // Read defensively: a transition shaped by an older operator (or a test double) may
  // carry no `state` at all — that is "nothing bound", never a throw past the CTRL line.
  const after = Array.isArray(delivery?.state?.stack) ? delivery!.state!.stack!.map(String) : [];
  const before = Array.isArray(delivery?.stackBefore) ? delivery!.stackBefore!.map(String) : undefined;
  let packages: { before: string[]; after: string[] } | null = null;
  let packageError: string | null = null;
  if (opts.packageResources && opts.guide) {
    try {
      const resolved = await opts.packageResources();
      packages = { before: [...resolved.before], after: [...resolved.after] };
    } catch (e) {
      packageError = e instanceof Error ? e.message : String(e);
    }
  }
  const packagesMoved = packageError !== null || (packages !== null &&
    (before == null ? packages.after.length > 0 : !sameRefs(packages.before, packages.after)));
  const emptyFullResync = before == null && after.length === 0;
  const emptyStackResyncNotice =
    '## Stack guidance — no runtime stack layers remain\n\n' +
    '> This full resync contains no runtime stack layers. Any runtime layer text injected from an earlier stack state is no longer part of the current stack; treat it as VOID from this turn on.';
  if (emptyFullResync && !opts.guide) {
    return { text: emptyStackResyncNotice, rendered: true, requiresFreshContext: false };
  }
  if (before != null && sameRefs(before, after) && !packagesMoved) return { text: '', rendered: true, requiresFreshContext: false };
  try {
    const bp = opts.blueprint ?? (await import('@papercusp/orchestrator/blueprint'));
    const harnessDir = opts.harnessDir ?? (await import('@papercusp/harness/paths')).harnessRoot();
    const from = before == null ? bp.emptyStackBinding() : bp.stackBindingFromRefs(before);
    const to = bp.stackBindingFromRefs(after);
    // composeSuStackMutation is synchronous after its documents are resolved. Prime
    // arbitrary installed/local identity documents through the canonical source
    // catalog so the live channel is not limited to SU's built-in mode/posture set.
    const resolvedLayers = new Map<string, StackDocument>();
    const [{ getIdentitySource, getSelectedModeCatalog, readSelectedModeDocument }, path, fs] = await Promise.all([
      import('./agent-identities/source'),
      import('node:path'),
      import('node:fs/promises'),
    ]);
    // WI-10004896: a catalog mode is read from the source the catalog SELECTED, exactly as
    // the launch does. Re-resolving its id (installed tier first) refused a vm-release
    // host's unattested first-party copy, so a mid-session mode:set failed there too.
    const modeCatalog = to.layers.some((layer) => bp.slotSpec(layer.slot)?.layer === 'modes')
      ? await getSelectedModeCatalog() : null;
    await Promise.all(to.layers.map(async (layer) => {
      const spec = bp.slotSpec(layer.slot);
      if (!spec) return;
      const modeEntry = modeCatalog?.entries.find((entry) =>
        entry.sourceId === layer.id && entry.slot === layer.slot);
      if (modeEntry) {
        const document = await readSelectedModeDocument(modeEntry);
        resolvedLayers.set(`${layer.slot}:${layer.id}`, {
          id: layer.id, layer: spec.layer, slot: layer.slot, ...document,
        });
        return;
      }
      const identity = await getIdentitySource(layer.id, { ...(opts.repoDir ? { repoDir: opts.repoDir } : {}) });
      if (!identity.ok || !identity.sourcePath ||
          !identity.identity.slots.some((entry) => entry.slot === layer.slot)) {
        if (spec.layer === 'modes') throw new Error(`selected mode identity ${layer.slot}:${layer.id} is unavailable or invalid`);
        return;
      }
      const sourcePath = path.join(path.dirname(identity.sourcePath), 'prompts', `${layer.slot}.md`);
      try {
        resolvedLayers.set(`${layer.slot}:${layer.id}`, {
          id: layer.id,
          layer: spec.layer,
          slot: layer.slot,
          text: await fs.readFile(sourcePath, 'utf8'),
          sourcePath,
        });
      } catch (error) {
        if (spec.layer === 'modes') throw error;
        /* built-in documents still resolve inside composeSuStackMutation */
      }
    }));
    const parts: string[] = [];
    if (emptyFullResync) parts.push(emptyStackResyncNotice);
    let preparedActivation: StackMutationActivation | undefined;
    let requiresFreshContext = false;
    let cursor = from;
    for (const m of bp.diffStackBindings(from, to)) {
      const applied = bp.composeSuStackMutation({
        harnessDir,
        binding: cursor,
        op: m.op,
        layer: { slot: m.slot, id: m.id },
        resolveLayer: (layer) => resolvedLayers.get(`${layer.slot}:${layer.id}`) ?? null,
        activation: opts.activation,
      });
      if (applied.injection) parts.push(applied.injection);
      if (applied.activation) preparedActivation = applied.activation;
      if (applied.mutation.changed && applied.mutation.delivery === 'relaunch-with-carry') {
        requiresFreshContext = true;
      }
      cursor = applied.runtimeBinding;
    }
    if (opts.guide) {
      // The addressed-guide half of the SAME transition — the wearer mapping and the read
      // are the launch's own (addressed-project-guide.ts). A read failure is surfaced IN the
      // delivered text, never swallowed: a silently-missed attach is the bug this closes.
      const { composeAddressedGuideTransition, suGuideWearer } = await import('./doc-projection/addressed-project-guide');
      try {
        if (packageError !== null) throw new Error(`package doc keys unavailable: ${packageError}`);
        const guide = await composeAddressedGuideTransition({
          ...opts.guide,
          // A full-resync (no stackBefore) re-delivers the COMPLETE addressed set, replacing
          // what came before — the anchor's replace-full rule, same as the layer half above.
          before: before == null ? null : { ...suGuideWearer(bp, from.layers), packageResources: packages?.before ?? [] },
          after: { ...suGuideWearer(bp, to.layers), packageResources: packages?.after ?? [] },
        });
        if (guide.text) parts.push(guide.text.replace(/\n+$/, ''));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(`[stack-binding-channel] addressed guide not read for stack transition: ${msg}`);
        parts.push(
          '## Addressed guidance — could not be read\n\n' +
            `> Your stack changed, but the Project-guide sections addressed to it could not be read (${msg}). ` +
            'A launch with this stack may carry guidance you have not received.',
        );
      }
    }
    return {
      text: parts.join('\n\n'),
      rendered: true,
      requiresFreshContext,
      ...(preparedActivation ? { activation: preparedActivation } : {}),
    };
  } catch (e) {
    warn(`[stack-binding-channel] stack transition not delivered (${JSON.stringify(before ?? null)} → ${JSON.stringify(after)}): ${e instanceof Error ? e.message : String(e)}`);
    return { text: '', rendered: false, requiresFreshContext: false };
  }
}

/**
 * Compatibility wrapper for callers that only need the fail-soft text.
 * Turn-start delivery uses renderStackTransitionContextResult so it can defer
 * the CTRL acknowledgement when this renderer fails.
 */
export async function renderStackTransitionContext(
  delivery: Partial<Pick<ControlTransition, 'state' | 'stackBefore'>> | null | undefined,
  opts: StackTransitionContextOptions = {},
): Promise<string> {
  return (await renderStackTransitionContextResult(delivery, opts)).text;
}
