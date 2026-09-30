/**
 * GET /api/admin/testing/domains/:id — full detail for one tab.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-003.
 *
 * Walks every section's globs server-side and returns the resolved file
 * list (path, size, mtime) plus the explicit `runners` declarations.
 * The SPA renders <DomainTestPanel> from this payload directly.
 *
 * Glob walk happens at REQUEST time — no checked-in catalog, no cache.
 * Worst-case cost is a handful of `fs.readdir` recursions; for the
 * largest tab (papercusp-su/tools) that scans ~1500 files and finishes
 * in tens of milliseconds.
 */

import { defineTool } from '@papercusp/agent-mcp';
import '../../../testing-domains-registry';
import { getTestDomain, type TestSection, type TestRunner, type TestTier } from '../../../testing-domains';
import { expandGlobs, inferWorkspaceRoot, type FileHit } from '../../../testing-domain-glob';

interface ResolvedSection {
  id: string;
  label: string;
  description?: string;
  files: FileHit[];
  runners: TestRunner[];
}

interface DomainDetail {
  id: string;
  label: string;
  description: string;
  tier: TestTier;
  sections: ResolvedSection[];
  totalFiles: number;
}

async function resolveSection(
  root: string,
  s: TestSection,
): Promise<ResolvedSection> {
  const files = s.globs?.length ? await expandGlobs(root, s.globs) : [];
  return {
    id: s.id,
    label: s.label,
    description: s.description,
    files,
    runners: s.runners ?? [],
  };
}

export default defineTool({
  method: 'GET',
  path: '/admin/testing/domains/:id',
  auth: { trust: ['verified', 'trusted'] },
  async handler(_req, ctx): Promise<Response> {
    const id = ctx.params.id;
    if (!id) return new Response('missing domain id', { status: 400 });

    const domain = getTestDomain(id);
    if (!domain) {
      return Response.json(
        { error: 'unknown_domain', domainId: id },
        { status: 404 },
      );
    }

    const root = inferWorkspaceRoot();
    const sections = await Promise.all(
      domain.sections.map((s) => resolveSection(root, s)),
    );
    const totalFiles = sections.reduce((n, s) => n + s.files.length, 0);

    const payload: DomainDetail = {
      id: domain.id,
      label: domain.label,
      description: domain.description,
      tier: domain.tier,
      sections,
      totalFiles,
    };
    return Response.json(payload);
  },
});
