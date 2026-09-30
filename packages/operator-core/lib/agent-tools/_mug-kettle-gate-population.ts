/**
 * _mug-kettle-gate-population.ts — the SINGLE SOURCE OF TRUTH for which mug/kettle-tier
 * verbs the retirement gate refuses, which stay reachable, and which no longer exist.
 *
 * WHY THIS IS A MODULE AND NOT A CONST IN THE TEST (WI-10002068). These populations lived
 * as module-private arrays inside `mug-kettle-tool-gate.test.ts`, so nothing outside that
 * file could derive from them — and every other statement of "which verbs refuse" (the su
 * instance prompt override, agent-insights/mug-kettle-tool-gate.md, the base playbook, the
 * kernel) was therefore a hand-maintained COPY sitting at rung 4 (CURATED) of the
 * derived-truth ladder when rung 1 (DERIVE) was available.
 *
 * It drifted exactly as that ladder predicts: EI-23782708033448780 found the su instance
 * prompt wrong FOUR times in ONE sentence, in BOTH directions — `curation:state-of-pot`,
 * `pot:list` and `pot:pause` labelled as refusing when they work, and `pot:declare-wake`
 * labelled as working when it refuses.
 *
 * ⚠ THE DRIFT IS SILENT IN THE DANGEROUS DIRECTION. A verb wrongly labelled REFUSES is
 * simply never called, so it produces no error and no trace. That is how
 * `curation:state-of-pot` — which IS Scout, and sits in a mandatory grounding read — went
 * unexercised across many sessions. Nothing fails; the capability just quietly stops being
 * used. A verb wrongly labelled WORKS fails loudly on first call and self-corrects.
 *
 * SCOPE. This module is PURE DATA with no imports, deliberately: the gate test joins these
 * rows to its own `load`/`args` wiring by name, and any prose surface can derive from them
 * without dragging in the tool graph. Test-only concerns (dynamic import thunks, handler
 * fixtures) stay in the test where they belong.
 *
 * ⚠ THIS LIST SHRINKS AS P-059 DELETES TIER CODE, AND THAT IS CORRECT (D-080). A row moves
 * `gated`/`excluded` -> `deleted`; it is never silently dropped. D-080's anti-vacuity rule
 * is enforced against these populations in the gate test — read it there before editing.
 */

/**
 * - `gated`    — the tool still exists and the retirement gate REFUSES it
 *                (`error: 'mug_kettle_retired'`, and it must perform NO write).
 * - `excluded` — the tool still exists and stays REACHABLE. These police the
 *                "gate too strong" direction, which is the one a namespace-shaped
 *                gate fails (D-017).
 * - `deleted`  — the tool no longer exists at all (P-059). Kept as a ROW rather than
 *                erased, because prose keeps making claims about these names and a
 *                deleted verb must be distinguishable from one that merely refuses.
 */
export type MugKettleDisposition = 'gated' | 'excluded' | 'deleted';

export interface MugKettleVerb {
  /** The colon-form verb name, exactly as prose and the tool catalog spell it. */
  readonly name: string;
  readonly disposition: MugKettleDisposition;
  /**
   * Why this verb sits on THIS side. Load-bearing, not commentary: the `excluded`
   * rationales are the record of which direction of failure each exclusion prevents,
   * and a `deleted` row's reason is the only surviving trace of the retirement.
   */
  readonly why: string;
}

