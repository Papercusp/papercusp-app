/**
 * The STACK-MUTATION PRIMITIVE — attach / detach a slot layer on a LIVE session
 * (`identities-v1-2026-08-30` P-012; rulings D-003 "switching and stacking are ONE
 * runtime mechanism — stack mutation", D-007 slots + cardinality, D-021 §1 the seal,
 * and P-012's own D-022).
 *
 * WHAT A BINDING IS. A `StackBinding` is the set of identity layers a session runs
 * BEYOND the kernel: one `BoundLayer { slot, id }` per filled slot (an additive slot
 * may carry several). It is DERIVED state, not a new table — for the interactive su
 * the fleet posture comes from presence (`fleet_role`) and the mode axes from
 * `agent_modes`, projected into the control anchor (`stack: ['fleet-posture:su.fleet-leader']`)
 * by the operator; this module is the pure algebra over that shape.
 *
 * WHAT A MUTATION IS. `attachLayer` / `detachLayer` produce a `StackMutation`: the
 * binding before and after, whether anything changed, what an exclusive attach
 * DISPLACED (`replaced` — D-007's "exactly one document per exclusive slot" holds
 * AFTER the mutation, so an attach on a filled exclusive slot is a SWAP, never a
 * hard-error: the hard-error is for a STACK that declares two claims at once), and
 * the DELIVERY the slot's layer dictates:
 *
 *   inject-now          — additive / mode-axis / fleet-posture layers (P-012 (a) + (c)):
 *                         the layer's rendered text reaches the running agent through
 *                         the existing mode-flip channel (the control anchor's
 *                         `⟦CTRL:transition⟧`, consumed at turn start) AND the layer
 *                         renders in its position on the next full render.
 *   relaunch-with-carry — an exclusive `domain` (P-012 (b)) or `client` swap: the
 *                         whole context is shaped by that layer, so the new stack is
 *                         delivered by a carry-respawn on the new stack, never by an
 *                         in-place rewrite. Nothing is injected.
 *
 * KERNEL-SAFE HANDOFF. `applyStackMutation` composes the NEXT FULL RENDER first
 * (`composeStack` — the seal, the identity-lint, the D-009 "no override path": a
 * BLOCK finding THROWS) and only then renders the inject-now payload, so a layer that
 * cannot be rendered under the seal can never be injected past it. The payload opens
 * with the `⟦stack⟧` stamp (a platform control literal — `identity-lint.ts` refuses an
 * identity that carries it) and a precedence preface that says, in the seal's own
 * terms, that the injected section sits ABOVE the seal and grants no authority.
 */
import { SLOT_IDS, SLOT_SPECS, compareSlotOrder, isSlotId, type SlotCardinality, type SlotId } from './slots.js';
import { composeStack, type ComposeStackOptions, type ComposedStack, type StackDocument } from './render-stack.js';

export interface BoundLayer {
  slot: SlotId;
  /** The document filling the slot — an identity / blueprint id (e.g. `su.fleet-leader`). */
  id: string;
}

export interface StackBinding {
  /** Canonical order: `compareSlotOrder`, ties by attach order. */
  layers: BoundLayer[];
}

export type MutationDelivery = 'inject-now' | 'relaunch-with-carry';
export type StackMutationOp = 'attach' | 'detach';

/** Explicit delivery boundary for an acknowledged activation (D-030/P-040). */
export interface StackActivationContext {
  delivery: 'soft' | 'fresh-context';
  carry: 'warm' | 'cold';
  privateMemory: 'preserve' | 'reset';
}

export interface StackActivationRevision {
  specificationRevision: string;
  stateRevision: string;
}

export interface StackMutationActivation {
  desired: StackActivationRevision;
  prepared: StackActivationRevision | null;
  applied: StackActivationRevision | null;
  status: 'desired' | 'prepared' | 'applied' | 'failed';
  /** Stable retry key; replays are safe and must not apply stale revisions. */
  idempotencyKey: string;
  context: StackActivationContext;
  failure?: string;
}

export function activationContextForDelivery(
  delivery: MutationDelivery,
  overrides: Partial<StackActivationContext> = {},
): StackActivationContext {
  return {
    delivery: delivery === 'relaunch-with-carry' ? 'fresh-context' : 'soft',
    carry: 'warm',
    privateMemory: 'preserve',
    ...overrides,
  };
}

