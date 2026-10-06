/**
 * `lsp:query` — the registered surface of the read-only code-intelligence
 * facade (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-012).
 *
 * ── Why ONE tool with an `op` enum, not seven tools ────────────────────────
 * D-007 makes prompt weight an ACCEPTANCE criterion, not a style preference:
 * in this repo tool-description growth has red-pinned the fleet gate more than
 * once, and the breach always lands committed hours before anyone notices. The
 * per-tool budget is 1,500 chars of description + guidance, so seven tools for
 * one subsystem would spend up to ~10.5K of catalog weight where one spends
 * ~1.2K. The facade's seven OPERATIONS are unchanged; only their packaging in
 * the catalog is consolidated. The `5-7 tool facade cap` D-007 names is a
 * ceiling, and one is under it.
 *
 * ── The op list is DERIVED, never retyped ──────────────────────────────────
 * The enum comes from `LSP_FACADE_OPS`, so a tool description cannot advertise
 * an op the facade will refuse (or omit one it implements). That drift is what
 * turns a tool description into a lie an agent has no way to detect.
 *
 * ── code:run parity ────────────────────────────────────────────────────────
 * This handler adds NO logic of its own beyond resolving the workspace root
 * and forwarding: `lsp:query` and an in-`code:run` `lspFacade(op, args)` call
 * reach the same function with the same semantics. Parity is structural rather
 * than tested-into-existence.
 */

import { z } from 'zod';
import { isAbsolute, join } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import {
  LSP_FACADE_OPS,
  lspFacade,
  type LspFacadeOp,
} from '../../code-intelligence/lsp-facade.ts';

// Zod needs a non-empty tuple; derived from the facade so the two cannot drift.
const OP_VALUES = [...LSP_FACADE_OPS] as [LspFacadeOp, ...LspFacadeOp[]];

export default defineTool({
  name: 'lsp:query',
  description:
    'READ-ONLY TypeScript/Rust compiler intelligence from pinned servers. `op`: symbol | references | implementations | diagnostics | workspace_symbols | refactor_preview | health. Returns `{sites, truncation, freshness, coverage, latencyMs, error}`; `line1` is one-indexed. Health describes readiness, not exhaustive references. Empty or degraded results require source/scope checks; unavailable servers return an error.',
  guidance: {
    when: 'You need compiler truth rather than text: declarations across boundaries/re-exports, references, implementations, file diagnostics, or rename sites.',
    // P-011 prompt weight: this field used to INTERPOLATE the ~647-char shared
    // RIPGREP_SCOPE_GUIDANCE, which alone put this tool at 1507 of the 1500-char
    // budget and red-pinned the fleet gate. The full ripgrep operating manual
    // belongs on capability:bash — the tool that actually RUNS rg, and whose
    // bash-search-scope-guidance.test.ts pins it there verbatim. Here a pointer
    // is enough ("prefer a docs pointer over prose-in-place", CLAUDE.md).
    notWhen:
      'Use text/regex search (`rg`/`grep`, scoped to source roots — see capability:bash guidance) for text, and gitnexus.context for call graphs. Unsupported files refuse and name the alternative.',
    chaining:
      'op:"workspace_symbols" { name } → op:"symbol"/"references" { file, line1, character }. On degradation, op:"health" reports servers and the processes:kill taskId.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  // A cold language-server start on this monorepo is ~4-5s (measured), and the
  // facade waits for project-load readiness rather than answering early with a
  // plausible WRONG location. Declared so the dispatch stack's budget matches.
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z.enum(OP_VALUES).describe('Which read-only operation to run.'),
    file: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Path to the file the cursor is in (absolute, or relative to the workspace root). Required for symbol/references/implementations/diagnostics/refactor_preview. For workspace_symbols it is not a cursor but an ANCHOR (a file, or a directory inside ONE project) naming which project the symbol index answers for: required for TypeScript (tsserver has no project until a document is opened), optional for rust when rootPath already holds a Cargo.toml. Unanchored and unresolvable, workspace_symbols refuses rather than returning an empty that would read as absence.',
      ),
    line1: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'ONE-indexed line, exactly as grep/sed/your editor states it. Rejected below 1: the wire protocol is zero-indexed and this boundary is where the conversion happens.',
      ),
    character: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('ZERO-indexed column offset within the line (a column, not a line — LSP convention).'),
    name: z.string().min(1).optional().describe('workspace_symbols: the symbol name to search for.'),
    language: z
      .enum(['typescript', 'rust'])
      .optional()
      .describe(
        'workspace_symbols: which pinned server answers. Each server has its OWN symbol index, so a TypeScript query cannot see Rust symbols. Default typescript.',
      ),
    newName: z
      .string()
      .min(1)
      .optional()
      .describe(
        'refactor_preview: the proposed new name. NOTHING is written — the result is the set of sites the rename would touch.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Cap on returned sites (clamped to the shared context budget). A cut is always reported via truncation.truncated + totalAvailable, so a capped result can never be mistaken for a complete one.',
      ),
    rootPath: z
      .string()
      .min(1)
      .optional()
      .describe('Project root override. Defaults to the agent workspace root.'),
  }),
  async handler(args, ctx) {
    // EI-1754's defect, avoided: the :3070 operator runs FROM the release
    // checkout, so a cwd-derived root would start a language server over the
    // RELEASE tree and answer confidently about code the agent never edited.
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    // The adapter opens files by absolute path; a relative one would resolve
    // against the operator's cwd (the release checkout) rather than the tree
    // the caller means — the same wrong-tree class as above, one layer down.
    const file = args.file ? (isAbsolute(args.file) ? args.file : join(root, args.file)) : undefined;
    const answer = await lspFacade(args.op, {
      file,
      line1: args.line1,
      character: args.character,
      rootPath: root,
      name: args.name,
      language: args.language,
      newName: args.newName,
      limit: args.limit,
    }, { workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId, actorId: ctx.principal?.slug });
    return { data: answer };
  },
});
