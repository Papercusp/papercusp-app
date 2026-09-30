/**
 * GET /api/admin/testing/domains — list every registered test domain.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-003.
 *
 * Returns the registry shape (id, label, description, tier, section
 * descriptors) WITHOUT walking the file system. The SPA renders the tab
 * list from this response; per-file walks happen in the per-domain
 * detail route (`testing-domain-detail.ts`).
 *
 * Importing the registry module here side-effect-registers all 21
 * domains; downstream callers (tests, smoke scripts) can rely on the
 * registry being populated.
 */

import { defineTool } from '@papercusp/agent-mcp';
import '../../../testing-domains-registry';
import { listTestDomains, type TestTier } from '../../../testing-domains';

interface SectionListEntry {
  id: string;
  label: string;
  description?: string;
  hasGlobs: boolean;
  hasRunners: boolean;
}

interface DomainListEntry {
  id: string;
  label: string;
  description: string;
  tier: TestTier;
  sections: SectionListEntry[];
}

export default defineTool({
  method: 'GET',
  path: '/admin/testing/domains',
  auth: { trust: ['verified', 'trusted'] },
  handler(): Response {
    const domains = listTestDomains().map<DomainListEntry>((d) => ({
      id: d.id,
      label: d.label,
      description: d.description,
      tier: d.tier,
      sections: d.sections.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        hasGlobs: (s.globs?.length ?? 0) > 0,
        hasRunners: (s.runners?.length ?? 0) > 0,
      })),
    }));
    return Response.json({ domains });
  },
});