function sameActivationRevision(a: StackActivationRevision | null | undefined, b: StackActivationRevision): boolean {
  return Boolean(a && a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision);
}

function assertActivationRevision(revision: StackActivationRevision): StackActivationRevision {
  if (!/^[0-9a-f]{64}$/.test(String(revision?.specificationRevision ?? ''))) {
    throw new Error('stack activation requires a lowercase sha256 specificationRevision');
  }
  if (!String(revision?.stateRevision ?? '').trim()) throw new Error('stack activation requires a non-empty stateRevision');
  return { specificationRevision: revision.specificationRevision, stateRevision: String(revision.stateRevision) };
}

/** Mark a successfully rendered mutation as prepared; host acknowledgement is separate. */
export function prepareStackMutationActivation(
  input: Omit<StackMutationActivation, 'prepared' | 'status'> & { prepared?: StackActivationRevision | null; status?: StackMutationActivation['status'] },
): StackMutationActivation {
  const desired = assertActivationRevision(input.desired);
  if (input.prepared && !sameActivationRevision(input.prepared, desired)) throw new Error('stale stack activation cannot be prepared');
  return {
    ...input,
    desired,
    prepared: desired,
    status: 'prepared',
    applied: input.applied ? assertActivationRevision(input.applied) : null,
  };
}

/** Acknowledge only the prepared revision. Repeated acknowledgement is idempotent. */
export function acknowledgeStackMutationActivation(
  current: StackMutationActivation,
  revision: StackActivationRevision,
): StackMutationActivation {
  const applied = assertActivationRevision(revision);
  if (sameActivationRevision(current.applied, applied)) return current;
  if (!sameActivationRevision(current.desired, applied) || !sameActivationRevision(current.prepared, applied)) {
    throw new Error('stack activation acknowledgement does not match the prepared revision');
  }
  return { ...current, prepared: null, applied, status: 'applied', failure: undefined };
}

/** Record a failed render/delivery while preserving the prior applied revision. */
export function failStackMutationActivation(
  current: StackMutationActivation,
  revision: StackActivationRevision,
  failure: string,
): StackMutationActivation {
  const failed = assertActivationRevision(revision);
  if (sameActivationRevision(current.applied, failed)) return current;
  if (!sameActivationRevision(current.desired, failed)) throw new Error('stale stack activation failure');
  if (!failure.trim()) throw new Error('stack activation failure requires a reason');
  return { ...current, prepared: null, status: 'failed', failure: failure.trim() };
}

export interface MutationDeliverySpec {
  delivery: MutationDelivery;
  /** Why this slot delivers the way it does — the P-012 clause it applies. */
  reason: string;
}

function deliveryForSlot(slot: SlotId): MutationDeliverySpec {
  const spec = SLOT_SPECS[slot];
  switch (spec.layer) {
    case 'client':
      return {
        delivery: 'relaunch-with-carry',
        reason: 'the client overlay names the CLI the session runs IN (Claude / Codex / OMP) — a different client is a different process, so the swap is a relaunch-with-carry (P-012 (b) by analogy with `domain`)',
      };
    case 'domain':
      return {
        delivery: 'relaunch-with-carry',
        reason: 'P-012 (b): the profession shapes the whole context; swapping the exclusive `domain` slot is a carry-respawn on the new stack, never an in-place rewrite',
      };
    case 'fleet-posture':
      return {
        delivery: 'inject-now',
        reason: 'P-012 (c): a posture swap (fleet:join → take-leadership) follows (a) with the exclusive-slot rule enforced — the attach REPLACES the previous posture and says so',
      };
    case 'modes':
      return {
        delivery: 'inject-now',
        reason: 'P-012 (a): a mode-axis layer rides the mode-flip channel that already delivers the registered mode contract; state + implications stay kernel (D-008)',
      };
    case 'practices':
      return {
        delivery: 'inject-now',
        reason: spec.cardinality === 'additive'
          ? 'P-012 (a): an additive practice stacks beside the others — injected now, rendered in place on the next full render'
          : 'P-012 (a): the collaboration stance is exclusive but context-neutral — a stance swap injects now and replaces the earlier stance',
      };
  }
}

/**
 * Keyed by `SlotId` so a slot added to `SLOT_IDS` without a delivery rule is a TYPE
 * error. Derived from the registry's LAYER, never restated per slot.
 */
