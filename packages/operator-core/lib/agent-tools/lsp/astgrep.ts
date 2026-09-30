/**
 * `code:structural` — the registered surface of the pinned ast-grep leg
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-014).
 *
 * Named for the QUESTION it answers, not the binary that answers it. The
 * routing distinction P-014 asks for lives in the description and guidance,
 * because that is the only place a choosing agent actually reads: `lsp:query`
 * is type truth, `gitnexus.query` is topology, this is shape.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import {
  AST_GREP_LANGUAGES,
  astGrepFacade,
  type AstGrepLanguage,
} from '../../code-intelligence/ast-grep-facade.ts';

const LANGS = Object.keys(AST_GREP_LANGUAGES) as [AstGrepLanguage, ...AstGrepLanguage[]];

export default defineTool({
  name: 'code:structural',
  description:
    'Find code by SHAPE with pinned ast-grep: `pattern` uses metavariables (`foo($X)`, `if ($C) { $$$BODY }`) and matches syntax, ignoring formatting and strings/comments. op:"search" lists matches; op:"rewrite_preview" also shows each proposed replacement. Read-only: this tool cannot emit ast-grep --update-all. Returns { sites:[{path,line1,detail}], truncation, freshness, error }; line1 is ONE-indexed. It knows no types: identically-shaped calls from different modules are indistinguishable.',
  guidance: {
    when: 'The question is about FORM: where an idiom or anti-pattern occurs, the blast radius of a codemod, a lint-shaped sweep. Also when the code does not typecheck — this parses, it does not compile.',
    notWhen:
      'Name resolution (shadowing, re-exports, generics) is lsp:query; call chains and impact are gitnexus.query. For plain text/regex, use scoped rg/grep; see /internal/docs/agent-insights/code-intelligence-backends-runbook.',
    chaining:
      'code:structural to find candidate sites by shape → lsp:query op:"symbol" on one to confirm it resolves where you think. A structural match set is a SUPERSET of the type-correct one.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z
      .enum(['search', 'rewrite_preview'])
      .describe('search lists matches; rewrite_preview also reports the replacement. Neither writes.'),
    pattern: z
      .string()
      .min(1)
      .describe('Structural pattern: code with metavariables. `$X` is one node, `$$$X` is many.'),
    language: z
      .enum(LANGS)
      .describe('Grammar to parse the pattern and files with. A pattern is only meaningful under a language.'),
    rewrite: z
      .string()
      .min(1)
      .optional()
      .describe('rewrite_preview only: replacement template, reusing the pattern\'s metavariables. NOTHING is written.'),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe('Files or directories to search. Defaults to the whole workspace root, which on this monorepo is slow — narrow it.'),
    rootPath: z.string().min(1).optional().describe('Project root override. Defaults to the agent workspace root.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Cap on returned sites. A cut is always reported via truncation.truncated + totalAvailable.'),
  }),
  async handler(args, ctx) {
    const root = args.rootPath ?? resolveAgentWorkspaceRoot(ctx);
    const answer = await astGrepFacade(args.op, {
      pattern: args.pattern,
      language: args.language,
      rewrite: args.rewrite,
      paths: args.paths,
      rootPath: root,
      limit: args.limit,
    });
    return { data: answer };
  },
});
