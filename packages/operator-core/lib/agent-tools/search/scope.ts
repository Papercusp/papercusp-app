/**
 * The one `scope` vocabulary shared by `search:fulltext` and `search:semantic`,
 * plus the synonym fold that keeps a caller's reasonable-but-undeclared source
 * name from becoming a wasted round-trip.
 *
 * WHY THIS FILE EXISTS AT ALL (the dedup half)
 * --------------------------------------------
 * Both tools declared their own byte-identical `SCOPE_CHOICES` literal, and both
 * must stay in lockstep with `SEARCH_SOURCES` in `./sources` — a source added
 * there is invisible to callers until BOTH copies are edited. `scopeChoices()`
 * derives the list from the registry instead, so the enum cannot drift from the
 * sources it names.
 *
 * WHY THE ALIAS FOLD (EI-20244869519887589)
 * -----------------------------------------
 * A caller asked for `scope: ['work_item', 'transcript']` and was refused. The
 * refusal listed the eight valid options — so it was not a silent failure — but
 * the list cannot answer the question the caller actually had, because TWO of
 * the options are near-synonyms in plain English:
 *
 *   * `turns`        = `operator_turns`, the older operator chat corpus
 *   * `session_turn` = "the episodic verbatim TRANSCRIPT index" (its own docblock
 *                      in ./sources, session-search-scope-2026-07-05 P-004/D-003)
 *
 * `transcript` is therefore not a typo and not ambiguous — it is the word the
 * source's own documentation uses for itself, and no amount of edit-distance or
 * token-overlap matching would ever have recovered it (`transcript` shares no
 * token with `session_turn`). That makes it a VOCABULARY gap, which only a
 * declared synonym can close.
 *
 * Folding rather than suggesting is the established treatment for a KNOWN,
 * unambiguous synonym in this repo (`work_items:set_state`'s `foldStateCase`,
 * `plans:add-item`'s `PHASE`, `improvements:capture`'s coercion layer). It does
 * NOT weaken the EI-10883 rule that an undeclared arg must be REJECTED rather
 * than silently ignored: an alias here resolves to a specific declared source and
 * searches exactly it, so nothing is quietly dropped or redirected. A value that
 * is neither canonical nor a declared alias still gets the full hard refusal with
 * the option list, unchanged.
 */

import { z } from 'zod';
import { SEARCH_SOURCES } from './sources';

/**
 * `all` is not a source — it is the expand-to-everything token both handlers
 * special-case before filtering `SEARCH_SOURCES` (EI-6984).
 */
export const SCOPE_ALL = 'all' as const;

/** Canonical source names, derived from the registry, plus the `all` token. */
export function scopeChoices(): [string, ...string[]] {
  // `z.enum` wants a non-empty tuple. Widen to `string[]` first and assert THAT:
  // the spread's inferred `[...string[], 'all']` does not overlap the target tuple
  // (the leading rest makes the first element unknowable to TS), so casting it
  // directly is the error TS2352 exists to catch. The non-emptiness is real —
  // SCOPE_ALL is always appended — it is just not visible in the inferred shape.
  const names: string[] = [...SEARCH_SOURCES.map((s) => s.name), SCOPE_ALL];
  return names as [string, ...string[]];
}

/**
 * Caller-natural synonyms → canonical source name.
 *
 * Every entry is grounded in the vocabulary the codebase ITSELF already uses for
 * that source (its docblock, its backing table, or this tool's own description),
 * never in a guess about what a caller might type. Keys are matched after
 * `normalizeScopeToken` below, so plural/`snake_case`/`camelCase`/hyphen variants
 * do NOT need their own rows — only genuine different-word synonyms do.
 */
const SCOPE_SYNONYMS: Readonly<Record<string, string>> = {
  // ./sources names session_turn "the episodic verbatim transcript index".
  transcript: 'session_turn',
  sessiontranscript: 'session_turn',
  // ./sources: "operator_turns has no workspace_id column…" — `turns` IS that table.
  operatorturn: 'turns',
  // search:fulltext's own description: scope:["work_item"] searches
  // "bug/change/task ISSUE titles+bodies" (the engineer_issues corpus).
  issue: 'work_item',
  // the coord_message source indexes coord:* traffic.
  coord: 'coord_message',
  coordmessage: 'coord_message',
};

/**
 * Fold case, separators, and a trailing plural so `session_turns`, `sessionTurn`,
 * `session-turn` and `SESSION_TURN` all reach the same key.
 *
 * The plural strip is deliberately last and deliberately naive (a single
 * trailing `s`): it exists so `transcripts`/`issues`/`decision` reach their
 * canonical row, not to stem English. It can only ever produce a LOOKUP key —
 * a token that resolves to nothing falls through untouched and is refused by the
 * enum as before, so a bad strip cannot invent an accepted value.
 */
function normalizeScopeToken(raw: string): string {
  const compact = raw.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return compact.endsWith('s') ? compact.slice(0, -1) : compact;
}

/**
 * Resolve one caller-supplied scope token to a canonical name, or return it
 * unchanged when nothing matches (so the enum produces the normal refusal).
 */
export function resolveScopeToken(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const canonical = new Map(scopeChoices().map((name) => [normalizeScopeToken(name), name]));
  const key = normalizeScopeToken(raw);
  // A CANONICAL match wins over the synonym table, mirroring `suggestArgName`'s
  // exact-declared-match precedence: the registry's own vocabulary can never be
  // overridden by an alias row, however this table later grows.
  return canonical.get(key) ?? SCOPE_SYNONYMS[key] ?? raw;
}

/**
 * The `scope` arg for both search tools: the canonical enum, with the synonym
 * fold applied BEFORE validation.
 *
 * `z.preprocess` is transparent to `z.toJSONSchema` (same property coord:send
 * relies on), so the advertised tool schema still shows the plain canonical enum
 * — callers are not taught two vocabularies, they are just no longer refused for
 * reaching for one obvious synonym.
 */
export function scopeArg() {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value.map(resolveScopeToken) : value),
    z.array(z.enum(scopeChoices())).optional(),
  );
}

/** The historic no-scope default: the four original prose surfaces (EI-6984). */
export const DEFAULT_SCOPE: readonly string[] = ['escalations', 'brainstorm', 'turns', 'decisions'];
