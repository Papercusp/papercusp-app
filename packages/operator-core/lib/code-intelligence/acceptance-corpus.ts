/**
 * The FROZEN code-intelligence acceptance corpus (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-002).
 *
 * Every backend in the bakeoff — GitNexus, the thin in-operator LSP adapter,
 * `mcp-language-server`, OMP's native LSP, ripgrep, and the packers — answers
 * these same cases, and is scored on the same ground truth.
 *
 * ── The one rule that keeps this corpus honest ────────────────────────────
 * Ground truth here is MEASURED against this repo, never asserted from memory,
 * and it is pinned to a commit (`CORPUS_BASELINE_COMMIT`). Fixtures rot: files
 * move and line numbers drift, and a corpus that rots silently is worse than
 * no corpus, because it fails backends for the fixture's staleness instead of
 * their own defects. `acceptance-corpus.test.ts` therefore re-verifies every
 * pinned fixture against the CURRENT tree on every run, and reports drift as a
 * FIXTURE problem — loudly and separately from a backend problem.
 *
 * When a fixture legitimately drifts, re-measure and re-pin it; do not relax
 * the expectation to make a red go green.
 */

import type { CodeIntelBackend, CodeIntelIntent } from './contracts.ts';

/**
 * The commit the ground truth below was measured against.
 * Re-pin this together with any fixture re-measurement.
 */
export const CORPUS_BASELINE_COMMIT = 'e3dbfa8012b01a3df65a0dec91fc77f1e45109b5';
export const CORPUS_BASELINE_MEASURED_AT = '2026-10-05T21:30:41Z';

/**
 * A location this corpus asserts exists in the tree, ONE-indexed.
 * `symbolOnLine` is the literal text that must appear on `line1` — that is
 * what makes the pin self-verifying rather than a bare number that silently
 * drifts onto an unrelated line.
 */
export interface PinnedSite {
  readonly path: string;
  readonly line1: number;
  readonly symbolOnLine: string;
}

/** How a case is graded. */
export type GradeMode =
  /** Every expected site must appear; extras are a false-positive failure. */
  | 'exact-set'
  /** Every expected site must appear; extras are tolerated (recall test). */
  | 'must-contain'
  /** The case asserts a PROPERTY of the answer, not a specific site set. */
  | 'property';

export interface CorpusCase {
  /** Stable id — referenced by baselines, scorecards, and Decisions. */
  readonly id: string;
  /** The plan's numbered falsification case (1..14) this implements. */
  readonly planCase: number;
  readonly intent: CodeIntelIntent;
  readonly title: string;
  /** What the agent actually asks. */
  readonly query: string;
  readonly gradeMode: GradeMode;
  /** Ground truth, measured at CORPUS_BASELINE_COMMIT. Empty for property cases. */
  readonly expectedSites: readonly PinnedSite[];
  /** Backends eligible to answer; others are expected to decline, not guess. */
  readonly eligibleBackends: readonly CodeIntelBackend[];
  /** Why this case is in the corpus — the defect it is designed to catch. */
  readonly falsifies: string;
  /** Set when the case is known to FAIL a backend today; the value is evidence. */
  readonly knownFailures?: Readonly<Partial<Record<CodeIntelBackend, string>>>;
}

const TS_BACKENDS: readonly CodeIntelBackend[] = [
  'gitnexus',
  'lsp-adapter',
  'mcp-language-server',
  'omp-lsp',
];

/**
 * Names deliberately EXCLUDED from the runtime acceptance harness (WI-2143024).
 *
 * These appeared as acceptance aspirations without an observable subject. A
 * name does not become a metric until a runner can read the event/value it
 * claims to measure and a grader owns the comparison. Keeping the dispositions
 * here prevents a future title or report from silently presenting one as
 * measured; remove an entry only together with its real subject and grader.
 */
export const EXCLUDED_ACCEPTANCE_SIGNALS = Object.freeze([
  {
    name: 'tool failures',
    reason:
      'this harness observes backend answers; CodeIntelAnswer.error is not a tool-transport failure event',
  },
  {
    name: 'packer selection',
    reason:
      'the current code-intelligence layer has explicit packer facades but no selection decision or event to observe',
  },
  {
    name: 'downstream reads',
    reason:
      'the harness ends at the backend answer and has no instrumented downstream consumer-read event',
  },
  {
    name: 'result tokens',
    reason:
      'resultTokensMax is enforced at facade output boundaries; the runtime bench calls adapters directly and never sees the serialized tool result',
  },
] as const);

