/**
 * Deterministic, collision-free identity for one Hive-evaluation run (P-022).
 *
 * Mirrors the gym's `gymRunIdentity`: every `(instance × scenario × repeat)` run gets its
 * own throwaway-hive home slug (its own `harness_<slug>` PG schema + substrate clone), and
 * a stable run id, derived PURELY from the key — so the same key always resolves to the same
 * names (idempotent re-runs / replay) and distinct keys never collide. The slug is
 * hyphen-free (it becomes an unquoted PG schema identifier) and bounded under Postgres's
 * 63-char limit, exactly as the gym requires.
 */
import { createHash } from 'node:crypto';

export interface HiveEvalRunKey {
  /** The code-generation instance under test (manifest instanceId). */
  instanceId: string;
  /** The scenario id (corpus key). */
  scenarioId: string;
  /** Repeat index within (instance × scenario) — the P-022 variance sample. */
  repeat: number;
  /** The run seed (determinism control; folded into identity so re-seeds don't collide). */
  seed: number;
}

export interface HiveEvalRunIdentity {
  /** Throwaway hive home slug → `harness_<slug>` schema; hyphen-free for unquoted PG use. */
  potSlug: string;
  /** Stable, human-readable run id (the runs-table primary key). */
  runId: string;
  /** Scratch dir name for the substrate clone (== potSlug; filesystem-safe). */
  cloneDirName: string;
}

/** `harness_` (8) + slug ≤ 63 ⇒ slug ≤ 55; reserve room for the prefix + hash. */
const MAX_SLUG_LEN = 55;
const HASH_LEN = 10;
const MAX_HINT_LEN = 18;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Lowercase, strip everything but `[a-z0-9]` (the slug is an unquoted PG schema name). */
function sanitizeSlugPart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function hiveEvalRunIdentity(key: HiveEvalRunKey): HiveEvalRunIdentity {
  const canonical = `${key.instanceId}::${key.scenarioId}::r${key.repeat}::s${key.seed}`;
  const hash = sha256hex(canonical).slice(0, HASH_LEN);
  const hint = sanitizeSlugPart(key.scenarioId).slice(0, MAX_HINT_LEN);

  let potSlug = `heval${hint}${hash}`;
  if (potSlug.length > MAX_SLUG_LEN) potSlug = potSlug.slice(0, MAX_SLUG_LEN);

  // Human-readable + stable: same key → same row (idempotent re-run / replay).
  const runId = `${key.instanceId}::${key.scenarioId}::r${key.repeat}`;

  return { potSlug, runId, cloneDirName: potSlug };
}
