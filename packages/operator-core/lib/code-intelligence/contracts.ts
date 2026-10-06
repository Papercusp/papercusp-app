/**
 * Code-intelligence acceptance contracts (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-002).
 *
 * This module is the FROZEN half of the acceptance corpus: the result schema
 * every backend is normalized into, the freshness/health truth contract, the
 * resource budgets, and the read-only/lock invariants. The cases themselves
 * live in `./acceptance-corpus.ts`.
 *
 * Why a normalization layer exists at all — this is measured, not assumed:
 * backends disagree about what a "line" is. GitNexus 1.6.9 emits ZERO-indexed
 * lines (verified 2026-08-21 against three independent symbols; see
 * LINE_INDEX_BASE below), the LSP wire protocol is likewise zero-indexed by
 * spec, and grep/sed/editors are one-indexed. An agent that copies a raw line
 * number from one backend into a citation is silently off by one. Every answer
 * therefore enters the corpus through `toOneIndexed()`, and `SymbolSite.line1`
 * is one-indexed BY CONSTRUCTION so the type name itself carries the contract.
 */

/** Backends that can answer a code-intelligence question in this repo. */
export type CodeIntelBackend =
  | 'gitnexus'
  | 'lsp-adapter'
  | 'mcp-language-server'
  | 'omp-lsp'
  | 'ripgrep'
  | 'ast-grep'
  | 'repomix'
  | 'code2prompt';

/**
 * Safe fallback guidance for the text-search route.
 *
 * A repository-wide `rg --hidden` search is particularly noisy here because
 * generated public documentation and the per-checkout `.papercusp/` reports
 * and state artifacts contain large rendered snapshots of the source tree.
 * Keep the scope rule in one place so every code-intelligence refusal and
 * tool-routing hint gives the same actionable fallback.
 */
export const RIPGREP_SCOPE_GUIDANCE =
  'Probe `rg` in the target shell (`command -v rg >/dev/null 2>&1`) because client-private binaries may not be inherited; prefer ripgrep (`rg`); else POSIX `grep`/`grep -E`. In `rg`, use lowercase `-e`/`--regexp`; uppercase `-E` means `--encoding`. Scope searches to source roots (for example, `apps/operator/lib` and `packages/operator-core/lib`) or exclude `.papercusp`, `apps/operator/public/internal/docs`, `dist`, `node_modules`, and `.git`. Cap matching lines with ripgrep itself (e.g., `rg --max-count 60 --max-columns 256 --max-columns-preview ...`); avoid piping to early-exit consumers such as `head` under `pipefail`, which can SIGPIPE `rg` (exit 141).';

/**
 * Line-index base per backend, MEASURED not assumed.
 *
 * gitnexus: verified 2026-08-21 at gitnexus@1.6.9 against three independent
 * symbols, each reported exactly one BELOW its true one-indexed declaration
 * line:
 *   - `managedSetInterval` libs/generic/scheduled-registry/src/index.ts → 285 (true 286)
 *   - `pinModuleState`     libs/generic/module-singleton/src/index.ts   → 105 (true 106)
 *   - a `vi.mock` factory property in predicate-watch.integration.test.ts   → 39  (true 40)
 * lsp-*: zero-indexed by the Language Server Protocol specification
 * (`Position.line` is "line position in a document (zero-based)").
 * ripgrep/grep: one-indexed by POSIX convention.
 * ast-grep: ZERO-indexed, measured 2026-08-21 at ast-grep 0.45.1 (P-014). Its
 *   `--json=compact` match objects report `range.start.line` for a match on the
 *   FIRST line of a file as `0`. Worth stating because ast-grep is a grep-shaped
 *   tool by name and ergonomics, and every OTHER grep-shaped backend in this
 *   table is one-indexed — so the convention a reader would assume from the
 *   name is the opposite of the one it uses.
 */
export const LINE_INDEX_BASE: Readonly<Record<CodeIntelBackend, 0 | 1>> = Object.freeze({
  gitnexus: 0,
  'lsp-adapter': 0,
  'mcp-language-server': 0,
  'omp-lsp': 0,
  ripgrep: 1,
  'ast-grep': 0,
  repomix: 1,
  code2prompt: 1,
});

