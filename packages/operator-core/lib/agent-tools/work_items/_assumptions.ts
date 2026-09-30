/**
 * _assumptions.ts — the commitment-class assumption declaration
 * (unified-agent-state-plane-2026-07-27 P-017 (b) gate #2, per D-016 / D-050).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * D-016 requires every agent-facing behaviour to name an enforcement TIER, and
 * says the prompt is never one. "Declare an assumption" was one of the three
 * behaviours it recorded as UNCOVERED, with the tier available to it being
 * "GATE at commitment calls + DETECTOR".
 *
 * D-050 defines the commitment class, and the line is NOT "important calls". It
 * is calls that REMOVE OTHERS' ABILITY TO CHECK YOU:
 *
 *   • a terminal work-item close removes the item from the shared queue — nobody
 *     re-derives it, nobody re-reads it, and if the close rested on a wrong
 *     assumption, the assumption leaves with the item. IN CLASS.
 *   • a plan Decision stays addressable forever and is MEANT to be re-read and
 *     challenged. OUT.
 *   • coord:escalate goes to a human, who is the check. OUT.
 *   • coord:send is gate #1's surface (`expects`). OUT — double-gating one call
 *     is how a field becomes noise.
 *
 * ── WHY A LITERAL 'none' AND NOT null / an optional field ───────────────────
 *
 * D-016: "A default is how a field dies — everyone takes it, and the field then
 * carries no information. Forcing an explicit choice, even when the choice is
 * `none`, is what makes the field real."
 *
 * So this is REQUIRED with no default. `'none'` is a literal string rather than
 * JSON `null` on purpose: `null` and *absent* are one fumble apart in a
 * hand-built payload, and this gate exists precisely to make the choice
 * conscious. A caller who means "nothing" must type it.
 *
 * ── THE HOLE ABOVE IS NOW CLOSED (P-008 (d) / D-079) ────────────────────────
 *
 * This header used to end: "keys are FORMAT-checked, not resolved against
 * `harness_shared.agent_facts` ... until P-008 lands this gate enforces that an
 * assumption was STATED, not that it exists — strictly more than the nothing that
 * preceded it. P-011's conflicting-assumption detector is what consumes the
 * content."
 *
 * ⚠ BOTH of those closing claims were FALSE AS BUILT, which is why P-008 (d)
 * turned out bigger than "add a lookup". The declaration was never PERSISTED:
 * required, format-checked by two refines, then referenced ZERO times downstream
 * — `set_state`'s handler never read it, and `complete` threaded it into its item
 * shape under a comment warning it must be threaded "or the declaration the gate
 * just forced would be collected and then dropped on the floor", where its only
 * consumer never mentioned it. So it WAS dropped on the floor, one call deeper
 * than that comment guards. A declaration that is validated and discarded is not
 * "strictly more than nothing" — it is exactly nothing, plus a required field on
 * every terminal close; and P-011 cannot consume content that was never written.
 *
 * Now: {@link resolveDeclaredAssumptions} resolves every entry and the caller
 * PERSISTS the result under `TERMINAL_ASSUMPTIONS_KEY`. Only total non-existence
 * dangles — `lapsed`, `superseded` and `retracted` all resolve and carry their
 * condition (D-079 R3; a SUSPECTED fact's default TTL is six hours, so refusing
 * on lapse would punish the exact behaviour this gate encourages).
 */

import { z } from 'zod';
import { InvalidInputError } from '@papercusp/tooldef';
import {
  assumptionSelectorsFor,
  danglingAssumptionsMessage,
  isDanglingCondition,
  resolveAssumptions,
} from '../../agent-facts/assumptions';
import { getWorkItem } from '../../work-items';
import type { StoredAssumptionDeclaration } from '../../coord-lifecycle/records';

/** The literal a caller passes to declare, explicitly, that this commitment rests
 *  on no recorded assumption. Exported so tests and callers cannot drift from it. */
export const NO_ASSUMPTIONS = 'none' as const;

