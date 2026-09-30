/**
 * Source scanners shared by the two halves of the degraded-provenance guard.
 *
 * WI-6382 established the SERVER rule (a `learning.*` catch must not return a
 * bare empty snapshot). WI-6410 found the other half: a resolver that faithfully
 * reports `unavailable` into a component that never reads it is EXACTLY as
 * broken as one that never reported it — the user sees the same confident empty
 * state either way, and the server guard is green throughout.
 *
 * The client guard needs to know which resolvers CAN report unavailability, so
 * it needs the server scanner. Extracting it here rather than re-implementing a
 * second, subtly-different walker is the point: two scanners that disagree about
 * what counts as a degraded return would let a resolver fall through the gap
 * between them, which is the same class of defect one level up.
 */

export interface CatchReturn {
  resolver: string;
  line: number;
  text: string;
}

/**
 * Walk a sync-resolver index source, tracking the current `'learning.*'`
 * resolver key and brace depth, and collect every `return` statement that sits
 * inside a `catch` block.
 */
export function collectCatchReturns(src: string): CatchReturn[] {
  const lines = src.split('\n');
  const out: CatchReturn[] = [];
  let resolver: string | null = null;
  let resolverDepth = -1;
  let depth = 0;
  // Depths at which a catch block opened (may nest).
  const catchDepths: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const code = line.replace(/\/\/.*$/, '');

    // A top-level resolver key: `  'learning.foo': {`
    const key = /^\s{2}'(learning\.[A-Za-z.]+)':\s*\{/.exec(line);
    if (key) {
      resolver = key[1];
      resolverDepth = depth;
    }

    const opensCatch = /\}\s*catch\s*\(/.test(code);

    for (const ch of code) {
      if (ch === '{') {
        depth++;
        if (opensCatch && catchDepths[catchDepths.length - 1] !== depth) {
          catchDepths.push(depth);
        }
      } else if (ch === '}') {
        if (catchDepths[catchDepths.length - 1] === depth) catchDepths.pop();
        depth--;
        if (resolver && depth <= resolverDepth) {
          resolver = null;
          resolverDepth = -1;
        }
      }
    }

    if (resolver && catchDepths.length > 0) {
      const ret = /^\s*return\s+(.+)$/.exec(code);
      if (ret) out.push({ resolver, line: i + 1, text: ret[1].trim() });
    }
  }
  return out;
}

/** A returned value that is a flat array literal — `[]`, or `[…]` of non-objects. */
export function isFlatArrayReturn(text: string): boolean {
  return /^\[\s*\]\s*;?$/.test(text);
}

/** A returned value that is an object snapshot wrapped in the helper. */
export function isDegradedReturn(text: string): boolean {
  return /^\[\s*degraded(Because)?\s*\(/.test(text);
}

/** A returned value that is an object snapshot — `[{ … }]` or `[SOME_EMPTY]`. */
export function isObjectSnapshotReturn(text: string): boolean {
  if (isFlatArrayReturn(text) || isDegradedReturn(text)) return false;
  return /^\[\s*\{/.test(text) || /^\[\s*[A-Z_][A-Z0-9_]*\s*\]/.test(text);
}

/**
 * The `learning.*` resolvers that CAN hand a client a degraded snapshot — i.e.
 * whose catch returns a `degraded(...)`-wrapped payload. This is precisely the
 * set whose consumers owe the user an honest failure state.
 */
export function degradedCapableResolvers(src: string): Set<string> {
  return new Set(
    collectCatchReturns(src)
      .filter((r) => isDegradedReturn(r.text))
      .map((r) => r.resolver),
  );
}

// ── Client half ────────────────────────────────────────────────────────────

export interface ClientQueryConsumer {
  /** The top-level component/hook the query is read inside. */
  component: string;
  file: string;
  line: number;
  queryNames: string[];
  /** How many distinct degraded-provenance reads the body performs. */
  faultChecks: number;
}

/**
 * Walk a client `.tsx` source and attribute each `queryName: "learning.X"` to
 * the top-level `function Foo(` / `const Foo = ` it sits inside, alongside a
 * count of how many degraded-provenance checks that body performs.
 *
 * The count matters, not merely presence: a component reading TWO
 * degraded-capable queries and calling `snapshotFault` ONCE is checking one and
 * silently trusting the other, which a boolean "does it handle faults" test
 * would wave through.
 */
export function collectClientQueryConsumers(src: string, file: string): ClientQueryConsumer[] {
  const lines = src.split('\n');
  const out: ClientQueryConsumer[] = [];
  let current: ClientQueryConsumer | null = null;

  // Attribution is by TOP-LEVEL DECLARATION BOUNDARY, deliberately not by brace
  // depth. The first cut of this scanner counted braces the way the server-side
  // one does, and in .tsx that is quietly wrong: a single unbalanced `{` in a
  // string literal, regex, or JSX comment desyncs the count for the rest of the
  // file, after which every later component is attributed to the first one. It
  // reported ONE consumer across the whole directory and every rule below passed
  // over the empty set — caught only because the non-blindness test asserts the
  // scanner SEES a realistic number first. In these files components are
  // declared at column 0 and everything inside them is indented, so "the nearest
  // preceding unindented declaration" is both simpler and strictly more robust.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const code = line.replace(/\/\/.*$/, '');

    const decl = /^(?:export\s+)?(?:function|const|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (decl) {
      current = {
        component: decl[1],
        file,
        line: i + 1,
        queryNames: [],
        faultChecks: 0,
      };
      out.push(current);
    }

    if (!current) continue;
    const q = /queryName:\s*"(learning\.[A-Za-z.]+)"/.exec(code);
    if (q) current.queryNames.push(q[1]);
    // The shared helper, or a hand-rolled read of the same provenance fields.
    if (/\bsnapshotFault\s*\(/.test(code)) current.faultChecks++;
    else if (/[?.]\.?unavailable\b/.test(code) || /\bdegradedFields\b/.test(code)) {
      current.faultChecks++;
    }
  }
  return out.filter((c) => c.queryNames.length > 0);
}