/**
 * GitNexus raw `startLine` base PER VERSION — the version-aware companion to
 * `LINE_INDEX_BASE.gitnexus` (WI-10005091 residue of plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13 D-002).
 *
 * `LINE_INDEX_BASE.gitnexus` is a single number, which is only true for the
 * pinned install (`PINNED_GITNEXUS_VERSION`, 1.6.9). GitNexus 1.6.12 reports a
 * 1-BASED `startLine`, so `toOneIndexed('gitnexus', …)`'s unconditional +1 would
 * put EVERY site one line late and an exact path:line consumer would score 0 by
 * construction (the bench's attempt 2 did exactly that). Measured on ONE source
 * tree, `getLongLivedAdminPool` (declared on 1-based line 145 of
 * long-lived-admin-pool.ts): raw `startLine` 144 on 1.6.9, 145 on 1.6.12.
 *
 * A version absent from this table is UNMEASURED: `gitnexusStartLineBase`
 * returns null and callers must refuse rather than guess. Adding a version here
 * requires re-measuring it against the fixture above — never infer it from a
 * neighbouring release. `contracts.test.ts` pins the pinned version to this
 * table so a pin bump cannot ship without the measurement.
 */
export const GITNEXUS_START_LINE_BASE_BY_VERSION: Readonly<Record<string, 0 | 1>> = Object.freeze({
  '1.6.9': 0,
  '1.6.12': 1,
});

/**
 * Raw `startLine` base for a GitNexus version string (`1.6.9`, or a banner such
 * as `GitNexus Analyzer (1.6.12)` — the first `x.y.z` found wins). Returns null
 * for an unparseable or UNMEASURED version, never a default.
 */
export function gitnexusStartLineBase(version: string | null | undefined): 0 | 1 | null {
  const m = typeof version === 'string' ? /(\d+\.\d+\.\d+)/.exec(version) : null;
  if (!m) return null;
  const base = GITNEXUS_START_LINE_BASE_BY_VERSION[m[1]!];
  return base === undefined ? null : base;
}

/**
 * Normalize a backend-reported line to the one-indexed convention every human
 * tool in this repo uses. Pass the RAW number exactly as the backend returned
 * it. Returns null for a missing line so a caller cannot silently turn an
 * absent line into line 1 (GitNexus's `status:"found"` shape omits `line`
 * entirely — see CORPUS case `schema-found-shape-carries-line`).
 */
export function toOneIndexed(
  backend: CodeIntelBackend,
  rawLine: number | null | undefined,
): number | null {
  if (rawLine === null || rawLine === undefined) return null;
  if (!Number.isFinite(rawLine)) return null;
  const base = LINE_INDEX_BASE[backend];
  const oneIndexed = base === 0 ? rawLine + 1 : rawLine;
  // A backend that reports a negative or zero line after normalization is
  // reporting garbage; surface it as absent rather than as a real location.
  return oneIndexed >= 1 ? oneIndexed : null;
}

/** One resolved location for a symbol, always one-indexed. */
export interface SymbolSite {
  /** Repo-relative path, POSIX separators. */
  readonly path: string;
  /** ONE-indexed line. Null when the backend did not report one. */
  readonly line1: number | null;
  /** Backend-reported symbol kind, lowercased ('function', 'class', ...). */
  readonly kind: string | null;
  /**
   * Optional human-readable detail for sites that carry one: a diagnostic's
   * message, a workspace-symbol's container, a rename edit's replacement text.
   *
   * OPTIONAL by construction — the frozen corpus (P-002) constructs sites
   * without it and must keep typechecking, and a required field here would
   * strand every existing call site. Absence means "this backend/intent has no
   * detail to give", never "the detail was empty".
   */
  readonly detail?: string | null;
  /**
   * The symbol's own name, on sites that name a symbol (a workspace-symbol
   * hit). OPTIONAL for the same reason as `detail`. Exact-name questions need
   * it: tsserver's symbol search is fuzzy, so a hit's location alone cannot say
   * whether it IS the symbol that was asked for.
   */
  readonly name?: string | null;
}

/** Whether returned matches were cut off. This says nothing about index coverage. */
export interface Truncation {
  /** True when the backend cut the result set. Never infer this from length. */
  readonly truncated: boolean;
  /** Total matches the backend claims exist, when it says. */
  readonly totalAvailable: number | null;
  /** Opaque continuation token, when the backend supports pagination. */
  readonly continuation: string | null;
}