/** Max keys accepted on one commitment. A close resting on more than a handful of
 *  assumptions is a signal the work was not actually scoped, not a shape to support. */
export const MAX_ASSUMPTION_KEYS = 10;

export type AssumptionDeclaration = string[] | typeof NO_ASSUMPTIONS;

/**
 * REQUIRED on every commitment-class call. Deliberately NOT `.optional()` and
 * deliberately without a default — see the header.
 */
/**
 * The SHAPE, spelled literally. EI-18812234312014879: the two refusals below used to
 * describe the VALUE ('the key(s) ... or the literal "none"') without the CONTAINER,
 * so a caller with exactly one key reasonably passed a bare string — and the union
 * then rejected it with nothing but zod's default `Invalid input`, which names no
 * expected type and no example. That is the worst possible ordering: an informative
 * refusal followed by an uninformative one, for the same argument. Both messages now
 * carry this, so whichever one a caller hits shows the array brackets.
 */
export const ASSUMPTIONS_SHAPE_HINT =
  'Shape: an ARRAY of facts:assert keys — assumptions: ["my-fact-key"] (note the brackets, even for a ' +
  'single key) — or the bare literal assumptions: "none".';

/**
 * Recovery guidance shared by both terminal writers. A transport timeout can
 * happen after `work_items:complete` has committed its record, so callers must
 * read the item before retrying. If they intentionally fall back to
 * `work_items:set_state`, the terminal-only assumptions declaration must travel
 * with the completion evidence instead of being dropped from the second call.
 */
export const TERMINAL_CLOSE_RECOVERY_HINT =
  'If work_items:complete times out, first re-read work_items:get; if the item is still open, retry the exact same completion payload (including assumptions). If you use work_items:set_state as the fallback, carry the same assumptions declaration and pass completionRef too. ' +
  ASSUMPTIONS_SHAPE_HINT;

export const assumptionsArg = z
  .union(
    [
      z.array(z.string().min(1).max(120)).min(1).max(MAX_ASSUMPTION_KEYS),
      z.literal(NO_ASSUMPTIONS),
    ],
    // Without this, ANY malformed value (a bare key string being by far the most
    // likely) surfaces as zod's bare "Invalid input".
    //
    // ⚠ `error`, NOT zod 3's `errorMap`: this repo is on zod 4, which IGNORES an
    // unknown params key rather than rejecting it — so the v3 spelling type-checks,
    // runs, and silently does nothing. The test below is what caught that.
    { error: () => `assumptions is malformed. ${ASSUMPTIONS_SHAPE_HINT}` },
  )
  .describe(
    "REQUIRED — the `facts:assert` KEYS this close rests on (e.g. [\"gate-red-is-flake-not-regression\"]), " +
      'or the literal "none" if it rests on no recorded assumption. There is deliberately NO default: a ' +
      'terminal close removes the item from the queue, so a wrong assumption leaves with it and nobody ' +
      'can catch it afterwards. Saying "none" is a valid answer; omitting the field is not.',
  );

/** The refusal message for the shorthand/inline axis, where a union cannot carry
 *  the requirement structurally. Shared so both tools refuse identically. */
export const ASSUMPTIONS_REQUIRED_MESSAGE =
  'a terminal close requires `assumptions` — the facts:assert key(s) this close rests on, or the ' +
  'literal "none". This is required-with-explicit-none by design (D-016/D-050): a terminal close ' +
  'removes the item from the shared queue, so an assumption that was wrong leaves with it. If the ' +
  `close rests on nothing you recorded, pass "none" explicitly. ${ASSUMPTIONS_SHAPE_HINT}`;

/** True when a value is a well-formed declaration. Used by the shorthand checks,
 *  which run BEFORE the object schema validates the field itself. */
export function hasAssumptionDeclaration(v: unknown): boolean {
  if (v === NO_ASSUMPTIONS) return true;
  return Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k.trim().length > 0);
}

