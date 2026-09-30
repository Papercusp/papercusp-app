/**
 * Read-only proposal views:
 *
 *   GET /api/harness/:slug/proposals       — proposal index + replanOnAccept flag
 *   GET /api/harness/:slug/proposals/:id   — one proposal .md file
 *
 * ProposalsPanel reads the list via Zero (harness_proposals_shared) since
 * Phase 2.5; these endpoints exist for back-compat + the replanOnAccept
 * flag the panel reads once at mount.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 11). The accept/reject POST mutations stay in harness.ts for
 * a later batch.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProject, harnessDir, safeRead } from '../../../harness-core';
import type { ProjectEntry } from '../../../harness-registry';
import { readEffectiveHarnessConfig } from '../../../harness-effective-config';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

interface ProposalListEntry {
  id: string;
  sizeBytes: number;
  ts: number;
  status: 'pending' | 'applied' | 'rejected';
  reviewVerdict: 'accept' | 'reject' | 'defer' | null;
  reviewedAt: number | null;
  reviewSummary: string | null;
  appliedAt: number | null;
  rejectedAt: number | null;
}

function parseFooterTs(body: string, key: 'appliedAt' | 'rejectedAt'): number | null {
  const m = body.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

function scanProposalsDir(project: ProjectEntry): ProposalListEntry[] {
  const dir = join(harnessDir(project), 'proposals');
  if (!existsSync(dir)) return [];
  const allFiles = readdirSync(dir);
  const reviewSet = new Set(allFiles.filter((f) => f.endsWith('.review.md')));
  return allFiles
    .filter((f) => f.endsWith('.md') && !f.endsWith('.review.md'))
    .map((f): ProposalListEntry => {
      const full = join(dir, f);
      let size = 0, ts = 0;
      try { const s = statSync(full); size = s.size; ts = Math.floor(s.mtimeMs); } catch {}
      const body = safeRead(full) ?? '';
      const applied = /^applied:\s*true/m.test(body);
      const rejected = /^rejected:\s*true/m.test(body);
      const status: ProposalListEntry['status'] = applied ? 'applied' : rejected ? 'rejected' : 'pending';
      const appliedAt = applied ? (parseFooterTs(body, 'appliedAt') ?? ts) : null;
      const rejectedAt = rejected ? (parseFooterTs(body, 'rejectedAt') ?? ts) : null;

      const reviewName = `${f.replace(/\.md$/, '')}.review.md`;
      let reviewVerdict: ProposalListEntry['reviewVerdict'] = null;
      let reviewedAt: number | null = null;
      let reviewSummary: string | null = null;
      if (reviewSet.has(reviewName)) {
        const reviewPath = join(dir, reviewName);
        const reviewBody = safeRead(reviewPath) ?? '';
        const verdictMatch = reviewBody.match(/^VERDICT:\s*(accept|reject|defer)\b/im);
        if (verdictMatch) {
          const v = verdictMatch[1].toLowerCase();
          if (v === 'accept' || v === 'reject' || v === 'defer') reviewVerdict = v;
        }
        try { reviewedAt = Math.floor(statSync(reviewPath).mtimeMs); } catch {}
        const summaryLine = reviewBody
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^VERDICT:/i.test(l) && !/^#/.test(l));
        reviewSummary = summaryLine ? summaryLine.slice(0, 240) : null;
      }
      return { id: f, sizeBytes: size, ts, status, reviewVerdict, reviewedAt, reviewSummary, appliedAt, rejectedAt };
    })
    .sort((a, b) => b.ts - a.ts);
}

const getProposals = defineTool({
  method: 'GET',
  path: '/harness/:slug/proposals',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const dir = join(harnessDir(project), 'proposals');
    if (!existsSync(dir)) return Response.json({ proposals: [], replanOnAccept: true });

    const items = scanProposalsDir(project);

    let replanOnAccept = true;
    try {
      const cfg = await readEffectiveHarnessConfig(project.slug, activeWorkspaceId(), project.path);
      const reviewer = cfg?.reviewer as { replanOnAccept?: boolean } | undefined;
      if (reviewer?.replanOnAccept === false) replanOnAccept = false;
    } catch {}

    return Response.json({ proposals: items, replanOnAccept });
  },
});

const getProposalById = defineTool({
  method: 'GET',
  path: '/harness/:slug/proposals/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = String(ctx.params.id).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!id || !id.endsWith('.md')) return Response.json({ error: 'invalid id' }, { status: 400 });
    const p = join(harnessDir(project), 'proposals', id);
    if (!existsSync(p)) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({ id, content: safeRead(p) });
  },
});

export default [getProposals, getProposalById];
