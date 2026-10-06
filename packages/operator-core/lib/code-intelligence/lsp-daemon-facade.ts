/**
 * `lsp.*` — the static, READ-ONLY code-intelligence facade (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-012, D-006/D-007).
 *
 * Seven operations over the pinned-server adapter in `./lsp-adapter.ts`:
 *   symbol · references · implementations · diagnostics ·
 *   workspace_symbols · refactor_preview · health
 *
 * ── Why a facade at all, rather than exporting the adapter ──────────────────
 * The adapter speaks the wire; the facade owns the POLICY, in one place a
 * reviewer can read end to end:
 *
 *  1. STATIC OP SET. The op list is a closed union, not a passthrough of
 *     arbitrary LSP methods. A backend swap (D-002's replaceability rail)
 *     changes the adapter and leaves callers untouched — and, more to the
 *     point, no caller can reach a method the read-only argument never
 *     covered. `workspace/applyEdit` is not absent by convention here; it is
 *     unreachable.
 *  2. FLAG-GATED AT THE ENTRY POINT. `FLAGS.CODE_INTEL_LSP` is checked ONCE,
 *     here, so there is no path into the adapter that skips it. Gating each
 *     call site instead is how a flag ends up meaning nothing.
 *  3. BUDGETS ARE ENFORCED, NOT DOCUMENTED. Every op caps its result set at
 *     `DEFAULT_RESOURCE_BUDGET`-derived limits and reports the cut through
 *     `truncation`, because an agent context is the scarce resource this whole
 *     subsystem spends.
 *  4. REFUSALS ARE ANSWERS. Nothing here throws for an operational failure. A
 *     disabled flag, an unprovisioned server, a half-loaded project and a
 *     genuinely-empty result are FOUR different states, and each returns a
 *     `CodeIntelAnswer` that says which one it is. `isTrustworthyEmpty()` is
 *     the predicate that separates them; a thrown exception would destroy the
 *     distinction, and a bare `[]` would forge it.
 *
 * ── code:run parity ────────────────────────────────────────────────────────
 * MEASURED 2026-08-21, and NOT what it first looks like: `code:run` executes in
 * a sandboxed VM with no `process` and no dynamic-import callback, so it cannot
 * import this module — nor any other. Its only surface is the `tools.*` proxy.
 *
 * Parity therefore means: `tools.lsp.query({ op, ... })` inside `code:run` and a
 * direct `lsp:query` MCP call reach THIS function with the same arguments and
 * the same semantics. That holds by construction, because the registered
 * handler (agent-tools/lsp/query.ts) adds no logic beyond resolving the
 * workspace root and forwarding. `lspFacadeOpSpec()` is the shared op contract
 * the tool's enum is derived from, so the two cannot drift into disagreement.
 *
 * ⚠ Do NOT write a `code:run` script that imports this file. It will fail with
 * "A dynamic import callback was not specified" — a sandbox limit, not a
 * missing export.
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import {
  DEFAULT_RESOURCE_BUDGET,
  RIPGREP_SCOPE_GUIDANCE,
  type BackendHealth,
  type CodeIntelAnswer,
  type CodeIntelIntent,
  type SymbolSite,
} from './contracts.ts';
import {
  languageForFile,
  lspClientInventory,
  lspDiagnostics,
  lspQuery,
  lspRenamePreview,
  lspWorkspaceSymbols,
  resolveServerBin,
  type LspLanguage,
} from './lsp-adapter.ts';

/** The closed, read-only op set. Adding a member is a deliberate act. */
export type LspFacadeOp =
  | 'symbol'
  | 'references'
  | 'implementations'
  | 'diagnostics'
  | 'workspace_symbols'
  | 'refactor_preview'
  | 'health';

export const LSP_FACADE_OPS: readonly LspFacadeOp[] = Object.freeze([
  'symbol',
  'references',
  'implementations',
  'diagnostics',
  'workspace_symbols',
  'refactor_preview',
  'health',
]);

/**
 * Result-set caps, derived from the shared budget rather than re-invented.
 *
 * `resultTokensMax` (1,500) is a CONTEXT budget; a site renders to roughly a
 * path + line + kind, so ~12 tokens. 100 sites is therefore the point at which
 * a single answer starts to crowd out the reasoning it was fetched to serve.
 * References legitimately run to hundreds, so this cut is expected and is
 * always REPORTED — never silently applied.
 */
export const MAX_SITES_PER_ANSWER = Math.max(
  1,
  Math.floor(DEFAULT_RESOURCE_BUDGET.resultTokensMax / 12),
);

export interface LspFacadeArgs {
  /** Absolute path to the file the cursor is in. Required except for `health`. */
  file?: string;
  /** ONE-indexed line, as a human, grep or editor states it. */
  line1?: number;
  /** Zero-indexed character offset within the line. */
  character?: number;
  /** Project root. Defaults to the repo root the operator is running in. */
  rootPath?: string;
  /** `workspace_symbols` only: the symbol name to search for. */
  name?: string;
  /** `workspace_symbols` only: which pinned server answers. */
  language?: LspLanguage;
  /** `refactor_preview` only: the proposed new name. NOTHING is written. */
  newName?: string;
  /** Cap on returned sites. Clamped to MAX_SITES_PER_ANSWER. */
  limit?: number;
}

