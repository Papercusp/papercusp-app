/** Platform-only capability-class definition (identities-v1 P-016 / D-004). */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { isCompilableSchema } from '../../datatype-payload-validation';
import {
  CAPABILITY_CLASS_ID_PATTERN as CLASS_ID,
  CAPABILITY_CLASS_VERB_PATTERN as VERB_ID,
  CAPABILITY_CLASS_VERSION_PATTERN as SEMVER,
  defineCapabilityClass,
  capabilityClassVectorStorageAcceptsProfile,
  normalizeCapabilityClassId,
  type CapabilityClassVerbs,
} from '../../capability-class-registry-store';
const jsonSchema = z.record(z.string(), z.unknown());
const interfaceVerb = z.object({
  inputSchema: jsonSchema.describe('JSON Schema for the class verb input.'),
  outputSchema: jsonSchema.optional().describe('Optional JSON Schema for the class verb structured output.'),
});

export const defineCapabilityClassTool = defineTool({
  name: 'classes:define',
  description:
    'Define one immutable version of a platform capability class — a fine-grained, job-scoped interface ' +
    'contract such as crm.email@1.0.0. Platform-only in v1. The class is stored in the existing registry ' +
    'model; providers prove conformance separately with classes:validate.',
  guidance: {
    when:
      'When the platform needs a new reusable capability contract before providers can bind to it. Define ' +
      'job-scoped verbs, not a vendor-shaped bundle; a changed contract gets a new semantic version.',
    notWhen:
      'To claim a provider implements a class — use classes:validate, which derives schemas from the live ' +
      'projected-tool registry. To distribute a proposed third-party class — that follows the Cupboard review path.',
    chaining: 'classes:define → classes:get → classes:validate { providerPackage, verbBindings } → classes:get (derived bindings).',
    seeAlso: ['classes:list', 'classes:get', 'classes:validate'],
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    id: z.string().min(3).max(120).describe('Namespaced job-scoped class id, e.g. crm.email or storage.object-read.'),
    version: z.string().regex(SEMVER).describe('Immutable semantic version, e.g. 1.0.0.'),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    verbs: z.record(z.string().regex(VERB_ID), interfaceVerb).refine((value) => Object.keys(value).length > 0, {
      message: 'at least one interface verb is required',
    }),
    behavioralSuiteRef: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe('Optional future behavioral-suite hook. P-016 structural validation reports it as not-run, never passed.'),
    tags: z.array(z.string().min(1).max(80)).max(32).optional(),
  }),
  async handler(args, ctx) {
    const reply = (data: unknown) => ({ data });
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return reply({ ok: false, reason: 'no_workspace' });
    const id = normalizeCapabilityClassId(args.id);
    if (!CLASS_ID.test(id)) {
      return reply({
        ok: false,
        reason: 'invalid_class_id',
        message: 'class ids must be namespaced and job-scoped (for example crm.email)',
      });
    }
    const verbs = args.verbs as CapabilityClassVerbs;
    const invalidSchemas = Object.entries(verbs).flatMap(([verb, contract]) => [
      ...(!isCompilableSchema(contract.inputSchema) ? [`${verb}.inputSchema`] : []),
      ...(contract.outputSchema && !isCompilableSchema(contract.outputSchema) ? [`${verb}.outputSchema`] : []),
    ]);
    if (invalidSchemas.length) {
      return reply({
        ok: false,
        reason: 'invalid_interface_schema',
        fields: invalidSchemas,
        message: 'every class interface schema must compile as JSON Schema',
      });
    }

    const resolved = await buildQueryEmbedderResolved({
      acquireBudgetMs: interactiveEmbedAcquireBudgetMs(),
    }).catch(() => null);
    const embeddingProfile =
      resolved && capabilityClassVectorStorageAcceptsProfile(resolved.profile)
        ? resolved.profile
        : null;
    const embedding = resolved && embeddingProfile
      ? await resolved.embed(`${args.title}\n${args.description}`).catch(() => null)
      : null;
    const ident = resolveAgentIdentity(ctx);
    const result = await defineCapabilityClass(getOrgPg().sql, {
      workspaceId,
      id,
      version: args.version,
      title: args.title,
      description: args.description,
      interfaceVerbs: verbs,
      behavioralSuiteRef: args.behavioralSuiteRef ?? null,
      tags: args.tags ?? [],
      embedding,
      embeddingProfile: embedding ? embeddingProfile : null,
      createdBy: ident.ownerId,
    });
    if (result.conflict) {
      return reply({
        ok: false,
        reason: 'version_conflict',
        classRef: result.capabilityClass.ref,
        message: 'that class version already exists with different contract bytes; publish a new semantic version',
        existing: result.capabilityClass,
      });
    }
    return reply({
      ok: true,
      created: result.created,
      capabilityClass: result.capabilityClass,
      note: result.created ? 'class version defined' : 'identical class version already existed',
    });
  },
});

export default defineCapabilityClassTool;
