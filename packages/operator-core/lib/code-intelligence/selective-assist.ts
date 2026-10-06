/**
 * P-006: selective graph assistance — the decision + bounded-execution layer.
 *
 * The code graph (GitNexus) is an OPTIONAL assist for exactly two decisions:
 *
 *   1. known-symbol navigation  — the agent already knows ONE exact code
 *      identifier and wants where it lives / who depends on it;
 *   2. shared-helper change     — the agent is about to make a SUBSTANTIVE edit
 *      (signature / rename / removal / behavior) to an EXPORTED symbol in shared
 *      library code whose consumer set it does not yet know.
 *
 * Everything else — log and error strings, env-var and constant names, config
 * and data files, comments and prose, runtime/process questions, multi-term or
 * regex keyword search, non-code targets, trivial edits — returns
 * `assist:'none'`: no graph call, no advisory, no tax. This module never runs on
 * a per-read / per-grep / per-turn basis; a caller invokes it only at one of the
 * two decision points above.
 *
 * Three rails, each pinned by selective-assist.test.ts:
 *   - BOUNDED: at most ONE facade call per decision, a hard wall-clock timeout,
 *     and a capped site count. No retries, no loops, never a second backend.
 *   - REVISION-AWARE: an answer whose index commit is behind the current source
 *     revision (or that reports on-disk staleness) is "stale", and every site
 *     the graph returns is re-checked against CURRENT source before it is
 *     called usable. A graph answer is a lead, never a verdict.
 *   - FAIL-OPEN: a refusal, error, timeout, throw, stale index, ambiguity or
 *     empty answer all resolve to `blocking:false` and the EXISTING route
 *     (`rg` / `lsp`). An empty graph answer is never read as absence — the
 *     index may simply not contain the symbol (contracts.ts: isTrustworthyEmpty
 *     is a state report, not proof of absence).
 */
import type { CodeIntelAnswer, SymbolSite } from './contracts';
import { GRAPH_FAILURE_FALLBACK_GUIDANCE } from './graph-fallback-guidance';
import {
  gitnexusFacade,
  type GitnexusDispatch,
  type GitnexusFacadeArgs,
  type GitnexusFacadeOp,
} from './gitnexus-facade';

export type AssistTrigger = 'known-symbol-navigation' | 'shared-helper-change';

/** The edit kinds that are SUBSTANTIVE for a shared helper (consumers can break). */
export type ChangeKind =
  | 'signature'
  | 'rename'
  | 'removal'
  | 'behavior'
  | 'internal'
  | 'comment'
  | 'format';

export const SUBSTANTIVE_CHANGE_KINDS: readonly ChangeKind[] = Object.freeze([
  'signature',
  'rename',
  'removal',
  'behavior',
]);

export type NonuseReason =
  | 'empty-query'
  | 'path-or-glob'
  | 'regex-pattern'
  | 'multi-term'
  | 'env-var-shaped'
  | 'keyword-shaped'
  | 'non-identifier'
  | 'non-code-target'
  | 'trivial-change'
  | 'not-exported'
  | 'not-shared-path'
  | 'test-or-generated-path';

/** The route the agent was on anyway — what a graph failure falls back to. */
export type FallbackRoute = 'rg' | 'lsp';

export type AssistIntent =
  | {
      kind: 'navigate';
      /** The exact string the agent would otherwise grep/search for. */
      query: string;
      /** Paths/globs the search was aimed at, when known. */
      scope?: readonly string[];
    }
  | {
      kind: 'change';
      symbol: string;
      /** Repo-relative POSIX path of the file being changed. */
      path: string;
      exported: boolean;
      change: ChangeKind;
    };

export interface AssistDecision {
  readonly assist: 'graph' | 'none';
  readonly trigger: AssistTrigger | null;
  readonly nonuse: NonuseReason | null;
  readonly reason: string;
  /** The single facade call to make; null when assist is 'none'. */
  readonly plan: { readonly op: GitnexusFacadeOp; readonly args: GitnexusFacadeArgs } | null;
  /** The existing route to keep / fall back to. Always present. */
  readonly fallback: FallbackRoute;
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|rs|go)$/i;
const NON_CODE_EXT =
  /\.(?:md|mdx|txt|log|json|jsonl|ya?ml|toml|ini|env|csv|sql|lock|svg|html|css)$/i;