export const MUG_KETTLE_VERBS: readonly MugKettleVerb[] = Object.freeze([
  // ---- GATED (D-017 actuators + D-048 tier surfaces) ----
  {
    name: 'pot:start',
    disposition: 'gated',
    why: 'D-017 actuator — the refusal is harm-prevention. Its body IS the tier restart, which is why the gate test asserts ZERO writes rather than merely an error code.',
  },
  {
    name: 'pot:wake',
    disposition: 'gated',
    why: 'D-017 actuator — the refusal is harm-prevention.',
  },
  {
    name: 'pot:set-steering',
    disposition: 'gated',
    why: 'D-048 tier surface, and the one true ACTUATOR of the four: it writes, then calls requestUrgentPotWake.',
  },
  {
    name: 'pot:declare-wake',
    disposition: 'gated',
    why: 'D-048 tier surface. Gated with the tier reads whose zero-valued answers would misreport a retired tier as a healthy idle one.',
  },
  {
    name: 'pot:mug_efficiency',
    disposition: 'gated',
    why: 'D-048 tier surface — a read whose zero-valued answer would misreport a retired tier as a healthy idle one.',
  },

  // ---- EXCLUDED (D-017: the "gate too strong" direction) ----
  {
    name: 'pot:pause',
    disposition: 'excluded',
    why: 'a STOPPER — refusing a stop is never the safe direction, and it is how a tier gets stranded running when the flag flips ON->OFF',
  },
  {
    name: 'curation:state-of-pot',
    disposition: 'excluded',
    why: "Scout's own corpus-synthesis step; D-001 keeps Scout INTACT, and the census found ZERO curation entry points",
  },
  {
    name: 'pot:list',
    disposition: 'excluded',
    why: 'the pot-as-CONTAINER surface — a Pot is a harness container and a federation peer, not only a Mug host (D-003 one layer up)',
  },
  {
    name: 'pot:dissolve',
    disposition: 'excluded',
    why:
      'D-048 ruled it CONTAINER-KEEP. Its own guidance is "Permanently tearing down a local pot — stop the Mug, ' +
      'cancel its cups, deregister it": it is a STOPPER, and D-017 is explicit that refusing a stop is never the ' +
      'safe direction. Gating it is how a tier gets stranded RUNNING with no way to wind it down after ON->OFF. ' +
      'It sits in the same `pot:*` namespace as four tools this file DOES gate, so it is exactly the entry a ' +
      'namespace-shaped or name-shaped pass would sweep up by mistake',
  },
  {
    name: 'pot:status',
    disposition: 'excluded',
    why:
      'D-048 ruled it TIER but explicitly left its gating OPTIONAL ("read-only ... not harm-prevention"), and D-049 ' +
      "settles the option as NO. Two independent reasons: it falls outside _mug-kettle-gate.ts's own stated scope " +
      '(ACTUATORS ONLY — a tool that INITIATES or SUSTAINS tier work), and it is a DIAGNOSTIC used to verify the ' +
      'tier is wound down. Gating the read that confirms the retirement worked removes evidence for P-030/P-031 ' +
      'to close on. Unlike pot:mug_efficiency it reports declaration STATE, not a zero-valued metric, so it cannot ' +
      'misreport a retired tier as a healthy idle one — the reason the other reads are gated does not apply here',
  },

  // ---- DELETED (P-059 removed the code outright) ----
  {
    name: 'cup:spawn',
    disposition: 'deleted',
    why: 'P-059 deleted it outright; its retirement emptied the `agent-tools/cup/` group entirely, so the whole `cup:` namespace is gone.',
  },
  {
    name: 'kettle:start',
    disposition: 'deleted',
    why: 'P-059 deleted it with the rest of `agent-tools/overwatch/`.',
  },
  {
    name: 'kettle:declare-wake',
    disposition: 'deleted',
    why: 'P-059 deleted it with the rest of `agent-tools/overwatch/`.',
  },
  {
    name: 'kettle:pause',
    disposition: 'deleted',
    why: 'Sat in EXCLUDED as a STOPPER, then retired with the rest of `agent-tools/overwatch/` in P-059. A retired tool cannot be a stopper for a tier that no longer runs, so the exclusion had become vacuous. pot:pause is unaffected — the pot substrate survives per D-003.',
  },
  {
    name: 'pot:survey',
    disposition: 'deleted',
    why: 'Sat in GATED; retired by P-059/D-080.',
  },
]);

