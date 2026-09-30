/**
 * reversibility.ts — the REVERSIBILITY axis of the Queen autonomy model
 * (queen-autonomy-policy-2026-06-13 B-02 / P-012).
 *
 * The autonomy gate composes THREE orthogonal axes — risk · reversibility ·
 * authority. `policy.ts` owns the risk/tier verdict (auto vs human) and the
 * routing taxonomy lives in `triage.ts`; THIS module owns the second axis and
 * answers one question per candidate/action:
 *
 *   **if the Queen auto-runs this and it turns out wrong, can the effect be UNDONE?**
 *
 * A *reversible* action is cheap to auto-try because a mistake is recoverable —
 * a code/config edit (git revert), a soft-delete (restore), a flag flip. An
 * *irreversible* one cannot be taken back at any price — a schema/data migration
 * (an un-droppable column's data is gone), a deploy that ships the fleet, an
 * outbound send, a credential rotation that invalidates the old secret. The model
 * (P-090) makes irreversible a HARD gate: irreversible never auto, regardless of
 * how low the risk tier reads.
 *
 * ── Fail-safe (the load-bearing rule, P-012) ────────────────────────────────
 * The tag is three-valued, but `unknown` collapses to `irreversible` at every
 * GATE consumer ({@link isAutoReversible}). We treat ONLY a positively-classified
 * `reversible` as auto-safe: absence of evidence is treated as irreversible,
 * never as reversible. "I can't prove this is undoable" ⇒ don't auto-run it.
 *
 * ── Scope / behavior-neutrality (P-091) ─────────────────────────────────────
 * B-02 BUILDS, EXPOSES, and PINS this classifier. It is deliberately NOT yet
 * wired into `classifyImprovement`'s tier decision — the live auto/human
 * partition is byte-identical to before this module existed. The gate wiring
 * (combine reversibility + category ceiling + authority into the auto decision)
 * is B-12 / P-070, arriving behind the autonomy policy. The decision ledger
 * (P-110) records the raw three-valued tag for fidelity; the gate applies the
 * fail-safe collapse. Both seams import from here — they never re-derive it.
 *
 * Pure logic — no DB, no IO — exhaustively unit-testable. Mirrors policy.ts in
 * shape (a path list + a keyword proxy + a precedence-ordered classifier).
 */

import { matchGlob } from './policy';

/** The reversibility tag (P-012). `unknown` is the honest "can't tell" value;
 *  it fails safe to `irreversible` at the gate ({@link isAutoReversible}). */
export type Reversibility = 'reversible' | 'irreversible' | 'unknown';

/**
 * Repo-relative path patterns whose EFFECT cannot be cleanly undone. Distinct
 * from policy.ts's `protectedPathPatterns` (a code-blast-radius concern: "don't
 * auto-touch the safety machinery"); the surfaces overlap but the axis differs.
 * A path is IRREVERSIBLE when applying a change there produces a side effect that
 * `git revert` cannot take back:
 *   - schema / data migrations — DDL + data backfills; an un-droppable column's
 *     data is gone even after the migration file is reverted.
 *   - the deploy / release machinery — ships the fleet outward; recalling a
 *     deploy is a forward rollback, not an undo.
 *   - credential / auth material — a rotation invalidates the prior secret
 *     irrecoverably.
 */
export const IRREVERSIBLE_PATH_PATTERNS: readonly string[] = [
  'libs/papercusp/libs/db/sql/**', // migrations — DDL/data, not git-revertable
  'packages/operator-core/lib/release/**',
  'apps/operator/lib/release/**',
  '**/credentials/**',
  '**/auth/**',
];

/**
 * Title/body markers (case-insensitive substring) for an irreversible EFFECT when
 * no paths were captured — the pre-paths proxy (paths are authoritative when
 * present). Anchored on destructive-EFFECT phrasings (deploy, rotate, drop,
 * purge, teardown, outbound send), not bare topic words, so describing a feature
 * ("the delete button needs a tooltip") doesn't trip it. Conservative by design:
 * a false positive only over-classifies as irreversible, which is the fail-safe
 * direction.
 */