const NON_CODE_DIR = /(?:^|\/)(?:logs?|docs?|\.papercusp|tmp|coverage|dist|node_modules)(?:\/|$)/i;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENV_OR_CONSTANT_SHAPED = /^[A-Z][A-Z0-9_]{2,}$/;
const SHARED_PATH = /^(?:libs|packages)\/|^apps\/[^/]+\/lib\//;
const TEST_OR_GENERATED =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|\.d\.[cm]?ts$|(?:^|\/)(?:dist|generated|\.vitest-tmp)\/)/;
/** Facade site cap: assistance is a handful of leads, not a census. */
export const ASSIST_SITE_LIMIT = 25;
/** Hard wall-clock bound on the one facade call. */
export const ASSIST_TIMEOUT_MS = 8_000;

function none(
  nonuse: NonuseReason,
  reason: string,
  fallback: FallbackRoute = 'rg',
): AssistDecision {
  return { assist: 'none', trigger: null, nonuse, reason, plan: null, fallback };
}

function scopeIsAllNonCode(scope: readonly string[] | undefined): boolean {
  if (!scope || scope.length === 0) return false;
  return scope.every((entry) => {
    const e = entry.trim();
    if (CODE_EXT.test(e)) return false;
    return NON_CODE_EXT.test(e) || NON_CODE_DIR.test(e);
  });
}

/**
 * Decide whether the graph is worth ONE call for this intent. Pure: no I/O, no
 * clock. The default for anything not positively recognised is `none`.
 */
export function decideGraphAssist(intent: AssistIntent): AssistDecision {
  if (intent.kind === 'navigate') {
    const q = intent.query.trim();
    if (!q) return none('empty-query', 'No symbol was named.');
    if (/[\\/]/.test(q) || CODE_EXT.test(q) || NON_CODE_EXT.test(q)) {
      return none('path-or-glob', 'A path or glob is a file question; rg/ls answers it from the working tree.');
    }
    if (/[*+?()[\]{}|^$]/.test(q)) {
      return none('regex-pattern', 'A regex is a text-shape question; rg answers it from the working tree.');
    }
    if (/\s/.test(q)) {
      return none('multi-term', 'Several terms or a quoted message is a text search, not a symbol lookup.');
    }
    if (ENV_OR_CONSTANT_SHAPED.test(q)) {
      return none('env-var-shaped', 'An ALL_CAPS token is an env var, constant or log level; rg finds its literal uses.');
    }
    if (!IDENTIFIER.test(q) || q.length < 3) {
      return none('non-identifier', 'Not a single code identifier.');
    }
    if (!/[a-z][A-Z]|_/.test(q) && !/^[A-Z][a-z]+[A-Za-z0-9]*$/.test(q)) {
      return none(
        'keyword-shaped',
        'A bare lowercase word reads as a keyword search; rg/lsp is the authoritative route for it.',
      );
    }
    if (scopeIsAllNonCode(intent.scope)) {
      return none('non-code-target', 'The search targets logs/docs/config, not indexed source.');
    }
    return {
      assist: 'graph',
      trigger: 'known-symbol-navigation',
      nonuse: null,
      reason: `Known symbol \`${q}\`: one graph lookup returns its location plus callers/callees.`,
      plan: { op: 'symbol', args: { name: q, limit: ASSIST_SITE_LIMIT } },
      fallback: 'rg',
    };
  }

  const { symbol, path, exported, change } = intent;
  const sym = symbol.trim();
  if (!SUBSTANTIVE_CHANGE_KINDS.includes(change)) {
    return none('trivial-change', `A ${change} edit cannot break a consumer.`, 'lsp');
  }
  if (!sym || !IDENTIFIER.test(sym)) {
    return none('non-identifier', 'The changed symbol is not a single code identifier.', 'lsp');
  }
  if (!exported) {
    return none('not-exported', 'A non-exported symbol has no cross-file consumers to find.', 'lsp');
  }
  if (!CODE_EXT.test(path) || NON_CODE_EXT.test(path)) {
    return none('non-code-target', 'The changed file is not indexed source.', 'lsp');
  }
  if (TEST_OR_GENERATED.test(path)) {
    return none('test-or-generated-path', 'Test and generated files are not shared helpers.', 'lsp');
  }
  if (!SHARED_PATH.test(path)) {
    return none('not-shared-path', 'The file is outside the shared library roots.', 'lsp');
  }
  return {
    assist: 'graph',
    trigger: 'shared-helper-change',
    nonuse: null,
    // `callers`, not `impact`: the facade's impact answer is a COUNT + risk grade
    // with a sentinel site (no file/line), so there is nothing to re-verify
    // against current source. Callers return real sites we can check.
    reason: `Substantive ${change} change to exported \`${sym}\`: one callers lookup lists consumers to confirm in current source.`,
    // `file_path` is the file being changed, i.e. where the symbol is DEFINED. A
    // shared-helper name is routinely defined more than once in the index (a test
    // fixture mirror, a same-named export), and the facade refuses to guess among
    // candidates — so without the defining file a real caller lookup degraded to
    // the fallback route every time (WI-10005154, live: getNextWorkItem).
    plan: { op: 'callers', args: { name: sym, file_path: path, limit: ASSIST_SITE_LIMIT } },
    fallback: 'lsp',
  };
}

