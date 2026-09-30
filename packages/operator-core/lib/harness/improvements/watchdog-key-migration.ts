/**
 * watchdog-key-migration.ts — a reusable, dry-run-default backfill that
 * recomputes the `payload.watchdogKey` of OPEN improvement EIs when the dedup
 * key SHAPE changes (watchdog-and-exposed-systems-improvement-2026-06-18 P-012).
 *
 * WHY this exists. The watchdog dedups a signal across ticks by an indexed
 * `payload.watchdogKey` (`<source>:<key>`). When the key shape changes — e.g.
 * P-012 adding a `:<fingerprint>` segment to `caller`/`transient` tool-error
 * keys so distinct same-class modes stop colliding — every OPEN EI still carries
 * the OLD shape. The next tick emits the NEW shape, which no longer matches, so
 * the open EI is ORPHANED (never dedups / ages / auto-closes against the live
 * signal) AND a fresh duplicate is filed → re-file churn. This is the lesson
 * behind the P-003 "must-be-post-deploy backfill". Running this routine ONCE
 * after the new collector deploys migrates the open EIs to the new shape so they
 * keep matching what the live collector now emits.
 *
 * GENERIC by design: `recomputeWatchdogKeys(deriveKey, deps, opts)` takes a pure
 * `deriveKey(candidate) → newKey | null`, so any FUTURE key-shape change is just
 * a new deriver + one call — future dedup-key changes are safe.
 * `deriveToolErrorWatchdogKey` is THIS change's deriver: it recomputes the
 * fingerprint from each open caller/transient EI's STORED SAMPLE (its body) and
 * appends it, matching exactly what the live collector now produces.
 *
 * PURE (no PG): the IO seam is `RecomputeDeps`. The live-PG deps + the
 * post-deploy CLI live in `apps/operator/scripts/recompute-watchdog-keys.ts`.
 */

import {
  toolErrorFingerprint,
  toolErrorSignalKey,
  FINGERPRINTED_TOOL_ERROR_CLASSES,
  type ToolErrorClass,
} from './tool-error-classifier';
import type { ImprovementCandidate } from './policy';

/** The watchdog source prefix for tool-error keys (`watchdogKeyOf` = source:key). */
export const REPEATED_TOOL_ERROR_PREFIX = 'repeated-tool-error:';

const TOOL_ERROR_CLASSES: readonly ToolErrorClass[] = ['structural', 'transient', 'caller', 'rate-limit'];

/** A parsed `repeated-tool-error:<tool>:<class>[:<fingerprint>]` key. */
export interface ParsedToolErrorKey {
  tool: string;
  klass: ToolErrorClass;
  fingerprint: string | null;
}

const TOOL_ERROR_KEY_RE = new RegExp(
  `^repeated-tool-error:(.+):(${TOOL_ERROR_CLASSES.join('|')})(?::(.+))?$`,
);

/**
 * Pure: parse a repeated-tool-error watchdogKey into its parts. The class token
 * is matched as a whole segment (anchored by `:` / end), so a tool name
 * containing `:` (e.g. `plans:list`) and a hyphen-joined fingerprint never
 * confuse the split. Returns null for any non-tool-error key.
 */
export function parseRepeatedToolErrorKey(key: string): ParsedToolErrorKey | null {
  const m = TOOL_ERROR_KEY_RE.exec(key);
  if (!m) return null;
  return { tool: m[1], klass: m[2] as ToolErrorClass, fingerprint: m[3] ?? null };
}

/**
 * Pure: pull the representative error sample out of a watchdog tool-error EI
 * body. The collector writes "… Sample error: <msg>" (structural) or
 * "… Sample: <msg>" (transient/caller/rate-limit) as the LAST line; the
 * fingerprint is derived from the first tokens of that sample. Returns null when
 * no sample line is present.
 */
export function extractSampleFromBody(body: string | null | undefined): string | null {
  const m = /Sample(?: error)?:\s*([\s\S]+)$/.exec(body ?? '');
  return m ? m[1].trim() || null : null;
}

/**
 * THIS change's deriver (P-012): for an OPEN tool-error EI whose key is a
 * now-fingerprinted class (`caller`/`transient`) but carries NO fingerprint yet,
 * recompute the fingerprint from the EI's stored sample and return the new,
 * fingerprinted key. Returns null (no migration) for:
 *   - non-tool-error keys,
 *   - `rate-limit` (deliberately coarse — one capacity concern),
 *   - keys that already carry a fingerprint (structural, or already migrated),
 *   - EIs whose body yields no derivable fingerprint.
 */
