/**
 * SU-S08 — compact read-correctness (token-efficient-agent-io P-013).
 *
 * Question: given a tool whose result arrives in a compact ROW encoding, does
 * the model map row positions to columns correctly when answering a question
 * about a specific cell?
 *
 * `audit:list` returns (via override) three rows in column order
 * id,ts,actor,action,subject. The user asks who the ACTOR was on the entry whose
 * ACTION was `locks:acquire`. The correct answer requires reading column 4
 * (action) to find the row, then column 3 (actor) of that row → `bob`. A
 * column-shifted misread would answer `alice`/`carol`, failing the gate.
 *
 * ENCODING — this scenario tracks the SHIPPED contract, which changed:
 *
 *   - It originally measured the HEADERLESS CSV arm (`AUDIT_CSV_RESULT`), where
 *     the column order lived only in the prompt's "## Wire schemas" legend,
 *     thousands of tokens from the data. Result: ~1/3 COLUMN-SHIFT MISREAD (2
 *     pass / 1 fail over 3 runs, groundedness variance 1.89) — filed as EI-136.
 *   - `audit:list` now ships as self-describing TOON, whose row header carries
 *     the field names INLINE (`[3]{id,ts,actor,action,subject}:`), so the
 *     mapping is local to the data. This scenario measures THAT.
 *
 * Both arms are kept in `_overrides.ts` and carry byte-identical data, so
 * re-pointing `toolOverride` re-runs the A/B rather than reasoning about it.
 * A regression here means the self-describing header stopped helping — check
 * whether `audit:list` was flipped back to a positional encoding in
 * `pre-prompt-registry-config.ts` before assuming a model regression.
 *
 * Load-bearing assert (ERROR): the reply names `bob`. Secondary (ERROR): it does
 * not CLAIM a decoy actor as the answer. Merely reproducing the other audit rows
 * in an accurate table is allowed; otherwise a correct, transparent answer would
 * fail just because it contains the names `alice` or `carol` (EI-22444127438822558).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertTextForbids } from './_asserts';
import { AUDIT_TOON_RESULT } from './_overrides';

export const SU_S08_COMPACT_READ: Scenario = {
  id: 'su-S08-compact-read',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to check recent audit events and tell them who performed the lock acquisition — i.e. the actor on the entry whose action is `locks:acquire`. The audit:list result comes back as compact TOON (a `[3]{id,ts,actor,action,subject}:` row header then rows of values in that column order).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // audit:list returns a fixed 3-row self-describing TOON body (the shipped
  // contract). Swap to AUDIT_CSV_RESULT to re-run the headerless arm of the A/B.
  toolOverride: AUDIT_TOON_RESULT,
  asserts: [
    assertTextRequires(/\bbob\b/i, {
      name: 'reads-correct-actor-from-csv',
      claim:
        'Expected the reply to name `bob` — the actor (col 3) of the row whose action (col 4) is `locks:acquire`, ' +
        'read positionally from the compact row body.',
      suggestion:
        'Map each value to the columns named in the row header (id,ts,actor,action,subject); find the row where action=locks:acquire, then report its actor.',
    }),
    assertTextForbids(
      /\bactor\b\s*(?:was|is|:|-)\s*(?:[*_`]\s*)*\b(?:alice|carol)\b|\b(?:alice|carol)\b\s+(?:was\s+)?(?:the\s+)?(?:actor|one\s+who\s+performed|person\s+who\s+performed|performed|acquired)\b|\blocks:acquire\b[^.\n]{0,64}\b(?:by|actor(?:\s+was|\s+is)?|performed\s+by)\b[^.\n]{0,24}\b(?:alice|carol)\b|\b(?:it|answer|performer)\s+(?:was|is)\s+(?!not\b)\b(?:alice|carol)\b/i,
      {
        name: 'no-column-shift-misread',
        claim:
          'The reply claimed a decoy actor (alice/carol) performed `locks:acquire` — a column-shift misread ' +
          'of the compact row body (those are the actors of the OTHER two rows).',
        suggestion:
          'Re-map the columns: actor is the 3rd value, action the 4th; only the locks:acquire row matters.',
      },
    ),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S08_COMPACT_READ;
