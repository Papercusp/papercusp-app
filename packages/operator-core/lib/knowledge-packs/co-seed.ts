/**
 * co-seed — the SHARED knowledge packs a new pot receives ALONGSIDE the pack
 * its blueprint declares.
 *
 * WHY THIS EXISTS AS A NAMED LIST
 * -------------------------------
 * `pot:create` already co-seeded ONE shared pack (`fleet-lessons`,
 * knowledge-pack-loop-integrity-2026-07-19 P-006a) as an inline special case.
 * That shape has no name, so "which packs does every pot get?" was answerable
 * only by reading the create path, and a second shared pack could only be added
 * by copy-pasting the block. This module is that rule, named once and testable
 * on its own.
 *
 * It is an EXTENSION of the knowledge-pack system, not a parallel selector —
 * memory-corpus-hygiene-and-release-distribution-2026-08-03 D-004: "The
 * knowledge-pack system IS the distribution allowlist — do not build a parallel
 * selector ... Any new 'what ships' mechanism must extend this per reuse-first."
 *
 * WHY `papercusp` IS ON THE LIST
 * ------------------------------
 * The `papercusp` pack is tier-1 PRODUCT knowledge — tool semantics, table
 * shapes, size caps, and the reading traps that return a confident answer
 * instead of an error. Same plan, D-003: tier-1 product knowledge "transfers
 * perfectly and SHOULD ship"; D-008 amends it so tier-2 dev-infrastructure
 * ships too and leaves only tier-3 THIS-BOX knowledge excluded.
 *
 * Every pot in a Papercusp install is operated BY agents calling Papercusp's
 * own tools, whatever the pot's subject matter is — so the audience for that
 * knowledge is every pot, not an opt-in subset.
 *
 * ⚠ DO NOT re-target this with pack `domains`. Measured on
 * `pack-format.filterByDomains`: an item carrying a domains tag seeds ONLY into
 * hives declaring that domain, and a hive declaring nothing receives untagged
 * items only — so a domains tag IS a delivery gate, which is exactly what D-008
 * forbids ("`domains`/`applies_to` remain available as ORGANIZING metadata ...
 * but are no longer an admission gate"). Pack identity carries the signal.
 *
 * NOT what EI-1539 rejected: that retirement was about a Papercusp-BRANDED id
 * being the wrong GLOBAL DEFAULT for generic engineering content, on a pack
 * that was byte-identical to `coding` and carried no Papercusp-specific content
 * at all. This is a co-seed of a pack whose content is Papercusp-specific, and
 * the global default (`DEFAULT_KNOWLEDGE_PACK_ID`) is untouched.
 *
 * Seeding a co-seed pack is BEST-EFFORT and per-pack isolated at the call site:
 * a pot is never failed because a shared pack was missing, and one failing pack
 * never suppresses the others.
 */
import { FLEET_LESSONS_PACK_ID } from './candidates-shared';

/** Tier-1 Papercusp PRODUCT knowledge lifted from the dogfooding corpus (P-008). */
export const PAPERCUSP_PACK_ID = 'papercusp';

/**
 * Shared packs every new pot is seeded with, in seed order, in ADDITION to the
 * pack its blueprint declares. A pack whose id IS the declared pack is skipped
 * by the caller (it has already been seeded).
 */
export const CO_SEED_PACK_IDS: readonly string[] = [FLEET_LESSONS_PACK_ID, PAPERCUSP_PACK_ID];