const INTENT_BY_OP: Record<LspFacadeOp, CodeIntelIntent> = {
  symbol: 'definition',
  references: 'references',
  implementations: 'implementations',
  diagnostics: 'diagnostics',
  workspace_symbols: 'symbol-search',
  refactor_preview: 'rename-preview',
  health: 'diagnostics',
};

function refusal(
  op: LspFacadeOp,
  query: string,
  error: string,
  health: BackendHealth,
  startedAt: number,
): CodeIntelAnswer {
  return {
    backend: 'lsp-adapter',
    intent: INTENT_BY_OP[op],
    query,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - startedAt,
    error,
  };
}

/**
 * Apply the context budget to an answer that the adapter produced.
 *
 * The cut is recorded on `truncation` with the PRE-CUT total, so a caller can
 * always tell a capped 100 from a true 100. Silently returning the first 100
 * of 400 references is the exact shape of a partial answer that reads as
 * complete — and for a rename or an impact question, acting on it is wrong.
 */
function applyBudget(input: CodeIntelAnswer, limit: number): CodeIntelAnswer {
  const answer: CodeIntelAnswer = {
    ...input,
    coverage: {
      basis: 'compiler-project',
      sourceCompleteness: 'unverified',
      limitations: [
        input.freshness.health === 'healthy'
          ? 'Compiler results cover the loaded project; external projects and dynamic/framework consumers require independent source checks.'
          : 'Compiler readiness is degraded or unmeasured; returned references may omit real consumers. Corroborate current source and graph topology.',
      ],
    },
  };
  if (answer.sites.length <= limit) return answer;
  const kept: readonly SymbolSite[] = answer.sites.slice(0, limit);
  return {
    ...answer,
    sites: kept,
    truncation: {
      truncated: true,
      totalAvailable: answer.truncation.totalAvailable ?? answer.sites.length,
      continuation: null,
    },
  };
}

/**
 * The single entry point. Returns an answer for EVERY outcome, including the
 * ones that are refusals — see rail 4 in the module header.
 */
export async function lspDaemonFacade(
  op: LspFacadeOp,
  args: LspFacadeArgs = {},
  delivery: 'context' | 'archive' = 'context',
): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const rootPath = args.rootPath ?? process.cwd();
  // Only the typed internal daemon seam selects archive delivery. Public limit
  // arguments cannot evade the existing context budget or the policy checks.
  const limit = delivery === 'archive' ? Infinity : Math.min(args.limit ?? MAX_SITES_PER_ANSWER, MAX_SITES_PER_ANSWER);

  if (!LSP_FACADE_OPS.includes(op)) {
    return refusal(
      'health',
      String(op),
      `unknown lsp op '${op}'. The op set is closed: ${LSP_FACADE_OPS.join(', ')}`,
      'unknown',
      started,
    );
  }

  // Rail 2: ONE flag check, covering every path into the adapter.
  const enabled = await getFlag(FLAGS.CODE_INTEL_LSP, 'system').catch(() => false);
  if (!enabled) {
    return refusal(
      op,
      args.file ?? args.name ?? '',
      `code-intelligence LSP facade is disabled (flag ${FLAGS.CODE_INTEL_LSP}). ` +
        `This is a DISABLED answer, not an empty one — do not read it as "no results".`,
      'unknown',
      started,
    );
  }

  if (op === 'health') return lspHealthAnswer(started);

  if (op === 'workspace_symbols') {
    if (!args.name) {
      return refusal(op, '', `lsp.workspace_symbols requires 'name'`, 'unknown', started);
    }
    const language = args.language ?? 'typescript';
    if (!resolveServerBin(language)) {
      return refusal(
        op,
        args.name,
        `pinned ${language} language server is not provisioned (P-007); refusing to ` +
          `answer from an unpinned server because its answers drift between runs`,
        'unknown',
        started,
      );
    }
    return applyBudget(
      await lspWorkspaceSymbols({
        name: args.name,
        rootPath,
        language,
        limit,
        // `file` is an ANCHOR here, not a cursor: it names the project whose
        // symbol index answers. Optional for rust (a Cargo.toml root suffices),
        // required for TypeScript (tsserver has no project until a document is
        // opened). Absent and unresolvable, the adapter refuses rather than
        // returning an empty that reads as absence.
        anchor: args.file,
      }),
      limit,
    );
  }

  // Every remaining op is position-addressed.
  if (!args.file) {
    return refusal(op, '', `lsp.${op} requires 'file'`, 'unknown', started);
  }
  if (!languageForFile(args.file)) {
    return refusal(
      op,
      args.file,
      `no pinned language server handles ${args.file}. Route this question to ` +
        `gitnexus (graph) or ${RIPGREP_SCOPE_GUIDANCE} instead of assuming there are no results.`,
      'unknown',
      started,
    );
  }

  if (op === 'diagnostics') {
    return applyBudget(await lspDiagnostics({ file: args.file, rootPath }), limit);
  }

  if (typeof args.line1 !== 'number' || typeof args.character !== 'number') {
    return refusal(
      op,
      args.file,
      `lsp.${op} requires 'line1' (ONE-indexed) and 'character' (zero-indexed)`,
      'unknown',
      started,
    );
  }
  if (args.line1 < 1) {
    return refusal(
      op,
      `${args.file}:${args.line1}`,
      `'line1' is ONE-indexed and must be >= 1; got ${args.line1}. A zero here is the ` +
        `off-by-one this layer exists to prevent (D-008).`,
      'unknown',
      started,
    );
  }

  const query = { file: args.file, line1: args.line1, character: args.character, rootPath };

  if (op === 'refactor_preview') {
    if (!args.newName) {
      return refusal(op, args.file, `lsp.refactor_preview requires 'newName'`, 'unknown', started);
    }
    // PREVIEW ONLY. The adapter computes a WorkspaceEdit and reads it as a
    // report; application is a separately gated capability (P-013) precisely
    // because a write from here would bypass PreToolUse lock arbitration.
    return applyBudget(await lspRenamePreview({ ...query, newName: args.newName }), limit);
  }

  return applyBudget(await lspQuery(INTENT_BY_OP[op], query), limit);
}

