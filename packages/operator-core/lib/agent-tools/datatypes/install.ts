/**
 * datatypes:install — install an APPROVED global datatype into your workspace
 * (reflexive-platform-extensibility-datatypes-2026-06-24 D-010 distribution).
 *
 * Copies an approved published datatype's definition into THIS workspace as a LOCAL
 * datatype, so it's usable like one you declared (a generic-kind's work_item_kind becomes
 * accepted; a blueprint can depend on it). The approved source is globally readable
 * (migration 426); the copy is written into the caller's own workspace (RLS WITH CHECK),
 * so an agent can only install INTO its own workspace. Idempotent.
 *
 * SCOPE, since P-027 / D-010 retired the parallel storefront: this is the INTRA-DATABASE
 * workspace→workspace copy of a row that is ALREADY approved in this same database. It is
 * not the storefront install — cross-machine distribution is cupboard:install-datatype,
 * over Cupboard `datatype` listings. Both are kept because they move different things:
 * a row between workspaces here, versus a verified package between machines.
 * `installPublishedDatatype` also has a live non-tool consumer (bundle-app-install-io
 * resolves an app bundle's declared datatype dependencies through it).
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { installPublishedDatatype } from '../../datatype-registry-store';

export default defineTool({
  name: 'datatypes:install',
  description:
    'Copy an APPROVED datatype that already exists in this database into your workspace as a LOCAL datatype ' +
    'you can use like one you declared. Idempotent: already-present ⇒ no change.',
  guidance: {
    when: 'Reusing a datatype already approved in this database from another workspace, without going through the Cupboard.',
    notWhen:
      "Declaring a NEW datatype (meta:define-datatype). Installing a PUBLISHED datatype from the Cupboard — that is cupboard:install-datatype, over cupboard:search { kind:'datatype' }.",
    chaining: 'datatypes:install { id } → work_items:create { kind } / dependencies.datatypes.',
    seeAlso: [
      "cupboard:install-datatype (install a published datatype from the Cupboard)",
      'datatypes:list (what this workspace already resolves)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('the approved datatype id to copy into this workspace'),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      return reply({ ok: false, reason: 'no_workspace', message: 'no workspace in the request context' });
    }
    const res = await installPublishedDatatype(sql, args.id, workspaceId);
    if (!res.ok) {
      return reply({
        ok: false,
        reason: res.reason,
        message:
          res.reason === 'not_found'
            ? `no APPROVED datatype "${args.id}" in this database — for a PUBLISHED one, browse cupboard:search { kind:'datatype' } and install it with cupboard:install-datatype`
            : `"${args.id}" is already present in this workspace`,
      });
    }
    return reply({
      ok: true,
      datatype: res.datatype,
      note:
        `installed "${res.datatype.id}" into this workspace — now usable locally` +
        (res.datatype.tier === 'generic-kind' && res.datatype.workItemKind
          ? ` (work_items:create { kind:"${res.datatype.workItemKind}" }).`
          : '.'),
    });
  },
});
