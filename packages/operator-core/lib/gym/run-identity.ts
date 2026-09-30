/**
 * Deterministic, collision-free identity for one hermetic gym run.
 *
 * Every `(task × variant × cycle)` evaluation runs in its own throwaway harness
 * — its own `harness_<slug>` PG schema, its own filed feature, its own substrate
 * clone dir. This derives those names purely from the run key so the same key
 * always resolves to the same names (idempotent re-runs / DBOS replay) and
 * distinct keys never collide.
 *
 * The slug is `gym-`-prefixed on purpose: the dedicated gym-operator scopes its
 * DBOS autoloop to gym harnesses via a slug match
 * (`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES`), and the prefix keeps gym schemas
 * visually distinct from real harnesses. It is kept short enough that
 * `harness_<slug>` stays within Postgres's 63-char identifier limit.
 */
import { createHash } from 'node:crypto';

export interface GymRunKey {
  /** The synthetic-task id (one feature per task). */
  taskId: string;
  /** The prompt-variant id (the overlay under test). */
  variantId: string;
  /** Optimization cycle index (0 for the spine's manual A/B). */
  cycle: number;
  /**
   * Repeat index within a (task × variant × cycle) — the P-014 variance sample.
   * Each repeat needs its OWN throwaway harness (schema + clone), so it is part of
   * the slug. Omitted/0 resolves identically to a no-repeat key (back-compat: a
   * single-run key keeps its original slug; only repeat ≥ 1 diverges).
   */
  repeat?: number;
}

export interface GymRunIdentity {
  /** Throwaway harness slug → `harness_<slug>` schema; gym-prefixed for autoloop scoping. */
  harnessSlug: string;
  /** The synthetic feature id filed into the throwaway harness (task-derived). */
  featureId: string;
  /** Scratch dir name for the substrate clone (== harnessSlug; filesystem-safe). */
  cloneDirName: string;
}

/** `harness_` (8) + slug ≤ 63 ⇒ slug ≤ 55; reserve room for the prefix + hash. */
const MAX_SLUG_LEN = 55;
const HASH_LEN = 10;
const MAX_HINT_LEN = 20;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Lowercase, strip everything that isn't `[a-z0-9]`. NO hyphens/underscores: the slug
 * becomes the PG schema `harness_<slug>`, and the orchestrator's search_path code does
 * not quote schema names — a hyphen there silently fails to resolve the per-harness
 * `harness_features` view (verified in the boot smoke). Live harness slugs are
 * hyphen-free for the same reason.
 */
function sanitizeSlugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function gymRunIdentity(key: GymRunKey): GymRunIdentity {
  // Append the repeat segment ONLY when ≥1 so a no-repeat / repeat-0 key keeps its
  // original slug (back-compat); repeat ≥ 1 gets a distinct schema + clone.
  const rep = key.repeat ?? 0;
  const canonical = rep > 0 ? `${key.taskId}::${key.variantId}::${key.cycle}::r${rep}` : `${key.taskId}::${key.variantId}::${key.cycle}`;
  const hash = sha256hex(canonical).slice(0, HASH_LEN);
  const hint = sanitizeSlugPart(`${key.variantId}${key.cycle}`).slice(0, MAX_HINT_LEN);

  // Hyphen-free, so `harness_<slug>` is a valid unquoted PG identifier.
  let harnessSlug = `gym${hint}${hash}`;
  if (harnessSlug.length > MAX_SLUG_LEN) harnessSlug = harnessSlug.slice(0, MAX_SLUG_LEN);

  const taskHash = sha256hex(key.taskId).slice(0, 8).toUpperCase();
  const featureId = `F-GYM-${taskHash}`;

  return { harnessSlug, featureId, cloneDirName: harnessSlug };
}
