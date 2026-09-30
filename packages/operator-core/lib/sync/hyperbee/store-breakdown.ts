/**
 * store-breakdown — bytes per CORE and per KIND for a hive peer-log store
 * (plan shared-pot-dao-cupboard-v1-2026-09-04 P-043; D-057, WI-2147374).
 *
 * D-057 measured a 46 GB store against "~66 MB/day of row content" and recorded
 * the >10x gap as unexplained, because nothing in the tree could answer "what is
 * IN the store". `log-stats.ts` reports op COUNTS per log; this reports BYTES —
 * on disk, and per federated kind — so the ratio is read off a measurement
 * instead of inferred from two numbers taken with different instruments.
 *
 * TWO HALVES, deliberately separate, because they answer different questions:
 *
 *   PER CORE (`measureStoreDir` + `HarnessLogStats`) — what the storage engine
 *   is holding. Corestore 7 keeps every core of a harness in ONE RocksDB under
 *   `.papercusp/<slug>/hyperbee/db`, so per-FILE attribution to a core is not
 *   available from disk; what IS available is the total, the file-class split
 *   (`.sst` table files vs `.blob` files — hypercore-storage sets
 *   `minBlobSize: 4096`, so blocks at or above 4 KB land in blob files), and
 *   bytes-per-op against the admitted set's op count.
 *
 *   PER KIND (`summarizeKindVolume`) — what the peer is PUTTING there, measured
 *   from `harness_shared.substrate_outbox`: appends, distinct keys, and wire
 *   bytes per federated table over a window, joined to the table's retention
 *   class. `appendsPerKey` is the number the amplification explanation rests on:
 *   an append-only log stores every VERSION, PG stores the current one.
 *
 * Pure + injectable: the fs walk takes a path, the kind rollup takes rows. The
 * agent tool binds them to the booted-handle registry and PG.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  retentionSpecFor,
  summarizeAmplification,
  type AppendVolumeProjection,
  type AmplificationSummary,
  type RetentionClass,
} from '../../harness-state/hive-log-retention';

/** On-disk footprint of one harness store, split by RocksDB file class. */
export interface StoreDirMeasurement {
  path: string;
  /** Total bytes under the store directory. */
  totalBytes: number;
  fileCount: number;
  /** Bytes by file extension, largest first. `.sst`/`.blob` are the two that matter. */
  byFileClass: { ext: string; bytes: number; files: number; pct: number }[];
  /** Oldest / newest mtime seen, ISO — the store's age span. */
  oldestMtime: string | null;
  newestMtime: string | null;
  /** Set when the directory could not be read; totalBytes is then 0 and UNKNOWN, not zero. */
  unreadable?: string;
}

/**
 * Walk a store directory and total its bytes by file class. Never throws: an
 * unreadable store reports `unreadable` so a caller can tell "could not measure"
 * from "measured zero" — the distinction a bare 0 destroys.
 */