/**
 * Freshness/health truth contract.
 *
 * The load-bearing rule (plan corpus case 8): a backend that is unhealthy MUST
 * say so. A confident empty list from a crashed or stale backend is the single
 * most dangerous failure mode in the whole routing design, because it is
 * indistinguishable from a true "no references" answer and it reads as proof
 * of absence. `health` is therefore REQUIRED on every answer and
 * `'unknown'` is a legitimate, branchable value — never coerce it to healthy.
 */
export type BackendHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface Freshness {
  readonly health: BackendHealth;
  /** When the backend's index/state was last updated, ISO-8601, or null. */
  readonly indexedAt: string | null;
  /**
   * True when the backend has observed on-disk edits not yet in its index.
   * Null when the backend cannot tell — which is itself a corpus failure for
   * any backend claiming a bounded freshness window (corpus case 6).
   */
  readonly staleVsDisk: boolean | null;
  /** Commit the index was built against, when the backend records one. */
  readonly indexedCommit: string | null;
}

/** The normalized answer shape every backend is scored against. */
export interface CodeIntelAnswer {
  readonly backend: CodeIntelBackend;
  readonly intent: CodeIntelIntent;
  readonly query: string;
  readonly sites: readonly SymbolSite[];
  readonly truncation: Truncation;
  readonly freshness: Freshness;
  /**
   * Scope of the evidence, independently of health, freshness and output limits.
   * Omission on a legacy producer means unmeasured, never source completeness.
   */
  readonly coverage?: {
    readonly basis: 'indexed-code' | 'compiler-project';
    readonly sourceCompleteness: 'unverified';
    readonly limitations: readonly string[];
  };
  /** Wall-clock milliseconds for this single call. */
  readonly latencyMs: number;
  /**
   * Set when the backend failed. A failed answer with `sites: []` MUST carry
   * this — that is what separates "it broke" from "there are none".
   */
  readonly error: string | null;
}

/** The question kinds the routing table dispatches on. */
export type CodeIntelIntent =
  | 'definition'
  | 'references'
  | 'implementations'
  | 'callers'
  | 'callees'
  | 'impact'
  | 'rename-preview'
  | 'diagnostics'
  /**
   * Find a symbol by NAME across the workspace (LSP `workspace/symbol`).
   * Distinct from 'text-search': the backend matches declared symbols, not
   * arbitrary text, so a comment mentioning the name is not a hit.
   */
  | 'symbol-search'
  | 'structural-search'
  | 'text-search'
  | 'pack';

/**
 * Legacy honesty predicate for the corpus runner. `true` includes explicit
 * failures and means the answer reports its state; it NEVER proves absence or
 * exhaustive references. Check coverage, scope and independent source evidence.
 */
export function isTrustworthyEmpty(answer: CodeIntelAnswer): boolean {
  if (answer.sites.length > 0) return true;
  if (answer.error !== null) return true; // loud failure — honest
  // An empty answer is only trustworthy from a backend that affirmatively
  // claims health. 'unknown' and 'degraded' empties are NOT evidence of
  // absence.
  return answer.freshness.health === 'healthy';
}

/**
 * Resource budgets, per backend process, under fleet load.
 *
 * These are CEILINGS for production selection, not measured values — the
 * measured baseline is recorded by the corpus runner. A backend that cannot be
 * bounded to these fails selection (plan: "cannot bound memory/process
 * multiplication under fleet load").
 */
export interface ResourceBudget {
  readonly coldStartMsMax: number;
  readonly warmQueryMsMax: number;
  readonly rssMbMax: number;
  /** Max long-lived child processes per workspace. */
  readonly childProcMax: number;
  /**
   * Max on-disk index footprint per backend, for the WHOLE index — not one
   * file of it. Graded by {@link classifyIndexDisk}; breaches that are real,
   * measured and accepted are recorded in {@link KNOWN_INDEX_DISK_EXCEEDANCES}
   * rather than by raising this number.
   *
   * Backends whose index is in memory (the LSP adapter: tsserver holds the
   * project graph in-process, which is why its failure mode is V8 old-space
   * exhaustion — WI-2142693) have NO subject for this budget. They grade
   * `not-measured`, never `within-budget`: an unmeasured subject that reports
   * a pass is the defect this budget was already an instance of (WI-2142942).
   */
  readonly indexDiskMbMax: number;
  /** Max tokens a single tool result may put into an agent's context. */
  readonly resultTokensMax: number;
}

