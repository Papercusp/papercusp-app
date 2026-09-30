/**
 * discovery:pots — the operator endpoint serving the discovered P2P hive list
 * (p2p-hive-directory-2026-06-06 P-005).
 *
 * The read projection of the hive directory: it returns the verified, un-muted
 * hives this peer has seen announced on the directory topic (HiveDirectory.
 * listDiscoveredHives) for the browse-and-join UIs — the pui Hives/Network board
 * (apps/tui hives.rs) and the desktop HiveDirectoryPanel (`discovery:pots`). Each
 * entry is a best-effort gossip listing (D-002): the join CTA runs the full
 * admission flow, the listing grants nothing.
 *
 * Read-only; reuses the live directory service unchanged (no replicated log).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildHiveDirectoryRows } from '../../discovery-hive-rows';
import type { HiveStatusBeacon } from '../../hive-beacon';

export interface DiscoveredHiveRow {
  potId: string;
  title: string;
  description: string;
  owner: string;
  visibility: 'public' | 'invite';
  /**
   * The Hive's Ed25519 identity pubkey (raw-32-byte base64) — the cross-Hive DIAL
   * ADDRESS. Pass it to `pot:cross_grant { peerHivePubkey }` to admit this Hive.
   * Empty string when the announce carried no identity (not cross-Hive-addressable).
   */
  hivePubkey: string;
  /** Member harness topics (hex) — the display signal. */
  memberTopics: string[];
  /** Full join links per member harness (one-click join), when the hive carries them. */
  memberLinks: string[];
  /** Number of member harnesses a join would run join-shared-harness for. */
  memberCount: number;
  createdAt: number;
  lastSeenMs: number;
  /**
   * The opt-in status beacon the hive published (P-005 / C-2), already sanitized.
   * Present only when the hive consented to publish + the announce carried a
   * well-formed beacon. The Network board (B-08) renders it for tier-4 foreign
   * hives; use hive-beacon.isBeaconStale for the staleness badge.
   */
  beacon?: HiveStatusBeacon;
}

export default defineTool({
  name: 'discovery:pots',
  description:
    'Browse the P2P hive directory — the verified hives this peer has seen announced on the well-known directory topic (title · description · owner · member harnesses). Best-effort gossip: joining a listed hive still runs the full admission/attestation flow. Feeds the pui Hives/Network board + the desktop HiveDirectoryPanel.',
  capability: 'discovery:read',
  guidance: {
    when: 'You want to see hives available to join across the P2P network (the browse list behind the pui Hives/Network board + the desktop HiveDirectoryPanel).',
    notWhen:
      'To list the workspace-local deployed pot frames (hiveControlFrames) use the harness/pot surfaces. To actually join a listed hive, run the join-shared-harness flow per member topic.',
    seeAlso: [
      'discovery:set_pot (edit your own hive\'s public listing)',
      'pot:ask (ask a peer Hive you discovered)',
      'pot:cross_grant (grant a discovered peer cross-hive access)',
    ],
  },
  requirePrincipal: false,
  args: z.object({
    /** Include hives whose last announce is past the freshness TTL (default false). */
    includeExpired: z.boolean().optional(),
    /** Max rows (default 200). */
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const rows: DiscoveredHiveRow[] = (await buildHiveDirectoryRows({ includeExpired: args.includeExpired }))
      .slice(0, args.limit ?? 200)
      .map((h) => ({
        ...h,
        hivePubkey: h.hivePubkey ?? '',
      }));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, count: rows.length, rows }),
        },
      ],
    };
  },
});
