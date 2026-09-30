/**
 * `gitnexusFacade` — the GitNexus half of the read-only code-intelligence
 * plane (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-006).
 *
 * This is the sibling of `lsp-facade.ts` and deliberately mirrors its shape:
 * a frozen op list, an intent map, one entry point that returns a
 * `CodeIntelAnswer` for EVERY outcome, and a budget applier that records the
 * pre-cut total. Read that module first; the rails are the same and are not
 * re-argued here.
 *
 * ── What is different about GitNexus, and why it needs its own rail ────────
 * The LSP facade's dangerous failure is a CONFIDENT EMPTY: a dead server
 * answering `[]` that reads as proof of absence. GitNexus has that failure
 * too, but it also has a second one that is strictly worse and that the
 * contracts did not previously name — CONFIDENT NOISE.
 *
 * Measured 2026-08-21 at gitnexus 1.6.9 against a freshly built index, with a
 * nonsense-symbol control on every call (plan D-021):
 *
 *   search_query('pinModuleState')                 -> 20 defs, top hits `a`, `b`
 *   search_query('zzz_no_such_symbol_control_zzz')  -> 20 defs, top hits
 *                                                     `rankByFrequency`, `mixedLengthCorpus`
 *
 * A symbol that does not exist returns twenty confident-looking rows. Passing
 * the wrong argument name produced BYTE-IDENTICAL output, which independently
 * proves the search term is never applied. So `query`/`cypher` cannot be
 * routed for symbol lookup — not because they fail, but because their success
 * and their failure are indistinguishable.
 *
 * `isTrustworthyEmpty()` in contracts.ts cannot catch this: the answer is not
 * empty. That is why routability here is a STATIC allowlist (`ROUTABLE_OPS`)
 * rather than a property inferred from a response. An engine whose output does
 * not vary with its input is not a backend you can validate per-call; it is
 * one you refuse by construction.
 *
 * ── Refusals name the alternative ─────────────────────────────────────────
 * A refusal that just says "unsupported" pushes the agent back to guessing,
 * and the guess is usually `grep -r` over the whole tree. Every refusal here
 * carries `useInstead`, so the answer to "GitNexus cannot do this" is always
 * "...and here is what does."
 */

import {
  type BackendHealth,
  type CodeIntelAnswer,
  type CodeIntelIntent,
  RIPGREP_SCOPE_GUIDANCE,
  type SymbolSite,
  toOneIndexed,
} from './contracts';

/** The read-only operations this facade exposes. */
export type GitnexusFacadeOp =
  /** Exact symbol lookup by name (+ optional kind) — GitNexus `context`. */
  | 'symbol'
  /** Who calls this symbol — the `incoming.calls` edges of `context`. */
  | 'callers'
  /** What this symbol calls — the `outgoing` edges of `context`. */
  | 'callees'
  /** Blast radius of changing a symbol — GitNexus `impact`. */
  | 'impact'
  /** Backend liveness + index freshness, with no query. */
  | 'health';

export const GITNEXUS_FACADE_OPS: readonly GitnexusFacadeOp[] = Object.freeze([
  'symbol',
  'callers',
  'callees',
  'impact',
  'health',
]);

const INTENT_BY_OP: Record<GitnexusFacadeOp, CodeIntelIntent> = {
  symbol: 'definition',
  callers: 'callers',
  callees: 'callees',
  impact: 'impact',
  health: 'diagnostics',
};

/**
 * Intents GitNexus must REFUSE, each with the thing that actually answers it.
 *
 * Keyed by intent rather than by op so a caller routing on `CodeIntelIntent`
 * (the corpus does) gets the refusal without having to know GitNexus's tool
 * names. `reason` is stated as an observation, not a verdict, so a future
 * measurement can overturn it without the text having to be re-argued.
 */
export const GITNEXUS_NOT_ROUTABLE: Readonly<
  Partial<Record<CodeIntelIntent, { reason: string; useInstead: string }>>