export const DEFAULT_RESOURCE_BUDGET: Readonly<ResourceBudget> = Object.freeze({
  coldStartMsMax: 10_000,
  warmQueryMsMax: 1_500,
  rssMbMax: 1_024,
  childProcMax: 1,
  indexDiskMbMax: 2_048,
  resultTokensMax: 1_500,
});

/**
 * Index-disk breaches that are MEASURED, ACCOUNTED, and BOUNDED.
 *
 * The exact analogue of `KNOWN_RSS_EXCEEDANCES` in `code-intel-bench.ts`, and
 * for the same reason: `indexDiskMbMax` is a frozen P-002 contract and is NOT
 * raised to fit the backend it is meant to judge — a budget edited to match
 * its subject stops being a budget. Deleting it would be the same move in a
 * politer costume: the honest answer to a failing check is "this is real,
 * here is its size and why we accept it for now", never "assert less".
 *
 * What this buys, versus the dead field it replaces (WI-2142942): the breach
 * becomes an input to backend selection instead of a silenced assertion, and
 * it stays BOUNDED — growth past `observedCeilingMb` fails, so accepting
 * today's footprint is not accepting unbounded growth.
 */
export interface KnownIndexDiskExceedance {
  readonly backend: string;
  readonly observedMb: number;
  /** Fails if the index grows past this — the exceedance stays bounded. */
  readonly observedCeilingMb: number;
  readonly why: string;
}

export const KNOWN_INDEX_DISK_EXCEEDANCES: readonly KnownIndexDiskExceedance[] = Object.freeze([
  Object.freeze({
    backend: 'gitnexus',
    observedMb: 6_558,
    observedCeilingMb: 10_240,
    why:
      'MEASURED 2026-09-03 on this checkout: `.gitnexus/` totals 6558MB — 3.2x ' +
      'the 2048MB budget. It decomposes as lbug 4946MB (the LadybugDB file), ' +
      'parsedfile-cache 1132MB and parse-cache 475MB. gitnexus derives its ' +
      'index from the whole tree and grows with it, so it CANNOT be bounded to ' +
      '2048MB on this repo. Recorded as a selection input rather than hidden. ' +
      'NOTE the instrument gap this exposes: `measureGitnexusDbUsage` stats the ' +
      'lbug FILE alone, against a different quantity (the 16GiB mmap cliff), so ' +
      'the 1607MB of parse caches is invisible to every pre-existing measurement.',
  }),
]);

/** How an index-disk footprint graded against `indexDiskMbMax`. */
export type IndexDiskVerdict =
  | {
      readonly backend: string;
      readonly status: 'not-measured';
      readonly budgetMb: number;
      /** Why no verdict was reached. NEVER collapses to a pass. */
      readonly reason: string;
    }
  | {
      readonly backend: string;
      readonly status: 'within-budget' | 'accepted-exceedance' | 'over-ceiling';
      readonly budgetMb: number;
      readonly measuredMb: number;
      /** The bounded allowance that applied, or null when none is recorded. */
      readonly acceptedCeilingMb: number | null;
    };

/**
 * Grade one backend's on-disk index footprint against `indexDiskMbMax`.
 *
 * `indexDiskMbMax` was a DEAD budget field until WI-2142942 — declared in
 * `ResourceBudget`, given a value, and compared in ZERO places, while every
 * sibling budget was either graded or consumed. A budget nothing compares
 * against cannot fail, so it reads as a standing guarantee: the contract
 * advertised that this layer holds indexes to 2GiB while the selected backend
 * sat at 3.2x that, and nothing anywhere said so. Same defect, and same fix,
 * as `warmQueryMsMax` in WI-2142923.
 *
 * The two failure modes this is built to refuse, in order of how easily they
 * slip through:
 *
 *   1. An UNMEASURED subject grading as a pass. A backend whose index is in
 *      memory has no footprint to measure, and reporting "0MB, within budget"
 *      for it would be strictly worse than the dead field — a false guarantee
 *      with evidence attached. It grades `not-measured`, carrying the reason.
 *   2. A TRUNCATED measurement grading as a pass. `dirSizeBytes` is bounded by
 *      `maxEntries` and an optional wall-clock deadline, and returns a PARTIAL
 *      total when it stops early. A partial total can only ever UNDER-count,
 *      which turns a real breach into a clean-looking pass, so a truncated
 *      walk is `not-measured` too — never graded.
 *
 * The budget and the exceedance set are both injectable so a control can prove
 * the guard fails without depending on the production constants' values.
 */