/**
 * Normalize the server-stamped shape returned under `payload._assumptions` back
 * to the caller-facing declaration accepted by terminal writers.
 *
 * A read→retry naturally hands `work_items:complete` / `work_items:set_state`
 * the stored `{ declared, resolvedAt }` object. `resolvedAt` is server metadata
 * and resolved entries carry the original key under their own `declared` field;
 * neither belongs in the input union. Only the unmistakable persisted shape is
 * rescued. Other objects remain untouched so malformed caller input still gets
 * the normal schema refusal.
 */
export function normalizePersistedAssumptionDeclaration(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (typeof record.resolvedAt !== 'string' || !record.resolvedAt.trim() || !('declared' in record)) {
    return raw;
  }

  const declared = record.declared;
  if (declared === NO_ASSUMPTIONS) return NO_ASSUMPTIONS;
  if (!Array.isArray(declared) || declared.length === 0) return raw;
  if (declared.every((entry) => typeof entry === 'string')) return declared;

  const keys = declared.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const original = (entry as Record<string, unknown>).declared;
    return typeof original === 'string' && original.trim().length > 0 ? original : undefined;
  });
  return keys.every((key): key is string => typeof key === 'string') ? keys : raw;
}

/** The refusal for a declaration that names the sentinel ALONGSIDE real keys. */
export const ASSUMPTIONS_CONTRADICTION_MESSAGE =
  `assumptions names both the literal "${NO_ASSUMPTIONS}" and real fact key(s). Those are contradictory ` +
  'claims: "none" asserts this close rests on NOTHING you recorded, while a key asserts it rests on that ' +
  'fact. Pass EITHER the keys alone, OR the bare literal assumptions: "none".';

/**
 * EI-19339908198998425 — normalize `["none"]` (the sentinel in a CONTAINER) to the
 * bare sentinel.
 *
 * ── WHY ACCEPT IT RATHER THAN REFUSE ────────────────────────────────────────
 *
 * This is the exact mirror of EI-18812234312014879, which sits in the header of
 * `assumptionsArg` above: there, a caller with one key passed a bare string where
 * an ARRAY was wanted. Here a caller passes an ARRAY where the bare LITERAL was
 * wanted. That one was fixed with a better message rather than by accepting the
 * shape, and the asymmetry is deliberate, not an inconsistency:
 *
 *   • a bare `"my-key"` is genuinely AMBIGUOUS — it is a plausible real key, so
 *     silently reinterpreting it would be guessing at intent.
 *   • `["none"]` is NOT ambiguous. `'none'` is a reserved literal of THIS schema,
 *     so an array whose only entry is that literal has exactly one possible
 *     meaning, and a fact genuinely keyed "none" is not a thing that should exist.
 *
 * D-016's rationale is that the field must carry a CONSCIOUS choice — "a default
 * is how a field dies". A caller who types `["none"]` has made that choice; they
 * have fumbled the container, not abstained. Refusing them enforces punctuation,
 * not intent.
 *
 * ⚠ THE FAILURE THIS REMOVES IS WORSE THAN A WASTED ROUND-TRIP. The old refusal
 * came from {@link danglingAssumptionsMessage}, whose remediation reads "...or
 * pass \"none\" if this close rests on nothing you recorded" — which is a
 * description of what the caller just passed. Its two most likely readings are
 * "re-send the identical call", or "assert a fact keyed `none` to satisfy the
 * resolver". The second is the laundering that D-050/D-079 gate exists to prevent:
 * the guard's own error text was steering callers into polluting the ledger to get
 * past it. (Observed live 2026-08-02 closing EI-19332542096444388: the completion
 * was recorded while the state write was refused, leaving the item done-in-content
 * but still `open` and claimable — the window where the auto-loop re-places work
 * on finished items.)
 *
 * The sentinel MIXED with real keys stays a hard refusal — that one is a genuine
 * contradiction about what the close rests on, not a container fumble.
 */
export function normalizeAssumptionDeclaration(declared: AssumptionDeclaration): AssumptionDeclaration {
  if (!Array.isArray(declared)) return declared;
  const sentinels = declared.filter((k) => typeof k === 'string' && k.trim() === NO_ASSUMPTIONS);
  if (sentinels.length === 0) return declared;
  if (sentinels.length === declared.length) return NO_ASSUMPTIONS;
  throw new InvalidInputError(ASSUMPTIONS_CONTRADICTION_MESSAGE);
}

