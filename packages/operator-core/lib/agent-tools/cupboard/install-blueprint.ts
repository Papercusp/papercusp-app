/**
 * cupboard:install-blueprint — install a blueprint from the Cupboard
 * (cupboard-agent-tool-coverage-2026-07-14 P-005).
 *
 * The agent-callable face of `installBlueprintFromCupboard` — the SAME core the
 * loopback POST /cupboard/install-blueprint route calls (D-001 reuse-first, no
 * fork): git-clone the listing's repo, validate the blueprint, and place it under
 * ~/.papercusp/blueprints/<id>/ (the installed tier that shadows the built-in of
 * the same id). With installPlugins:true the blueprint's Cupboard-resolvable
 * plugin deps auto-install (consent-gated); declared work-blueprint deps pull
 * their providers in (spawned-blueprint closure).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { classContractConsentSchema } from '../../cupboard/class-contract-payload';
import { recipeProviderConsentSchema } from '../../cupboard/capability-grant-resolver';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:install-blueprint',
  capability: 'harness:write',
  description:
    "Manage the complete lifecycle of a Cupboard blueprint on the existing blueprint store: install/update validates the repo and immutable full-content closure; rollback selects a previously installed version; uninstall removes the active library entry while retaining pinned version bytes for live sessions. Prompt-text and burn-knob diffs are returned. activationStack preflights exclusive-slot conflicts for a combined install-and-activate; applying the desired revision remains the acknowledged P-040 activation door. No identity-specific installer or listing kind is used.",
  guidance: {
    when: "Installing a blueprint from the Cupboard so it becomes available to harness:create — the user found a blueprint listing (cupboard:search / blueprint:catalog) and wants it installed.",
    notWhen:
      "Browsing installable blueprints (blueprint:catalog); creating a harness from an ALREADY-installed blueprint (harness:create); installing a plugin (cupboard:install-plugin) or app-template (templates:new-app); publishing a blueprint (blueprint:publish).",
    chaining:
      'Find the listing first (cupboard:search / blueprint:catalog) for its listingId. After install, harness:create can use the blueprint. Set installPlugins:true to also pull the blueprint\'s declared plugin deps.',
    seeAlso: [
      'blueprint:catalog (browse installable blueprints)',
      'harness:create (create a harness from the installed blueprint)',
      'cupboard:install-plugin (install a plugin instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id — resolves the repo URL + listing_ref from the listing.'),
    githubUrl: z.string().max(500).optional().describe('Install a repo directly instead of resolving a listing (listingRef = the blueprint subdir).'),
    listingRef: z.string().max(200).optional().describe('Within-repo blueprint discriminator (the subdir to look in first).'),
    installPlugins: z
      .boolean()
      .optional()
      .describe("Consent to auto-install the blueprint's Cupboard-resolvable plugin deps and the fully reviewed transitive package closure of selected capability providers."),
    operation: z.enum(['install', 'update', 'rollback', 'uninstall']).default('install'),
    blueprintId: z.string().max(120).optional().describe('Installed blueprint id; required for rollback/uninstall.'),
    targetVersion: z.string().max(200).optional().describe('Previously installed version or package content hash; required for rollback.'),
    activationStack: z.array(z.string().min(1).max(120)).max(40).optional()
      .describe('Ids already selected for a combined install-and-activate preflight. Library-only install permits alternatives.'),
    potSlug: entityRef('pot', {
      soft: true,
      max: 120,
      describe: 'Target pot for install-time capability-class grant resolution; required when the identity declares grants.',
    }).optional(),
    capabilityRole: z.string().trim().min(1).max(120).optional()
      .describe('Administrator-declared target role for the grant ceiling. Required for a multi-role pot; omission is inferred only for a single-role pot. Selecting a role does not widen its permissions.'),
    capabilityProviderSelections: z.record(z.string(), z.string().min(1)).optional()
      .describe('Explicit provider choices keyed by exact class@version ref; values are provider package or package@version.'),
    classContractConsent: classContractConsentSchema.optional()
      .describe('Administrator decision on the consentSubject from a class_contract_consent_required refusal, plus decision.'),
    recipeProviderConsent: recipeProviderConsentSchema.optional()
      .describe('Administrator decision on the consentSubject from a capability_recipe_provider_consent_required refusal, plus decision.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    if ((args.operation === 'install' || args.operation === 'update') && !args.listingId && !args.githubUrl) {
      return text({ ok: false, error: 'listingId or githubUrl required for install/update' });
    }
    if ((args.operation === 'rollback' || args.operation === 'uninstall') && !args.blueprintId) {
      return text({ ok: false, error: `blueprintId required for ${args.operation}` });
    }
    if (args.operation === 'rollback' && !args.targetVersion) {
      return text({ ok: false, error: 'targetVersion required for rollback' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    if (args.operation !== 'uninstall') {
      const gate = await gateInstallDoor({
        idOrRef: args.listingId ?? args.listingRef ?? args.blueprintId,
        kind: 'blueprint',
        subject,
        operation: args.operation === 'rollback' ? 'rollback' : 'install',
      });
      if (!gate.ok) {
        return text({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
      }
    }

    const { installBlueprintFromCupboard } = await import('../../cupboard/install-blueprint-io');
    const outcome = await installBlueprintFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      installPlugins: args.installPlugins === true,
      operation: args.operation,
      ...(args.blueprintId ? { blueprintId: args.blueprintId } : {}),
      ...(args.targetVersion ? { targetVersion: args.targetVersion } : {}),
      ...(args.activationStack ? { activationStack: args.activationStack } : {}),
      workspaceId: subject,
      ...(args.potSlug ? { potSlug: args.potSlug } : {}),
      ...(args.capabilityRole ? { capabilityRole: args.capabilityRole } : {}),
      capabilityMode: 'agent',
      ...(args.capabilityProviderSelections
        ? { capabilityProviderSelections: args.capabilityProviderSelections }
        : {}),
      ...(args.classContractConsent ? { classContractConsent: args.classContractConsent } : {}),
      ...(args.recipeProviderConsent ? { recipeProviderConsent: args.recipeProviderConsent } : {}),
    });

    if (!outcome.ok) {
      return text({
        ok: false,
        error: outcome.error,
        detail: outcome.detail,
        status: outcome.status,
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
      });
    }
    const r = outcome.result;
    if (!('pluginInstalls' in r)) {
      return text({ ok: true, ...r });
    }
    return text({
      ok: true,
      id: r.id,
      version: r.version,
      operation: r.operation,
      abstract: r.abstract,
      installedTo: r.installedTo,
      release: r.release,
      diff: r.diff,
      activationPreflight: r.activationPreflight,
      activationRequired: r.operation === 'update',
      dependencies: r.dependencies,
      capabilityGrants: r.capabilityGrants,
      capabilityProviderReview: r.capabilityProviderReview,
      capabilityProviderInstalls: r.capabilityProviderInstalls,
      ...(r.classContracts ? { classContracts: r.classContracts } : {}),
      ...(r.pluginInstalls.length > 0 ? { pluginInstalls: r.pluginInstalls } : {}),
      ...(r.blueprintInstalls.length > 0 ? { blueprintInstalls: r.blueprintInstalls } : {}),
    });
  },
});