export function deriveToolErrorWatchdogKey(candidate: ImprovementCandidate): string | null {
  const key = candidate.watchdogKey;
  if (typeof key !== 'string' || !key.startsWith(REPEATED_TOOL_ERROR_PREFIX)) return null;
  const parsed = parseRepeatedToolErrorKey(key);
  if (!parsed) return null;
  // rate-limit is never fingerprinted; structural / already-fingerprinted keys
  // already carry their fp → nothing to migrate.
  if (!FINGERPRINTED_TOOL_ERROR_CLASSES.has(parsed.klass)) return null;
  if (parsed.fingerprint) return null;
  const fp = toolErrorFingerprint(extractSampleFromBody(candidate.body));
  if (!fp) return null;
  const newKey = `${REPEATED_TOOL_ERROR_PREFIX}${toolErrorSignalKey(parsed.tool, parsed.klass, fp)}`;
  return newKey === key ? null : newKey;
}

export interface WatchdogKeyChange {
  id: string;
  oldKey: string;
  newKey: string;
}

export interface WatchdogKeyCollision extends WatchdogKeyChange {
  /** The OPEN EI that already holds `newKey` (so migrating would create a duplicate key). */
  heldBy: string;
}

export interface RecomputeResult {
  /** Open EIs carrying a watchdogKey that were considered. */
  scanned: number;
  /** EIs whose key was (or, in dry-run, would be) migrated. */
  changed: WatchdogKeyChange[];
  /** EIs SKIPPED because their new key already belongs to another open EI. */
  collisions: WatchdogKeyCollision[];
  /** EIs the deriver left alone (newKey null or unchanged). */
  unchanged: number;
  /** Whether this was a dry run (no writes). */
  dryRun: boolean;
}

export interface RecomputeDeps {
  /** OPEN improvement candidates that carry a `payload.watchdogKey`. */
  listOpenKeyed: () => Promise<ImprovementCandidate[]>;
  /** Persist a recomputed key onto one EI (e.g. `mergeIssuePayload(id, { watchdogKey })`). */
  setWatchdogKey: (id: string, newKey: string) => Promise<void>;
}

/**
 * Recompute open EIs' watchdogKeys via a pluggable `deriveKey`. Dry-run by
 * DEFAULT (reports what it would do, writes nothing). Collision-safe: if a
 * recomputed key already belongs to ANOTHER open EI (or to one migrated earlier
 * in this pass), the row is SKIPPED and reported as a collision rather than
 * minting a second open EI on the same key — a genuine duplicate the dedup /
 * auto-close path reconciles.
 */
export async function recomputeWatchdogKeys(
  deriveKey: (candidate: ImprovementCandidate) => string | null,
  deps: RecomputeDeps,
  opts: { dryRun?: boolean } = {},
): Promise<RecomputeResult> {
  const dryRun = opts.dryRun ?? true;
  const candidates = await deps.listOpenKeyed();
  const withKey = candidates.filter(
    (c): c is ImprovementCandidate & { watchdogKey: string } =>
      typeof c.watchdogKey === 'string' && c.watchdogKey.length > 0,
  );

  // The live key→owner map, mutated as we migrate so a SECOND old key mapping to
  // the same new key collides too (consistent in dry-run + execute).
  const ownerOfKey = new Map<string, string>();
  for (const c of withKey) if (!ownerOfKey.has(c.watchdogKey)) ownerOfKey.set(c.watchdogKey, c.id);

  const changed: WatchdogKeyChange[] = [];
  const collisions: WatchdogKeyCollision[] = [];
  let unchanged = 0;

  for (const c of withKey) {
    const oldKey = c.watchdogKey;
    const newKey = deriveKey(c);
    if (!newKey || newKey === oldKey) {
      unchanged += 1;
      continue;
    }
    const holder = ownerOfKey.get(newKey);
    if (holder !== undefined && holder !== c.id) {
      collisions.push({ id: c.id, oldKey, newKey, heldBy: holder });
      continue;
    }
    if (!dryRun) await deps.setWatchdogKey(c.id, newKey);
    changed.push({ id: c.id, oldKey, newKey });
    // Reflect the move in the owner map for downstream collision checks.
    if (ownerOfKey.get(oldKey) === c.id) ownerOfKey.delete(oldKey);
    ownerOfKey.set(newKey, c.id);
  }

  return { scanned: withKey.length, changed, collisions, unchanged, dryRun };
}
