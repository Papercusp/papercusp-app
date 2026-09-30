/** Prove a provider against a class from actual live projected-tool schemas. */
import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  projectedToolRegistryRevision,
  SU_ROLES,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  getCapabilityClass,
  parseCapabilityClassRef,
  recordProviderConformance,
  validateProviderInterface,
  type ProviderToolContract,
} from '../../capability-class-registry-store';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const validateCapabilityProviderTool = defineTool({
  name: 'classes:validate',
  description:
    'Validate one provider package against an exact capability class@version by deriving every bound ' +
    'tool schema from the live projected-tool registry. Every attempt records an immutable conformance run; ' +
    'only a passing run creates the provider binding. No caller-set conformance status exists.',
  guidance: {
    when: 'After a provider package registers its tools and the class contract exists. Map each logical class verb to its real MCP tool name.',
    notWhen: 'To define the class itself (classes:define) or to claim behavior-suite success; P-016 only proves structural schemas and reports a behavioral hook as not-run.',
    chaining: 'classes:get { ref } → classes:validate { classRef, providerPackage, providerVersion, verbBindings } → classes:get (attested provider appears).',
    seeAlso: ['classes:define', 'classes:list', 'classes:get'],
    returns: '{ ok, runId, conformance, binding? }; a failed structural run returns ok:false and never creates/updates a provider binding.',
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    classRef: z.string().min(3).max(220).describe('Exact class ref, e.g. crm.email@1.0.0.'),
    providerPackage: z.string().min(1).max(200).describe('Projected-tool plugin/package owner, matched exactly against tool.pluginName.'),
    providerVersion: z.string().regex(SEMVER),
    verbBindings: z
      .record(z.string().min(1).max(120), z.string().min(1).max(200))
      .refine((value) => Object.keys(value).length > 0, { message: 'at least one verb binding is required' })
      .describe('Logical class verb → actual MCP tool name.'),
  }),
  result: z
    .object({
      ok: z.boolean(),
      reason: z.string().optional(),
      classRef: z.string().optional(),
      runId: z.string().optional(),
      conformance: z.object({}).passthrough().optional(),
      binding: z.object({}).passthrough().optional(),
      note: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const reply = (data: unknown) => ({ data });
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return reply({ ok: false, reason: 'no_workspace' });
    const parsed = parseCapabilityClassRef(args.classRef);
    if (!parsed) return reply({ ok: false, reason: 'invalid_class_ref' });
    const capabilityClass = await getCapabilityClass(
      getOrgPg().sql,
      workspaceId,
      parsed.id,
      parsed.version,
    );
    if (!capabilityClass) return reply({ ok: false, reason: 'class_not_found', classRef: args.classRef });

    const tools = listAllProjectedTools();
    const byName = new Map(
      tools.flatMap((tool) => {
        const name = tool.expose.mcp?.name;
        return name ? [[name, tool] as const] : [];
      }),
    );
    const lookup = (name: string): ProviderToolContract | null => {
      const tool = byName.get(name);
      if (!tool) return null;
      return {
        name,
        pluginName: tool.pluginName,
        inputSchema: tool.discoveryInputSchema ?? tool.inputSchema,
        outputSchema: tool.outputJsonSchema ?? null,
      };
    };
    const registryRevision = projectedToolRegistryRevision();
    const report = validateProviderInterface({
      capabilityClass,
      providerPackage: args.providerPackage,
      providerVersion: args.providerVersion,
      registryRevision,
      verbBindings: args.verbBindings,
      lookup,
    });
    const ident = resolveAgentIdentity(ctx);
    const recorded = await recordProviderConformance(getOrgPg().sql, {
      workspaceId,
      classId: capabilityClass.id,
      classVersion: capabilityClass.version,
      providerPackage: args.providerPackage,
      providerVersion: args.providerVersion,
      verbBindings: args.verbBindings,
      report,
      performedBy: ident.ownerId,
    });
    return reply({
      ok: report.ok,
      runId: recorded.runId,
      conformance: report,
      ...(recorded.binding ? { binding: recorded.binding } : {}),
      note: report.ok
        ? 'structural conformance passed; provider binding now derives from this run'
        : 'structural conformance failed; the run was recorded and no provider binding changed',
    });
  },
});

export default validateCapabilityProviderTool;
