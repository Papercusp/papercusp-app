/**
 * `code:pack` — the registered surface of the pinned packing leg (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-016; D-005, D-040).
 *
 * Named for the JOB (package evidence) rather than the binary, like its
 * siblings: `lsp:query` is type truth, `gitnexus.query` is topology,
 * `code:structural` is shape, this is evidence-for-a-reader.
 *
 * One tool over two engines on purpose. The engine is a consequence of the op —
 * `pack` is repomix, `diff` is code2prompt — because the choice turns on a
 * property the caller should not have to know: only repomix has a secret
 * scanner. Exposing two tools would invite picking the one without one.
 *
 * ⚠ The response shape lives in `guidance.returns`, NOT in `description`. The
 * prompt-weight budget counts description + when/notWhen/chaining and excludes
 * returns/seeAlso, so documenting the payload here would spend fleet-wide
 * system-prompt budget on something a caller only needs after it has already
 * chosen this tool.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { PACK_TEMPLATES, packerFacade, type PackTemplate } from '../../code-intelligence/packer-facade.ts';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';

const TEMPLATES = Object.keys(PACK_TEMPLATES) as [PackTemplate, ...PackTemplate[]];

export default defineTool({
  name: 'code:pack',
  description:
    'Package code as review evidence with pinned Repomix 1.18.0/code2prompt 4.2.0 (never `npx latest`). `op:"pack"` selects a non-empty `include`; `op:"diff"` packs the git diff. Only pack secret-scans; diff uses the deny-set. Read-only; the full body goes to a scratch file, not context.',
  guidance: {
    when: 'Need a scoped subsystem document for review, audit, or refactor; use `diff` for changed code only.',
    notWhen:
      `Packing follows retrieval: use lsp:query, gitnexus.query, code:structural, or ${RIPGREP_SCOPE_GUIDANCE} first, then pack the measured radius.`,
    chaining:
      'gitnexus.query → code:pack include:<radius>; cite provenance.commit + dirty.',
    returns:
      '{ answer, artifact }. `artifact.path` is the scratch file holding the full pack; `artifact.preview` is a bounded head of it. `artifact.provenance` states what the pack actually IS: engine + engineVersion, commit, dirty (true = NOT reproducible from that commit, so do not cite it as "the code at <sha>"), baseRef/baseCommit, the include/ignore/denyGlobs actually applied, template, fileCount, bytes, chars, capturedAt, and securityScan ("secretlint+deny-set" for pack, "deny-set-only" for diff). fileCount is null — never 0 — when the selection could not be parsed out of the pack, because "I could not read it" and "it selected nothing" are different answers. `answer` is the normalized code-intelligence shape: sites[] is one entry per SELECTED FILE, truncation.truncated marks a pack cut at the byte ceiling, and a refusal (flag off, engine unprovisioned, pin drifted, empty include) arrives as answer.error with health "unknown" rather than as an empty pack.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  timeoutSec: 200,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z
      .enum(['pack', 'diff'])
      .describe('pack = the matching files (Repomix). diff = what changed (code2prompt). Neither writes.'),
    include: z
      .array(z.string().min(1))
      .min(1)
      .describe('REQUIRED glob set, e.g. ["packages/operator-core/lib/scheduler/**"]. A pattern starting with "-" is refused.'),
    ignore: z
      .array(z.string().min(1))
      .optional()
      .describe('Extra excludes. Appended to a non-overridable secret deny-set (.env, keys, credentials), never replacing it.'),
    format: z
      .enum(['markdown', 'xml'])
      .optional()
      .describe('Document format. Defaults to xml for pack, markdown for diff.'),
    template: z
      .enum(TEMPLATES)
      .optional()
      .describe('Prepend a reviewer framing: code-review | security-audit | refactor-prep | none.'),
    baseRef: z
      .string()
      .min(1)
      .optional()
      .describe('diff only: ref to diff against, e.g. "origin/main". Omitted = the working-tree diff.'),
    compress: z
      .boolean()
      .optional()
      .describe('pack only: collapse bodies to signatures. Much smaller; loses implementation detail.'),
    rootPath: z.string().min(1).optional().describe('Project root override. Defaults to the agent workspace root.'),
  }),
  result: z.object({ answer: z.unknown().optional(), artifact: z.unknown().optional() }).passthrough(),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    const result = await packerFacade(args.op, {
      include: args.include,
      ignore: args.ignore,
      rootPath: root,
      format: args.format,
      template: args.template,
      baseRef: args.baseRef,
      compress: args.compress,
    });
    return { data: result };
  },
});