/** Verbs the gate REFUSES. */
export const gatedVerbs = (): readonly MugKettleVerb[] =>
  MUG_KETTLE_VERBS.filter((v) => v.disposition === 'gated');

/** Verbs that still WORK and must never be refused. */
export const excludedVerbs = (): readonly MugKettleVerb[] =>
  MUG_KETTLE_VERBS.filter((v) => v.disposition === 'excluded');

/** Verbs whose code no longer exists. */
export const deletedVerbs = (): readonly MugKettleVerb[] =>
  MUG_KETTLE_VERBS.filter((v) => v.disposition === 'deleted');

/**
 * The directories P-059 emptied. Separate from the verb rows because this is the claim
 * prose actually makes ("the whole `cup:` namespace is gone"), and it is checkable as a
 * directory fact rather than per-verb — so the `deleted` rows above can be verified
 * without guessing at each removed module's former path.
 */
export const DELETED_TOOL_GROUP_DIRS: readonly string[] = Object.freeze(['cup', 'overwatch']);

/* ────────────────────────────────────────────────────────────────────────────
 * PROSE DERIVATION (WI-10002068 step 2)
 *
 * Every prose statement of "which of these verbs refuse" used to be a hand-typed
 * copy of the rows above — rung 4 (CURATED) where rung 1 (DERIVE) was available —
 * and it drifted in BOTH directions, silently: a verb wrongly labelled REFUSES is
 * simply never called, so it emits no error and leaves no trace.
 *
 * So the canonical sentence is RENDERED from the rows, dropped into each prose
 * surface between the markers below, and byte-compared by
 * `doc-claims/mug-kettle-verb-dispositions.test.ts`. The guard is an equality
 * check, not an English parser: it cannot pass vacuously, and it cannot be made
 * to pass by rewording.
 *
 * There is deliberately no `gen:` script. The block is ONE line; the guard's
 * failure message prints the exact expected text, so the repair is a paste — a
 * generator entrypoint would be a new durable surface earning nothing.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Opening marker of the generated prose block. Must be unique per surface. */
export const MUG_KETTLE_BLOCK_BEGIN =
  '<!-- GENERATED mug-kettle-verb-dispositions — DO NOT HAND-EDIT. Derived from packages/operator-core/lib/agent-tools/_mug-kettle-gate-population.ts; pinned by packages/operator-core/lib/doc-claims/mug-kettle-verb-dispositions.test.ts -->';

/** Closing marker of the generated prose block. */
export const MUG_KETTLE_BLOCK_END = '<!-- /GENERATED mug-kettle-verb-dispositions -->';

/** `a`, `b` and `c` — the Oxford-less list form the surrounding prose already uses. */
function nameList(verbs: readonly MugKettleVerb[]): string {
  const ticked = verbs
    .map((v) => `\`${v.name}\``)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ticked.length <= 1) return ticked.join('');
  return `${ticked.slice(0, -1).join(', ')} and ${ticked[ticked.length - 1]}`;
}

/**
 * The canonical one-line statement of the split, derived from `MUG_KETTLE_VERBS`.
 *
 * Kept to a single line on purpose: it is injected into prompt files that every
 * su carries in context, and a line is the smallest unit a reader can diff by eye
 * against the block they are reading.
 */
export function renderMugKettleDispositionProse(): string {
  return [
    `${nameList(excludedVerbs())} still WORK — never refuse them.`,
    `${nameList(gatedVerbs())} REFUSE with \`mug_kettle_retired\` and perform no write.`,
    `${nameList(deletedVerbs())} were DELETED outright and do not exist at all — a deleted verb is not a refusing one.`,
  ].join(' ');
}

/** The full marker-delimited block, exactly as it must appear in every pinned surface. */
export function renderMugKettleDispositionBlock(): string {
  return `${MUG_KETTLE_BLOCK_BEGIN}\n${renderMugKettleDispositionProse()}\n${MUG_KETTLE_BLOCK_END}`;
}
