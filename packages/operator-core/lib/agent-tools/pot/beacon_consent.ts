/**
 * pot:beacon_consent — owner/Mug management of a Pot's beacon-publish consent
 * (hive-network-surface-2026-06-11 P-005 / brief B-07; contract C-2).
 *
 * The agent-surface twin of the desktop consent UX (the creation-form checkbox +
 * the pot header toggle): enable / disable / read whether THIS Pot publishes a
 * live status beacon (active agents · queue depth · focus) onto the directory
 * gossip. Owner-consent, DEFAULT-OFF (D-002) — absent = OFF. Consent lives in
 * hive_settings (federates to every Swarm of the Pot) and is the gate B-06's
 * publisher (`maybeBuildPotBeacon`) checks before a beacon rides the re-announce.
 *
 * Sibling of `pot:cross_grant` (the other owner hive_settings policy verb).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { getBeaconPublishConsent, setBeaconPublishConsent } from '../../beacon-consent';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'pot:beacon_consent',
  profile: 'engineer',
  description:
    "Manage whether THIS Pot publishes a live status beacon (active agents, queue depth, focus, last-completed) onto the directory gossip — the owner-consent gate, default-OFF (D-002). Pass `consent` to set it (true = publish, false = stop); omit `consent` to read the current state. The consent federates to every Swarm of the Pot and gates B-06's beacon publisher. The beacon only rides a PUBLISHED (public/invite) pot's re-announce — enabling it on a private pot has no effect until the pot is published.",
  guidance: {
    when: "Enabling, disabling, or checking this Pot's status-beacon publishing — the same consent the desktop publish-flow asks for, managed from the agent surface. Pass consent:true to opt a published pot into the beacon, consent:false to withdraw it, or omit consent to read the current value.",
    notWhen:
      "Directory visibility (public/invite/private) — that's discovery:set_pot. Cross-Pot ask/work-request grants — pot:cross_grant. Within-Pot coordination — coord:* / topics.",
    chaining:
      "discovery:set_pot { visibility:'public' } (make the pot discoverable) → pot:beacon_consent { pot, consent:true } (opt the now-public pot into the live beacon).",
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z
      .string()
      .min(1)
      .max(120)
      .describe("This Pot's home slug (consent is Pot-scoped + federates to its Swarms)."),
    consent: z
      .boolean()
      .optional()
      .describe('true = publish a status beacon; false = stop. Omit to just READ the current consent (absent = OFF).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    if (args.consent === undefined) {
      return json({ ok: true, action: 'get', pot: args.pot, consent: await getBeaconPublishConsent(ws, args.pot) });
    }
    try {
      await setBeaconPublishConsent(ws, args.pot, args.consent);
    } catch (e) {
      // setPotSetting rejects when the pot doesn't exist (logical scope, no FK).
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), pot: args.pot });
    }
    return json({ ok: true, action: 'set', pot: args.pot, consent: args.consent });
  },
});