export const IRREVERSIBLE_KEYWORDS: readonly string[] = [
  'migration',
  'deploy',
  'release to production',
  'rotate credential',
  'rotate the credential',
  'revoke credential',
  'delete account',
  'hard delete',
  'permanently delete',
  'purge',
  'teardown',
  'tear down',
  'drop table',
  'drop column',
  'truncate',
  'send email',
  'send an email',
];

export interface ReversibilityDecision {
  reversibility: Reversibility;
  /** Human-readable trail of why this verdict was chosen (for the digest + ledger). */
  reasons: string[];
  /** The irreversible path-pattern or keyword that forced the verdict, if any. */
  hit?: string;
}

/** The minimal shape the classifier reads. `ImprovementCandidate` (policy.ts) and
 *  `ScoredItem` (digest.ts) both satisfy it structurally. */
export interface ReversibilityInput {
  /** Known implementation footprint — authoritative when present. */
  paths?: string[];
  title?: string;
  body?: string;
}

/**
 * Classify a candidate/action's reversibility. Precedence (first hit wins):
 *   1. an irreversible PATH (the strongest signal — a migration/deploy/credential
 *      edit produces an effect git revert cannot take back) → irreversible.
 *   2. an irreversible-effect KEYWORD in the title/body (the pre-paths proxy) →
 *      irreversible.
 *   3. a concrete repo edit with a KNOWN footprint, none of it irreversible →
 *      reversible (git revert undoes a code/config change cleanly).
 *   4. no footprint and no marker — we cannot PROVE the effect is undoable →
 *      `unknown`, which every gate consumer ({@link isAutoReversible}) treats as
 *      irreversible (P-012 fail-safe). The scoper supplying `paths` is what moves
 *      a candidate out of `unknown` before the B-12 gate consumes the verdict.
 */
export function classifyReversibility(c: ReversibilityInput): ReversibilityDecision {
  const reasons: string[] = [];

  // 1. Irreversible paths — the authoritative signal.
  for (const p of c.paths ?? []) {
    const hit = IRREVERSIBLE_PATH_PATTERNS.find((pat) => matchGlob(pat, p));
    if (hit) {
      reasons.push(`touches irreversible surface "${p}" (pattern ${hit}) → irreversible`);
      return { reversibility: 'irreversible', reasons, hit };
    }
  }

  // 2. Irreversible-effect markers in the title/body (the pre-paths proxy).
  const hay = `${c.title ?? ''} ${c.body ?? ''}`.toLowerCase();
  const kw = IRREVERSIBLE_KEYWORDS.find((k) => hay.includes(k.toLowerCase()));
  if (kw) {
    reasons.push(`mentions irreversible effect "${kw}" → irreversible`);
    return { reversibility: 'irreversible', reasons, hit: kw };
  }

  // 3. A concrete repo edit with a known footprint, none of it irreversible.
  if ((c.paths ?? []).length > 0) {
    reasons.push('a repo edit with a known footprint, no irreversible surface → reversible (git-revertable)');
    return { reversibility: 'reversible', reasons };
  }

  // 4. No footprint, no marker — fail-safe to unknown (treated as irreversible).
  reasons.push(
    'no known footprint and no irreversible marker → unknown (fail-safe: treated as irreversible at the gate)',
  );
  return { reversibility: 'unknown', reasons };
}

/**
 * The fail-safe collapse (P-012): the ONE place the three-valued tag becomes the
 * binary auto-gate input. Only a POSITIVELY-`reversible` action is auto-safe —
 * `irreversible` AND `unknown` both fail. Every autonomy gate consuming
 * reversibility MUST go through this predicate, never compare the raw tag, so the
 * unknown→irreversible rule cannot be forgotten at a call site.
 */
export function isAutoReversible(r: Reversibility): boolean {
  return r === 'reversible';
}

/**
 * Collapse the three-valued tag to its EFFECTIVE (fail-safe) reversibility for
 * display / the gate's binary view. `unknown` → `irreversible`. The ledger
 * (P-110) records the raw {@link Reversibility} for fidelity; surfaces that only
 * need "is it undoable?" use this.
 */
export function effectiveReversibility(r: Reversibility): 'reversible' | 'irreversible' {
  return r === 'reversible' ? 'reversible' : 'irreversible';
}
