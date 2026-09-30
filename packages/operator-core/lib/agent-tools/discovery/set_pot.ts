/**
 * discovery:set_pot — the hive create/edit surface (p2p-hive-directory P-004).
 *
 * Carries a hive's directory metadata (title + description + visibility +
 * member harness topics) and, on save, announces it per its visibility:
 * `public` → the global directory topic, `invite` → an invite-scoped topic,
 * `private` → never announced. The metadata persists in the workspace registry
 * (hive-directory-meta.ts); the announce rides the live directory singleton
 * (a no-op broadcast until the substrate boot-join wires the transport).
 *
 * Idempotent create-or-edit: calling again with the same potId edits +
 * re-announces (the directory converges on the newer ts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { HIVE_VISIBILITIES } from '../../sync/hyperbee/hive-announce';
import type { HiveDirectoryMeta } from '../../hive-publish';
import { activeWorkspaceId } from '../../workspace-registry';
import { hardText, LIMITS } from '../limits';

export default defineTool({
  name: 'discovery:set_pot',
  description:
    "Create, edit, or WITHDRAW a hive's public listing — title, description, and visibility. This is ALSO the way to publish a harness/hive to the public Cupboard storefront: public = announce to the global P2P directory AND list the hive's member repos as kind='harness' Cupboard listings; invite = invite-scoped topic only (no Cupboard rows); private = withdraw (stop re-announcing + UNLIST the Cupboard rows). Saves the metadata + (re)publishes per visibility, so a public flip lists on the Cupboard and a private flip delists.",
  capability: 'discovery:write',
  guidance: {
    when: 'You want to publish a hive so others can find + join it — to the P2P directory AND (for a public hive whose member repos have GitHub coords) the public Cupboard storefront; or edit an existing listing (title/description/visibility); or WITHDRAW it (visibility:private stops re-announcing AND unlists its Cupboard rows). This is the harness/hive equivalent of cupboard:publish-plugin / :publish-template / blueprint:publish.',
    notWhen:
      "Creating a hive FROM a GitHub URL (pot:create_from_repo clones + auto-publishes by repo visibility); publishing a NON-harness kind (cupboard:publish-plugin for a plugin/pack, cupboard:publish-template for a template, blueprint:publish for a blueprint, knowledge_packs:publish for a pack, cupboard:publish-app for a standalone app); deploying a pot's execution frames (deploy:pot); browsing OTHERS' hives (discovery:pots).",
    seeAlso: [
      'pot:create_from_repo (create + auto-publish a hive FROM a GitHub URL)',
      'discovery:pots (browse OTHERS\' hives)',
      'cupboard:publish-plugin (publish a plugin/pack to the Cupboard instead)',
      'pot:get (the pot whose listing you are editing)',
    ],
  },
  requirePrincipal: false,
  args: z
    .object({
      potId: z.string().min(1).max(120),
      title: hardText(LIMITS.SHORT_TITLE),
      description: hardText(LIMITS.ANNOTATION, { min: 0 }).default(''),
      visibility: z.enum(HIVE_VISIBILITIES as unknown as [string, ...string[]]).default('public'),
      /** Member harness swarm-topics (hex) — the display signal (how many harnesses). */
      memberTopics: z.array(z.string().min(1)).max(64).optional(),
      /** Full papercusp://harness?... join links per member harness (one-click join). */
      memberLinks: z.array(z.string().min(1)).max(64).optional(),
      /** Required for visibility:invite — the secret whose topic invitees join. */
      inviteSecret: z.string().min(1).optional(),
      /** Epoch-ms created stamp (defaults to now on first create). */
      createdAt: z.number().int().positive().optional(),
    })
    // invite genuinely REQUIRES the secret — `publishHiveToDirectory` throws
    // without it (hive-publish.ts) and the sibling HTTP route 400s up front
    // (set-hive.ts). Reject here too so the MCP face fails cleanly BEFORE the
    // meta is saved, instead of half-saving then surfacing a generic
    // announceError (the "one flip surface" P-015 stays consistent).
    .refine((a) => a.visibility !== 'invite' || !!a.inviteSecret, {
      message: 'invite visibility requires inviteSecret',
      path: ['inviteSecret'],
    }),
  async handler(args) {
    // The composition (save → withdraw|publish) is shared with the HTTP face
    // (POST /api/discovery/set-pot) — one flip surface (P-015).
    const { setHiveListing } = await import('../../hive-set-listing');
    const res = await setHiveListing(
      {
        potId: args.potId,
        title: args.title,
        description: args.description,
        visibility: args.visibility as HiveDirectoryMeta['visibility'],
        ...(args.memberTopics ? { memberTopics: args.memberTopics } : {}),
        ...(args.memberLinks ? { memberLinks: args.memberLinks } : {}),
        ...(args.inviteSecret ? { inviteSecret: args.inviteSecret } : {}),
        ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      },
      activeWorkspaceId(),
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
  },
});
