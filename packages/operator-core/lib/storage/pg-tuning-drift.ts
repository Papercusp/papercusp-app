/**
 * PostgreSQL tuning-drift alarm (EI-19314331871893219).
 *
 * `databaseTuningToSettings()` in @papercusp/resource-profile is the source of
 * truth for every server GUC we set. On a NATIVE PostgreSQL those settings reach
 * the cluster only when someone runs `scripts/pg-autotune.ts --apply` — and until
 * this alarm existed, NOTHING checked that they had. A setting added to the map
 * simply never arrived, silently, and the source, its tests and its comments all
 * went on saying the defense was in place.
 *
 * That is not a hypothetical failure mode; it is the one that produced this file.
 * Two settings were found unapplied on the live cluster, both for weeks:
 *
 *   - `max_slot_wal_keep_size` (WI-347) — the disk-fill-SPOF defense. The live
 *     cluster was running PG's default of `-1` (UNLIMITED), which is precisely
 *     the condition {@link ./replication-slot-alarm} can only WARN about and
 *     cannot cap. The guard everyone believed was armed was not.
 *   - `shared_preload_libraries` (P-020) — query telemetry across a re-provision.
 *
 * The mechanism was mundane and will recur: `--apply` used to RESTART Postgres,
 * which nobody dares do on a shared box, so a later agent hand-appended its knob
 * to the managed drop-in instead. The live config forked from the map and every
 * setting added in between was dropped. (pg-autotune now reloads instead of
 * restarting when it can, which removes the reason to hand-edit — but a fix that
 * relies on nobody ever hand-editing again is not a fix, so: this detector.)
 *
 * Read-only and best-effort — it never throws, mirroring replication-slot-alarm
 * and the other periodic monitors, so it can never affect the cluster it watches.
 *
 * ── Scope: NATIVE PG only ─────────────────────────────────────────────────────
 * An embedded/desktop Postgres is launched by us with `-c` flags fed from the SAME
 * derivation at every boot, so it cannot accumulate this drift and the remedy
 * (`pg-autotune --apply`) does not apply to it. The check skips that host rather
 * than emitting an alarm nobody can act on.
 */
import { readFileSync } from 'node:fs';
import { generated, getOrgPg } from '@papercusp/db-org';
import {
  databaseTuningToSettings,
  deriveDatabaseTuning,
  detectResourceSignals,
  diffPgSettings,
  type PgLiveSetting,
  type PgSettingsDrift,
} from '@papercusp/resource-profile';
import { desc, inArray } from 'drizzle-orm';
import { detectEmbeddedPg } from '../resource-profile';
import { notifySyncInvalidate } from '../sync-sse';

const TOAST_RING_BUFFER = 2000;

/**
 * The GUCs we intend the cluster to run. Mirrors what `pg-autotune` writes:
 * the derived map, for a DEDICATED database (`embeddedPg: false` — this check
 * only ever runs against a native PG, see the header).
 *
 * `shared_preload_libraries` is deliberately NOT included, for two independent
 * reasons. pg-autotune computes it as a UNION with whatever is already loaded, so
 * its target depends on live state rather than on the derivation — a fixed
 * expectation here would alarm on any host that legitimately preloads an extra
 * library. And `pg_settings` does not expose it to the operator's non-superuser
 * role at all (verified on the dev box: the derived GUCs below are readable,
 * `shared_preload_libraries` is not), so it would only ever land in `unknown`.
 */
export function targetSettings(): Record<string, string> {
  return databaseTuningToSettings(deriveDatabaseTuning(detectResourceSignals({ embeddedPg: false })));
}