export const SLOT_MUTATION_DELIVERY: Readonly<Record<SlotId, MutationDeliverySpec>> = Object.fromEntries(
  SLOT_IDS.map((slot) => [slot, deliveryForSlot(slot)]),
) as Record<SlotId, MutationDeliverySpec>;

export function mutationDelivery(slot: SlotId): MutationDelivery {
  return SLOT_MUTATION_DELIVERY[slot].delivery;
}

export interface StackMutation {
  op: StackMutationOp;
  slot: SlotId;
  id: string;
  cardinality: SlotCardinality;
  delivery: MutationDelivery;
  /** false = the binding already was (attach) / never had (detach) this layer. */
  changed: boolean;
  /** An exclusive attach on a filled slot displaces the holder — the swap D-007 permits. Attach only. */
  replaced: BoundLayer | null;
  before: StackBinding;
  after: StackBinding;
  reason: string;
  /** Present when a caller supplied a revisioned activation envelope. */
  activation?: StackMutationActivation;
}

function assertSlot(slot: string): asserts slot is SlotId {
  if (!isSlotId(slot)) throw new Error(`stack-mutation: unknown slot "${slot}" (registry: ${SLOT_IDS.join(', ')})`);
}

function sameLayer(a: BoundLayer, b: BoundLayer): boolean {
  return a.slot === b.slot && a.id === b.id;
}

export function emptyStackBinding(): StackBinding {
  return { layers: [] };
}

/**
 * Canonical form: known slots only, no duplicate (slot, id), no exclusive slot with
 * two DISTINCT documents (that is a composition hard-error, D-007 — a binding is a
 * stack, and a stack never carries the conflict), ordered by `compareSlotOrder` with
 * input order breaking ties (stable sort).
 */
export function normalizeStackBinding(binding: StackBinding | readonly BoundLayer[]): StackBinding {
  const input = Array.isArray(binding) ? binding : (binding as StackBinding).layers;
  const layers: BoundLayer[] = [];
  const exclusiveHolder = new Map<SlotId, string>();
  for (const raw of input) {
    const slot = String(raw.slot);
    assertSlot(slot);
    const id = String(raw.id ?? '').trim();
    if (!id) throw new Error(`stack-mutation: a bound layer on "${slot}" has no document id`);
    const layer = { slot, id };
    if (layers.some((l) => sameLayer(l, layer))) continue;
    if (SLOT_SPECS[slot].cardinality === 'exclusive') {
      const held = exclusiveHolder.get(slot);
      if (held != null && held !== id) {
        throw new Error(`stack-mutation: exclusive slot "${slot}" is bound to two documents ("${held}", "${id}") — a binding is a stack and may not carry a slot conflict`);
      }
      exclusiveHolder.set(slot, id);
    }
    layers.push(layer);
  }
  const indexed = layers.map((layer, i) => ({ layer, i }));
  indexed.sort((a, b) => compareSlotOrder(a.layer.slot, b.layer.slot) || a.i - b.i);
  return { layers: indexed.map(({ layer }) => layer) };
}

function mutation(
  op: StackMutationOp,
  before: StackBinding,
  after: StackBinding,
  layer: BoundLayer,
  changed: boolean,
  replaced: BoundLayer | null,
  reason: string,
): StackMutation {
  const spec = SLOT_MUTATION_DELIVERY[layer.slot];
  return {
    op,
    slot: layer.slot,
    id: layer.id,
    cardinality: SLOT_SPECS[layer.slot].cardinality,
    delivery: spec.delivery,
    changed,
    replaced,
    before,
    after,
    reason: changed ? `${reason} — ${spec.reason}` : reason,
  };
}

/**
 * Attach a layer. Exclusive slot: a DIFFERENT holder is REPLACED (`replaced` names
 * it), the same holder is a no-op. Additive slot: appended once (a repeat is a
 * no-op). Pure — returns the new binding, never mutates the input.
 */
