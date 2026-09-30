/**
 * substrate:revoke_self_device — MCP tool for self-revocation.
 *
 * Plan: substrate-revocation-v1 Task 3 (D-003/D-004/D-005).
 *
 * Revoke ONE of your own device pubkeys from a harness (a lost or rotated
 * device). Writes the updated contributor row to the booted handle's own
 * log (replicates + projects to `harness_shared.contributors`) and calls
 * handle.revoke() for immediate local effect.
 *
 * Self-revocation only: you can only revoke pubkeys that appear in your
 * OWN device_attestations. Revoking another contributor is not supported
 * (v2, needs a trust-model decision).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { revokeSelfDevice } from '../../sync/hyperbee/revoke-self-device';

export default defineTool({
  name: 'substrate:revoke_self_device',
  profile: 'engineer',
  description:
    'Revoke one of your own device pubkeys from a harness (lost or rotated device). Adds the pubkey to revoked_pubkeys in your contributor row, replicates to peers, and drops the device from the booted substrate immediately.',
  capability: 'intel:write',
  guidance: {
    when: 'Revoke ONE of your OWN device keys from a harness (a lost or rotated device) so peers stop admitting it.',
    notWhen: "Revoking ANOTHER contributor's key / kicking out a bad actor — not supported (self-revocation only, v2 for owner-revocation).",
    chaining:
      "Resolve the device pubkey from the contributor's own device_attestations first (e.g. via dev:dogfood_substrate_status or the Contributors tab).",
    seeAlso: [
      'substrate:revoke_contributor (revoke ANOTHER contributor — owner scope)',
      'dev:dogfood_substrate_status (resolve the device pubkey)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger', 'architect'],
  args: z.object({
    workspaceId: z.string().min(1).describe('The workspace ID the harness belongs to.'),
    harnessSlug: z.string().min(1).describe('The harness slug to revoke the device from.'),
    devicePubkey: z
      .string()
      .min(1)
      .describe(
        "The device pubkey (base64) to revoke. Must be one of the caller's own device_attestations[].device_pubkey values.",
      ),
  }),
  async handler(args) {
    const result = await revokeSelfDevice(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
