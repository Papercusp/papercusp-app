/**
 * freshness — declared-dependency staleness, replacing TTL guessing
 * (agent-protocol-authority-semantics-2026-07-26 P-007, D-013).
 *
 * ## What this replaces
 *
 * Whether a carry-note (today: a work-item checkpoint) can be TRUSTED is decided
 * by three independent time constants, each a proxy for the same question:
 *
 * | constant | site | the question it actually answers |
 * |---|---|---|
 * | `STALE_CHECKPOINT_MS` 45m | turn-end-tracking | write a fresh mechanical checkpoint? |
 * | `CHECKPOINT_RELATIVE_STALE_LAG_MS` 5m | checkpoint-staleness | did the assignee keep working past it? |
 * | `HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS` 2m | carry-brief | superseded inside the same session? |
 *
 * The question that matters is none of those: **has anything the note depends on
 * changed since it was written?** Guessing it with a clock produces two failures,
 * and the second is a correctness hole no constant can close:
 *
 * - **False stale** — a 3h-old checkpoint on an untouched item is flagged
 *   distrust-worthy though it is perfectly current, so the successor re-derives
 *   what it could have trusted.
 * - **False fresh** — every existing heuristic keys on the AUTHOR's own activity
 *   (assignee `lastActiveAt`, same-session turns), so a dependency changed by a
 *   PEER is structurally invisible. WI-5013 is this class.
 *
 * ## The model
 *
 * XFlow's declared `from:` set plus a Fresh/Stale/Recomputed marker. A writer
 * declares dependencies as flat `kind:ref` tag strings — deliberately the same tag
 * vocabulary as `@papercusp/cache` (`item:WI-C`), not a new one. Each dependency
 * resolves to a VERSION TOKEN stamped alongside the note; a reader re-resolves and
 * diffs. Both the false-stale and false-fresh cases above invert correctly, and a
 * stale verdict names WHICH dependency moved — the actionable payload no TTL can
 * produce.
 *
 * Every dependency worth declaring already carries a durable monotonic version (a
 * work-item's `updated_ts`, a file's content hash, a plan's `version`), so this
 * needs no generation counters, no LISTEN/NOTIFY and no in-process state — and is
 * therefore correct across processes, sessions and operator restarts BY
 * CONSTRUCTION. That is required here: a checkpoint's reader is a successor in a
 * different process, the exact case the operator's L1-only cache generations
 * (`cache/instance.ts`) cannot serve. See D-013 for why `@papercusp/cache` was
 * evaluated for reuse and rejected on that ground plus the absence of a factory.
 *
 * ## Purity
 *
 * This module has ZERO imports, by design. CLAUDE.md's generic-first rule wants a
 * domain-free algorithm to start as `libs/generic/<name>`; the deviation is
 * deliberate and time-boxed (D-013) because git-sync is currently failing to push
 * `libs/generic/*` submodules, so a new one would be born stranded from its
 * remote. EXTRACTION TRIGGER: the second consumer (standing facts or plan
 * decisions). Keep this file import-free so that move stays mechanical.
 */

/** The stored shape's version, so a future shape change is detectable rather than
 *  silently mis-parsed. */
export const DECLARED_DEPS_VERSION = 1 as const;

/**
 * A reader's verdict on a note.
 *
 * `recomputed` is the XFlow tri-state's third leg and is NOT derivable at read
 * time — it is stamped at WRITE time when the note being replaced was ALREADY
 * stale. It means: currently valid, but rewritten after its world moved, so the
 * narrative may only be partially updated rather than continuously true. A reader
 * that treats it as plain `fresh` loses exactly that warning.
 */
export type FreshnessVerdict = 'fresh' | 'stale' | 'recomputed' | 'undeclared';

/** One dependency's observed version at the moment the note was written. */
export interface DepStamp {
  /** The dependency tag, `kind:ref` (e.g. `file:packages/x/y.ts`, `work-item:WI-1`). */
  dep: string;
  /** The version token observed at write time. Opaque to this module. */
  token: string;
  /** Epoch ms the token was observed. */
  at: number;
}

/** The stored `carry_notes.deps` payload. */
export interface DeclaredDeps {
  v: typeof DECLARED_DEPS_VERSION;
  stamps: DepStamp[];
  /** Set at write time when the replaced note was already stale (see `recomputed`). */
  recomputed?: boolean;
}

/** A dependency whose token moved since the note was written. */
export interface ChangedDep {
  dep: string;
  /** The token stamped at write time. */
  was: string;
  /** The token resolved now. */
  now: string;
}