export function attachLayer(binding: StackBinding, layer: BoundLayer): StackMutation {
  const before = normalizeStackBinding(binding);
  const slot = String(layer.slot);
  assertSlot(slot);
  const id = String(layer.id ?? '').trim();
  if (!id) throw new Error(`stack-mutation: attach on "${slot}" names no document id`);
  const target = { slot, id };
  if (before.layers.some((l) => sameLayer(l, target))) {
    return mutation('attach', before, before, target, false, null, `"${id}" already fills "${slot}"`);
  }
  if (SLOT_SPECS[slot].cardinality === 'exclusive') {
    const holder = before.layers.find((l) => l.slot === slot) ?? null;
    const after = normalizeStackBinding([...before.layers.filter((l) => l.slot !== slot), target]);
    return mutation(
      'attach',
      before,
      after,
      target,
      true,
      holder,
      holder ? `"${id}" replaces "${holder.id}" on the exclusive "${slot}" slot` : `"${id}" fills the empty exclusive "${slot}" slot`,
    );
  }
  const after = normalizeStackBinding([...before.layers, target]);
  return mutation('attach', before, after, target, true, null, `"${id}" stacks on the additive "${slot}" slot`);
}

/**
 * Detach a layer. Exclusive slot: `id` is optional (the slot has at most one holder);
 * when given it must match, else the detach is a no-op. Additive slot: `id` is
 * REQUIRED — "detach the practices" is not a mutation, one document is.
 */
export function detachLayer(binding: StackBinding, target: { slot: SlotId; id?: string | null }): StackMutation {
  const before = normalizeStackBinding(binding);
  const slot = String(target.slot);
  assertSlot(slot);
  const wanted = String(target.id ?? '').trim() || null;
  if (!wanted && SLOT_SPECS[slot].cardinality === 'additive') {
    throw new Error(`stack-mutation: detach on the additive "${slot}" slot must name the document id`);
  }
  const holder = before.layers.find((l) => l.slot === slot && (wanted == null || l.id === wanted)) ?? null;
  if (!holder) {
    const shown = wanted ?? '(any)';
    return mutation('detach', before, before, { slot, id: shown }, false, null, `"${shown}" is not bound on "${slot}"`);
  }
  const after = normalizeStackBinding(before.layers.filter((l) => !sameLayer(l, holder)));
  return mutation('detach', before, after, holder, true, null, `"${holder.id}" leaves "${slot}"`);
}

// ── the compact wire form (`slot:id`) — what the control anchor carries ───────

export function bindingRef(layer: BoundLayer): string {
  return `${layer.slot}:${layer.id}`;
}

export function bindingRefs(binding: StackBinding): string[] {
  return normalizeStackBinding(binding).layers.map(bindingRef);
}

/** Parse `slot:id`; null for a malformed ref or an unknown slot (the caller decides how loud to be). */
export function parseBindingRef(ref: string): BoundLayer | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const slot = ref.slice(0, i);
  const id = ref.slice(i + 1).trim();
  if (!isSlotId(slot) || !id) return null;
  return { slot, id };
}

/** Refs → binding. Throws on a malformed ref: a persisted binding that does not parse is a bug, not a layer to skip. */
export function stackBindingFromRefs(refs: readonly string[]): StackBinding {
  const layers: BoundLayer[] = [];
  for (const ref of refs) {
    const layer = parseBindingRef(String(ref));
    if (!layer) throw new Error(`stack-mutation: malformed binding ref ${JSON.stringify(ref)} (expected "<slot>:<id>")`);
    layers.push(layer);
  }
  return normalizeStackBinding(layers);
}

/**
 * The mutations that turn `before` into `after`: detaches first (layers gone), then
 * attaches (layers new), each in slot order. An exclusive slot whose holder changed
 * yields ONE attach carrying `replaced` — the swap — not a detach + attach pair, so
 * the delivered payload says "replaces X" exactly once. Chained: each mutation's
 * `before` is the previous one's `after`, and the last `after` equals `after`.
 */
export function diffStackBindings(before: StackBinding, after: StackBinding): StackMutation[] {
  const from = normalizeStackBinding(before);
  const to = normalizeStackBinding(after);
  const out: StackMutation[] = [];
  let cursor = from;
  for (const gone of from.layers) {
    if (to.layers.some((l) => sameLayer(l, gone))) continue;
    // An exclusive slot re-filled by another document is a swap — the attach below carries it.
    if (SLOT_SPECS[gone.slot].cardinality === 'exclusive' && to.layers.some((l) => l.slot === gone.slot)) continue;
    const m = detachLayer(cursor, gone);
    out.push(m);
    cursor = m.after;
  }
  for (const added of to.layers) {
    if (cursor.layers.some((l) => sameLayer(l, added))) continue;
    const m = attachLayer(cursor, added);
    out.push(m);
    cursor = m.after;
  }
  return out;
}