export function measureStoreDir(path: string, maxClasses = 6): StoreDirMeasurement {
  const byExt = new Map<string, { bytes: number; files: number }>();
  let totalBytes = 0;
  let fileCount = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        continue; // a file removed mid-walk (compaction) is not a measurement failure
      }
      totalBytes += st.size;
      fileCount += 1;
      // RocksDB numbers its files (000644.blob), so the EXTENSION is the class;
      // an extension-less control file (CURRENT, MANIFEST-…) keys on its name.
      const dot = entry.name.lastIndexOf('.');
      const ext = dot > 0 ? entry.name.slice(dot) : entry.name;
      const slot = byExt.get(ext) ?? { bytes: 0, files: 0 };
      slot.bytes += st.size;
      slot.files += 1;
      byExt.set(ext, slot);
      const m = st.mtimeMs;
      if (oldest === null || m < oldest) oldest = m;
      if (newest === null || m > newest) newest = m;
    }
  };

  try {
    walk(path);
  } catch (e) {
    return {
      path,
      totalBytes: 0,
      fileCount: 0,
      byFileClass: [],
      oldestMtime: null,
      newestMtime: null,
      unreadable: e instanceof Error ? e.message : String(e),
    };
  }

  const byFileClass = [...byExt.entries()]
    .map(([ext, v]) => ({
      ext,
      bytes: v.bytes,
      files: v.files,
      pct: totalBytes > 0 ? Number(((v.bytes / totalBytes) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, maxClasses);

  return {
    path,
    totalBytes,
    fileCount,
    byFileClass,
    oldestMtime: oldest === null ? null : new Date(oldest).toISOString(),
    newestMtime: newest === null ? null : new Date(newest).toISOString(),
  };
}

/** One federated table's measured append volume over the window. */
export interface KindVolumeRow {
  table: string;
  appends: number;
  distinctKeys: number;
  avgWireBytes: number;
  wireBytes: number;
}

export interface KindVolumeSummary {
  windowHours: number;
  rows: (AppendVolumeProjection & { classified: boolean })[];
  amplification: AmplificationSummary;
  /**
   * Tables that PRODUCED appends in the window but carry NO retention class —
   * the P-043 gap observed at runtime rather than at build time. Should always
   * be empty (the doc-claim test fails the build first); non-empty here means a
   * producer shipped ahead of its classification.
   */
  unclassifiedProducers: string[];
}

/**
 * Roll measured outbox rows into the per-kind view, joined to each table's
 * retention class. Pure over the rows so a caller can pass a fresh measurement,
 * a recorded one, or a fixture.
 */
export function summarizeKindVolume(rows: readonly KindVolumeRow[], windowHours: number): KindVolumeSummary {
  const projected = rows
    .map((r) => {
      const spec = retentionSpecFor(r.table);
      return {
        table: r.table,
        appends24h: r.appends,
        distinctKeys: r.distinctKeys,
        avgWireBytes: r.avgWireBytes,
        appendsPerKey: r.distinctKeys > 0 ? Number((r.appends / r.distinctKeys).toFixed(2)) : 0,
        wireBytes24h: r.wireBytes,
        latestOnlyBytes24h: r.distinctKeys * r.avgWireBytes,
        retention: (spec?.retention ?? 'permanent') as RetentionClass,
        classified: spec !== null,
      };
    })
    .sort((a, b) => b.wireBytes24h - a.wireBytes24h);

  return {
    windowHours,
    rows: projected,
    amplification: summarizeAmplification(projected),
    unclassifiedProducers: projected.filter((r) => !r.classified).map((r) => r.table).sort(),
  };
}

export interface StoreAmplificationView {
  /** Bytes the store holds per op in the admitted set. */
  bytesPerOp: number | null;
  /**
   * Store bytes ÷ own-log wire bytes over the window, ANNUALISED to the window.
   * Null when either half is unmeasurable. Read it as an ORDER OF MAGNITUDE:
   * the store accumulates every admitted peer's log since the store was created,
   * while the wire measurement covers this peer over the window — they are not
   * the same population, which is precisely why D-057's ratio was unexplained.
   */
  storeBytesPerWindowWireByte: number | null;
  /** The caveat above, carried WITH the number so it cannot be quoted bare. */
  caveat: string;
}

/**
 * Relate the two halves without pretending they measure the same population.
 * The caveat travels with the ratio on purpose: quoting "store ÷ daily rows" as
 * an amplification factor is the exact error D-057 recorded as unexplained.
 */
export function relateStoreToWire(
  storeBytes: number,
  replayCostOps: number,
  windowWireBytes: number,
): StoreAmplificationView {
  return {
    bytesPerOp: replayCostOps > 0 ? Math.round(storeBytes / replayCostOps) : null,
    storeBytesPerWindowWireByte:
      windowWireBytes > 0 ? Number((storeBytes / windowWireBytes).toFixed(1)) : null,
    caveat:
      'The store holds EVERY admitted peer log since the store was created; the wire figure is ' +
      'THIS peer over the window. The ratio is a scale check, never an amplification factor — ' +
      'use `amplification.versionMultiplier` (appends ÷ distinct keys) for that.',
  };
}
