/**
 * Structural shape fingerprint for a derived-read producer's output — the
 * detector behind WI-7289.
 *
 * ── The defect this exists to catch ──────────────────────────────────────────
 * `registry.ts`'s `producerVersion` is a hand-maintained integer: a snapshot
 * whose stored `producer_version` matches the registered one is served as-is
 * (registry.ts:204), and the write side refuses to downgrade it (registry.ts
 * :376-380). That makes the version bump the ONLY thing that makes a payload
 * SHAPE change self-enforcing — a superseded shape is treated as absent and
 * re-warmed, rather than served forever. Three producers shipped a shape
 * change WITHOUT bumping it and went inert for a full work-item cycle each
 * (learning.improvements/WI-7275+WI-7279, coord.history/WI-7295,
 * learning.observations/WI-7303, plans.lint/multiple) — every time with green
 * tests and clean types, because nothing tied the two facts together. Per
 * D-016, a detector needs a floor or it is prose exhortation in a costume; a
 * code comment saying "remember to bump this" is exactly the convention that
 * already failed three times.
 *
 * ── What this gives you ──────────────────────────────────────────────────────
 * `deriveShapeFingerprint` is a pure, deterministic, STRUCTURAL signature of a
 * value — the set of keys present, recursively, and for an array the UNION of
 * every element's keys (so a D-025 null-omitted field that merely happens to
 * be absent on one sample row doesn't register as a shape change on its own —
 * see the note on the function). It never looks at VALUES, only shape.
 *
 * `assertShapeMatchesRecordedVersion` pins a producer's REAL sample output to
 * its REGISTERED `producerVersion` (read live from the registry, never
 * duplicated as a second hardcoded literal) in a small checked-in
 * `expectedByVersion` map colocated with the test that already knows how to
 * build a representative sample:
 *   - the shape changes but the version doesn't move -> the map's entry for
 *     the (unchanged) CURRENT version stops matching the real sample -> the
 *     test fails, at the exact point where WI-7275/7279/7295/7303 shipped
 *     silently.
 *   - the version is bumped but nobody records what the new shape actually
 *     is -> no map entry for the new version -> fails with an actionable
 *     message, rather than silently passing on an unverified shape.
 *
 * This is deliberately TEST-ONLY (no production code path changes): every
 * shape here is only meaningfully knowable by actually running the real
 * compute — which read-time code must never do (registry.ts D-003) — but a
 * test is exactly where invoking it is free and already the house pattern
 * (producers.test.ts already calls `producer.compute()` directly, and each
 * delegate module's own test suite already calls the real narrowing function
 * with lower-level stubs — see e.g. learning-digest-snapshot.ts's
 * HUMAN_QUEUE_WIRE_FIELDS pin in learning-improvements.test.ts).
 */

/** Recursion guard against pathological/cyclic nesting; real payloads here are shallow. */
const MAX_DEPTH = 8;

/**
 * A pure structural signature of `value`: WHICH keys are present, recursively
 * — never their values. Two payloads with identical key structure but
 * different content fingerprint identically; a genuinely added, removed, or
 * renamed field does not.
 *
 * Arrays fingerprint as the UNION of every element's shape (not just the
 * first element), so an optional/D-025-omitted field that is merely absent on
 * SOME rows in a given sample still contributes its presence from whichever
 * rows do carry it — the union is what a consumer can actually see across
 * the whole snapshot, which is the thing that matters for wire-shape.
 */
export function deriveShapeFingerprint(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return 'deep';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'arr<empty>';
    const shapes = new Set(value.map((v) => deriveShapeFingerprint(v, depth + 1)));
    return `arr<${[...shapes].sort().join('|')}>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((k) => `${k}:${deriveShapeFingerprint((value as Record<string, unknown>)[k], depth + 1)}`);
    return `obj{${parts.join(',')}}`;
  }
  // Primitive: TYPE only, never the value — 'string' | 'number' | 'boolean' | ...
  return typeof value;
}

/**
 * Assert that a producer's CURRENTLY REGISTERED `producerVersion` has a
 * recorded expected shape, and that a real sample of its output still
 * matches it. See the module doc for what this catches and why it is
 * test-only.
 *
 * @param key              the producer's registry key, for the error message.
 * @param producerVersion  read LIVE from the registry (e.g.
 *                         `producer.producerVersion`) — never a second
 *                         hardcoded copy of the number in producers.ts, or
 *                         the two could drift from EACH OTHER too.
 * @param sample           a real, representative output value from the
 *                         producer's actual compute path (not an arbitrary
 *                         test double standing in for it — fingerprinting a
 *                         hand-invented mock only pins the mock).
 * @param expectedByVersion a small map, checked into the calling test file,
 *                         from producerVersion -> its recorded fingerprint.
 */
export function assertShapeMatchesRecordedVersion(opts: {
  key: string;
  producerVersion: number;
  sample: unknown;
  expectedByVersion: Record<number, string>;
}): void {
  const { key, producerVersion, sample, expectedByVersion } = opts;
  const actual = deriveShapeFingerprint(sample);
  const expected = expectedByVersion[producerVersion];
  if (expected === undefined) {
    throw new Error(
      `[shape-guard] '${key}' is registered at producerVersion ${producerVersion} (producers.ts) but has no ` +
        `recorded expected shape for it in this test's expectedByVersion map. If you just bumped the version, ` +
        `add expectedByVersion[${producerVersion}] = ${JSON.stringify(actual)} (the shape just computed) once ` +
        `you've confirmed it's the shape you intended to ship.`,
    );
  }
  if (expected !== actual) {
    throw new Error(
      `[shape-guard] '${key}''s computed output shape changed but producerVersion is still ${producerVersion} ` +
        `(producers.ts). A snapshot already stored at that version passes registry.ts:204's version check and ` +
        `keeps serving the SUPERSEDED shape indefinitely (WI-7289 — the exact WI-7275/WI-7279/WI-7295/WI-7303 ` +
        `trap). Bump producerVersion in producers.ts for '${key}', then add the new fingerprint under the new ` +
        `version key in this test's expectedByVersion map.\n` +
        `  expected (v${producerVersion}): ${expected}\n` +
        `  actual:            ${actual}`,
    );
  }
}