export interface TuningDriftDeps {
  /** Injectable for tests — defaults to a read-only pg_settings scan. */
  fetchLiveSettings?: (names: string[]) => Promise<PgLiveSetting[]>;
  /** Injectable for tests — defaults to `detectEmbeddedPg()`. */
  isEmbeddedPg?: () => boolean;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

/** Build the toast body for a drift result. Pure — unit-testable. */
export function formatTuningDriftToast(drift: PgSettingsDrift): {
  level: string;
  message: string;
  description: string;
} {
  const lines = drift.diverged
    .map(
      (d) =>
        `• ${d.name}: live=${d.live}, should be ${d.target}` +
        (d.restartOnly ? ' (needs a PG restart)' : ' (SIGHUP-reloadable — no downtime)'),
    )
    .join('\n');
  return {
    level: 'warning',
    message: `Postgres tuning drift — ${drift.diverged.length} setting(s) not applied`,
    description:
      `The live cluster does not match databaseTuningToSettings() in ` +
      `@papercusp/resource-profile, so tuning/safety settings the code believes are ` +
      `in force are NOT:\n${lines}\n\n` +
      `This is how the max_slot_wal_keep_size disk-fill defense sat unapplied for weeks ` +
      `(EI-19314331871893219). Fix: \`npx tsx scripts/pg-autotune.ts --check\` to see the ` +
      `full diff, then \`--apply\` to close it (it reloads rather than restarting when ` +
      `nothing postmaster-level changed).`,
  };
}

async function defaultFetchLiveSettings(names: string[]): Promise<PgLiveSetting[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { name: string; setting: string; unit: string | null; context: string | null }[]
  >`
    select name, setting, unit, context
    from pg_settings
    where name = any(${names})
  `;
  return rows.map((r) => ({
    name: r.name,
    setting: String(r.setting ?? ''),
    unit: r.unit,
    context: r.context,
  }));
}

async function defaultEmitToast(t: {
  level: string;
  message: string;
  description: string;
}): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors replication-slot-alarm / storage-growth-alarm).
  void (async () => {
    const stale = await db
      .select({ id: tl.id })
      .from(tl)
      .orderBy(desc(tl.createdAt))
      .offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

export interface TuningDriftResult {
  /** True when the host was skipped (embedded PG) — NOT a clean bill of health. */
  skipped: boolean;
  checked: number;
  drift: PgSettingsDrift | null;
}

/** One read-only pass: compare the live cluster against the derived tuning and
 *  toast on any divergence. Never throws. */
export async function runPgTuningDriftCheckOnce(
  deps: TuningDriftDeps = {},
): Promise<TuningDriftResult> {
  const fetchLiveSettings = deps.fetchLiveSettings ?? defaultFetchLiveSettings;
  const isEmbeddedPg = deps.isEmbeddedPg ?? detectEmbeddedPg;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  try {
    if (isEmbeddedPg()) return { skipped: true, checked: 0, drift: null };
  } catch {
    return { skipped: true, checked: 0, drift: null };
  }

  const target = targetSettings();
  let live: PgLiveSetting[];
  try {
    live = await fetchLiveSettings(Object.keys(target));
  } catch (err) {
    console.warn(
      `[pg-tuning-drift] settings scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
    return { skipped: false, checked: 0, drift: null };
  }

  const drift = diffPgSettings(target, live);
  if (drift.diverged.length > 0) {
    console.warn(
      `[pg-tuning-drift] ${drift.diverged.length} setting(s) not applied: ` +
        drift.diverged.map((d) => `${d.name} live=${d.live} want=${d.target}`).join('; ') +
        '. Remedy: npx tsx scripts/pg-autotune.ts --check (then --apply).',
    );
    try {
      await emitToast(formatTuningDriftToast(drift));
    } catch (err) {
      console.warn(
        `[pg-tuning-drift] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  return { skipped: false, checked: live.length, drift };
}

// ── Huge-page backing alarm (endgame D-052 / WI-10002573) ────────────────────
//
// `huge_pages=try` is PostgreSQL's DEFAULT, and "try" means: if the kernel pool
// cannot hold the shared-memory segment, fall back to ordinary 4 KiB pages and
// say nothing. The cluster then looks healthy while every backend maps
// shared_buffers with its own 4 KiB page tables, and the segment becomes
// swappable. Measured on the tower on 2026-09-23: shared_buffers=64 GB,
// shared_memory_size_in_huge_pages=32983 against a pool of 618 pages,
// huge_pages_status=off, PageTables 16.6 GB, and 17 GB of shared_buffers in swap
// (EI-24018312041976584). The only existing check
// (apps/operator/scripts/systemd/papercusp-host-performance.sh) verifies the
// reservation at BOOT. Nothing noticed PostgreSQL running unbacked afterwards.
//
// This is the runtime detector. It rides the pg-tuning-drift tick (same cadence,
// same native-only scope) and does not add a second scheduler.
//
// It fires only on the silent case: huge_pages=try with huge_pages_status=off.
// huge_pages=off is an explicit choice, not a fallback. huge_pages=on cannot run
// unbacked, because PostgreSQL refuses to start without the pool.
//
// Pool figures come from THIS host's /sys. That assumes PostgreSQL runs on the
// operator's host, which targetSettings() already assumes when it sizes GUCs from
// local RAM. PostgreSQL's own huge_pages_status confirms the fallback, so a
// remote cluster could at worst get the wrong remedy, never a false alarm.

/** Below this shared-memory size, 4 KiB pages cost each backend at most ~2 MiB
 *  of page tables (8 bytes per 4 KiB page = 1/512 of the segment). That is noise
 *  not worth a standing toast, so an unbacked segment this small is not alarmed. */
export const HUGE_PAGE_ALERT_MIN_SHARED_MEMORY_BYTES = 1024 ** 3;

/** PostgreSQL's view of its own huge-page state. A null field could not be read. */
export interface HugePagePgState {
  /** `huge_pages`: 'try' | 'on' | 'off'. */
  hugePages: string | null;
  /** `huge_pages_status` (PG 17+): 'on' | 'off' | 'unknown'. Null on older servers. */
  status: string | null;
  /** `shared_memory_size_in_huge_pages`: PostgreSQL's page count for its segment. */
  requiredPages: number | null;
  /** `shared_memory_size` in MB: the segment size, independent of the page size. */
  sharedMemoryMb: number | null;
  /** `huge_page_size` in kB; 0 means the kernel's default huge-page size. */
  hugePageSizeKb: number | null;
}

/** The kernel pool for the page size PostgreSQL would use. */
export interface HugePagePool {
  pageSizeKb: number;
  /** nr_hugepages: pages the kernel has actually allocated to the pool. */
  total: number;
  free: number;
  /** resv_hugepages: pages committed to a mapping but not yet faulted in. */
  reserved: number;
  /** /proc/meminfo PageTables in kB, the measured cost of the fallback; null if unread. */
  pageTablesKb: number | null;
}

export type HugePageBackingVerdict =
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'unknown'; reason: string }
  | { kind: 'backed' }
  | { kind: 'below-floor'; sharedMemoryBytes: number }
  | {
      kind: 'unbacked';
      /** pool-too-small: the pool cannot hold the segment (the D-052 state).
       *  pool-not-adopted: the pool is now big enough, but PostgreSQL started first.
       *  pool-unreadable: PostgreSQL reports the fallback; the pool could not be read. */
      cause: 'pool-too-small' | 'pool-not-adopted' | 'pool-unreadable';
      requiredPages: number;
      sharedMemoryBytes: number | null;
      pool: HugePagePool | null;
    };

/** Classify one sample. Pure, and the unit-tested core of the alarm. */
export function evaluateHugePageBacking(
  pg: HugePagePgState,
  pool: HugePagePool | null,
  opts: { platform?: NodeJS.Platform; minSharedMemoryBytes?: number } = {},
): HugePageBackingVerdict {
  const platform = opts.platform ?? process.platform;
  const floor = opts.minSharedMemoryBytes ?? HUGE_PAGE_ALERT_MIN_SHARED_MEMORY_BYTES;
  // PostgreSQL implements huge pages only on Linux (and Windows large pages, which
  // this fleet does not run). Anywhere else, "try" always resolves to off by design.
  if (platform !== 'linux') {
    return { kind: 'not-applicable', reason: `huge pages are not supported on ${platform}` };
  }
  if (pg.hugePages === null) return { kind: 'unknown', reason: 'huge_pages is not readable' };
  if (pg.hugePages !== 'try') {
    return {
      kind: 'not-applicable',
      reason:
        pg.hugePages === 'on'
          ? 'huge_pages=on: PostgreSQL refuses to start unbacked, so no silent fallback is possible'
          : `huge_pages=${pg.hugePages} is an explicit setting, not a fallback`,
    };
  }
  if (pg.status === null || pg.status === 'unknown') {
    return {
      kind: 'unknown',
      reason: 'huge_pages_status is not exposed (PostgreSQL < 17), so a fallback cannot be observed',
    };
  }
  if (pg.status === 'on') return { kind: 'backed' };
  if (pg.status !== 'off') return { kind: 'unknown', reason: `unrecognised huge_pages_status=${pg.status}` };
  if (pg.requiredPages === null || pg.requiredPages <= 0) {
    return { kind: 'unknown', reason: 'shared_memory_size_in_huge_pages is not readable' };
  }
  const sharedMemoryBytes = pg.sharedMemoryMb !== null && pg.sharedMemoryMb > 0 ? pg.sharedMemoryMb * 1024 ** 2 : null;
  if (sharedMemoryBytes !== null && sharedMemoryBytes < floor) {
    return { kind: 'below-floor', sharedMemoryBytes };
  }
  const base = { kind: 'unbacked' as const, requiredPages: pg.requiredPages, sharedMemoryBytes, pool };
  if (pool === null) return { ...base, cause: 'pool-unreadable' };
  // The comparison the leader ruled on: the pool cannot hold PostgreSQL's segment.
  if (pool.total < pg.requiredPages) return { ...base, cause: 'pool-too-small' };
  return { ...base, cause: 'pool-not-adopted' };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Build the toast body for an unbacked verdict. Pure — unit-testable. */
export function formatHugePageBackingToast(
  v: Extract<HugePageBackingVerdict, { kind: 'unbacked' }>,
): { level: string; message: string; description: string } {
  const size = v.sharedMemoryBytes !== null ? gib(v.sharedMemoryBytes) : `${v.requiredPages} huge pages`;
  const pool = v.pool;
  const poolLine = pool
    ? `Kernel pool (${pool.pageSizeKb} kB pages): ${pool.total} allocated, ${pool.free} free, ` +
      `${pool.reserved} reserved; PostgreSQL needs ${v.requiredPages}.`
    : `The kernel huge-page pool could not be read on the operator host; PostgreSQL needs ${v.requiredPages} pages.`;
  const costLine =
    pool?.pageTablesKb != null
      ? `\nPageTables is currently ${gib(pool.pageTablesKb * 1024)}: that is the per-backend cost of mapping ` +
        `shared memory with 4 KiB pages, and the segment is also swappable.`
      : '';
  let remedy: string;
  if (v.cause === 'pool-too-small') {
    remedy =
      `Fix: raise vm.nr_hugepages to at least ${v.requiredPages} plus the pages other processes hold ` +
      `(persist it in /etc/sysctl.d), then restart PostgreSQL. If the kernel cannot allocate that many ` +
      `(memory fragmentation on a long-running host), reboot so the pool is reserved before PostgreSQL ` +
      `starts. Once it is backed, consider huge_pages=on so a future fallback fails loudly instead.`;
  } else if (v.cause === 'pool-not-adopted') {
    const available = pool ? pool.free - pool.reserved : 0;
    remedy =
      `The pool is now large enough, but PostgreSQL started before it existed, and huge pages are only ` +
      `adopted at startup. Fix: restart PostgreSQL` +
      (available < v.requiredPages
        ? `, but first free the pool: only ${available} pages are unreserved, so another process holds the rest.`
        : '.');
  } else {
    remedy = `Check /sys/kernel/mm/hugepages on the database host, then size vm.nr_hugepages to at least ${v.requiredPages}.`;
  }
  return {
    level: 'warning',
    message: `Postgres is not using huge pages: ${size} of shared memory is on 4 KiB pages`,
    description:
      `huge_pages=try silently fell back (huge_pages_status=off). ${poolLine}${costLine}\n\n${remedy} ` +
      `(endgame D-052 / WI-10002573)`,
  };
}

async function defaultFetchHugePagePgState(): Promise<HugePagePgState> {
  const { sql } = getOrgPg();
  const rows = await sql<{ name: string; setting: string | null }[]>`
    select name, setting
    from pg_settings
    where name = any(${[
      'huge_pages',
      'huge_pages_status',
      'shared_memory_size_in_huge_pages',
      'shared_memory_size',
      'huge_page_size',
    ]})
  `;
  const byName = new Map(rows.map((r) => [r.name, r.setting === null ? null : String(r.setting)]));
  const num = (name: string): number | null => {
    const raw = byName.get(name);
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    hugePages: byName.get('huge_pages') ?? null,
    status: byName.get('huge_pages_status') ?? null,
    requiredPages: num('shared_memory_size_in_huge_pages'),
    sharedMemoryMb: num('shared_memory_size'),
    hugePageSizeKb: num('huge_page_size'),
  };
}

/** Parse `<Key>: <n> [kB]` from /proc/meminfo text. Pure — unit-testable. */
export function parseMeminfoKb(text: string, key: string): number | null {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : null;
}

/** Read the pool for `hugePageSizeKb` (0 = the kernel default). Null when unreadable. */
export function readHugePagePool(
  hugePageSizeKb: number | null,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): HugePagePool | null {
  try {
    const meminfo = read('/proc/meminfo');
    const pageSizeKb =
      hugePageSizeKb !== null && hugePageSizeKb > 0 ? hugePageSizeKb : parseMeminfoKb(meminfo, 'Hugepagesize');
    if (pageSizeKb === null || pageSizeKb <= 0) return null;
    const dir = `/sys/kernel/mm/hugepages/hugepages-${pageSizeKb}kB`;
    const counter = (name: string): number => {
      const n = Number(read(`${dir}/${name}`).trim());
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad ${dir}/${name}`);
      return n;
    };
    return {
      pageSizeKb,
      total: counter('nr_hugepages'),
      free: counter('free_hugepages'),
      reserved: counter('resv_hugepages'),
      pageTablesKb: parseMeminfoKb(meminfo, 'PageTables'),
    };
  } catch {
    return null;
  }
}

export interface HugePageBackingDeps {
  /** Injectable for tests — defaults to a read-only pg_settings scan. */
  fetchPgState?: () => Promise<HugePagePgState>;
  /** Injectable for tests — defaults to {@link readHugePagePool} on this host. */
  readPool?: (hugePageSizeKb: number | null) => HugePagePool | null;
  /** Injectable for tests — defaults to `detectEmbeddedPg()`. */
  isEmbeddedPg?: () => boolean;
  /** Injectable for tests — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

export interface HugePageBackingResult {
  /** True when the host was skipped (embedded PG): NOT a clean bill of health. */
  skipped: boolean;
  /** Null when the settings scan failed. */
  verdict: HugePageBackingVerdict | null;
}

/** One read-only pass: toast when PostgreSQL has silently fallen back from
 *  huge_pages=try to 4 KiB pages. Never throws. */
export async function runPgHugePageBackingCheckOnce(
  deps: HugePageBackingDeps = {},
): Promise<HugePageBackingResult> {
  const fetchPgState = deps.fetchPgState ?? defaultFetchHugePagePgState;
  const readPool = deps.readPool ?? ((kb: number | null) => readHugePagePool(kb));
  const isEmbeddedPg = deps.isEmbeddedPg ?? detectEmbeddedPg;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  try {
    if (isEmbeddedPg()) return { skipped: true, verdict: null };
  } catch {
    return { skipped: true, verdict: null };
  }

  let pg: HugePagePgState;
  try {
    pg = await fetchPgState();
  } catch (err) {
    console.warn(
      `[pg-huge-pages] settings scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
    return { skipped: false, verdict: null };
  }

  let pool: HugePagePool | null;
  try {
    pool = readPool(pg.hugePageSizeKb);
  } catch {
    pool = null;
  }
  const verdict = evaluateHugePageBacking(pg, pool, { platform: deps.platform });
  if (verdict.kind === 'unbacked') {
    console.warn(
      `[pg-huge-pages] huge_pages=try fell back to 4 KiB pages (huge_pages_status=off, cause=${verdict.cause}): ` +
        `PostgreSQL needs ${verdict.requiredPages} huge pages, pool total=${pool?.total ?? 'unreadable'}. ` +
        'See endgame D-052 / WI-10002573.',
    );
    try {
      await emitToast(formatHugePageBackingToast(verdict));
    } catch (err) {
      console.warn(
        `[pg-huge-pages] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  return { skipped: false, verdict };
}