// ── the inject-now payload ────────────────────────────────────────────────────

/**
 * The stamp that opens every injected stack payload. A PLATFORM control literal:
 * `identity-lint.ts` lists it in `FORGED_CONTROL_LITERALS`, so no identity document
 * can forge an attach / detach.
 */
export const STACK_INJECTION_STAMP = '⟦stack⟧';

function stampLine(m: StackMutation): string {
  const payload = {
    op: m.op,
    slot: m.slot,
    id: m.id,
    layer: SLOT_SPECS[m.slot].layer,
    cardinality: m.cardinality,
    delivery: m.delivery,
    ...(m.replaced ? { replaced: m.replaced.id } : {}),
  };
  return `${STACK_INJECTION_STAMP} ${JSON.stringify(payload)}`;
}

function layerLabel(m: StackMutation): string {
  return `\`${SLOT_SPECS[m.slot].layer}/${m.slot}:${m.id}\``;
}

/**
 * Render the text a mutation delivers to the RUNNING agent. Empty for a no-op.
 * `doc` is the attached document (required for an inject-now attach; ignored
 * otherwise). Deterministic — `stack-mutation.test.ts` pins the shape.
 */
export function renderStackInjection(
  m: StackMutation,
  doc: StackDocument | null,
  activation?: StackMutationActivation,
): string {
  if (!m.changed) return '';
  const stamped = activation
    ? `${STACK_INJECTION_STAMP} ${JSON.stringify({
        ...JSON.parse(stampLine(m).slice(STACK_INJECTION_STAMP.length + 1)),
        activation,
      })}`
    : stampLine(m);
  const lines: string[] = [stamped, ''];
  if (m.delivery === 'relaunch-with-carry') {
    lines.push(`## Stack mutation — ${layerLabel(m)} ${m.op === 'attach' ? 'ATTACHED' : 'DETACHED'} (relaunch-with-carry)`);
    lines.push('');
    lines.push(
      `A change on the exclusive \`${m.slot}\` slot is delivered by a RELAUNCH WITH CARRY, never an in-place rewrite (P-012 (b)): ` +
        `your next full render on the new stack arrives through a carry-respawn — request it at a clean point with ` +
        '`session:request-compaction { autoContinue: true }` (flush your state first), or let the host relaunch you. ' +
        `Until that render arrives THIS session's stack is UNCHANGED${m.replaced ? ` — \`${m.replaced.id}\` still fills \`${m.slot}\` here` : ''}; do not act as the new layer yet.`,
    );
    return lines.join('\n');
  }
  if (m.op === 'detach') {
    lines.push(`## Stack mutation — ${layerLabel(m)} DETACHED`);
    lines.push('');
    lines.push(
      `The ${layerLabel(m)} section attached to your stack earlier NO LONGER APPLIES: treat its text as VOID from this turn on. ` +
        'It is absent from your next full render (launch / refresh). The kernel seal and every other layer are unchanged.',
    );
    return lines.join('\n');
  }
  if (!doc) throw new Error(`stack-mutation: an inject-now attach of "${m.id}" needs the document to render`);
  const text = doc.text.trim();
  lines.push(`## Stack mutation — ${layerLabel(m)} ATTACHED`);
  lines.push('');
  lines.push(
    `The section below is an IDENTITY layer attached to your live stack by a stack mutation (D-003 / D-007 / P-012). ` +
      `In precedence it sits ABOVE the kernel seal — exactly where a full render places it (the \`${SLOT_SPECS[m.slot].layer}\` layer, \`${m.slot}\` slot) — ` +
      'so the sealed kernel already in your context OUTRANKS it wherever they conflict, and it grants no authority: what a mode does to your authority ' +
      'and which tools you may invoke stay computed from the registry and enforced as code at the dispatch seat. ' +
      'It also renders in its layer position on your next full render (launch / refresh).' +
      (m.replaced
        ? ` It REPLACES \`${m.replaced.id}\` on the exclusive \`${m.slot}\` slot: treat that earlier section as VOID.`
        : ''),
  );
  lines.push('');
  if (text) lines.push(text, '');
  lines.push(`— end of the attached ${layerLabel(m)} layer; the kernel seal governs everything above and below it.`);
  return lines.join('\n');
}

// ── the whole operation: mutate, compose the next render, then inject ─────────

