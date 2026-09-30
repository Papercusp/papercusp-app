/**
 * hive:store_breakdown — bytes per CORE and per KIND for the hive peer-log store
 * (plan shared-pot-dao-cupboard-v1-2026-09-04 P-043; D-057, WI-2147374).
 *
 * WHY THE TOOL EXISTS. D-057 measured a 46 GB store on the dev box against
 * "~66 MB/day of row content" and recorded the >10x gap as UNEXPLAINED — not
 * because it is hard, but because nothing in the tree could answer "what is in
 * the store". `dogfood:substrate_status` reports op COUNTS; `dev:pg_table_sizes`
 * reports POSTGRES bytes, which is a different store entirely. Answering it took
 * a `du`, three hand-written queries and an arithmetic step nobody would repeat.
 * This is that answer as one call, so the next agent reads a measurement instead
 * of re-deriving one — and so a retention regression is visible before it is 46 GB.
 */
import { z } from 'zod';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { workspacesRoot } from '../../workspace-registry';
import { harnessStorePath } from '../../sync/hyperbee/corestore';
import { collectSubstrateLogStats } from '../../sync/hyperbee/log-stats';
import {
  measureStoreDir,
  relateStoreToWire,
  summarizeKindVolume,
  type KindVolumeRow,
} from '../../sync/hyperbee/store-breakdown';
import { checkHiveLogRetentionCoverage } from '../../harness-state/hive-log-retention';

export default defineTool({
  name: 'hive:store_breakdown',
  description:
    "What the hive peer-log store actually holds: on-disk bytes per harness store (split by RocksDB file class — .sst vs .blob), op counts per admitted log, and per-federated-kind append volume over a window joined to each kind's RETENTION CLASS. `amplification.versionMultiplier` (appends ÷ distinct keys) is the real growth driver — an append-only log stores every VERSION while PG stores the current one — and `appendsPerKey` names which kinds pay it. Read `storeBytesPerWindowWireByte` WITH its caveat: the store spans every admitted peer since creation, the wire figure is this peer over the window, so it is a scale check and never an amplification factor.",
  guidance: {
    when: "Asking where a hyperbee/peer-log store's bytes went, whether a federated kind's volume is growing, whether a new op kind landed without a retention class (`unclassifiedProducers`), or sizing what an epoch-rotation pass would reclaim (the `rotating` rows). Also the before/after instrument for any retention change.",
    notWhen:
      'Postgres table sizes — dev:pg_table_sizes. Replay cost / op counts alone — dev:dogfood_substrate_status. Whether federation is FLOWING (drain stalls, admitted-set health) — dev:dogfood_substrate_status.',
    seeAlso: ['dev:pg_table_sizes (the OTHER store)', 'dev:dogfood_substrate_status (is federation flowing)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'curator'],
  args: z.object({
    workspace: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Workspace id. Omit to report every booted harness.'),
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('Harness slug. Omit to report every booted harness.'),
    windowHours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .optional()
      .describe('Append-volume window for the per-kind rollup (default 24).'),
    skipDiskWalk: z
      .boolean()
      .optional()
      .describe(
        'Skip the on-disk measurement and report op counts + per-kind volume only. The walk stats every file in the store (2,709 files / 46 GB on the dev box, ~1s); skip it when you only need the kind rollup.',
      ),
  }),
  async handler(args) {
    const windowHours = args?.windowHours ?? 24;
    const wantWorkspace = args?.workspace;
    const wantHarness = args?.harness;

    const logStats = collectSubstrateLogStats().filter(
      (s) =>
        (wantWorkspace ? s.workspaceId === wantWorkspace : true) &&
        (wantHarness ? s.harnessSlug === wantHarness : true),
    );

    // A caller can name a harness whose substrate is not booted in THIS process
    // (the sidecar owns it, or it is simply down). Report the store from disk
    // anyway — the bytes are there whether or not this process holds the cores —
    // rather than answering with an empty list that reads like "nothing to see".
    const targets =
      logStats.length > 0
        ? logStats.map((s) => ({ workspaceId: s.workspaceId, harnessSlug: s.harnessSlug, stats: s }))
        : wantWorkspace && wantHarness
          ? [{ workspaceId: wantWorkspace, harnessSlug: wantHarness, stats: null }]
          : [];

    const sql = getOrgPg().sql;
    const sinceMs = Date.now() - windowHours * 3600_000;

    const harnesses = [];
    for (const t of targets) {
      const storePath = harnessStorePath({
        workspaceRoot: join(workspacesRoot(), t.workspaceId),
        harnessSlug: t.harnessSlug,
      });
      const disk = args?.skipDiskWalk ? null : measureStoreDir(storePath);

      // Per-KIND: what this peer PUT on the log over the window. substrate_outbox
      // is the CDC producer queue, so it is exactly the own-log append stream —
      // and it carries the wire `row`, which is what the log stores, not the PG
      // row's on-disk footprint (the substitution that made D-057's baseline ~4x low).
      const volumeRows = (await sql`
        SELECT table_name,
               count(*)::int                       AS appends,
               count(DISTINCT key)::int            AS distinct_keys,
               coalesce(round(avg(pg_column_size(row)))::int, 0) AS avg_wire_bytes,
               coalesce(sum(pg_column_size(row)), 0)::bigint     AS wire_bytes
          FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${t.workspaceId}
           AND harness_slug = ${t.harnessSlug}
           AND ts > ${sinceMs}
         GROUP BY table_name
      `) as unknown as {
        table_name: string;
        appends: number;
        distinct_keys: number;
        avg_wire_bytes: number;
        wire_bytes: string | number;
      }[];

      const kindRows: KindVolumeRow[] = volumeRows.map((r) => ({
        table: r.table_name,
        appends: Number(r.appends),
        distinctKeys: Number(r.distinct_keys),
        avgWireBytes: Number(r.avg_wire_bytes),
        wireBytes: Number(r.wire_bytes),
      }));
      const kinds = summarizeKindVolume(kindRows, windowHours);

      harnesses.push({
        workspaceId: t.workspaceId,
        harnessSlug: t.harnessSlug,
        booted: t.stats !== null,
        store: disk,
        logs: t.stats
          ? {
              ownLogOps: t.stats.ownLogOps,
              admittedLogCount: t.stats.admittedLogCount,
              replayCostOps: t.stats.replayCostOps,
              largestLogOps: t.stats.largestLogOps,
              perLog: t.stats.perLog.slice(0, 10),
            }
          : null,
        kinds,
        scale:
          disk && !disk.unreadable
            ? relateStoreToWire(disk.totalBytes, t.stats?.replayCostOps ?? 0, kinds.amplification.wireBytes24h)
            : null,
      });
    }

    // Surface the build-time invariant at runtime too: an operator reading this
    // tool should not have to know a doc-claim test exists to learn that a
    // federated kind shipped without a retention class.
    const coverage = checkHiveLogRetentionCoverage();

    const payload = {
      windowHours,
      harnesses,
      retentionCoverage: {
        ok: coverage.ok,
        unclassified: coverage.unclassified,
        orphanPolicy: coverage.orphanPolicy,
        incoherent: coverage.incoherent,
      },
      note:
        targets.length === 0
          ? 'No booted substrate harness matched. Pass BOTH workspace and harness to measure a store from disk without a booted handle.'
          : undefined,
    };

    // Return the canonical payload shape so the framework owns MCP wire
    // encoding and the tool remains schema-able.
    return { data: payload };
  },
});