> = Object.freeze({
  'text-search': {
    reason:
      'GitNexus indexes declared symbols and their edges, not arbitrary text. ' +
      'Its `query` tool looks like a text search and is not one: measured ' +
      '2026-08-21, a nonsense symbol returns 20 confident-looking results ' +
      '(plan D-021).',
    useInstead: RIPGREP_SCOPE_GUIDANCE,
  },
  references: {
    reason:
      'GitNexus has no reference index that discriminates by input. `query` ' +
      'returns unranked rows whose content does not vary with the search ' +
      'term, so a reference list built from it cannot be trusted (D-021). ' +
      'Callers specifically ARE available via op:"callers".',
    useInstead:
      'lsp:query { op:"references" } for compiler-accurate references, or ' +
      'gitnexus op:"callers" if you specifically want call edges.',
  },
  'symbol-search': {
    reason:
      'Fuzzy symbol search maps onto `query`, which does not apply the search ' +
      'term (D-021). Exact-name lookup is supported — use op:"symbol".',
    useInstead:
      'lsp:query { op:"workspace_symbols" }, or gitnexus op:"symbol" when you ' +
      'know the exact name.',
  },
  'rename-preview': {
    reason:
      'GitNexus `rename` is dropped by the bridge\'s read-only rail before a ' +
      'tool definition is built, so it is not callable from this plane.',
    useInstead: 'lsp:query { op:"refactor_preview" }.',
  },
  'structural-search': {
    reason: 'Not implemented by GitNexus.',
    useInstead: 'ast-grep for structural/AST patterns.',
  },
  diagnostics: {
    reason:
      'GitNexus is a graph index, not a compiler — it has no diagnostics. The ' +
      'facade DOES expose op:"health" (backend liveness + index freshness), ' +
      'but that answers "can I trust this backend", not "what is wrong with ' +
      'this file". Routing diagnostics to a liveness probe would return a ' +
      'healthy-looking empty for a file full of type errors.',
    useInstead: 'lsp:query { op:"diagnostics" } for real compiler diagnostics.',
  },
  implementations: {
    reason:
      'GitNexus exposes no implementations/trait-impl tool (the 1.6.9 catalog ' +
      'is list_repos, query, cypher, context, detect_changes, check, impact, ' +
      'explain, pdg_query, route_map, tool_map, shape_check, api_impact, ' +
      'group_list, trace), and nothing here has been MEASURED answering it. ' +
      'Per D-021 an intent is not routed to this backend on the strength of a ' +
      'plausible-looking tool name — only on a measurement carrying a ' +
      'nonsense-input control.',
    useInstead:
      'lsp:query { op:"implementations" } — rust-analyzer for Rust traits, ' +
      'tsserver for TS interfaces.',
  },
});

/**
 * The context budget for one answer. Mirrors the LSP facade's cap so a router
 * swapping backends does not silently change how much a caller receives.
 */
export const MAX_SITES_PER_ANSWER = 100;

/**
 * One call into the GitNexus MCP bridge. Injected rather than imported so
 * operator-core does not reach into a plugin's file layout, and so tests can
 * drive the facade without spawning a child.
 */
export interface GitnexusDispatch {
  (tool: string, args: Record<string, unknown>): Promise<unknown>;
}

let dispatchImpl: GitnexusDispatch | null = null;

/**
 * Host seam. The operator wires the real plugin dispatcher at boot; tests
 * inject a stub. Unconfigured is a REFUSAL, never a silent empty — an
 * unconfigured backend that answered `[]` would be indistinguishable from a
 * healthy backend with nothing to say, which is the whole failure this plane
 * exists to prevent.
 */
export function configureGitnexusDispatch(impl: GitnexusDispatch | null): void {
  dispatchImpl = impl;
}

/**
 * PROCESS-LOCAL dispatch/refusal counts. NOT the adoption measurement.
 *
 * These were introduced as "adoption telemetry", and that framing was wrong in
 * a way worth naming, because it is the same mistake one rung up from the one
 * this module already guards. The counters live in a module global: they reset
 * on every restart, they are invisible across the ~100 processes that actually
 * call this plane, and outside this file's own unit test nothing has ever read
 * them. A number nobody can read cannot measure adoption.
 *
 * The real measurement already exists and is durable — `tool_invocations`
 * records every `graph:query` call with its args, so per-op adoption is
 * DERIVED rather than hand-maintained (CLAUDE.md, "derive, pin, or attest"):
 *
 *   SELECT args_json->>'op' AS op, count(*), count(DISTINCT coord_owner_id)
 *     FROM harness_shared.tool_invocations
 *    WHERE workspace_id = 'papercusp-workspace' AND tool_name = 'graph:query'
 *    GROUP BY 1 ORDER BY 2 DESC;
 *
 * Measured 2026-09-02: 42 `graph:query` calls from 9 distinct callers, all 42
 * carrying `op` — against 90 raw `gitnexus.context` calls from 14 callers. The
 * uncurated plane is still ahead, which is precisely the fact P-006 wanted
 * visible, and it is visible today with no new surface.
 *
 * Keep these counters for what they honestly are: an in-process probe the unit
 * tests assert against. Do not report them as adoption, and do not build a
 * reporting surface on top of them — extend the ledger query instead.
 */
