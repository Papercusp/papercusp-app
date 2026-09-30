/**
 * `lsp:apply` — the registered surface of the WRITE capability
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-013).
 *
 * SEPARATE from `lsp:query` on purpose, at every layer: its own tool, its own
 * capability, its own flag, its own module. P-013's whole point is that the
 * read facade's read-only property survives the arrival of a writer, and a
 * `dryRun: false` argument on `lsp:query` would have ended it — a read-only
 * rail with a write mode is not a read-only rail, however it is documented.
 *
 * The handler adds no policy of its own. It resolves the workspace root the
 * way `lsp:query` does (never the operator's own cwd — on `:3070` that is the
 * release checkout, a different tree from the one the agent edits) and forwards
 * to `applyRenameEdit`, whose six invariants are pinned by lsp-apply.test.ts.
 */

import { z } from 'zod';
import { isAbsolute, join } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { applyRenameEdit } from '../../code-intelligence/lsp-apply.ts';
import { defaultApplyDeps } from '../../code-intelligence/lsp-apply-runtime.ts';

export default defineTool({
  name: 'lsp:apply',
  description:
    'WRITES a compiler-computed rename across every file the pinned language server says it touches. Give it the SAME cursor you would give lsp:query op:"refactor_preview" (file, line1 one-indexed, character zero-indexed) plus newName. All-or-nothing: it locks the whole target set atomically, and returns { filesChanged, editsApplied, diagnostics:{before,after,delta,measured}, contentAfter, completenessProven, completenessWarning } or refuses with a typed reason and writes NOTHING — stale_document (a peer edited a target since the plan; re-preview), file_locked (a named peer holds a target), lock_unavailable (the lock authority is down; retry), edit_out_of_bounds/overlapping_edits (the plan does not match the files). diagnostics.measured===false means the delta was NOT measured, never that it was clean. completenessProven:false (the norm for TypeScript) means call-site completeness is unproven — read completenessWarning and verify independently before trusting the rename is total.',
  guidance: {
    when: 'You want to actually perform a rename you have previewed, and want every call site updated by the compiler rather than by search-and-replace.',
    notWhen:
      'Editing one file, or any change that is not a symbol rename — use capability:edit. To see the blast radius WITHOUT writing, lsp:query op:"refactor_preview".',
    chaining:
      'lsp:query op:"refactor_preview" to review the sites → lsp:apply with the same cursor. Pass the preview\'s content hashes as `expect` to refuse if anything moved in between.',
  },
  capability: 'intel:write',
  requirePrincipal: false,
  // A cold server start is ~4-5s and the writer additionally waits for full
  // project load: a rename computed from a half-loaded program MISSES call
  // sites, which is the most dangerous partial answer this subsystem can give.
  timeoutSec: 120,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    file: z
      .string()
      .min(1)
      .describe('File the cursor is in (absolute, or relative to the workspace root).'),
    line1: z
      .number()
      .int()
      .min(1)
      .describe('ONE-indexed line, exactly as grep/sed/your editor states it.'),
    character: z
      .number()
      .int()
      .min(0)
      .describe('ZERO-indexed column offset within the line (a column, not a line).'),
    newName: z.string().min(1).describe('The new symbol name.'),
    rootPath: z
      .string()
      .min(1)
      .optional()
      .describe('Project root override. Every write must resolve inside it. Defaults to the agent workspace root.'),
    expect: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Optional compare-and-swap: path -> sha256 as you saw it in the preview. Any listed file whose content has changed since refuses with stale_document instead of writing. Closes the preview->apply window; the plan->apply window is always closed.',
      ),
  }),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    const file = isAbsolute(args.file) ? args.file : join(root, args.file);
    const result = await applyRenameEdit(
      {
        file,
        line1: args.line1,
        character: args.character,
        newName: args.newName,
        rootPath: root,
        expect: args.expect,
      },
      defaultApplyDeps(ctx),
    );
    return { data: result };
  },
});
