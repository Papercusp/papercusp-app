/**
 * Storage growth alarm (infra-perf-reliability-audit-round4-2026-06-19 P-017,
 * lane su-61e7e). The 102 GB substrate_outbox incident (EI-126) grew SILENTLY —
 * the one-time reclaim left recurrence unguarded, and nothing watches PG table
 * growth. This is the missing guard: a periodic READ-ONLY size check that emits a
 * `notifications:recent` toast when any storage category crosses an absolute byte
 * ceiling, so a runaway table is surfaced at GBs, not hundreds of GBs.
 *
 * Stateless by design — an absolute per-category ceiling cannot false-NEGATIVE on
 * a runaway the way a growth-RATE heuristic (which would need persisted history)
 * can. The default ceiling is generous (the telemetry tables are legitimately
 * multi-GB and already retention-bounded); the federation bloat-queue
 * (substrate_outbox) gets a tighter ceiling because it should stay small while
 * draining — that is the exact table that ran away in EI-126.
 *
 * Verify-before-fix (round-2 D-001): the round-4 audit confirmed the existing
 * "unbounded" tables are mostly TOAST-heavy + low-row (activity-bounded, not
 * runaway), so this PREVENTS a future recurrence rather than reclaiming today.
 *
 * THREE INDEPENDENT LEGS (EI-7518, then WI-936229). The category-ceiling leg above walks
 * `computeStorageUsage()`, which iterates STORAGE_CATEGORIES — so it can only
 * ever see tables somebody REGISTERED. A table nobody registered produces no
 * row and therefore cannot breach at ANY size, which left this alarm unable to
 * catch its own motivating case: a table growing unwatched *because* it was
 * never declared. `detectUndeclaredGrowth` is the second leg — it sweeps the
 * catalog directly (`pg_stat_user_tables`, NOT the category list) for tables
 * over a floor that carry no recorded retention decision. Measured 2026-08-03,
 * five such tables held ~278 MB, the largest being `pot_throughput_ticks` at
 * 167 MB / 410,510 rows with zero DELETE sites anywhere in the tree.
 *
 * `detectExemptSubsetGrowth` is the THIRD leg, and it exists because the first
 * two share an assumption: that a retention decision is a property of a TABLE.
 * Leg 1 sees only registered categories; leg 2 skips any table carrying an
 * exemption. A table that is BOTH unregistered AND exempt is therefore invisible
 * to this alarm at any size — which is exactly what happened to `work_items`,
 * where ~776k ephemeral resource-governor receipts accumulated in two days
 * (measured 2026-08-29) inside a ledger correctly declared never-prunable. Leg 3
 * asks the narrower question the exemption cannot answer: which rows in here are
 * NOT the canonical population the exemption was granted for?
 *
 * Read-only + best-effort: it never throws (mirrors the other periodic monitors),
 * so it can never affect the system it watches.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { escalateAlarm } from '../alarm-attention';
import { notifySyncInvalidate } from '../sync-sse';
import { isPgCategory, STORAGE_CATEGORIES } from './categories';
import {
  isRegisteredDiskPath,
  listDiskRootChildrenAsync,
  registeredDiskPaths,
  type DiskEntry,
  type DiskRootChildScan,
} from './disk';
import { computeStorageUsage, type StorageUsageRow } from './usage';
import { bareTableName, CHUNK_STORES } from '../search/chunks/registry';

const GIB = 1024 ** 3;
const TOAST_RING_BUFFER = 2000;
/** The marker phrase that makes "nothing prunes this" MACHINE-READABLE. The
 *  unpruned-by-design set is derived from it rather than maintained beside the
 *  map, so a new blanket exemption cannot slip past the subset guard below by
 *  being worded differently. */
export const NOT_AGE_PRUNABLE = 'not age-prunable by design';
const STORAGE_GROWTH_ESCALATE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const STORAGE_GROWTH_ESCALATION_TITLE = 'Storage growth critical';

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Absolute ceiling (GiB) above which a PG category is flagged. The bloat-queue
 *  (substrate_outbox) is the EI-126 102 GB class — it should stay small while
 *  draining, so a much tighter ceiling. Both env-overridable. */
