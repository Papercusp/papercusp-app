/**
 * seed-pack-key — which Knowledge Pack a blueprint declares as its seed pack,
 * across the `learning.pack` → `knowledge.pack` rename
 * (cupboard-public-release-2026-07-12 P-001 / knowledge-packs-2026-07-11 D-001).
 *
 * PURE — no fs, no PG. The precedence is subtle enough to deserve its own tested
 * function rather than an inline `??` chain at the call site.
 *
 * WHY THE DEPRECATED KEY CAN WIN
 * ------------------------------
 * Blueprints resolve through an `extends` deep-merge, so the blueprint handed to
 * pot:create is a MERGE of its own source and its bases. After the rename:
 *
 *   - every FIRST-PARTY base (coding, work) declares `knowledge.pack` and no
 *     longer declares `learning.pack`;
 *   - therefore a resolved `learning.pack` can only have come from a PRE-RENAME
 *     blueprint's own source — a user-authored or already-installed one, which we
 *     never rewrite (blueprint YAML is a true boundary under D-001).
 *
 * So when a legacy blueprint extends `coding` and overrides the seed pack, the
 * merged result carries BOTH keys:
 *
 *     knowledge.pack = 'coding'    ← INHERITED from the base
 *     learning.pack  = 'my-pack'   ← the AUTHOR's own explicit choice
 *
 * A naive `knowledge.pack ?? learning.pack` would seed 'coding' and silently
 * discard what the author actually asked for — a wrong-pack seeding that nobody
 * would notice until the pot behaved oddly. The author's own declaration must
 * win, so a present `learning.pack` that DISAGREES takes precedence (and is
 * reported as deprecated so it can be migrated).
 *
 * When the keys agree, or only one is present, there is nothing to arbitrate:
 * the canonical `knowledge.pack` is preferred and no deprecation is reported.
 */

export interface SeedPackBlueprint {
  knowledge?: { pack?: string } | null;
  /** @deprecated pre-rename key; read-only compat. */
  learning?: { pack?: string } | null;
}

export interface SeedPackResolution {
  /** The declared seed pack id, or undefined when the blueprint declares none. */
  packId?: string;
  /** True when the value came from the deprecated `learning.pack` key. */
  deprecatedKey: boolean;
  /** Set only when BOTH keys are present and DISAGREE (legacy override of a renamed base). */
  conflict?: { knowledge: string; learning: string };
}

export function resolveSeedPackKey(blueprint: SeedPackBlueprint | null | undefined): SeedPackResolution {
  const knowledge = blueprint?.knowledge?.pack?.trim() || undefined;
  const learning = blueprint?.learning?.pack?.trim() || undefined;

  if (knowledge && learning && knowledge !== learning) {
    // Both present and disagreeing: `learning.pack` is necessarily the author's
    // own line (no first-party base sets it any more) while `knowledge.pack` is
    // inherited — honour the author.
    return { packId: learning, deprecatedKey: true, conflict: { knowledge, learning } };
  }
  if (knowledge) return { packId: knowledge, deprecatedKey: false };
  if (learning) return { packId: learning, deprecatedKey: true };
  return { deprecatedKey: false };
}