/**
 * `lsp.health` — what servers are running, how they are, and what it cost.
 *
 * Shaped for `dev:service_health` consumption (D-006): every row carries the
 * `taskId` that `processes:kill` takes, because killing a language server by
 * NAME would reach any peer agent's server on this shared box.
 */
export interface LspHealthReport {
  /** False when the flag is off — the servers are not merely idle. */
  enabled: boolean;
  /** Worst health across live servers; 'unknown' when none are running. */
  overall: BackendHealth;
  /** Includes the adapter's per-intent proof ledger and actual progress state. */
  servers: ReturnType<typeof lspClientInventory>;
  /** Which pinned servers are provisioned at all (P-007). */
  provisioned: Record<LspLanguage, boolean>;
}

const HEALTH_RANK: Record<BackendHealth, number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  unhealthy: 3,
};

export async function lspHealth(): Promise<LspHealthReport> {
  const enabled = await getFlag(FLAGS.CODE_INTEL_LSP, 'system').catch(() => false);
  const servers = lspClientInventory();
  // Worst-of, never best-of: one dead server among three is a degraded
  // subsystem, and reporting the healthy majority would hide exactly the
  // server whose empty answers cannot be trusted.
  const overall = servers.length
    ? servers.reduce<BackendHealth>(
        (worst, s) => (HEALTH_RANK[s.health] > HEALTH_RANK[worst] ? s.health : worst),
        'healthy',
      )
    : 'unknown';
  return {
    enabled,
    overall,
    servers,
    provisioned: {
      typescript: resolveServerBin('typescript') !== null,
      rust: resolveServerBin('rust') !== null,
    },
  };
}

function lspHealthAnswer(started: number): Promise<CodeIntelAnswer> {
  return lspHealth().then((report) => ({
    backend: 'lsp-adapter' as const,
    intent: 'diagnostics' as CodeIntelIntent,
    query: 'lsp.health',
    sites: report.servers.map((s) => ({
      path: s.rootPath,
      line1: null,
      kind: s.language,
      detail: `task=${s.taskId} health=${s.health} coldStart=${s.coldStartMs}ms docs=${s.openDocs}`,
    })),
    truncation: {
      truncated: false,
      totalAvailable: report.servers.length,
      continuation: null,
    },
    freshness: {
      health: report.overall,
      indexedAt: new Date().toISOString(),
      staleVsDisk: null,
      indexedCommit: null,
    },
    latencyMs: Date.now() - started,
    // Health reporting that no servers are up is a FACT, not a failure.
    error: null,
  }));
}

/**
 * The op contract, as data.
 *
 * The tool layer registers from THIS, so a registered tool cannot advertise an
 * op the facade does not implement (or miss one it does) — the drift that
 * makes a tool description a lie.
 */
export function lspFacadeOpSpec(): Array<{
  op: LspFacadeOp;
  requires: string[];
  reads: true;
  writes: false;
}> {
  return [
    { op: 'symbol', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'references', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'implementations', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'diagnostics', requires: ['file'], reads: true, writes: false },
    { op: 'workspace_symbols', requires: ['name'], reads: true, writes: false },
    {
      op: 'refactor_preview',
      requires: ['file', 'line1', 'character', 'newName'],
      reads: true,
      writes: false,
    },
    { op: 'health', requires: [], reads: true, writes: false },
  ];
}
