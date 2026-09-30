/**
 * The traffic-evidence BUFFER — pure, bounded, deduplicating. No I/O, no PG, no clock beyond
 * an injected `now`.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * WHY A BUFFER AT ALL, RATHER THAN WRITING A ROW PER CALL. A single integration test file can
 * drive hundreds of requests; a full suite drives millions. One INSERT per call would put a
 * network round-trip on the dispatcher's hot path — inside `runRouteStack`'s `finally` and the
 * MCP telemetry sink, both of which every production request also passes through. Collapsing
 * in memory first means the process writes O(distinct surface × test case) rows, not O(calls),
 * and the hot path costs a Map lookup.
 *
 * THE COLLAPSE KEY IS THE BINDING, NOT THE CALL: (kind, surfaceId, testFile, testCase). That is
 * precisely the question the census asks — "does a test case exercise this surface?" — so N
 * calls from one test case to one route are ONE fact observed N times, not N facts. `calls`
 * keeps the count so a later reader can still tell a route exercised once from one hammered
 * 400 times, which is the only thing the collapse would otherwise destroy.
 *
 * ⚠ VERDICT MERGE KEEPS THE WORST OUTCOME, NOT THE LAST. A test case that hits a route twice —
 * once getting a 200 and once a 500 — has evidence of a broken surface. Keeping the last
 * outcome makes that depend on call ORDER, so the same defect would report differently run to
 * run; keeping the worst is order-independent and can only ever over-report trouble, which is
 * the safe direction for a coverage signal. Asserted in `buffer.test.ts`.
 */

/** Outcome of exercising a surface, as this layer observes it. Mirrors the DB check constraint. */
export type EvidenceVerdict = 'pass' | 'fail' | 'error' | 'skip';

/**
 * Worst-first severity. `error` outranks `fail` because a surface that THREW is a stronger
 * signal than one that returned a failing-but-handled response.
 */
const VERDICT_SEVERITY: Readonly<Record<EvidenceVerdict, number>> = Object.freeze({
  error: 3,
  fail: 2,
  pass: 1,
  skip: 0,
});

/** One observation, as the dispatcher hooks report it. */
export interface TrafficObservation {
  /** Census surface kind — `http-route` | `mcp-tool`. Must match the provider that emitted it. */
  kind: string;
  /** Census surface identity, derived by the SAME rule the provider used. */
  surfaceId: string;
  verdict: EvidenceVerdict;
  runGroupId: string | null;
  testFile: string | null;
  testCase: string | null;
  /** TRUE only for machine-written suites (fuzz/crawl). Separates the L2 floor from L3 intent. */
  generated?: boolean;
  /** Free-form context kept on the row — HTTP status, tool error code, ... */
  details?: Record<string, unknown>;
}

/** A collapsed binding, ready to be written as one `coverage_evidence` row. */
export interface BufferedEvidence {
  kind: string;
  surfaceId: string;
  verdict: EvidenceVerdict;
  runGroupId: string | null;
  testFile: string | null;
  testCase: string | null;
  generated: boolean;
  /** How many observations collapsed into this binding. */
  calls: number;
  details: Record<string, unknown>;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface EvidenceBufferOptions {
  /**
   * Hard ceiling on DISTINCT bindings held in memory. Reached only by a pathological run
   * (every surface × every test case); past it new bindings are DROPPED and counted rather
   * than growing without bound inside a test process.
   */
  maxBindings?: number;
  now?: () => number;
}

const DEFAULT_MAX_BINDINGS = 20_000;

/**
 * Field separator for the collapse key.
 *
 * Built with `String.fromCharCode(0)` rather than typed as a literal control character: a raw
 * NUL byte in a .ts file makes every text tool (grep, diff, `file`, review UIs) classify the
 * file as BINARY and stop matching it — which is how a source file becomes invisible to the
 * very searches that would have caught a bug in it. (Measured here: the first draft of this
 * file did exactly that, and `grep -c ""` over it returned nothing while a control file on the
 * same command returned 143.) NUL is still the right VALUE — it cannot occur in a route path,
 * tool name, file path or test name, so no two distinct tuples can collide by concatenation,
 * where a `:` separator would let tool `a:b` collide with kind `a` + id `b`.
 */
const KEY_SEP = String.fromCharCode(0);

export function bindingKey(o: {
  kind: string;
  surfaceId: string;
  testFile: string | null;
  testCase: string | null;
}): string {
  return [o.kind, o.surfaceId, o.testFile ?? '', o.testCase ?? ''].join(KEY_SEP);
}

export class EvidenceBuffer {
  private readonly bindings = new Map<string, BufferedEvidence>();
  private readonly maxBindings: number;
  private readonly now: () => number;
  private droppedCount = 0;

  constructor(options: EvidenceBufferOptions = {}) {
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Record one observation. Returns false only when the buffer is full and the binding is new. */
  record(o: TrafficObservation): boolean {
    const key = bindingKey(o);
    const existing = this.bindings.get(key);
    const at = this.now();

    if (existing) {
      existing.calls += 1;
      existing.lastSeenMs = at;
      if (VERDICT_SEVERITY[o.verdict] > VERDICT_SEVERITY[existing.verdict]) {
        existing.verdict = o.verdict;
        // Carry the details of the WORST observation, so the row's context describes the
        // outcome the row reports rather than whichever call happened to land last.
        if (o.details) existing.details = { ...o.details };
      }
      // A binding is `generated` only if EVERY observation of it was: one hand-written test
      // exercising the surface is what the L3 intent tier is asking about, and a fuzzer running
      // over the same surface must not be able to erase that.
      existing.generated = existing.generated && (o.generated ?? false);
      return true;
    }

    if (this.bindings.size >= this.maxBindings) {
      this.droppedCount += 1;
      return false;
    }

    this.bindings.set(key, {
      kind: o.kind,
      surfaceId: o.surfaceId,
      verdict: o.verdict,
      runGroupId: o.runGroupId,
      testFile: o.testFile,
      testCase: o.testCase,
      generated: o.generated ?? false,
      calls: 1,
      details: o.details ? { ...o.details } : {},
      firstSeenMs: at,
      lastSeenMs: at,
    });
    return true;
  }

  get size(): number {
    return this.bindings.size;
  }

  /** Bindings refused because the buffer was full. Reported on flush so a drop is never silent. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Remove and return everything held. The buffer is empty afterwards. */
  drain(): BufferedEvidence[] {
    const out = [...this.bindings.values()];
    this.bindings.clear();
    return out;
  }

  /** Read without draining — for assertions and diagnostics. */
  peek(): BufferedEvidence[] {
    return [...this.bindings.values()];
  }

  clear(): void {
    this.bindings.clear();
    this.droppedCount = 0;
  }
}