export interface GitnexusAdoptionCounters {
  dispatched: number;
  refused: number;
  failed: number;
  byOp: Record<string, number>;
  refusedByIntent: Record<string, number>;
}

const counters: GitnexusAdoptionCounters = {
  dispatched: 0,
  refused: 0,
  failed: 0,
  byOp: {},
  refusedByIntent: {},
};

/** Snapshot of adoption counters (copied — callers cannot mutate the source). */
export function gitnexusAdoptionSnapshot(): GitnexusAdoptionCounters {
  return {
    ...counters,
    byOp: { ...counters.byOp },
    refusedByIntent: { ...counters.refusedByIntent },
  };
}

export function _resetGitnexusAdoptionCountersForTests(): void {
  counters.dispatched = 0;
  counters.refused = 0;
  counters.failed = 0;
  for (const k of Object.keys(counters.byOp)) delete counters.byOp[k];
  for (const k of Object.keys(counters.refusedByIntent)) {
    delete counters.refusedByIntent[k];
  }
}

export interface GitnexusFacadeArgs {
  /** Symbol name. Required for every op except `health`. */
  name?: string;
  /** Optional GitNexus symbol kind ('Function', 'Class', ...). */
  kind?: string;
  /** `impact` only: which way to walk the graph. Defaults to 'downstream'. */
  direction?: 'upstream' | 'downstream' | 'both';
  /** Repository name in the GitNexus index. */
  repo?: string;
  /** Cap on returned sites. Clamped to MAX_SITES_PER_ANSWER. */
  limit?: number;
}

function answer(
  op: GitnexusFacadeOp,
  query: string,
  startedAt: number,
  parts: {
    sites?: readonly SymbolSite[];
    health: BackendHealth;
    error?: string | null;
    indexedAt?: string | null;
    indexedCommit?: string | null;
    staleVsDisk?: boolean | null;
    totalAvailable?: number | null;
    truncated?: boolean;
  },
): CodeIntelAnswer {
  return {
    backend: 'gitnexus',
    intent: INTENT_BY_OP[op],
    query,
    sites: parts.sites ?? [],
    truncation: {
      truncated: parts.truncated ?? false,
      totalAvailable: parts.totalAvailable ?? null,
      continuation: null,
    },
    freshness: {
      health: parts.health,
      indexedAt: parts.indexedAt ?? null,
      staleVsDisk: parts.staleVsDisk ?? null,
      indexedCommit: parts.indexedCommit ?? null,
    },
    coverage: {
      basis: 'indexed-code',
      sourceCompleteness: 'unverified',
      limitations: ['Index freshness and output limits do not establish source completeness; corroborate relevant consumers in current source or official LSP.'],
    },
    latencyMs: Date.now() - startedAt,
    error: parts.error ?? null,
  };
}

/**
 * Build the refusal for an intent GitNexus must not answer.
 *
 * `health:'unknown'` is deliberate and load-bearing. The backend was never
 * consulted, so claiming 'healthy' would assert something unmeasured, and
 * `isTrustworthyEmpty()` would then read the empty site list as proof of
 * absence. 'unknown' + a non-null `error` makes the refusal honest under the
 * frozen contract without needing a new field.
 */
export function gitnexusRefusal(
  intent: CodeIntelIntent,
  query: string,
  startedAt: number = Date.now(),
): CodeIntelAnswer | null {
  const entry = GITNEXUS_NOT_ROUTABLE[intent];
  if (!entry) return null;
  counters.refused += 1;
  counters.refusedByIntent[intent] = (counters.refusedByIntent[intent] ?? 0) + 1;
  return {
    backend: 'gitnexus',
    intent,
    query,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: {
      health: 'unknown',
      indexedAt: null,
      staleVsDisk: null,
      indexedCommit: null,
    },
    latencyMs: Date.now() - startedAt,
    error: `gitnexus does not answer '${intent}': ${entry.reason} Use instead: ${entry.useInstead}`,
  };
}

/**
 * The bridge decorates every result with a human-readable freshness note. It
 * is prose, so parse it defensively: a miss yields `null`/'unknown' rather
 * than a confident default. `staleVsDisk` is only set to `true` on the
 * explicit "HEAD has moved since" phrase — inferring it from a timestamp
 * comparison would be a guess dressed as a measurement.
 */
export function parseFreshnessNote(text: string): {
  indexedCommit: string | null;
  staleVsDisk: boolean | null;
} {
  const commit = /at commit ([0-9a-f]{7,40})/i.exec(text);
  const moved = /HEAD has moved since/i.test(text);
  return {
    indexedCommit: commit?.[1] ?? null,
    staleVsDisk: moved ? true : null,
  };
}