export type AssistOutcome =
  | 'skipped'
  | 'graph-used'
  | 'graph-uncorroborated'
  | 'graph-stale'
  | 'graph-failed'
  | 'graph-empty';

export interface FreshnessVerdict {
  readonly state: 'fresh' | 'stale' | 'unknown';
  readonly why: string;
}

function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/**
 * Revision-aware freshness. `staleVsDisk:true` or an index commit that differs
 * from the current source revision is STALE; when neither side can say, the
 * verdict is `unknown` — never silently `fresh`.
 */
export function assessFreshness(
  answer: CodeIntelAnswer,
  currentRevision: string | null,
): FreshnessVerdict {
  const f = answer.freshness;
  if (f.staleVsDisk === true) {
    return { state: 'stale', why: 'the index reports on-disk edits it has not ingested' };
  }
  if (f.indexedCommit && currentRevision) {
    return sameCommit(f.indexedCommit, currentRevision)
      ? { state: 'fresh', why: `index commit ${f.indexedCommit.slice(0, 12)} matches the source revision` }
      : {
          state: 'stale',
          why: `index commit ${f.indexedCommit.slice(0, 12)} is not the source revision ${currentRevision.slice(0, 12)}`,
        };
  }
  if (f.staleVsDisk === false && f.indexedCommit === null) {
    return { state: 'fresh', why: 'the backend reports no un-ingested on-disk edits' };
  }
  return { state: 'unknown', why: 'neither the index commit nor the source revision could be compared' };
}

export interface SourceVerification {
  readonly verified: readonly SymbolSite[];
  readonly unverified: readonly SymbolSite[];
}