export function categoryCeilingBytes(id: string): number {
  if (id === 'substrate-outbox') return envNum('PAPERCUSP_STORAGE_ALARM_OUTBOX_GB', 3) * GIB;
  return envNum('PAPERCUSP_STORAGE_ALARM_DEFAULT_GB', 10) * GIB;
}

export interface StorageBreach {
  id: string;
  label: string;
  bytes: number;
  ceilingBytes: number;
  trimmable: boolean;
}

export interface GrowthAlarmDeps {
  /** Injectable for tests — defaults to a sizes-only (cheap) usage scan. */
  computeUsage?: () => Promise<StorageUsageRow[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
  /** Injectable for tests — defaults to a live `pg_stat_user_tables` size scan.
   *  Feeds the UNDECLARED sweep below, which deliberately does NOT go through
   *  `computeStorageUsage` (that is category-derived — the blind spot). */
  listTableSizes?: () => Promise<TableSizeRow[]>;
  /** Injectable for tests — defaults to the bounded, cooperative immediate-child disk sweep. */
  listDiskRootChildren?: (registeredPaths: readonly string[]) => Promise<DiskRootChildScan>;
  /** Injectable for tests — defaults to one bounded COUNT per EXEMPT_SUBSET_PROBES
   *  entry. Feeds the THIRD leg: growth inside a table the other two legs are
   *  structurally forbidden to look at (WI-936229). */
  countExemptSubsets?: () => Promise<ExemptSubsetCount[]>;
  /** Injectable for tests — defaults to the shared attention-notify rail. */
  escalate?: (t: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests — the persistent cross-restart cooldown floor. */
  recentlyEscalated?: () => Promise<boolean>;
}

/** One physical table's size, straight from the catalog — NOT category-derived. */
export interface TableSizeRow {
  table: string;
  totalBytes: number;
  rows: number;
}

/** An undeclared table over the floor: growing, and owned by no retention policy. */
export interface UndeclaredGrowth {
  table: string;
  bytes: number;
  rows: number;
  floorBytes: number;
}

/** An on-disk immediate child over the shared undeclared-growth floor. */
export interface UndeclaredDiskGrowth {
  path: string;
  bytes: number;
  floorBytes: number;
}

/**
 * Floor above which a `harness_shared` table is EXPECTED to carry a retention
 * decision. Deliberately far tighter than `categoryCeilingBytes` (GBs): a
 * declared table is watched and owned, so it earns a generous ceiling; an
 * UNDECLARED one is by definition unowned, which is the higher-risk class and
 * the one that historically ran to 102 GB unnoticed (EI-126).
 */
export function undeclaredFloorBytes(): number {
  return envNum('PAPERCUSP_STORAGE_ALARM_UNDECLARED_MB', 128) * 1024 * 1024;
}

/** Disk uses the same floor as the catalog leg so the alarm has one policy. */
export function undeclaredDiskFloorBytes(): number {
  return undeclaredFloorBytes();
}

/**
 * Tables that carry a retention decision made SOMEWHERE OTHER than
 * `STORAGE_CATEGORIES` — each with the evidence for it. Without this map the
 * sweep below would report a table as unowned merely because its owner is a
 * bespoke GC actor rather than a declared category, which is a FALSE "nothing
 * prunes this" — the precise error that makes a coverage audit untrustworthy.
 *
 * ⚠ An entry here is a CLAIM that something prunes the table. Add one only with
 * the deleting call site verified (`grep -n "delete from harness_shared.<t>"`),
 * never because a table "looks managed" or "is probably fine".
 *
 * Absence from this map is NOT an accusation — it means no retention decision
 * has been RECORDED for that table, which is exactly what the sweep surfaces.
 */
export const RETENTION_COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  operator_turns: 'pruned by operator-turns-gc.ts',
  operator_conversations: 'pruned by operator-turns-gc.ts',
  plan_revisions: 'pruned by agent-tools/plans/revisions-gc.ts',
  // Payload pruned (SET payload = NULL), rows kept as each sink's dedupe identity —
  // the row horizon is an open decision, tracked on WI-10004921.
  trigger_deliveries:
    'payload pruned by external-triggers/delivery-retention.ts pruneTriggerDeliveryPayloads (30d horizon; non-event-bus copies immediately); rows kept as per-sink dedupe identity',
  coord_thread_posts: 'pruned by agent-tools/coordination/message-log-gc.ts',
  session_archive_files: `permanent canonical archive — archiveSession() writes/updates it in session-archive.ts; ${NOT_AGE_PRUNABLE}`,
  session_turns: 'pruned by search/session-ingest.ts pruneSessionTurnsOnce (RETENTION_DAYS=45)',
  session_turn_parts: 'pruned by search/session-ingest.ts pruneSessionTurnsOnce (PART_RETENTION_DAYS=14)',
  // Every chunk store (session_turn_chunks, text_chunks, …): DERIVED from
  // search/chunks/registry.ts CHUNK_STORES, each with its deleting mechanism
  // (generic-rag-chunking P-005).
  ...Object.fromEntries(CHUNK_STORES.map((s) => [bareTableName(s.table), s.retention])),
  work_items: `canonical work ledger — ${NOT_AGE_PRUNABLE}`,
  memory_canonical: `canonical memory store — ${NOT_AGE_PRUNABLE}`,
  memory_vec_harrier: `canonical memory vectors — ${NOT_AGE_PRUNABLE}`,
};

/** Tables whose retention decision is "nothing prunes this, ever". Derived from
 *  the map above rather than re-listed, so the two cannot drift apart. */
export function unprunedByDesignTables(map: Readonly<Record<string, string>> = RETENTION_COVERED_ELSEWHERE): string[] {
  return Object.keys(map)
    .filter((t) => map[t].includes(NOT_AGE_PRUNABLE))
    .sort();
}

/* ────────────────────────── THE THIRD LEG (WI-936229) ──────────────────────────
 *
 * A table-level exemption is a claim about EVERY ROW in the table, and that is
 * a granularity the other two legs cannot question. `work_items` is exempt
 * because a work ledger genuinely must not be age-pruned — but the resource
 * governor writes EPHEMERAL ADMISSION RECEIPTS into it, one row per admission.
 * Measured 2026-08-29: 912,883 rows, ~776k of them receipts accumulated in two
 * days at ~429/min, and BOTH existing legs were structurally blind — leg 1
 * because `work_items` is not a registered storage category, leg 2 because it
 * carries an exemption. The alarm built for the EI-126 runaway could not see a
 * runaway happening inside the one table it had been told never to look at.
 *
 * The fix is not to remove the exemption (it is correct for real work) but to
 * narrow it: declare the SUBSET the exemption does not cover, and alarm on that
 * subset alone. Receipts are not work.
 */

/** A population inside an exempt table that the exemption does NOT cover. */
export interface ExemptSubsetProbe {
  /** `harness_shared` table, which MUST carry an exemption — otherwise leg 2 already sees it. */
  table: string;
  /** Human name for the subset, used in the toast. */
  subset: string;
  /** Read-only SQL predicate selecting the subset. A CONSTANT from this module — never caller input. */
  predicateSql: string;
  /** Row count above which the subset is reported. */
  rowCeiling: number;
  /** Why the table's exemption does not extend to these rows. */
  why: string;
}

export const EXEMPT_SUBSET_PROBES: readonly ExemptSubsetProbe[] = [
  {
    table: 'work_items',
    subset: 'resource-governor admission receipts',
    predicateSql: `payload ? 'resource_governor'`,
    rowCeiling: 50_000,
    why:
      'The work_items exemption covers the canonical work ledger. The resource governor also writes one ' +
      'ephemeral receipt row per admission into the same table (resource-governor/queue.ts), and those are ' +
      'queue telemetry, not work — nothing reaps them, and every claimability census scans them.',
  },
];

/** Exempt tables deliberately declared to host NO ephemeral subset, with the reason.
 *  An unpruned-by-design table must appear either here or in EXEMPT_SUBSET_PROBES;
 *  the guard test fails on one that appears in neither, so a new blanket exemption
 *  cannot be added without answering "what ephemeral rows land in here?". */
export const NO_EPHEMERAL_SUBSET: Readonly<Record<string, string>> = {
  memory_canonical: 'every row is an owner-authored memory; no subsystem writes telemetry into it',
  memory_vec_harrier: 'strictly derived vectors, 1:1 with memory_canonical rows — inherits that population',
  session_archive_files: 'append-only archive of real sessions; the archive IS the product, not a by-product',
};

/** One probe's measured size. `rows: null` means the count FAILED — unknown, never zero. */
export interface ExemptSubsetCount {
  table: string;
  subset: string;
  rows: number | null;
}

/** A subset over its ceiling: unbounded growth inside a table nobody prunes. */
export interface ExemptSubsetGrowth {
  table: string;
  subset: string;
  rows: number;
  rowCeiling: number;
  why: string;
}

/**
 * Pure: which declared subsets are over their ceiling.
 *
 * A probe whose count is null, or that has no matching count row at all, is
 * reported as UNKNOWN — never silently omitted and never treated as zero. An
 * unmeasured subset reads exactly like a healthy one otherwise, which is the
 * failure mode this whole leg exists to end.
 */
export function detectExemptSubsetGrowth(
  counts: readonly ExemptSubsetCount[],
  probes: readonly ExemptSubsetProbe[] = EXEMPT_SUBSET_PROBES,
): { over: ExemptSubsetGrowth[]; unknown: string[] } {
  const over: ExemptSubsetGrowth[] = [];
  const unknown: string[] = [];

  for (const p of probes) {
    const hit = counts.find((c) => c.table === p.table && c.subset === p.subset);
    if (!hit || hit.rows === null || !Number.isFinite(hit.rows)) {
      unknown.push(`${p.table}/${p.subset}`);
      continue;
    }
    if (hit.rows > p.rowCeiling) {
      over.push({ table: p.table, subset: p.subset, rows: hit.rows, rowCeiling: p.rowCeiling, why: p.why });
    }
  }

  return { over: over.sort((a, b) => b.rows - a.rows), unknown: unknown.sort() };
}

/** `bak_*` pre-migration snapshots are frozen undo trails, never live growth —
 *  skipped STRUCTURALLY rather than listed, mirroring the same carve-out in
 *  identity-keyed-state-inventory.test.ts (hand-listing each new one red the
 *  fleet gate four times there). */
const FROZEN_BACKUP_TABLE_RE = /^bak_/;

/**
 * Pure: which tables are over the floor with no recorded retention decision.
 *
 * This is the leg `detectBreaches` structurally cannot cover. `detectBreaches`
 * walks `computeStorageUsage()`, which iterates `STORAGE_CATEGORIES` — so a
 * table nobody registered produces NO row and can therefore never breach, at
 * ANY size. An alarm whose stated job is catching tables that grow unwatched
 * was itself scoped to the watched set; a gate conditioned on the very act
 * whose omission is the bug cannot catch the bug.
 *
 * Also returns `staleCovered`: entries in RETENTION_COVERED_ELSEWHERE matching
 * no live table (renamed/dropped), so the map cannot rot into fiction.
 */
export function detectUndeclaredGrowth(
  tables: TableSizeRow[],
  declaredTables: readonly string[],
  floorBytes: number = undeclaredFloorBytes(),
): { undeclared: UndeclaredGrowth[]; staleCovered: string[] } {
  const declared = new Set(declaredTables);
  const live = new Set(tables.map((t) => t.table));

  const undeclared = tables
    .filter(
      (t) =>
        t.totalBytes > floorBytes &&
        !declared.has(t.table) &&
        !(t.table in RETENTION_COVERED_ELSEWHERE) &&
        !FROZEN_BACKUP_TABLE_RE.test(t.table),
    )
    .map((t) => ({ table: t.table, bytes: t.totalBytes, rows: t.rows, floorBytes }))
    .sort((a, b) => b.bytes - a.bytes);

  // An EMPTY catalog is not evidence that every table was renamed — it means the
  // scan returned nothing (a transient read that resolved to [] rather than
  // throwing). Deriving staleness from it would name the whole map as rot and
  // fire a confident, entirely false alarm, so absence of data is treated as
  // "unknown" rather than "absent".
  const staleCovered =
    tables.length === 0
      ? []
      : Object.keys(RETENTION_COVERED_ELSEWHERE)
          .filter((t) => !live.has(t))
          .sort();

  return { undeclared, staleCovered };
}

/**
 * Pure disk twin of {@link detectUndeclaredGrowth}. The scanner deliberately
 * returns overlapping root views, so this detector repeats the exact-path
 * deduplication as a defense-in-depth boundary. A registered path covers its
 * descendants; only an unregistered child over the floor is reported.
 *
 * `incomplete` is fail-closed: a bounded walk that stopped early is UNKNOWN,
 * not evidence that the unvisited portion is healthy. Known offenders remain
 * useful evidence and are returned alongside that qualification.
 */
export function detectUndeclaredDiskGrowth(
  entries: readonly DiskEntry[],
  registeredPaths: readonly string[],
  floorBytes: number = undeclaredDiskFloorBytes(),
  truncated = false,
): { undeclared: UndeclaredDiskGrowth[]; incomplete: boolean } {
  const seen = new Set<string>();
  const undeclared = entries
    .filter((entry) => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path);
      return (
        Number.isFinite(entry.sizeBytes) &&
        entry.sizeBytes > floorBytes &&
        !isRegisteredDiskPath(entry.path, registeredPaths)
      );
    })
    .map((entry) => ({ path: entry.path, bytes: entry.sizeBytes, floorBytes }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  return { undeclared, incomplete: truncated };
}

function fmtGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** Pure breach detection over a usage snapshot — unit-testable without PG. Only
 *  PG tables are guarded (the runaway class is a Postgres table, EI-126). */
export function detectBreaches(rows: StorageUsageRow[]): StorageBreach[] {
  const breaches: StorageBreach[] = [];
  for (const r of rows) {
    if (r.kind !== 'pg') continue;
    const ceilingBytes = categoryCeilingBytes(r.id);
    if (r.totalBytes > ceilingBytes) {
      breaches.push({ id: r.id, label: r.label, bytes: r.totalBytes, ceilingBytes, trimmable: r.trimmable });
    }
  }
  return breaches;
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
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
  // Bound the ring buffer (mirrors agent-governor-observer).
  void (async () => {
    const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
    if (stale.length > 0)
      await db.delete(tl).where(
        inArray(
          tl.id,
          stale.map((r) => r.id),
        ),
      );
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/** Build the toast body for a set of breaches. Pure — unit-testable. */
export function formatBreachToast(breaches: StorageBreach[]): { level: string; message: string; description: string } {
  const lines = breaches
    .map(
      (b) =>
        `• ${b.label} (${b.id}): ${fmtGb(b.bytes)} > ${fmtGb(b.ceilingBytes)} ceiling${b.trimmable ? '' : ' — read-only/federated'}`,
    )
    .join('\n');
  return {
    level: 'warning',
    message: `Storage growth alarm — ${breaches.length} table(s) over threshold`,
    description:
      `These Postgres tables crossed their size ceiling (the silent-growth guard for the EI-126 102 GB class):\n${lines}\n\n` +
      `Review in Settings → Storage. Tune a ceiling via PAPERCUSP_STORAGE_ALARM_DEFAULT_GB / PAPERCUSP_STORAGE_ALARM_OUTBOX_GB.`,
  };
}

/** Build the human-facing escalation for an explicit category ceiling breach. */
export function formatGrowthEscalation(breaches: StorageBreach[]): { title: string; body: string } {
  const worst = [...breaches].sort((a, b) => b.bytes - a.bytes)[0];
  const action = worst.trimmable
    ? 'Trim the category or investigate its retention path now.'
    : 'Investigate the read-only/federated retention path now.';
  return {
    title: STORAGE_GROWTH_ESCALATION_TITLE,
    body:
      `${worst.label} (${worst.id}) is ${fmtGb(worst.bytes)} over its ${fmtGb(worst.ceilingBytes)} ceiling. ` +
      `${action}`,
  };
}

function fmtSize(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Build ONE aggregated toast for the undeclared sweep. Pure — unit-testable.
 *  Deliberately one toast for the whole set, not one per table: a per-table
 *  alarm on a dozen unowned tables trains the reader to dismiss it. */
export function formatUndeclaredToast(
  found: UndeclaredGrowth[],
  staleCovered: string[] = [],
): { level: string; message: string; description: string } {
  const lines = found
    .map((u) => `• harness_shared.${u.table}: ${fmtSize(u.bytes)} / ${u.rows.toLocaleString()} rows`)
    .join('\n');
  const stale =
    staleCovered.length > 0
      ? `\n\n⚠ RETENTION_COVERED_ELSEWHERE names ${staleCovered.length} table(s) that no longer exist ` +
        `(renamed/dropped — remove or update): ${staleCovered.join(', ')}.`
      : '';
  return {
    level: 'warning',
    message:
      found.length === 0
        ? `Retention coverage map is stale — ${staleCovered.length} entry/entries name no live table`
        : `${found.length} unowned table(s) over ${fmtSize(found[0].floorBytes)} with no retention decision`,
    description:
      `These Postgres tables are over the floor and carry NO recorded retention decision — no storage ` +
      `category, and no entry in RETENTION_COVERED_ELSEWHERE. They are invisible to the category ceiling ` +
      `alarm by construction, so they can grow without bound unnoticed:\n${lines}\n\n` +
      `This is not an accusation that they are unpruned — it means nobody recorded a decision. Fix by ` +
      `either adding a category in storage/categories.ts (with an ageColumn + federation class), or, if ` +
      `something already prunes it, recording that in RETENTION_COVERED_ELSEWHERE with the verified call ` +
      `site. Tune the floor via PAPERCUSP_STORAGE_ALARM_UNDECLARED_MB.${stale}`,
  };
}

/** Build ONE aggregated toast for the bounded disk undeclared sweep. */
export function formatUndeclaredDiskToast(
  found: readonly UndeclaredDiskGrowth[],
  incomplete = false,
): { level: string; message: string; description: string } {
  const lines = found.map((entry) => `• ${entry.path}: ${fmtSize(entry.bytes)}`).join('\n');
  const floor = found[0]?.floorBytes ?? undeclaredDiskFloorBytes();
  const qualification = incomplete
    ? `\n\n⚠ The bounded disk walk was truncated before it could inspect every child. ` +
      `This result is UNKNOWN, not healthy; rerun the sweep after the budget can cover the roots.`
    : '';
  return {
    level: 'warning',
    message:
      found.length > 0
        ? `${found.length} unowned disk entr${found.length === 1 ? 'y' : 'ies'} over ${fmtSize(floor)}`
        : `Disk retention coverage check incomplete — unmeasured entries are UNKNOWN`,
    description:
      `These on-disk entries are over the undeclared-growth floor and are not covered by a registered ` +
      `storage category. They are invisible to the category ceiling alarm by construction, so they can ` +
      `grow without bound unnoticed:\n${lines}\n\n` +
      `Fix by adding a storage category with an explicit retention policy, or record why the entry is ` +
      `covered elsewhere. Tune the shared floor via PAPERCUSP_STORAGE_ALARM_UNDECLARED_MB.${qualification}`,
  };
}

/** Build ONE aggregated toast for the exempt-subset leg. Pure — unit-testable.
 *  UNKNOWN subsets are named explicitly: a probe that could not be measured is
 *  a hole in the guard, and a silent hole is what let 776k rows accumulate. */
export function formatExemptSubsetToast(
  over: readonly ExemptSubsetGrowth[],
  unknown: readonly string[] = [],
): { level: string; message: string; description: string } {
  const lines = over
    .map(
      (o) =>
        `• harness_shared.${o.table} — ${o.subset}: ${o.rows.toLocaleString()} rows ` +
        `> ${o.rowCeiling.toLocaleString()} ceiling\n    ${o.why}`,
    )
    .join('\n');
  const unmeasured =
    unknown.length > 0
      ? `\n\n⚠ ${unknown.length} declared subset(s) could NOT be measured this pass — treat as UNKNOWN, ` +
        `not as healthy: ${unknown.join(', ')}.`
      : '';
  return {
    level: 'warning',
    message:
      over.length === 0
        ? `Exempt-table subset check incomplete — ${unknown.length} subset(s) unmeasured`
        : `${over.length} ephemeral subset(s) growing unbounded inside a retention-EXEMPT table`,
    description:
      `These row populations live inside a table whose retention decision is "${NOT_AGE_PRUNABLE}" — so the ` +
      `category-ceiling leg cannot see them (the table is not a registered category) and the undeclared leg ` +
      `cannot either (the table carries an exemption). The exemption is correct for the table's canonical ` +
      `rows; it does NOT extend to these:\n${lines}\n\n` +
      `Fix by giving the subset a reaper and recording it, or by keeping the ephemeral rows out of the ` +
      `canonical table entirely. Declared in EXEMPT_SUBSET_PROBES (storage/storage-growth-alarm.ts).${unmeasured}`,
  };
}

/** Default exempt-subset counter. One bounded COUNT per declared probe; a probe
 *  that throws yields `rows: null` (UNKNOWN) rather than 0, so a failed read can
 *  never be mistaken for an empty subset. */
async function defaultCountExemptSubsets(
  probes: readonly ExemptSubsetProbe[] = EXEMPT_SUBSET_PROBES,
): Promise<ExemptSubsetCount[]> {
  const sqlClient = getOrgPg().sql as unknown as {
    unsafe: (q: string) => Promise<Array<{ n: string | number }>>;
  };
  const out: ExemptSubsetCount[] = [];
  for (const p of probes) {
    if (!/^[a-z_][a-z0-9_]*$/.test(p.table)) {
      out.push({ table: p.table, subset: p.subset, rows: null });
      continue;
    }
    try {
      const rows = await sqlClient.unsafe(
        `SELECT count(*)::bigint AS n FROM harness_shared.${p.table} WHERE ${p.predicateSql}`,
      );
      const n = Number(rows?.[0]?.n);
      out.push({ table: p.table, subset: p.subset, rows: Number.isFinite(n) ? n : null });
    } catch (err) {
      console.warn(
        `[storage-growth-alarm] subset probe ${p.table}/${p.subset} failed (reported UNKNOWN): ${(err as Error)?.message ?? String(err)}`,
      );
      out.push({ table: p.table, subset: p.subset, rows: null });
    }
  }
  return out;
}

/** Default undeclared-table scan: the catalog, NOT the category list. */
async function defaultListTableSizes(): Promise<TableSizeRow[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql as unknown as (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<Array<{ table: string; total_bytes: string | number; rows: string | number }>>;
  const rows = await sql`
    SELECT relname AS table,
           pg_total_relation_size(relid) AS total_bytes,
           n_live_tup AS rows
      FROM pg_stat_user_tables
     WHERE schemaname = 'harness_shared'`;
  return rows.map((r) => ({
    table: String(r.table),
    totalBytes: Number(r.total_bytes),
    rows: Number(r.rows),
  }));
}

/** One read-only pass: size every storage category, toast on any breach. Never
 *  throws — observability is best-effort, mirroring the other periodic monitors. */
export async function runStorageGrowthAlarmOnce(deps: GrowthAlarmDeps = {}): Promise<{
  checked: number;
  breaches: StorageBreach[];
  undeclared: UndeclaredGrowth[];
  undeclaredDisk: UndeclaredDiskGrowth[];
  diskScanIncomplete: boolean;
  exemptSubsets: ExemptSubsetGrowth[];
  exemptUnknown: string[];
}> {
  const computeUsage = deps.computeUsage ?? (() => computeStorageUsage({ sizesOnly: true }));
  const emitToast = deps.emitToast ?? defaultEmitToast;
  const listTableSizes = deps.listTableSizes ?? defaultListTableSizes;
  const scanDiskRoots =
    deps.listDiskRootChildren ?? ((paths: readonly string[]) => listDiskRootChildrenAsync({ registeredPaths: paths }));
  const escalate = deps.escalate;
  const recentlyEscalated = deps.recentlyEscalated;

  let rows: StorageUsageRow[] = [];
  try {
    rows = await computeUsage();
  } catch (err) {
    console.warn(`[storage-growth-alarm] usage scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    rows = [];
  }

  const breaches = detectBreaches(rows);
  if (breaches.length > 0) {
    try {
      await emitToast(formatBreachToast(breaches));
    } catch (err) {
      console.warn(`[storage-growth-alarm] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
    // A category ceiling is an explicit, actionable threshold. The separate
    // undeclared-table leg remains warning-only: missing retention metadata is
    // not proof that the table is already unhealthy.
    await escalateAlarm(
      {
        ...formatGrowthEscalation(breaches),
        cooldownMs: STORAGE_GROWTH_ESCALATE_COOLDOWN_MS,
        source: 'storage-growth-alarm',
      },
      { notify: escalate, recentlyEscalated },
    );
  }

  // ── The undeclared sweep (the leg detectBreaches structurally cannot cover) ──
  // Runs INDEPENDENTLY of the usage scan above: the category path is precisely
  // the blind spot, so a failure there must not also blind the catalog sweep.
  let undeclared: UndeclaredGrowth[] = [];
  try {
    const declaredTables = STORAGE_CATEGORIES.filter(isPgCategory).map((c) => c.table);
    const result = detectUndeclaredGrowth(await listTableSizes(), declaredTables);
    undeclared = result.undeclared;
    if (undeclared.length > 0 || result.staleCovered.length > 0) {
      await emitToast(formatUndeclaredToast(undeclared, result.staleCovered));
    }
  } catch (err) {
    console.warn(
      `[storage-growth-alarm] undeclared sweep skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
  }

  // ── The disk undeclared sweep (the category leg cannot cover this) ────────
  // The root list intentionally overlaps (~/.papercusp contains several named
  // stores), and the scanner/detector both deduplicate exact child paths.
  let undeclaredDisk: UndeclaredDiskGrowth[] = [];
  let diskScanIncomplete = false;
  try {
    const declaredDiskPaths = registeredDiskPaths(STORAGE_CATEGORIES.filter((c) => c.kind === 'disk'));
    const scan = await scanDiskRoots(declaredDiskPaths);
    const result = detectUndeclaredDiskGrowth(
      scan.entries,
      declaredDiskPaths,
      undeclaredDiskFloorBytes(),
      scan.truncated,
    );
    undeclaredDisk = result.undeclared;
    diskScanIncomplete = result.incomplete;
    if (undeclaredDisk.length > 0 || diskScanIncomplete) {
      try {
        await emitToast(formatUndeclaredDiskToast(undeclaredDisk, diskScanIncomplete));
      } catch (err) {
        console.warn(
          `[storage-growth-alarm] disk undeclared toast failed (non-fatal): ${(err as Error)?.message ?? String(err)}`,
        );
      }
    }
  } catch (err) {
    diskScanIncomplete = true;
    console.warn(
      `[storage-growth-alarm] disk undeclared sweep skipped (UNKNOWN, non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
    try {
      await emitToast(formatUndeclaredDiskToast([], true));
    } catch (toastErr) {
      console.warn(
        `[storage-growth-alarm] disk undeclared UNKNOWN toast failed (non-fatal): ${(toastErr as Error)?.message ?? String(toastErr)}`,
      );
    }
  }

  // ── The exempt-subset sweep (the leg NEITHER of the two above can cover) ──
  // Also independent: the two legs above are blind to this class by
  // construction, so a failure in either must not suppress it.
  let exemptSubsets: ExemptSubsetGrowth[] = [];
  let exemptUnknown: string[] = [];
  try {
    const countExemptSubsets = deps.countExemptSubsets ?? (() => defaultCountExemptSubsets());
    const result = detectExemptSubsetGrowth(await countExemptSubsets());
    exemptSubsets = result.over;
    exemptUnknown = result.unknown;
    if (exemptSubsets.length > 0 || exemptUnknown.length > 0) {
      await emitToast(formatExemptSubsetToast(exemptSubsets, exemptUnknown));
    }
  } catch (err) {
    console.warn(
      `[storage-growth-alarm] exempt-subset sweep skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
  }

  return {
    checked: rows.length,
    breaches,
    undeclared,
    undeclaredDisk,
    diskScanIncomplete,
    exemptSubsets,
    exemptUnknown,
  };
}