/**
 * The bridge's response budget, measured from the runtime rather than assumed
 * (`RESPONSE_BUDGET_CHARS` was 20000 on 2026-08-21).
 */
export const OBSERVED_RESPONSE_BUDGET_CHARS = 20_000;

/**
 * The ONE wording for "the budget cut this answer".
 *
 * This is a function rather than two hand-written strings because the two call
 * sites below (`impact`, and the shared `context` path) previously spelled the
 * same contract three different ways — "TRUNCATED answer, not an empty one",
 * "TRUNCATED, not empty", and a third variant hand-copied into the test's
 * regex, which then failed against a message that was in fact correct. The
 * contract is one sentence; it gets one source.
 *
 * The load-bearing half is the second clause. A truncated answer that reads as
 * empty inverts the finding — the largest blast radii are precisely what
 * overflow the budget — so the notice must deny emptiness explicitly, and
 * `gitnexus-facade.test.ts` asserts that it does.
 */
export function truncationNotice(op: GitnexusFacadeOp): string {
  return (
    `gitnexus ${op} exceeded the ${OBSERVED_RESPONSE_BUDGET_CHARS}-char response ` +
    'budget and was cut mid-JSON, so the result could not be parsed. This is a ' +
    'TRUNCATED answer, not an empty one — re-run with a smaller `limit` ' +
    '(limit:5 parses; limit:100 does not).'
  );
}

/**
 * Extract the JSON body the bridge returns ahead of its markdown decoration.
 *
 * ⚠ The budget cut is applied to the SERIALIZED JSON and does not preserve
 * validity: a large `impact` answer (20,383 chars) comes back sliced at
 * exactly 20,000, mid-string, and `JSON.parse` fails with "Bad control
 * character in string literal ... at position 20000". Measured 2026-08-21.
 *
 * That distinction matters more than it looks. A parse failure caused by
 * TRUNCATION means "there was an answer and you got part of it"; a parse
 * failure caused by anything else means "the backend is malformed". Reporting
 * the first as the second sends the reader to debug the wrong system — which
 * is exactly what this facade did on its first run, reporting a truncated
 * impact answer as "returned no impactedCount", i.e. as an absence.
 */
function parseEnvelope(raw: unknown): {
  json: Record<string, unknown> | null;
  text: string;
  truncated: boolean;
} {
  const content = (raw as { content?: Array<{ text?: string }> } | null)?.content;
  const text = String(content?.[0]?.text ?? (typeof raw === 'string' ? raw : ''));
  const head = text.split('\n---')[0];
  try {
    const parsed = JSON.parse(head) as unknown;
    return {
      json: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null,
      text,
      truncated: false,
    };
  } catch {
    // Attribute the failure only when the evidence supports it: the payload
    // reached the budget. Below it, an unparseable body is a real malformation
    // and must not be excused as truncation.
    const truncated = head.length >= OBSERVED_RESPONSE_BUDGET_CHARS;
    return { json: null, text, truncated };
  }
}

interface GnxSymbol {
  uid?: string;
  name?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
}

interface IndexHealth {
  freshness: {
    health: BackendHealth;
    indexedAt: string | null;
    staleVsDisk: boolean | null;
    indexedCommit: string | null;
  };
  /** Non-null only when the index-health probe was itself unmeasured. */
  error: string | null;
}

function unknownIndexHealth(error: string): IndexHealth {
  return {
    freshness: {
      health: 'unknown',
      indexedAt: null,
      staleVsDisk: null,
      indexedCommit: null,
    },
    error,
  };
}

/**
 * Parse the authoritative `list_repos` health response.
 *
 * The bridge decorates query responses with a best-effort prose note, but the
 * note is intentionally omitted for fresh positive hits. `list_repos` is the
 * structured source of truth, so every facade call probes it once and carries
 * the same freshness envelope onto hits, misses, and the dedicated health op.
 */