/**
 * P-008 (d) / D-079 — RESOLVE a declaration against the facts ledger and return
 * what to persist. Throws {@link InvalidInputError} when any entry dangles.
 *
 * ⚠ THE SINGLE ENTRY POINT FOR BOTH COMMITMENT TOOLS. D-050: "a half-verification
 * that resolves on one tool and not the other is worse than none." `set_state`'s
 * terminal branch and `complete`'s per-item path both call exactly this, so the
 * resolution rules, the refusal text, and the stored shape cannot diverge.
 *
 * Resolution is an async DB read, so it CANNOT live in the zod refine that
 * enforces the field's presence — a zod `.refine` is synchronous. Presence is
 * structural (schema); resolvability is semantic (here, at handler time).
 *
 * NOTE the `role` scope is absent from the bare-key search: `AgentIdentity`
 * carries no role, so there is nothing to resolve it against. A role-scoped fact
 * is still citable — with an absolute `fact:role:<role>:<key>` ref, which the
 * resolver reads outside the caller's own selector set precisely for this case.
 */
export async function resolveDeclaredAssumptions(args: {
  declared: AssumptionDeclaration;
  workItemId: string;
  ownerId?: string | null;
  harnessSlug?: string | null;
}): Promise<StoredAssumptionDeclaration> {
  const resolvedAt = new Date().toISOString();
  // EI-19339908198998425: `["none"]` means the sentinel, not a fact key named
  // "none". Normalized HERE, at the shared entry point, so `complete` and
  // `set_state` cannot diverge on it — the same reason the harness derive below
  // lives here rather than at the two known call sites.
  const declared = normalizeAssumptionDeclaration(args.declared);
  if (declared === NO_ASSUMPTIONS) return { declared: NO_ASSUMPTIONS, resolvedAt };

  // EI-18806393166489384: derive the harness scope from the work-item when the
  // caller did not name it, so a fact asserted at `scope:'harness'` for THIS
  // item's own harness resolves without the caller having to repeat the harness
  // it is already closing an item in.
  //
  // Why here and not at the call sites: `assumptionSelectorsFor`'s `push` helper
  // silently no-ops on an empty ref, so an undefined harness does not fail — the
  // selector VANISHES, and the refusal then truthfully lists the scopes it
  // searched with harness simply absent. That reads as a missing feature rather
  // than a dropped argument, which is why this was filed three times and
  // mis-diagnosed as "the resolver doesn't search harness scope" each time.
  // `complete.ts` happens to have the row in hand already, but `set_state.ts`
  // does not, and a fourth caller would have to remember — fixing only the known
  // call sites leaves the trap armed.
  let harnessSlug = args.harnessSlug ?? null;
  if (!harnessSlug) {
    // Fail OPEN, per this file's standing discipline: the derive is a
    // convenience, so a ledger/PG blip must never become the reason a close is
    // refused. Falling back to "no harness selector" is exactly the old
    // behaviour, so the worst case here is what callers already had.
    harnessSlug = await getWorkItem(args.workItemId)
      .then((wi) => wi?.harness ?? null)
      .catch(() => null);
  }

  const selectors = assumptionSelectorsFor({
    workItemId: args.workItemId,
    ownerId: args.ownerId,
    harnessSlug,
  });
  // Only a GENUINE absence refuses. `resolveAssumptions` fails open to
  // `unresolved` when the ledger could not be read, so a PG blip never turns into
  // a fleet-wide block on closing work — see isDanglingCondition.
  const resolved = await resolveAssumptions(declared, selectors);
  const dangling = resolved.filter((r) => isDanglingCondition(r.condition));
  if (dangling.length > 0) {
    throw new InvalidInputError(danglingAssumptionsMessage(dangling, selectors));
  }
  return { declared: resolved, resolvedAt };
}
