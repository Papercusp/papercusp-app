/**
 * substrate:revoke_contributor — OWNER-revocation of another contributor, at
 * HARNESS scope or HIVE scope.
 *
 * Plan: non-collaborator-join-fork-pr-2026-06-02 D-001 (supersedes the old
 * substrate-revocation-v2 branch-delete design) + shared-hive-federation-2026-06-08
 * P-006 (the Hive-scope generalization).
 *
 * OWNER action: revoke a bad-actor contributor by adding their device pubkeys to a
 * revocation set (the owner's own row's `revoked_pubkeys`, which federates and is
 * honored by every peer's `read-admission` union). The contributor is dropped from
 * live federation on the next admission re-verify. Replaces the old branch-delete,
 * which is a no-op in the write-free model (admission is gated on the attestation
 * gist, not a repo branch).
 *
 * Two scopes (provide exactly one):
 *   - `harnessSlug` — revoke from ONE shared harness's federation (the per-harness
 *     revoked set; authority = repo-admin GitHub token).
 *   - `potSlug` — revoke from the WHOLE Hive (all its harnesses' federation) in one
 *     action — the "join the Hive once, revoke from the Hive once" symmetry (P-006).
 *     Authority = the Swarm that HOLDS the Hive private key (keypair-native, not
 *     gh-repo-admin — a Hive may be repo-less).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { revokeContributorViaGithub } from '../../sync/hyperbee/revoke-contributor';
import { revokeHiveContributor } from '../../hive-revoke-contributor';
import { resolveFederatedPotScope } from '../../federated-pot-scope';

export default defineTool({
  name: 'substrate:revoke_contributor',
  profile: 'engineer',
  description:
    "OWNER action: revoke another contributor by adding their device pubkeys to a revocation set. Scope is per-HARNESS (`harnessSlug`) or per-HIVE (`potSlug` — revokes from the whole Hive's federation at once, P-006). Every peer honors it on the next admission re-verify and drops them from live federation. Harness scope requires a repo-admin token; Hive scope requires holding the Hive key.",
  capability: 'intel:write',
  guidance: {
    when: "OWNER action: revoke ANOTHER contributor by adding their device pubkeys to a revocation set. Pass `harnessSlug` to drop them from ONE harness's federation (repo-admin token), or `potSlug` to drop them from the WHOLE Hive's federation in one action (P-006 — requires this Swarm to hold the Hive key). Use when a contributor is a confirmed bad actor, their account is compromised, or they must be removed from the shared federation entirely.",
    notWhen:
      'Revoking your OWN device — use `substrate:revoke_self_device` instead. For harness scope, not when the token lacks GitHub admin on the shared repo. For Hive scope, not when this Swarm does not hold the Hive private key (only the owning Swarm may revoke Hive-wide).',
    chaining:
      "Resolve the contributor's githubUserId from the Contributors tab, `dev:dogfood_substrate_status`, `harness:membership`, or `pot:get` first — githubUserId is the stable numeric GitHub user id, not the login.",
    seeAlso: [
      'substrate:revoke_self_device (revoke your OWN device)',
      'dev:dogfood_substrate_status (resolve the contributor githubUserId)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger', 'architect'],
  args: z
    .object({
      workspaceId: z.string().min(1).describe('The workspace ID the harness/Pot belongs to.'),
      harnessSlug: z
        .string()
        .min(1)
        .optional()
        .describe('HARNESS-scoped revoke: the harness slug. Provide EITHER harnessSlug OR potSlug.'),
      potSlug: z
        .string()
        .min(1)
        .optional()
        .describe(
          "HIVE-scoped revoke: the Hive's home slug — revokes the contributor from the WHOLE Hive's federation (all its harnesses) at once (P-006). Provide EITHER harnessSlug OR potSlug.",
        ),
      githubUserId: z
        .number()
        .int()
        .positive()
        .describe(
          'The NUMERIC GitHub user id of the contributor to revoke (e.g. 12345). This is the stable id, not the login string. Their device pubkeys are added to the revocation set.',
        ),
      devicePubkey: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Hive scope only: revoke just this one attested device (base64) of githubUserId, e.g. a departed test VM that used the owner's own login. Refused if it is this Swarm's own device.",
        ),
    })
    .refine((a) => !!a.harnessSlug !== !!a.potSlug, {
      message: 'Provide exactly one of harnessSlug (harness scope) or potSlug (Pot scope).',
    })
    .refine((a) => !(a.devicePubkey && a.harnessSlug), {
      message: 'devicePubkey is Hive-scoped: pass it with potSlug (for your own harness device use substrate:revoke_self_device).',
    }),
  async handler(args) {
    const result = args.potSlug
      ? await revokeHiveContributor({
          workspaceId: args.workspaceId,
          // WI-6318: `potSlug` is a TOOL ARGUMENT, so on a joiner it is the LOCAL pot handle,
          // while pot_members lives under the OWNER-authored (federated) slug. The revoke
          // UPDATEs the caller's own member row, so an unresolved local handle finds no row
          // and the revoke fails outright ("owner has no hive_members row — join the Hive
          // before revoking") on a Pot the caller has genuinely joined. Resolving is a no-op
          // on an owner and fails open to the local handle.
          potHomeSlug: await resolveFederatedPotScope(args.workspaceId, args.potSlug),
          githubUserId: args.githubUserId,
          devicePubkey: args.devicePubkey,
        })
      : await revokeContributorViaGithub({
          workspaceId: args.workspaceId,
          harnessSlug: args.harnessSlug!,
          githubUserId: args.githubUserId,
        });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