export function classifyIndexDisk(
  backend: string,
  measuredMb: number | null,
  opts: {
    readonly truncated?: boolean;
    readonly budgetMb?: number;
    readonly exceedances?: readonly KnownIndexDiskExceedance[];
  } = {},
): IndexDiskVerdict {
  const budgetMb = opts.budgetMb ?? DEFAULT_RESOURCE_BUDGET.indexDiskMbMax;
  const exceedances = opts.exceedances ?? KNOWN_INDEX_DISK_EXCEEDANCES;

  if (measuredMb === null) {
    return {
      backend,
      status: 'not-measured',
      budgetMb,
      reason: `no on-disk index footprint was measured for '${backend}'`,
    };
  }
  if (opts.truncated === true) {
    return {
      backend,
      status: 'not-measured',
      budgetMb,
      reason:
        `the directory walk for '${backend}' stopped early, so ${measuredMb}MB is a ` +
        'partial total that can only under-count; refusing to grade it',
    };
  }

  const allowance = exceedances.find((e) => e.backend === backend) ?? null;
  if (measuredMb <= budgetMb) {
    return {
      backend,
      status: 'within-budget',
      budgetMb,
      measuredMb,
      acceptedCeilingMb: allowance?.observedCeilingMb ?? null,
    };
  }
  if (allowance !== null && measuredMb <= allowance.observedCeilingMb) {
    return {
      backend,
      status: 'accepted-exceedance',
      budgetMb,
      measuredMb,
      acceptedCeilingMb: allowance.observedCeilingMb,
    };
  }
  return {
    backend,
    status: 'over-ceiling',
    budgetMb,
    measuredMb,
    acceptedCeilingMb: allowance?.observedCeilingMb ?? null,
  };
}

/**
 * Read-only / lock invariants (plan corpus cases 10 and 13).
 *
 * The code-intelligence layer is a READ plane. Any backend exposing a tool
 * that mutates the tree bypasses the `PreToolUse` lock arbitration that keeps
 * this shared checkout collision-free, so mutation must be absent rather than
 * merely unused.
 */
export const FORBIDDEN_MUTATING_TOOL_PATTERNS: readonly RegExp[] = Object.freeze([
  // `rename` ALONE is not enough: a real backend names it `rename_symbol`,
  // which /^rename$/ waved straight through. Prefix-anchored, so an unrelated
  // op like `refactor_preview` is untouched.
  /^rename/i,
  // `edit` as a leading or trailing word-part. Together these subsume the
  // former /^apply[_-]?edit$/ and /^workspace[_-]?edit$/ while also catching
  // `edit_file` (snake, leading) and `applyEdit` (camel, trailing) — the two
  // spellings a single exact-anchored pattern cannot both cover.
  /(^|[_-])edit/i,
  /edit$/i,
  /write/i,
  /delete/i,
  /^format/i,
  /^fix/i,
]);

/**
 * Tools that are allowed to CARRY a mutating name because they only ever
 * return a preview. Keep this list tiny and justified; each entry is a
 * promise the corpus verifies by asserting the tree is byte-identical after
 * the call (corpus case `read-only-no-mutation`).
 */
export const PREVIEW_ONLY_ALLOWLIST: readonly string[] = Object.freeze([
  // GitNexus `rename` returns a rename PLAN (affected sites) and never writes.
  // Verified by the no-mutation corpus case, not by its name.
  'rename',
]);

export function isMutatingToolName(name: string): boolean {
  if (PREVIEW_ONLY_ALLOWLIST.includes(name)) return false;
  return FORBIDDEN_MUTATING_TOOL_PATTERNS.some((re) => re.test(name));
}