export interface FreshnessResult {
  verdict: FreshnessVerdict;
  /** How many dependencies the note declared. */
  declared: number;
  /** Dependencies whose token moved — empty unless `verdict === 'stale'`. */
  changed: ChangedDep[];
  /**
   * Dependencies that could not be resolved NOW (a deleted file, a PG hiccup).
   * These deliberately do NOT make the note stale — see the warn-only note on
   * {@link computeFreshness}.
   */
  unresolvable: string[];
  /** Human-facing explanation; present for every verdict except `undeclared`. */
  reason?: string;
}

/** A resolved view of the world: dependency tag → current token, or `null` when
 *  it could not be resolved right now. */
export type CurrentTokens = ReadonlyMap<string, string | null>;

/**
 * Parse a stored `deps` payload defensively. Returns `null` for anything that is
 * absent, malformed, or a version this build does not understand — all of which
 * mean "undeclared", never "stale". A note must never be distrusted because its
 * METADATA failed to parse.
 */
export function parseDeclaredDeps(raw: unknown): DeclaredDeps | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<DeclaredDeps>;
  if (obj.v !== DECLARED_DEPS_VERSION) return null;
  if (!Array.isArray(obj.stamps)) return null;
  const stamps: DepStamp[] = [];
  for (const s of obj.stamps) {
    if (!s || typeof s !== 'object') continue;
    const { dep, token, at } = s as Partial<DepStamp>;
    if (typeof dep !== 'string' || dep.length === 0) continue;
    if (typeof token !== 'string') continue;
    stamps.push({ dep, token, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
  }
  if (stamps.length === 0) return null;
  return { v: DECLARED_DEPS_VERSION, stamps, ...(obj.recomputed === true ? { recomputed: true } : {}) };
}

/**
 * PURE (no I/O) so it unit-tests without PG/DI ceremony.
 *
 * Warn-only discipline, inherited from `computeCheckpointStaleness`: a dependency
 * that cannot be resolved right now is reported in `unresolvable` and does NOT
 * count as changed. A resolver hiccup (a transient PG error, a file temporarily
 * absent) must never manufacture distrust in a note that is probably fine — the
 * whole point of this axis is to STOP crying stale without cause.
 */
export function computeFreshness(input: {
  deps: DeclaredDeps | null | undefined;
  currentTokens: CurrentTokens;
}): FreshnessResult {
  const deps = input.deps;
  if (!deps || deps.stamps.length === 0) {
    return { verdict: 'undeclared', declared: 0, changed: [], unresolvable: [] };
  }

  const changed: ChangedDep[] = [];
  const unresolvable: string[] = [];

  for (const stamp of deps.stamps) {
    // `has` distinguishes "resolved to null" from "never attempted" — both are
    // unresolvable, and neither is a change.
    const current = input.currentTokens.get(stamp.dep);
    if (current === null || current === undefined) {
      unresolvable.push(stamp.dep);
      continue;
    }
    if (current !== stamp.token) changed.push({ dep: stamp.dep, was: stamp.token, now: current });
  }

  const declared = deps.stamps.length;

  if (changed.length > 0) {
    const names = changed.map((c) => c.dep);
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` (+${names.length - 3} more)` : '';
    return {
      verdict: 'stale',
      declared,
      changed,
      unresolvable,
      reason:
        `${changed.length} of ${declared} declared ${declared === 1 ? 'dependency' : 'dependencies'} ` +
        `changed since this note was written: ${shown}${more}. The note predates those changes — ` +
        `re-read what moved before acting on it.`,
    };
  }

  // Nothing moved. `recomputed` (stamped at write) still tells the reader the note
  // was rebuilt after an invalidation rather than being continuously valid.
  if (deps.recomputed) {
    return {
      verdict: 'recomputed',
      declared,
      changed,
      unresolvable,
      reason:
        `all ${declared} declared ${declared === 1 ? 'dependency is' : 'dependencies are'} unchanged since ` +
        `this note was written, but it was REWRITTEN after an earlier dependency change — it may have been ` +
        `refreshed only in part, so trust its facts over its narrative.`,
    };
  }

  return {
    verdict: 'fresh',
    declared,
    changed,
    unresolvable,
    reason:
      unresolvable.length > 0
        ? `all resolvable declared dependencies are unchanged (${unresolvable.length} could not be ` +
          `resolved right now and were not counted either way) — the note's age alone is not a reason ` +
          `to distrust it.`
        : `all ${declared} declared ${declared === 1 ? 'dependency is' : 'dependencies are'} unchanged ` +
          `since this note was written — the note's age alone is not a reason to distrust it.`,
  };
}

/**
 * Decide the `recomputed` flag for a write: true when the note being REPLACED had
 * already gone stale. Kept here (not at the call site) so the write and read sides
 * share one definition of the tri-state.
 */
export function shouldMarkRecomputed(priorVerdict: FreshnessVerdict | null | undefined): boolean {
  return priorVerdict === 'stale';
}