function parseIndexHealth(raw: unknown, repo: string): IndexHealth {
  const { json, text, truncated } = parseEnvelope(raw);
  if (!json) {
    return unknownIndexHealth(
      truncated
        ? truncationNotice('health')
        : `gitnexus list_repos returned an unparseable envelope: ${text.slice(0, 200)}`,
    );
  }

  const repositories = Array.isArray(json.repositories) ? json.repositories : [];
  const entry = repositories.find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === 'object' && candidate.name === repo,
  );
  if (!entry) {
    return unknownIndexHealth(
      `gitnexus list_repos did not report repository '${repo}'; index health is UNMEASURED. ` +
        'Do not treat graph results as current.',
    );
  }

  const indexedAt = typeof entry.indexedAt === 'string' ? entry.indexedAt : null;
  const indexedCommit = typeof entry.lastCommit === 'string' ? entry.lastCommit.slice(0, 40) : null;
  const staleness = entry.staleness;
  const commitsBehind =
    staleness !== null && typeof staleness === 'object'
      ? (staleness as { commitsBehind?: unknown }).commitsBehind
      : undefined;
  if (typeof commitsBehind !== 'number' || !Number.isFinite(commitsBehind) || commitsBehind < 0) {
    return unknownIndexHealth(
      `gitnexus list_repos returned repository '${repo}' without a valid staleness.commitsBehind ` +
        'value; index health is UNMEASURED. Do not treat graph results as current.',
    );
  }

  const staleVsDisk = commitsBehind > 0;
  return {
    freshness: {
      health: staleVsDisk ? 'degraded' : 'healthy',
      indexedAt,
      staleVsDisk,
      indexedCommit,
    },
    error: null,
  };
}

async function readIndexHealth(dispatch: GitnexusDispatch, repo: string): Promise<IndexHealth> {
  try {
    // list_repos enumerates the bridge's structured registry. Filter by repo
    // locally because the upstream tool's schema does not take a repo name.
    return parseIndexHealth(await dispatch('list_repos', {}), repo);
  } catch (e) {
    return unknownIndexHealth(
      `gitnexus list_repos health probe threw: ${e instanceof Error ? e.message : String(e)}. ` +
        'Index health is UNMEASURED; do not treat graph results as current.',
    );
  }
}

function joinErrors(...errors: Array<string | null | undefined>): string | null {
  const present = errors.filter((error): error is string => Boolean(error));
  return present.length > 0 ? present.join(' ') : null;
}

async function enrichEdge(
  edge: GnxSymbol,
  dispatch: GitnexusDispatch,
  repo: string,
): Promise<GnxSymbol> {
  // GitNexus's edge rows often carry only uid/name/filePath. Resolve the UID
  // through context so callers and callees are navigable without a second
  // grep. Keep the original edge when the enrichment call is unavailable or
  // returns a mismatched symbol; a bad side probe must not rewrite topology.
  if (!edge.uid || (edge.kind !== undefined && edge.startLine !== undefined)) return edge;
  try {
    const { json } = parseEnvelope(await dispatch('context', { uid: edge.uid, repo }));
    const symbol = json?.symbol;
    if (!symbol || typeof symbol !== 'object') return edge;
    const detail = symbol as GnxSymbol;
    if (detail.uid && detail.uid !== edge.uid) return edge;
    return {
      ...edge,
      name: edge.name ?? detail.name,
      kind: edge.kind ?? detail.kind,
      filePath: edge.filePath ?? detail.filePath,
      startLine: edge.startLine ?? detail.startLine,
    };
  } catch {
    return edge;
  }
}

/**
 * The wording for a graph edge that points at a FILE rather than a call site.
 *
 * One source, because the label is the whole fix: without it a file row is
 * rendered `{ path, line1: null, kind: null, detail: 'index.test.ts' }`, which
 * reads as "a caller named index.test.ts".
 */
export const FILE_LEVEL_EDGE_DETAIL =
  'file-level graph edge — GitNexus links this FILE to the symbol; it is NOT a resolved call site';

/** A caller/callee answer, split by what the graph actually resolved. */
interface EdgeSites {
  sites: SymbolSite[];
  /** Edges that resolved to a real symbol with a line. */
  callSiteCount: number;
  /** Edges that are file nodes — no line, no kind, not a call site. */
  fileEdgeCount: number;
}

/**
 * Split `incoming.calls` / `outgoing.*` into resolved call sites and file-level
 * edges, and LABEL the second kind so it cannot be read as the first.
 *
 * ── The measurement (2026-09-02, gitnexus 1.6.9, HEAD acab51f9) ────────────
 * Every raw edge row carries only `{uid, name, filePath}` — no `kind`, no
 * `startLine` — so each is enriched through `context({uid})`. That call returns
 * `status:'found'` for BOTH node kinds, but only a symbol node carries a line:
 *
 *   uid '.../index.test.ts:make' -> symbol { name:'make', kind:'Function', startLine:71 }
 *   uid '.../index.test.ts'      -> symbol { name:'index.test.ts' }   // no kind, no line
 *   uid '.../pinned-subject.fixture.ts' -> symbol { name:'pinned-subject.fixture.ts' }
 *
 * So `callers('pinModuleState')` returned THREE rows of which one was a real
 * caller, and `index.test.ts` appeared twice — once as the true caller `make`
 * at line 72, once as the bare containing file. The only tell was an
 * unexplained `line1: null`.
 *
 * That is the failure this module's own header names — a result whose success
 * and whose noise are indistinguishable — reproduced one layer up. Enrichment
 * "succeeding" with nothing to add is precisely the shape that hides it.
 *
 * File edges are KEPT (they are real graph facts, and dropping data silently is
 * the other way to lie) but are labelled and sorted after the resolved sites,
 * and the caller is told the split through `error`.
 */
