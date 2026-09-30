/**
 * Pattern awaits (event-await-discoverability-and-coverage-2026-07-03 P-201).
 *
 * `events:await` normally waits on an EXACT key. A pattern await waits on a KEY
 * PATTERN, so a fleet leader registers ONE await for "any lane item finished"
 * instead of N one-per-item awaits. Two authoring forms, both normalized to a
 * glob whose `*` matches any run of characters:
 *
 *   - a raw GLOB — `work-item:done:*`, `service:up:*`
 *   - a friendly MACRO — `@plan:<slug>`  → `plan-item:done:<slug>:*`  (any item in that plan finished)
 *                        `@fleet:<slug>` → `fleet:*:<slug>`           (any fleet event for that slug)
 *
 * Matching REUSES @papercusp/rules' mingo-backed `matches` operator — the SAME
 * leaf evaluator the ECA reaction engine's `when` uses (plan D-002 / P-201) — so
 * pattern semantics stay consistent with rule conditions: the glob compiles to an
 * anchored `matches` OperatorTest and is evaluated by `evaluateOperatorTest`. We
 * do NOT hand-roll a second regex/glob matcher.
 *
 * Pure. No I/O. `store.fireAwaitsForKey` uses `keyMatchesPattern` to fire pattern
 * awaits alongside exact-key awaits; the `events:await` tool uses `isPattern` /
 * `expandPatternMacro` / `assertUsablePattern` at registration.
 */

import {
  evaluateOperatorTest,
  evaluateDataCondition,
  isPlainObject,
  type OperatorTest,
  type DataCondition,
} from '@papercusp/rules';

/**
 * A registered event key is a PATTERN (not an exact key) iff it contains a glob
 * `*` or is a friendly `@macro:...` form. Exact keys are colon-delimited idents
 * (`work-item:done:WI-12`, `session:compacted:su-x`) — they never contain `*`
 * and never start with `@`, so this classification is unambiguous.
 */
export function isPattern(key: string): boolean {
  return typeof key === 'string' && (key.includes('*') || key.startsWith('@'));
}

/**
 * Expand a friendly macro to its concrete glob; pass a raw glob (or an exact key)
 * through unchanged. The macro targets are GROUNDED against the catalog key
 * schemes (catalog.ts): plan items are `plan-item:done:<slug>:<id>`, fleet events
 * are `fleet:<verb>:<slug>`. An unknown `@macro` THROWS — a typo'd macro must fail
 * loudly at registration, never silently store a key that can never match.
 */
export function expandPatternMacro(key: string): string {
  // WI-3309/EI-8413: guard a malformed (non-string) key rather than crashing —
  // callers on a best-effort emit path (fireAwaitsForKey) must never throw on
  // bad candidate data; see the store.ts call-site comment for the concrete repro.
  if (typeof key !== 'string') return key;
  if (!key.startsWith('@')) return key;
  const plan = /^@plan:(.+)$/.exec(key);
  if (plan) return `plan-item:done:${plan[1]}:*`;
  const fleet = /^@fleet:(.+)$/.exec(key);
  if (fleet) return `fleet:*:${fleet[1]}`;
  throw new Error(
    `events:await — unknown pattern macro '${key}'. Known macros: @plan:<slug>, @fleet:<slug>. ` +
      `Or pass a raw glob, e.g. 'work-item:done:*'.`,
  );
}

