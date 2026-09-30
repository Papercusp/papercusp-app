/**
 * harness_docs:list — the merged per-harness docs tree (P-007), agent-facing.
 * Generated + manual + augmented docs with source + freshness status + (for the
 * active doc) the body + augmented overlay. Same data the docs tab renders.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { buildMergedDocs } from '../../harness/docs/merged-read';
import { shapeHarnessDocsList } from './list-shape';

const argsSchema = z.object({
  harness: harnessArg,
  docId: z.string().optional().describe('Which doc to load the body/overlay for (defaults to index/README/first).'),
  recompute: z.boolean().optional().describe('Recompute the active doc\'s freshness from git on read (default: use the cached sweep status).'),
});

export default defineTool({
  name: 'harness_docs:list',
  description:
    'List a harness\'s merged docs (generated · manual · augmented) with source badges + drift status (fresh/stale/review/untracked), and the active doc\'s body + augmented overlay. Supersedes the FS-only project-docs read.',
  guidance: {
    when: 'You want a harness\'s project docs WITH provenance + freshness — which are generated vs human, which are stale, which are not drift-tracked.',
    notWhen: 'For Papercusp framework docs use docs:get/outline. For raw markdown without metadata the old project-docs endpoint still exists but is superseded.',
    chaining: 'harness_docs:list → harness_docs:regenerate (stale generated) / harness_docs:verify (stale manual) / harness_docs:set_overlay (add human nuance).',
    seeAlso: [
      'harness_docs:regenerate (refresh a stale GENERATED doc)',
      'harness_docs:verify (re-confirm a stale MANUAL doc)',
      'docs:outline (Papercusp FRAMEWORK docs live in the docs:* surface)',
    ],
  },
  capability: 'docs:read',
  requirePrincipal: false,
  agentRoles: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'doc-steward', 'curator', 'operator'],
  modality: ['text'],
  args: argsSchema,
  // context-trimming-tiers P-023: trimmed/standard sessions get lean entry
  // rows, a clipped active-doc body with a loud continuation pointer, and the
  // `files` duplicate collapsed to a count (see list-shape.ts).
  // EI-8326: a caller that supplied `docId` wants a compact per-doc status,
  // not the whole harness's global entries list re-sent every time.
  shape: {
    // WI-2145871: BOTH axes are pinnable here. `projectEntry()` rebuilds each
    // entry FROM LITERALS (so `fields` has teeth), and — unlike most shapers in
    // this file — the envelope is a hand-written literal rather than `{ ...d }`,
    // so `preserve` has teeth too: a key dropped from that reconstruction goes
    // silently, and a top-level key is typically the QUALIFIER on the rows.
    //
    // ⚠ SECOND EMISSION PATH, and the check cannot reach it: when the caller
    // supplies `docId` this shaper returns a DIFFERENT envelope (entries
    // suppressed in favour of `entriesCount` + `entries_suppressed`).
    // checkTrimmedContract invokes the shaper with `args: {}`, so `docIdRequested`
    // is always false there and only the main path is ever exercised. `preserve`
    // is therefore the INTERSECTION of BOTH paths' UNCONDITIONAL keys — `entries`
    // is deliberately NOT among them (it is main-path only, and is already the
    // `rows` axis). Same caveat class as fleet:leader-brief's budget path.
    // Falsifiability measured, not assumed
    // (.papercusp/scratch/wi2145871-final-two-teeth.mts, 12/12): entry-row
    // sentinel ABSENT, all five preserve keys survive, a dropped top-level
    // `activePath` is CAUGHT, and the probe's CALIBRATION arm against a
    // spreading shaper DID surface the sentinel.
    contract: {
      rows: 'entries',
      fields: ['docId', 'source', 'status', 'title'],
      preserve: ['ok', 'activePath', 'filesCount', 'content', 'activeEntry'],
    },
    standard: (data, sctx) =>
      shapeHarnessDocsList(data, 'standard', { docIdRequested: !!(sctx.args as { docId?: string }).docId }),
    trimmed: (data, sctx) =>
      shapeHarnessDocsList(data, 'trimmed', { docIdRequested: !!(sctx.args as { docId?: string }).docId }),
  },
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const merged = await buildMergedDocs(scope.slug, {
      ...(args.docId ? { activePath: args.docId } : {}),
      ...(args.recompute ? { recomputeActive: true } : {}),
    });
    // {data} envelope so the payload-tier shapers apply (the error path above
    // stays a raw ToolResult and passes through unshaped).
    return { data: merged };
  },
});