async function sitesFromEdges(
  edges: GnxSymbol[],
  dispatch: GitnexusDispatch,
  repo: string,
): Promise<EdgeSites> {
  const enriched = await Promise.all(edges.map((edge) => enrichEdge(edge, dispatch, repo)));

  const callSites: SymbolSite[] = [];
  const fileEdges: SymbolSite[] = [];

  for (const edge of enriched) {
    // Resolution is judged on the LINE, not on the dispatch outcome: a file
    // node answers `status:'found'` with no line, so "the probe succeeded" is
    // not evidence that a call site was located.
    const resolved = typeof edge.startLine === 'number' && Number.isFinite(edge.startLine);
    const site = resolved
      ? siteOf(edge, edge.name)
      : siteOf({ ...edge, kind: 'file' }, FILE_LEVEL_EDGE_DETAIL);
    if (!site) continue;
    (resolved ? callSites : fileEdges).push(site);
  }

  return {
    // Resolved call sites lead, so the answer to the question asked comes
    // first and a `limit` cut keeps the call sites rather than the files.
    sites: [...callSites, ...fileEdges],
    callSiteCount: callSites.length,
    fileEdgeCount: fileEdges.length,
  };
}

/**
 * The caveat for an edge answer that is partly file-level.
 *
 * Non-null `error` beside non-empty `sites` is this facade's existing channel
 * for "here is an answer, and here is what is wrong with it" (the stale-index
 * note uses it the same way), so the split rides there rather than overloading
 * `truncation`, whose `totalAvailable` means "rows before the cut".
 */
export function fileEdgeNotice(
  op: GitnexusFacadeOp,
  callSiteCount: number,
  fileEdgeCount: number,
): string | null {
  if (fileEdgeCount <= 0) return null;
  const total = callSiteCount + fileEdgeCount;
  return (
    `gitnexus ${op} returned ${total} edge(s): ${callSiteCount} resolved call site(s) and ` +
    `${fileEdgeCount} FILE-level edge(s) carrying no line. The file rows are listed last, ` +
    `with kind:"file". Do not count them as ${op} — the same file can appear both as a ` +
    'resolved site and as a file edge, so counting rows overstates the real total.'
  );
}

/**
 * GitNexus reports ZERO-INDEXED lines (D-008, re-verified 2026-08-21:
 * `pinModuleState` at a true line 106 came back as 105). Every line leaves
 * this module through `toOneIndexed`, so a cited line matches `grep -n`.
 */