export const ACCEPTANCE_CORPUS: readonly CorpusCase[] = Object.freeze([
  // ── 1. Definition across a package boundary ────────────────────────────
  {
    id: 'definition-cross-package-bare-specifier',
    planCase: 1,
    intent: 'definition',
    title: 'Definition of a symbol imported by workspace bare specifier',
    query: 'pinModuleState',
    gradeMode: 'must-contain',
    expectedSites: [
      {
        path: 'libs/generic/module-singleton/src/index.ts',
        line1: 106,
        symbolOnLine: 'export function pinModuleState',
      },
    ],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'A backend that only does text matching, or that cannot follow the ' +
      'npm-workspace symlink from `@papercusp/module-singleton` to ' +
      'libs/generic/module-singleton, resolves this to an import line rather ' +
      'than the declaration.',
    knownFailures: {
      gitnexus:
        'Reports the correct file but line 105 (zero-indexed) and additionally ' +
        'surfaces apps/operator/dist-sidecar/embed-sidecar.mjs — a BUILD ARTIFACT ' +
        'that should be excluded from the index. Measured 2026-08-21 @ gitnexus 1.6.9.',
    },
  },

  // ── 2. References through a barrel / re-export ─────────────────────────
  {
    id: 'references-through-barrel-reexport',
    planCase: 2,
    intent: 'references',
    title: 'References to a symbol re-exported through a barrel index',
    query: 'PanelRegistry',
    gradeMode: 'must-contain',
    expectedSites: [
      {
        path: 'libs/generic/dock-workbench/src/panel-registry.ts',
        line1: 30,
        symbolOnLine: 'export class PanelRegistry',
      },
      {
        path: 'libs/generic/dock-workbench/src/index.ts',
        line1: 4,
        symbolOnLine: "export * from './panel-registry'",
      },
    ],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'A backend that stops at the barrel `export * from` and never reaches ' +
      'consumers importing through it returns a FALSE-EMPTY reference set — ' +
      'the most dangerous failure in the whole design, because an empty ' +
      'reference list reads as proof that nothing uses the symbol.',
  },

  // ── 3. Shadowed / same-named symbols must not cross-contaminate ────────
  {
    id: 'shadowed-symbol-no-cross-contamination',
    planCase: 3,
    intent: 'definition',
    title: 'A test mock sharing a name is not offered as a peer definition',
    query: 'managedSetInterval',
    gradeMode: 'exact-set',
    expectedSites: [
      {
        path: 'libs/generic/scheduled-registry/src/index.ts',
        line1: 410,
        symbolOnLine: 'export function managedSetInterval',
      },
    ],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'There is exactly ONE declaration of managedSetInterval in the tree. A ' +
      'backend that also returns the `vi.mock` factory property in ' +
      'predicate-watch.integration.test.ts is ranking a stub as a peer of the ' +
      'real definition, which sends an agent to edit a mock.',
    knownFailures: {
      gitnexus:
        'Returns status:"ambiguous" with 2 candidates — the real declaration ' +
        '(reported line 285, zero-indexed) AND the vi.mock factory property at ' +
        'predicate-watch.integration.test.ts (reported 39, true line 40), which ' +
        'is an object property, not a function declaration. Measured 2026-08-21.',
    },
  },

  // ── 4. Interface implementations / type definitions ────────────────────
  {
    id: 'rust-trait-implementations',
    planCase: 7,
    intent: 'implementations',
    title: 'Rust trait implementations across the Tauri crate',
    query: 'IpcStream',
    gradeMode: 'must-contain',
    expectedSites: [
      {
        path: 'papercusp-desktop/src-tauri/src/endpoint_ipc.rs',
        line1: 319,
        symbolOnLine: 'impl AsyncRead for IpcStream',
      },
      {
        path: 'papercusp-desktop/src-tauri/src/endpoint_ipc.rs',
        line1: 335,
        symbolOnLine: 'impl AsyncWrite for IpcStream',
      },
    ],
    eligibleBackends: ['lsp-adapter', 'mcp-language-server', 'omp-lsp', 'gitnexus'],
    falsifies:
      'Rust support is the half of the bakeoff most likely to be silently ' +
      'absent. A TypeScript-only backend must DECLINE this case, not answer ' +
      'it emptily.',
  },

  // ── 5. Callers of a real function ──────────────────────────────────────
  {
    id: 'callers-of-managed-spawn',
    planCase: 2,
    intent: 'callers',
    title: 'Callers of managedSpawn, excluding its own definition site',
    query: 'managedSpawn',
    gradeMode: 'must-contain',
    expectedSites: [
      {
        path: 'packages/operator-core/lib/voice-node/local-whisper-service.ts',
        line1: 411,
        symbolOnLine: 'await managedSpawn',
      },
      {
        path: 'packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts',
        line1: 353,
        symbolOnLine: 'await managedSpawn',
      },
    ],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'Call-graph backends are chosen over ripgrep precisely for this ' +
      'question. A backend that returns the definition site as a "caller", or ' +
      'that misses a call behind `await`, is not adding value over grep.',
    knownFailures: {
      gitnexus:
        'The status:"found" response shape omits `line` entirely (returns ' +
        'undefined) where the status:"ambiguous" shape carries it — so a ' +
        'successful single-hit lookup is LESS informative than an ambiguous ' +
        'one. Measured 2026-08-21 @ gitnexus 1.6.9.',
    },
  },

  // ── 6..14: property cases (graded on behaviour, not a site set) ────────
  {
    id: 'freshness-uncommitted-edit-visible',
    planCase: 6,
    intent: 'definition',
    title: 'An uncommitted on-disk edit becomes visible within a bounded window',
    query: '(runner writes a temp symbol, then queries for it)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'An index-backed backend can answer confidently from a stale graph. ' +
      'Either the edit is visible within the declared freshness window, or ' +
      'the backend reports staleVsDisk=true. Silently answering from a stale ' +
      'index while claiming health is a selection-disqualifying defect.',
  },
  {
    id: 'unhealthy-backend-never-returns-confident-empty',
    planCase: 8,
    intent: 'references',
    title: 'A crashed/OOM backend returns a loud error, never an empty list',
    query: '(runner kills the child mid-query)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'THE disqualifying failure. `isTrustworthyEmpty()` must be false for ' +
      'the answer: an empty result set with health!=healthy and error=null is ' +
      'indistinguishable from a true "no references" answer.',
  },
  {
    id: 'concurrent-reads-isolated',
    planCase: 9,
    intent: 'references',
    title: 'Concurrent queries from multiple agents stay isolated and correct',
    query: '(runner issues N concurrent distinct queries)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'A single shared stdio child multiplexing JSON-RPC ids can interleave ' +
      "responses under fleet load and hand agent A the answer to agent B's " +
      'question — a correctness failure that only appears under concurrency.',
  },
  {
    id: 'read-only-no-mutation',
    planCase: 10,
    intent: 'rename-preview',
    title: 'No backend modifies a file during read/preview operations',
    query: '(runner hashes the tree before and after the full corpus)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'A write that bypasses the PreToolUse lock arbitration silently clobbers ' +
      'a peer on this shared checkout. Mutation must be ABSENT, not merely ' +
      'unused — verified by tree hash, not by reading tool names.',
  },
  {
    id: 'truncation-is-explicit',
    planCase: 11,
    intent: 'references',
    title: 'Truncation is explicit and continuation preserves completeness',
    query: 'pinModuleState',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'pinModuleState has 143 reference lines across the tree — comfortably ' +
      'past any sane result cap. A backend that silently returns the first N ' +
      'without setting truncated=true converts a capped measurement into a ' +
      'confident wrong total.',
  },
  {
    id: 'code-run-orchestration-without-shell',
    planCase: 12,
    intent: 'references',
    title: 'code:run can chain lookup → references → diagnostics with no shell fallback',
    query: '(runner composes three calls in one code:run script)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'If the facade cannot be composed from code:run, agents fall back to ' +
      'bash — which is the exact routing failure this plan exists to fix.',
  },
  {
    id: 'resource-budget-measured-from-runtime',
    planCase: 13,
    intent: 'definition',
    title: 'Cold start, warm latency, RSS, child count, and index disk',
    query: '(runner measures from the actual runtime, not from docs)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'Every runtime figure named by this case must come from the running process ' +
      '(cgroup/proc), never from a vendor README. Budgets in DEFAULT_RESOURCE_BUDGET ' +
      'are ceilings. Signals the runner cannot observe are excluded rather than ' +
      'reported as measured; see EXCLUDED_ACCEPTANCE_SIGNALS.',
  },
  {
    id: 'cross-check-against-compiler',
    planCase: 14,
    intent: 'diagnostics',
    title: 'Sampled answers agree with tsc/rust-analyzer ground truth',
    query: '(runner samples answers and re-derives them from the compiler)',
    gradeMode: 'property',
    expectedSites: [],
    eligibleBackends: TS_BACKENDS,
    falsifies:
      'The corpus itself can be wrong. Sampling against the compiler is what ' +
      'keeps the fixtures honest rather than self-confirming.',
  },
]);

/** Every plan falsification case (1..14) that the corpus covers. */
export function coveredPlanCases(): number[] {
  return [...new Set(ACCEPTANCE_CORPUS.map((c) => c.planCase))].sort((a, b) => a - b);
}

export function corpusCase(id: string): CorpusCase | undefined {
  return ACCEPTANCE_CORPUS.find((c) => c.id === id);
}