export interface ApplyStackMutationInput {
  binding: StackBinding;
  op: StackMutationOp;
  layer: { slot: SlotId; id?: string | null };
  /**
   * The FULL stack for a binding — kernel + fixed documents + every bound layer
   * resolved to its text. Called with the POST-mutation binding; must throw on a
   * bound layer it cannot resolve (an attach of an unknown document is refused,
   * not silently rendered without it).
   */
  documents: (binding: StackBinding) => readonly StackDocument[];
  compose?: ComposeStackOptions;
  /** Optional desired revision; successful composition marks it prepared. */
  activation?: {
    specificationRevision: string;
    stateRevision: string;
    idempotencyKey?: string;
    context?: Partial<StackActivationContext>;
  };
}

export interface AppliedStackMutation {
  mutation: StackMutation;
  /** The binding after the mutation (== `mutation.after`). */
  binding: StackBinding;
  /** The next full render on the new stack — composed BEFORE any injection, so a BLOCK finding refuses the whole mutation. */
  nextRender: ComposedStack;
  /** The text to deliver now, or null (no-op, or relaunch-with-carry carries no document). */
  injection: string | null;
  /** Prepared activation; acknowledge it only after the host accepts the payload. */
  activation?: StackMutationActivation;
}

export function applyStackMutation(input: ApplyStackMutationInput): AppliedStackMutation {
  const id = String(input.layer.id ?? '').trim();
  const m = input.op === 'attach'
    ? attachLayer(input.binding, { slot: input.layer.slot, id })
    : detachLayer(input.binding, { slot: input.layer.slot, id: id || null });
  const docs = input.documents(m.after);
  if (m.changed && m.op === 'attach') {
    const bound = docs.find((d) => d.id === m.id && d.slot === m.slot);
    if (!bound) throw new Error(`stack-mutation: the stack for the new binding does not carry "${m.slot}:${m.id}" — the attach cannot be rendered`);
  }
  // Kernel-safe: the seal + identity-lint over the WHOLE next render, before one byte is injected.
  const nextRender = composeStack(docs, input.compose);
  const doc = m.op === 'attach' ? (docs.find((d) => d.id === m.id && d.slot === m.slot) ?? null) : null;
  const activation = m.changed && input.activation
    ? prepareStackMutationActivation({
        desired: {
          specificationRevision: input.activation.specificationRevision,
          stateRevision: input.activation.stateRevision,
        },
        prepared: null,
        applied: null,
        status: 'desired',
        idempotencyKey: input.activation.idempotencyKey ?? `stack-activation:${input.activation.specificationRevision}:${input.activation.stateRevision}`,
        context: activationContextForDelivery(SLOT_MUTATION_DELIVERY[m.slot].delivery, input.activation.context),
      })
    : undefined;
  const injection = m.changed ? renderStackInjection(m, doc, activation) : '';
  return { mutation: activation ? { ...m, activation } : m, binding: m.after, nextRender, injection: injection || null, ...(activation ? { activation } : {}) };
}

// ── the pinned doc rendering (COMPOSITION_MODEL.md §11) ──────────────────────

/**
 * The delivery table, embedded verbatim in `docs/COMPOSITION_MODEL.md` between
 * `<!-- STACK-MUTATION:BEGIN/END -->` and asserted equal by `stack-mutation.test.ts`
 * (derived-truth ladder, rung 2: PIN) — the prose can never describe a delivery
 * rule other than the one this module applies.
 */
export function renderStackMutationMarkdown(): string {
  const lines: string[] = [];
  lines.push('| slot | cardinality | layer | attach / detach delivers by | why |');
  lines.push('|---|---|---|---|---|');
  for (const slot of SLOT_IDS) {
    const spec = SLOT_SPECS[slot];
    const d = SLOT_MUTATION_DELIVERY[slot];
    lines.push(`| \`${slot}\` | ${spec.cardinality} | ${spec.layer} | **${d.delivery}** | ${d.reason} |`);
  }
  lines.push('');
  lines.push(
    `Exclusive attach on a filled slot = a SWAP (the mutation carries \`replaced\`); a repeat attach or a detach of an unbound layer is a no-op that delivers nothing. ` +
      `Every inject-now payload opens with the \`${STACK_INJECTION_STAMP}\` stamp (a forged-control literal) and is rendered only AFTER the next full render composed clean under the seal.`,
  );
  return lines.join('\n');
}