/** Escape every regex metacharacter EXCEPT `*` (the one glob wildcard we honor). */
function escapeExceptStar(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a glob (already macro-expanded) to the anchored `matches` OperatorTest
 * the rules mingo evaluator consumes. `*` → `.*`; every other character is
 * literal (escaped). The whole key is anchored (`^…$`) so a glob matches the
 * ENTIRE key, never a substring.
 */
export function patternToOperatorTest(glob: string): OperatorTest {
  const source = '^' + escapeExceptStar(glob).replace(/\*/g, '.*') + '$';
  return { matches: source };
}

/**
 * Does a fired EXACT key match a stored PATTERN? Reuses the ECA engine's leaf
 * evaluator (mingo `$regex`) so a pattern await matches exactly what a rule
 * `when: { key: { matches } }` would. A non-pattern `pattern` (no `*` after macro
 * expansion) degrades to plain string equality — a safe no-op for exact keys that
 * slip into the pattern candidate set.
 */
export function keyMatchesPattern(pattern: string, firedKey: string): boolean {
  // WI-3309/EI-8413: a malformed (non-string) candidate can never match anything —
  // degrade to false rather than throwing (see store.ts's fireAwaitsForKey call site).
  if (typeof pattern !== 'string') return false;
  const glob = expandPatternMacro(pattern);
  if (!glob.includes('*')) return glob === firedKey;
  return evaluateOperatorTest(patternToOperatorTest(glob), firedKey);
}

/**
 * Normalize the compact comparison aliases used by the older predicate-watch
 * surface before evaluating a persisted event-await filter.  `event_awaits`
 * rows predate the shared rules vocabulary and some durable rows therefore
 * carry `{ eq: value }` / `{ ne: value }`, while `evaluateDataCondition` only
 * recognizes the canonical `{ equals: value }` / `{ notEquals: value }` form.
 * Keep this compatibility at the await boundary instead of widening the
 * generic rules vocabulary; new callers should continue to use the canonical
 * names documented by `dataConditionSchema`.
 */
function normalizeLegacyPayloadFilter(filter: unknown): unknown {
  if (Array.isArray(filter)) return filter.map(normalizeLegacyPayloadFilter);
  if (!isPlainObject(filter)) return filter;

  const keys = Object.keys(filter);
  if (keys.length === 1) {
    const key = keys[0]!;
    const value = filter[key];
    if (key === 'all' || key === 'any') {
      return { [key]: Array.isArray(value) ? value.map(normalizeLegacyPayloadFilter) : value };
    }
    if (key === 'not') return { not: normalizeLegacyPayloadFilter(value) };
    if (key === 'some' && isPlainObject(value)) {
      const spec = { ...value };
      if (Array.isArray(spec.of)) spec.of = spec.of.map(normalizeLegacyPayloadFilter);
      return { some: spec };
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [path, test] of Object.entries(filter)) {
    if (isPlainObject(test) && ('eq' in test || 'ne' in test)) {
      const leaf = { ...test } as Record<string, unknown>;
      if ('eq' in leaf && !('equals' in leaf)) {
        leaf.equals = leaf.eq;
        delete leaf.eq;
      }
      if ('ne' in leaf && !('notEquals' in leaf)) {
        leaf.notEquals = leaf.ne;
        delete leaf.ne;
      }
      normalized[path] = leaf;
    } else {
      // Match-map values are opaque payload values unless they are an explicit
      // combinator; traversing them would change a legitimate object equality
      // test into a different condition.
      normalized[path] = test;
    }
  }
  return normalized;
}

/**
 * Does an emitted PAYLOAD satisfy a watch's payload_filter (EI-8998)? Reuses
 * `evaluateDataCondition` — the SAME MatchMap/`all`/`any`/`some`/`not` vocabulary
 * an ECA rule's `when` evaluates (incl. the P-001 `some:{require,of}` k-of-n) — so
 * predicate-watch semantics stay consistent
 * with rule conditions, same as keyMatchesPattern does for key globs above. A
 * null/undefined filter always matches (no predicate registered). A malformed
 * filter (author bug, e.g. not stored as a plain object) degrades to `false`
 * rather than throwing — mirrors keyMatchesPattern's malformed-candidate
 * guard: a best-effort emit path (fireAwaitsForKey) must never crash on bad
 * candidate data, and a filter that can't be evaluated can never usefully
 * match.
 */
export function payloadMatchesFilter(filter: unknown, payload: unknown): boolean {
  if (filter == null) return true;
  // A DataCondition must be a plain object (a MatchMap, or a sole all/any/not key) —
  // reject anything else UP FRONT rather than handing it to evaluateDataCondition,
  // whose MatchMap branch would otherwise treat a non-object's enumerable keys (e.g. a
  // string's character indices) as paths and can vacuously "match" nothing-to-fail-on.
  if (!isPlainObject(filter)) return false;
  try {
    return evaluateDataCondition(normalizeLegacyPayloadFilter(filter) as DataCondition, payload);
  } catch {
    return false;
  }
}

/**
 * The literal, wildcard-free key PREFIX of a glob — everything before its first
 * `*`, trimmed back to a whole `:` segment boundary. Used to turn a pattern into
 * an index-backed prefix scan over the fire latch (`event_key_fires`), which is
 * then narrowed with the exact `keyMatchesPattern` semantics above.
 *
 *   `release:green:*`  → `release:green`
 *   `fleet:*:my-slug`  → `fleet`
 *   `*:papercusp`      → ``          (no anchorable prefix — caller must bound the scan)
 *
 * Returns `''` when the glob starts with a wildcard: there is no prefix to
 * anchor on, and a caller must NOT turn that into an unbounded scan.
 */
export function patternLiteralPrefix(glob: string): string {
  if (typeof glob !== 'string') return '';
  const star = glob.indexOf('*');
  const literal = star === -1 ? glob : glob.slice(0, star);
  // Trim back to the last complete segment: a partial segment (`release:gr`)
  // would under-match a prefix scan that assumes segment boundaries.
  const cut = literal.lastIndexOf(':');
  if (cut === -1) return star === -1 ? literal : '';
  return literal.slice(0, cut);
}

/**
 * Reject a too-broad glob at registration. A pattern that is only wildcards and
 * separators (`*`, `*:*`) would match nearly every emit and wake-storm the
 * subscriber, so we require at least a few literal (non-`*`, non-`:`) characters
 * to anchor it. Throws — the caller surfaces the message.
 */
export function assertUsablePattern(glob: string): void {
  const literal = glob.replace(/[*:]/g, '');
  if (literal.length < 3) {
    throw new Error(
      `events:await — pattern '${glob}' is too broad (it would wake on nearly every event). ` +
        `Anchor it with a concrete prefix, e.g. 'work-item:done:*' or '@plan:<slug>'.`,
    );
  }
}