function hasToken(text: string, name: string): boolean {
  const esc = name.replace(/[$]/g, '\\$');
  return new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`).test(text);
}

/**
 * Re-check every graph site against CURRENT source. For a definition lookup the
 * reported (one-indexed) line must name the symbol; for impact the dependent's
 * file must reference it. A site we cannot read, or whose line does not hold
 * up, is unverified — the caller must not act on it without a fresh look.
 */
export function verifySitesAgainstSource(
  op: GitnexusFacadeOp,
  name: string,
  sites: readonly SymbolSite[],
  readSource: (path: string) => string | null,
): SourceVerification {
  const verified: SymbolSite[] = [];
  const unverified: SymbolSite[] = [];
  for (const site of sites) {
    let text: string | null = null;
    try {
      text = readSource(site.path);
    } catch {
      text = null;
    }
    let ok = false;
    if (text !== null) {
      if (op === 'symbol') {
        const line = site.line1 !== null ? text.split('\n')[site.line1 - 1] : undefined;
        ok = line !== undefined && hasToken(line, name);
      } else {
        ok = hasToken(text, name);
      }
    }
    (ok ? verified : unverified).push(site);
  }
  return { verified, unverified };
}

export interface AssistDeps {
  /** The GitNexus plugin dispatcher (request-scoped in production). */
  readonly dispatch: GitnexusDispatch | null;
  /** Current source revision (git HEAD), or null when unknown. */
  readonly currentRevision?: () => string | null | Promise<string | null>;
  /** Current-source reader; null for a missing file. */
  readonly readSource: (path: string) => string | null;
  readonly timeoutMs?: number;
}

export interface AssistResult {
  readonly decision: AssistDecision;
  readonly outcome: AssistOutcome;
  /** Graph assistance NEVER blocks the work route. */
  readonly blocking: false;
  /** What to continue with: the graph leads, or the existing route. */
  readonly route: 'graph' | FallbackRoute;
  readonly answer: CodeIntelAnswer | null;
  readonly freshness: FreshnessVerdict | null;
  readonly verifiedSites: readonly SymbolSite[];
  readonly unverifiedSites: readonly SymbolSite[];
  /** Advisory text. Never asserts absence; always names the fallback. */
  readonly note: string;
  readonly elapsedMs: number;
}

function settle(
  decision: AssistDecision,
  outcome: AssistOutcome,
  startedAt: number,
  parts: Partial<Omit<AssistResult, 'decision' | 'outcome' | 'blocking' | 'elapsedMs'>> & { note: string },
): AssistResult {
  return {
    decision,
    outcome,
    blocking: false,
    route: outcome === 'graph-used' ? 'graph' : decision.fallback,
    answer: parts.answer ?? null,
    freshness: parts.freshness ?? null,
    verifiedSites: parts.verifiedSites ?? [],
    unverifiedSites: parts.unverifiedSites ?? [],
    note: parts.note,
    elapsedMs: Date.now() - startedAt,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decide, and — only when the decision is `graph` — make the ONE bounded call,
 * check freshness, and re-verify against current source. Never throws.
 */
export async function runSelectiveAssist(
  intent: AssistIntent,
  deps: AssistDeps,
): Promise<AssistResult> {
  const startedAt = Date.now();
  const decision = decideGraphAssist(intent);
  if (decision.assist === 'none' || decision.plan === null) {
    return settle(decision, 'skipped', startedAt, {
      note: `No graph assistance (${decision.nonuse}): ${decision.reason} Continue with ${decision.fallback}.`,
    });
  }
  const { op, args } = decision.plan;
  const name = args.name ?? '';
  const ms = deps.timeoutMs ?? ASSIST_TIMEOUT_MS;

  let answer: CodeIntelAnswer;
  try {
    const raced = await withTimeout(gitnexusFacade(op, args, deps.dispatch), ms);
    if ('timedOut' in raced) {
      return settle(decision, 'graph-failed', startedAt, {
        note: `Graph lookup timed out after ${ms}ms. ${GRAPH_FAILURE_FALLBACK_GUIDANCE} Continue with ${decision.fallback}.`,
      });
    }
    answer = raced.value;
  } catch (err) {
    return settle(decision, 'graph-failed', startedAt, {
      note: `Graph lookup threw (${err instanceof Error ? err.message : String(err)}). ${GRAPH_FAILURE_FALLBACK_GUIDANCE} Continue with ${decision.fallback}.`,
    });
  }

  if (answer.error !== null) {
    return settle(decision, 'graph-failed', startedAt, {
      answer,
      note: `Graph answered with an error (${answer.error.slice(0, 160)}). ${GRAPH_FAILURE_FALLBACK_GUIDANCE} Continue with ${decision.fallback}.`,
    });
  }

  let revision: string | null = null;
  try {
    revision = (await deps.currentRevision?.()) ?? null;
  } catch {
    revision = null;
  }
  const freshness = assessFreshness(answer, revision);

  if (freshness.state === 'stale') {
    return settle(decision, 'graph-stale', startedAt, {
      answer,
      freshness,
      note: `Graph index is stale: ${freshness.why}. ${GRAPH_FAILURE_FALLBACK_GUIDANCE} Continue with ${decision.fallback}.`,
    });
  }

  if (answer.sites.length === 0) {
    return settle(decision, 'graph-empty', startedAt, {
      answer,
      freshness,
      note: `Graph returned no match for \`${name}\`. That is NOT evidence the symbol is absent — the index may not contain it. Continue with ${decision.fallback}.`,
    });
  }

  const { verified, unverified } = verifySitesAgainstSource(op, name, answer.sites, deps.readSource);
  if (verified.length === 0) {
    return settle(decision, 'graph-uncorroborated', startedAt, {
      answer,
      freshness,
      unverifiedSites: unverified,
      note: `None of the ${unverified.length} graph site(s) for \`${name}\` held up against current source. ${GRAPH_FAILURE_FALLBACK_GUIDANCE} Continue with ${decision.fallback}.`,
    });
  }

  const partial = unverified.length > 0 ? ` ${unverified.length} other site(s) did NOT verify — do not act on them unconfirmed.` : '';
  const truncated = answer.truncation.truncated ? ' The list is truncated: it is a set of leads, not every consumer.' : '';
  return settle(decision, 'graph-used', startedAt, {
    answer,
    freshness,
    verifiedSites: verified,
    unverifiedSites: unverified,
    note: `${verified.length} graph site(s) for \`${name}\` verified against current source (${freshness.why}).${partial}${truncated} The graph never proves absence; ${decision.fallback} remains the fallback.`,
  });
}