function siteOf(s: GnxSymbol | undefined, detail?: string): SymbolSite | null {
  if (!s?.filePath) return null;
  return {
    path: s.filePath,
    line1: toOneIndexed('gitnexus', s.startLine),
    kind: s.kind ? String(s.kind).toLowerCase() : null,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function applyBudget(a: CodeIntelAnswer, limit: number): CodeIntelAnswer {
  if (a.sites.length <= limit) return a;
  return {
    ...a,
    sites: a.sites.slice(0, limit),
    truncation: {
      truncated: true,
      // PRE-CUT total, so a capped 100 is never mistaken for a true 100.
      totalAvailable: a.truncation.totalAvailable ?? a.sites.length,
      continuation: null,
    },
  };
}

/**
 * The single entry point. Returns a `CodeIntelAnswer` for every outcome,
 * including refusals and failures — a caller never has to catch.
 */
export async function gitnexusFacade(
  op: GitnexusFacadeOp,
  args: GitnexusFacadeArgs = {},
  dispatch?: GitnexusDispatch | null,
): Promise<CodeIntelAnswer> {
  // WI-40206/D-057: prefer a dispatcher supplied by THIS call over the module
  // global. The real dispatcher is request-scoped (it closes over the calling
  // tool's `ctx`, which carries workspace + principal), so a tool handler that
  // configured the global would publish its own request context to every
  // concurrent caller. Passing it per call keeps that scoping race-free; the
  // global remains for tests and for any future boot-time wiring.
  const activeDispatch = dispatch ?? dispatchImpl;
  const startedAt = Date.now();
  const query = args.name ?? '';
  const limit = Math.min(Math.max(1, args.limit ?? MAX_SITES_PER_ANSWER), MAX_SITES_PER_ANSWER);

  if (!GITNEXUS_FACADE_OPS.includes(op)) {
    counters.failed += 1;
    return answer('symbol', query, startedAt, {
      health: 'unknown',
      error: `unknown gitnexus op '${op}'. Valid ops: ${GITNEXUS_FACADE_OPS.join(', ')}.`,
    });
  }

  if (!activeDispatch) {
    counters.failed += 1;
    return answer(op, query, startedAt, {
      health: 'unknown',
      error:
        'gitnexus dispatch is not configured in this process (no dispatcher was ' +
        'passed to gitnexusFacade and configureGitnexusDispatch was never called). ' +
        'This is a wiring fault, not an empty result — do not read it as "no matches".',
    });
  }

  if (op !== 'health' && !query) {
    counters.failed += 1;
    return answer(op, query, startedAt, {
      health: 'unknown',
      error: `gitnexus op '${op}' requires a symbol name.`,
    });
  }

  counters.dispatched += 1;
  counters.byOp[op] = (counters.byOp[op] ?? 0) + 1;

  const repo = args.repo ?? 'papercusp';

  try {
    // Freshness is a property of the index, not of whether this particular
    // query happened to hit. Probe it before every operation so a positive hit
    // cannot silently turn a stale graph into `health:"healthy"`.
    const indexHealth = await readIndexHealth(activeDispatch, repo);

    if (op === 'health') {
      return answer(op, query, startedAt, {
        ...indexHealth.freshness,
        error: indexHealth.error,
      });
    }

    if (op === 'impact') {
      // BOTH `target` and `direction` are required upstream. Omitting
      // `direction` does not error — it returns an envelope whose fields are
      // undefined, which is why the default is explicit here rather than left
      // to the server (measured 2026-08-21).
      const raw = await activeDispatch('impact', {
        target: query,
        direction: args.direction ?? 'downstream',
        repo,
        limit,
      });
      const { json, truncated } = parseEnvelope(raw);

      if (truncated) {
        // Explicit truncation, per the Truncation contract: say the answer was
        // cut. Do NOT present this as zero impact — a large blast radius is
        // precisely what overflows the budget, so the truncated case
        // correlates with the HIGHEST-risk answers.
        return answer(op, query, startedAt, {
          health: 'degraded',
          truncated: true,
          totalAvailable: null,
          indexedAt: indexHealth.freshness.indexedAt,
          staleVsDisk: indexHealth.freshness.staleVsDisk,
          indexedCommit: indexHealth.freshness.indexedCommit,
          error: joinErrors(indexHealth.error, truncationNotice(op)),
        });
      }

      const upstreamError = typeof json?.error === 'string' ? json.error : null;
      if (upstreamError) {
        // An unknown target returns an explicit error rather than an empty
        // set — an honest failure, and it must stay one.
        return answer(op, query, startedAt, {
          ...indexHealth.freshness,
          error: joinErrors(indexHealth.error, upstreamError),
        });
      }

      const impacted = typeof json?.impactedCount === 'number' ? json.impactedCount : null;
      const risk = typeof json?.risk === 'string' ? json.risk : null;
      return answer(op, query, startedAt, {
        ...indexHealth.freshness,
        // `impact` answers a COUNT + risk grade, not a site list. The count
        // rides on totalAvailable and the grade on the site detail, so an
        // empty `sites` here is structural rather than an absence claim.
        sites: risk
          ? [{ path: '(impact summary)', line1: null, kind: 'impact', detail: `risk=${risk}` }]
          : [],
        totalAvailable: impacted,
        error: joinErrors(
          indexHealth.error,
          impacted === null
            ? 'gitnexus impact returned no impactedCount; treat this as unmeasured, not zero.'
            : null,
        ),
      });
    }

    // symbol | callers | callees read through `context`.
    const raw = await activeDispatch('context', {
      name: query,
      ...(args.kind ? { kind: args.kind } : {}),
      repo,
    });
    const { json, text, truncated } = parseEnvelope(raw);

    if (!json) {
      counters.failed += 1;
      return answer(op, query, startedAt, {
        health: truncated ? 'degraded' : 'unhealthy',
        indexedAt: indexHealth.freshness.indexedAt,
        staleVsDisk: indexHealth.freshness.staleVsDisk,
        indexedCommit: indexHealth.freshness.indexedCommit,
        truncated,
        error: joinErrors(
          indexHealth.error,
          truncated
            ? truncationNotice(op)
            : `gitnexus returned an unparseable envelope: ${text.slice(0, 200)}`,
        ),
      });
    }

    const status = typeof json.status === 'string' ? json.status : null;

    if (status !== 'found') {
      // Exact-index omissions exist: even a fresh, untruncated miss cannot
      // establish source absence. Preserve ambiguity and failures separately.
      const candidates = Array.isArray(json.candidates) ? json.candidates.slice(0, 5) : [];
      const ambiguity = candidates.map((candidate: GnxSymbol) =>
        [candidate.uid, candidate.filePath, candidate.name].filter(Boolean).join(' '),
      ).filter(Boolean).join('; ');
      const missing = status === 'not_found' || status === 'not-found';
      const ambiguous = status === 'ambiguous';
      const reason = ambiguous
        ? `gitnexus symbol is ambiguous${ambiguity ? `: ${ambiguity}` : ''}. Resolve the production symbol with gitnexus.context { uid or file_path } and corroborate current source.`
        : missing
          ? 'gitnexus did not find this symbol in its index; source existence is unverified. Check scoped rg or official LSP, including source at indexedCommit, before concluding absence.'
          : `gitnexus context failed or returned an unrecognized status (${status ?? 'missing'}): ${typeof json.error === 'string' ? json.error : 'no valid found/not_found/ambiguous status'}. Use scoped rg or official LSP.`;
      return answer(op, query, startedAt, {
        ...indexHealth.freshness,
        ...(!missing && !ambiguous ? { health: 'unhealthy' as const } : {}),
        sites: [],
        error: joinErrors(
          indexHealth.error,
          reason,
          indexHealth.freshness.staleVsDisk === true
            ? 'gitnexus index is behind HEAD; a symbol written since the last ' +
                'analyze is reported identically to one that does not exist. ' +
                'Confirm with rg before concluding absence.'
            : null,
        ),
      });
    }

    const sym = json.symbol as GnxSymbol | undefined;
    let sites: SymbolSite[] = [];
    let edgeNotice: string | null = null;

    if (op === 'symbol') {
      const s = siteOf(sym);
      if (s) sites = [s];
      else edgeNotice = 'gitnexus reported found without a usable symbol location; verify in current source.';
    } else if (op === 'callers') {
      const incoming = (json.incoming as { calls?: GnxSymbol[] } | undefined)?.calls ?? [];
      const resolved = await sitesFromEdges(incoming, activeDispatch, repo);
      sites = resolved.sites;
      edgeNotice = fileEdgeNotice(op, resolved.callSiteCount, resolved.fileEdgeCount);
    } else if (op === 'callees') {
      const outgoing = json.outgoing as Record<string, GnxSymbol[]> | undefined;
      // Only CALLS are callees. Field accesses/type uses are different graph
      // relations and cannot be presented as resolved function calls.
      const flat = outgoing?.calls ?? [];
      const resolved = await sitesFromEdges(flat, activeDispatch, repo);
      sites = resolved.sites;
      edgeNotice = fileEdgeNotice(op, resolved.callSiteCount, resolved.fileEdgeCount);
    }

    return applyBudget(
      answer(op, query, startedAt, {
        ...indexHealth.freshness,
        sites,
        totalAvailable: sites.length,
        error: joinErrors(indexHealth.error, edgeNotice),
      }),
      limit,
    );
  } catch (e) {
    counters.failed += 1;
    // A thrown dispatch is the LOUD failure mode and must stay loud: sites
    // stays empty but `error` is non-null, so isTrustworthyEmpty() passes it
    // as honest rather than as evidence of absence.
    return answer(op, query, startedAt, {
      health: 'unhealthy',
      error: `gitnexus dispatch threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/**
 * Route an intent to this backend, or explain why it cannot be routed.
 *
 * Returns the refusal answer for a non-routable intent so a router can hand
 * the caller one uniform shape either way.
 */
export function gitnexusOpForIntent(intent: CodeIntelIntent): GitnexusFacadeOp | null {
  // The refusal table is AUTHORITATIVE and is consulted first. `health` claims
  // the 'diagnostics' intent for shape reasons, but diagnostics is explicitly
  // non-routable here — a liveness probe answering a diagnostics question
  // would return a healthy-looking empty for a file full of type errors. This
  // ordering is what keeps the two tables from disagreeing.
  if (GITNEXUS_NOT_ROUTABLE[intent]) return null;
  for (const op of GITNEXUS_FACADE_OPS) {
    if (INTENT_BY_OP[op] === intent) return op;
  }
  return null;
}
