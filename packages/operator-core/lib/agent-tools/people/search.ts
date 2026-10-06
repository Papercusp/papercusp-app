/**
 * people:search — find canonical persons in the workspace relationship graph
 * (crm-agent-sales-onboarding-apps-2026-10-06 P-003, D-016 / D-017). The graph is the only person
 * store: Email, Calendar, Phone and the CRM call this through their platform tool invoker instead
 * of keeping contact tables. Read-only; identity fields only, never interaction content.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { isCodingAgentRole } from '../../personal-vault/coding-roles';
import { PEOPLE_SEARCH_MAX_LIMIT, searchPeople } from '../../relationship-graph/people';

export default defineTool({
  name: 'people:search',
  description:
    'Search canonical persons (PER- ids) in the workspace relationship graph by free text (name, email, phone digits) ' +
    'and/or exact `emails` / `phones`. Exact identity matches rank first. Returns { ok, people:[{ id, displayName, emails, ' +
    'phones, organizationId, title, sourceRecordCount }], count }. Read-only.',
  guidance: {
    when: 'An app or agent needs the person behind a name, address or number (contact lookup, recipient autocomplete, CRM person list).',
    notWhen: 'For one known PER- id, use people:get. For message or meeting content, use personal:search.',
    chaining: 'people:search → people:get { ids } after a stored id may have been merged.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    query: z.string().max(200).optional().describe('free text: part of a name, an address, or phone digits'),
    emails: z.array(z.string().min(1).max(320)).max(50).optional().describe('exact email addresses'),
    phones: z.array(z.string().min(1).max(40)).max(50).optional().describe('exact phone numbers'),
    limit: z.number().int().min(1).max(PEOPLE_SEARCH_MAX_LIMIT).optional().describe('max persons (default 50)'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId?.trim() ?? '';
    const refused = isCodingAgentRole((ctx as { role?: string | null }).role)
      ? 'coding_agent_denied'
      : !workspaceId || workspaceId === '*' ? 'workspace_required' : null;
    const people = refused ? [] : await searchPeople(getOrgPg().sql, workspaceId, args);
    return { data: { ok: refused === null, error: refused, people, count: people.length } };
  },
});
