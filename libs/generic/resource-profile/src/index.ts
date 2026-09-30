/**
 * @papercusp/resource-profile — detect a host's effective compute resources ONCE
 * at boot and derive every scale cap with explicit floors + ceilings, so nothing
 * is hardcoded for one machine.
 *
 * The same operator binary runs on a 2-core laptop (with an embedded Postgres
 * sharing the box) and on a 128-core server (with a dedicated native PG). Every
 * concurrency number — how many agents run at once, DBOS queue depth, the PG pool
 * size, serialization worker count — should scale between those two worlds instead
 * of being a constant tuned for one. This module is the ONE place that reads the
 * host once and turns it into those caps; consumers seed their defaults from it.
 *
 * BORROWABLE / generic-first: pure derivation behind a {@link configureResourceProfile}
 * seam. It does NOT import any host module — the caller injects the raw signals
 * (cores, RAM) and the two domain bits we can't sniff generically
 * ({@link ResourceSignals.embeddedPg}, {@link ResourceSignals.hostRole}). With no
 * injection it auto-detects from Node's `os` (cgroup-quota-aware
 * `os.availableParallelism()`, NOT raw `os.cpus().length`, so a 2-CPU-quota pod on
 * a 128-core node sees 2). Detection runs once and the derived caps are memoized;
 * call {@link resetResourceProfile} in tests.
 *
 * Every cap is `clamp(formula, FLOOR, CEILING)` — a floor so the smallest host
 * still makes forward progress (never 0 agents, never a 0-size pool) and a ceiling
 * so the largest host can't blow past what the rest of the system (PG max
 * connections, DBOS, file descriptors) can absorb.
 */

/** Coarse host bucket, derived from effective core count. Drives nothing on its
 *  own — it's a label for diagnostics + a cheap switch consumers can branch on. */
export type HostClass = 'laptop' | 'workstation' | 'server';

/**
 * Whether THIS process runs the shared background machinery (DBOS pipelines,
 * federation drains, watchdogs) or only serves requests. A request-only host
 * derives smaller background-oriented caps (queue concurrency) because it isn't
 * the one draining the queues. Generic over the host's own meaning of "role".
 */
export type HostRole = 'full' | 'request-only' | 'utility';

/** Raw host signals — injected by the caller, or auto-detected from `os`. */
export interface ResourceSignals {
  /** EFFECTIVE core count (cgroup-quota-aware). Defaults to
   *  `os.availableParallelism()` — NOT `os.cpus().length`, which ignores a
   *  container CPU quota and over-reports on a big shared node. Drives every cap
   *  that scales with THIS PROCESS's own usable concurrency (agent slots, DBOS
   *  queue depth, the org pool's `desired` size, serialization threads, …) — i.e.
   *  "how much work can I, this process, actually do at once". */
  cores: number;
  /** The MACHINE's real logical core count (`os.cpus().length`), ignoring any
   *  cgroup CPU quota placed on this one process. Optional; when omitted every
   *  consumer falls back to {@link cores} (unchanged behavior for any caller that
   *  only knows one number).
   *
   *  Used ONLY by {@link deriveDatabaseTuning}: `max_connections` and the other
   *  PG-server knobs describe the CAPACITY OF THE DATABASE SERVER, not of the one
   *  cgroup-limited client process asking for a pool — a `CPUQuota=` on a
   *  dedicated background-worker systemd unit has nothing to do with how many
   *  backends the (unthrottled) Postgres server can actually hold. Using the
   *  quota-scoped {@link cores} for that formula silently manufactures a fictional,
   *  far-too-low `max_connections` ESTIMATE that then feeds {@link
   *  boundedOrgPoolMax}'s connection-budget math as if it were the DB's real
   *  ceiling — collapsing that process's pool to the size-1 floor even though the
   *  live server has hundreds of free slots (confirmed root cause of WI-5456: a
   *  16-core-quota bg-host on a 128-core/512-`max_connections` box derived
   *  `maxConnections=100` from `clamp(16*4,100,1000)`, not the live 512, and its
   *  org pool collapsed to `poolMax=1` — every routines-tick query then serialized
   *  through one connection). `detectResourceSignals()` auto-fills this from
   *  `os.cpus().length`, which is NOT cgroup-quota-aware and so reads the real
   *  machine regardless of this process's own CPU allowance. */
  physicalCores?: number;
  /** Total physical RAM in bytes (`os.totalmem()`). */
  totalMemBytes: number;
  /** Free RAM in bytes at detection time (`os.freemem()`). A second clamp on the
   *  agent cap: a 64-core box with 1 GB free shouldn't launch 16 agents. */
  freeMemBytes: number;
  /** Does an embedded Postgres share THIS box? When true the DB competes with the
   *  operator for the same cores/RAM, so the per-core agent budget halves. */
  embeddedPg: boolean;
  /** This process's role (see {@link HostRole}). Default `'full'`. */
  hostRole: HostRole;
  /** Running on battery power (a laptop unplugged)? P5-3: when true the derived
   *  caps enter power-saver mode — fewer concurrent agents, no serialization
   *  thread pool, and a >1 {@link ResourceProfile.backgroundCadenceMultiplier} so
   *  background ticks run less often. Optional; defaults false (AC / unknown =
   *  full power — a server we can't read battery state for is never throttled).
   *  Detected out-of-band via {@link detectPowerSource} and injected at boot. */
  onBattery?: boolean;
}

/**
 * Recommended PostgreSQL server knobs derived from the host, PGTune-style.
 *
 * The stock Postgres defaults (`max_connections=100`, `shared_buffers=128MB`)
 * are sized for a tiny machine and never grow — on a 128-core / 251 GiB box
 * that is a 0.05%-of-RAM buffer cache and a connection ceiling a single
 * operator process can exhaust by itself. These caps scale the server to the
 * detected hardware (with floors so a laptop stays sane and ceilings so a huge
 * box can't ask for more shared memory than is wise). Applied two ways:
 *   - embedded Postgres (the desktop): fed straight into the postmaster's
 *     `-c key=value` flags at boot — the app autoadjusts with zero config;
 *   - native Postgres (a dev box / dedicated server): rendered into a
 *     `conf.d` drop-in by the `pg-autotune` script.
 *
 * Memory sizes are in **MiB**. Render to GUC strings via
 * {@link databaseTuningToSettings}.
 */
export interface DatabaseTuning {
  /** `max_connections` — server-wide backend ceiling. */
  readonly maxConnections: number;
  /** `superuser_reserved_connections` — slots kept for superusers so an
   *  exhausted pool never locks operators out of their own DB. */
  readonly superuserReservedConnections: number;
  /** `shared_buffers` (MiB) — the DB's dedicated page cache. ~25% RAM on a
   *  dedicated DB, a gentler ~15% when an embedded PG shares the box. */
  readonly sharedBuffersMb: number;
  /** `effective_cache_size` (MiB) — planner hint for total cache (OS + DB),
   *  not an allocation. ~75% RAM dedicated, ~50% embedded. */
  readonly effectiveCacheSizeMb: number;
  /** `maintenance_work_mem` (MiB) — for VACUUM / CREATE INDEX. */
  readonly maintenanceWorkMemMb: number;
  /** `work_mem` (MiB) — per sort/hash node. Sized so `max_connections` worth of
   *  concurrent sorts can't blow past RAM. */
  readonly workMemMb: number;
  /** `random_page_cost` for the supported SSD/NVMe storage profile. */
  readonly randomPageCost: number;
  /** `effective_io_concurrency` for the supported SSD/NVMe storage profile. */
  readonly effectiveIoConcurrency: number;
  /** `wal_buffers` (MiB). */
  readonly walBuffersMb: number;
  /** `max_wal_size` (MiB) — WAL volume between checkpoints before one is FORCED. */
  readonly maxWalSizeMb: number;
  /** `max_worker_processes` — background-worker slot ceiling (>= the parallel
   *  caps below + replication senders). */
  readonly maxWorkerProcesses: number;
  /** `max_parallel_workers` — total parallel-query workers. */
  readonly maxParallelWorkers: number;
  /** `max_parallel_workers_per_gather` — parallel workers a single query may use. */
  readonly maxParallelWorkersPerGather: number;
  /** `max_parallel_maintenance_workers` — parallel workers for CREATE INDEX etc. */
  readonly maxParallelMaintenanceWorkers: number;
}

/** The memoized, fully-derived profile — every scale cap the app needs. */
export interface ResourceProfile {
  /** The (possibly injected) raw signals the caps were derived from. */
  readonly signals: Readonly<ResourceSignals>;
  /** Coarse bucket from effective cores: <=4 laptop, <=16 workstation, else server. */
  readonly hostClass: HostClass;
  /** Fleet-wide cap on concurrently-running agent spawns. The single most
   *  load-bearing number; everything else is sized around it. */
  readonly maxSimultaneousAgents: number;
  /** Concurrency for the background work queue (DBOS). 0 is never valid — the
   *  queue must always drain — so the floor is 1. */
  readonly dbosQueueConcurrency: number;
  /** Max connections for the operator's PG pool. Sized so concurrent agents +
   *  background workers each get a connection, capped well under PG's own
   *  `max_connections`. */
  readonly pgPoolMax: number;
  /** Dedicated worker threads for CPU-heavy serialization/encoding. **0 ⇒ run
   *  inline** on the main thread (a small host shouldn't pay for a thread pool). */
  readonly serializationWorkers: number;
  /** Embedding batch size — how many items to embed per call. Bigger hosts push
   *  bigger batches for throughput; small hosts keep latency/memory down. */
  readonly embedBatchSize: number;
  /** Process-global ceiling on TOTAL concurrent Hyperswarm peer connections,
   *  shared across EVERY joined topic (the one shared swarm per process passes
   *  this straight to Hyperswarm's `maxPeers`). FLOORED at 256 so even the
   *  smallest host can hold one FULL 256-peer shared hive; scaled UP with
   *  cores/RAM so a 256-peer hive doesn't starve the box's OTHER topics
   *  (directory gossip + sibling harnesses); CEILED so a connection-flood can't
   *  exhaust file descriptors / RAM. */
  readonly maxSwarmPeers: number;
  /** RECOMMENDED placement of the shared background machinery (DBOS pipelines,
   *  the routines engine, periodic timers, drains) given this host's capacity.
   *  `true` ⇒ keep it IN the serving process — the desktop default: splitting buys
   *  nothing on a small single-user box and just costs a second process. `false` ⇒
   *  a host big enough to warrant moving background work to its OWN process so it
   *  can't steal the request loop. Derived purely from capacity — split only on a
   *  server-class host with a dedicated (native) Postgres; a laptop/workstation, or
   *  ANY host whose PG is embedded on the same box, keeps it in-process. (P3-1 of
   *  operator-scalability-event-loop reads this; on the desktop the split is a
   *  no-op. Independent of {@link ResourceSignals.hostRole}, which is what THIS
   *  process is *configured* to do; this is what the *hardware* recommends.) */
  readonly backgroundInProcess: boolean;
  /** HTTP worker processes for a clustered deploy (P3-2). >1 ONLY on a server-class
   *  host with a dedicated PG (same gate as {@link backgroundInProcess} = false);
   *  laptop / workstation / any embedded-PG (desktop) host stays 1. The RECOMMENDED
   *  count — the operator actually forks it only when clustering is explicitly
   *  enabled (default-off). `clamp(cores - 1, 1, 32)` (reserve a core for the
   *  background primary; cap so fd/connection pressure stays sane). */
  readonly httpWorkers: number;
  /** Total operator processes: clustered ⇒ {@link httpWorkers} request workers + 1
   *  background primary; otherwise 1 (a single process serves + runs background).
   *  **Feed this into PG pool sizing (boundedOrgPoolMax `expectedProcesses`)** so a
   *  clustered host's per-process pools can't multiply past PG `max_connections` —
   *  the exact 2026-06-17 connection-exhaustion this whole effort started from. */
  readonly processCount: number;
  /** Recommended PostgreSQL server knobs for THIS host (see {@link DatabaseTuning}).
   *  The desktop's embedded PG reads these at boot; a native PG is tuned from them
   *  by the `pg-autotune` script. */
  readonly database: DatabaseTuning;
  /** Multiplier (>=1) background tick schedulers apply to their cadence. 1 on AC;
   *  >1 on battery (P5-3) so periodic background work runs proportionally less
   *  often to save power. A tick that fires every minute at multiplier 3 should
   *  effectively run ~every 3 minutes. */
  readonly backgroundCadenceMultiplier: number;
}

/** Override any subset of the auto-detected signals. */
export type ResourceProfileConfig = Partial<ResourceSignals>;

// ---------------------------------------------------------------------------
// Derivation — pure, exported for unit tests (no memoization, no `os`).
// ---------------------------------------------------------------------------

const GIB = 1024 * 1024 * 1024;

function clamp(n: number, lo: number, hi: number): number {
  // A non-finite input (NaN/±Infinity) must never escape as a cap — NaN passes
  // straight through Math.min/Math.max and would poison every derived number
  // (and the host class) for the memoized process lifetime. Fall back to the
  // floor, the safe small-host default.
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Pure PostgreSQL server-tuning derivation from raw signals — PGTune-style,
 * every knob a `clamp(formula, FLOOR, CEILING)`. Exported + memo-free for unit
 * tests. See {@link DatabaseTuning} for what each knob is.
 *
 * `cores` in the table below is {@link ResourceSignals.physicalCores} (falling
 * back to {@link ResourceSignals.cores} when not supplied) — the real machine,
 * not this process's cgroup CPU-quota allowance. See `physicalCores`' doc comment.
 *
 * | knob                          | formula                                            | floor |  ceiling |
 * |-------------------------------|----------------------------------------------------|-------|----------|
 * | maxConnections                | cores * 4                                          |  100  |   1000   |
 * | superuserReservedConnections  | round(maxConnections * 0.02)                       |    3  |     12   |
 * | sharedBuffersMb               | RAM * (embeddedPg ? 0.15 : 0.25)                   |  128  |  32768   |
 * | effectiveCacheSizeMb          | RAM * (embeddedPg ? 0.50 : 0.75)                   |  256  | 786432   |
 * | maintenanceWorkMemMb          | RAM / 16                                            |   64  |   2048   |
 * | workMemMb                     | (RAM - sharedBuffers) / (maxConnections * 4)       |    4  |     64   |
 * | randomPageCost                | supported SSD/NVMe storage profile                 |  1.1  |    1.1   |
 * | effectiveIoConcurrency        | supported SSD/NVMe storage profile                 |  200  |    200   |
 * | walBuffersMb                  | sharedBuffers * 0.03                                |    4  |     64   |
 * | maxWalSizeMb                  | pre-cap host-scaled sharedBuffers / 8               | 1024  |   8192   |
 * | maxWorkerProcesses            | cores                                              |    8  |    256   |
 * | maxParallelWorkers            | cores                                              |    8  |    256   |
 * | maxParallelWorkersPerGather   | round(cores / 2)                                   |    1  |      8   |
 * | maxParallelMaintenanceWorkers | round(cores / 2)                                   |    1  |      8   |
 *
 * The embedded-vs-dedicated split mirrors the rest of the module: an embedded PG
 * shares the box with the operator + agents, so it takes a gentler slice of RAM
 * (it must not starve the very process it serves); a dedicated/native DB gets the
 * textbook PGTune fractions.
 *
 * Deliberately keys off {@link ResourceSignals.physicalCores} (the real machine,
 * falling back to {@link ResourceSignals.cores} when not supplied) rather than the
 * cgroup-quota-scoped `cores` every OTHER derived cap uses — these are PG-SERVER
 * knobs, a property of the machine Postgres runs on, not of whichever one
 * CPU-quota-limited client process happens to be deriving them. See the
 * `physicalCores` doc comment for the WI-5456 incident this fixes.
 */
export function deriveDatabaseTuning(signals: ResourceSignals): DatabaseTuning {
  const rawCores = Math.floor(signals.physicalCores ?? signals.cores);
  const cores = Number.isFinite(rawCores) ? Math.max(1, rawCores) : 1;
  // Floor RAM at 0.5 GiB so a bogus/zero signal still yields finite, sane caps
  // (the clamps below would otherwise key off 0).
  const totalMb = Math.max(0.5 * 1024, (Number.isFinite(signals.totalMemBytes) ? signals.totalMemBytes : 0) / (1024 * 1024));
  const { embeddedPg } = signals;

  const maxConnections = clamp(cores * 4, 100, 1000);
  const superuserReservedConnections = clamp(Math.round(maxConnections * 0.02), 3, 12);
  // Keep the host-scaled fraction separately: shared_buffers is a fixed startup
  // allocation, while max_wal_size protects write-heavy hosts from premature
  // forced checkpoints and must retain its prior 8 GiB ceiling on this class of
  // machine even though the cache itself is now capped at 32 GiB.
  const hostScaledSharedBuffersMb = clamp(Math.round(totalMb * (embeddedPg ? 0.15 : 0.25)), 128, 65536);
  const sharedBuffersMb = Math.min(hostScaledSharedBuffersMb, 32768);
  const effectiveCacheSizeMb = clamp(Math.round(totalMb * (embeddedPg ? 0.5 : 0.75)), 256, 786432);
  const maintenanceWorkMemMb = clamp(Math.round(totalMb / 16), 64, 2048);
  const workMemMb = clamp(Math.round((totalMb - sharedBuffersMb) / (maxConnections * 4)), 4, 64);
  // Papercusp's supported hosts are SSD/NVMe-backed. PostgreSQL's stock
  // 4.0/16 profile models rotational media and can reject useful index scans.
  // If rotational storage becomes a supported target, add an explicit storage
  // signal rather than silently restoring the global defaults.
  const randomPageCost = 1.1;
  const effectiveIoConcurrency = 200;
  const walBuffersMb = clamp(Math.round(sharedBuffersMb * 0.03), 4, 64);
  // max_wal_size — PG's 1 GB default forces a checkpoint whenever 1 GB of WAL
  // accrues, and the first write to every page after a checkpoint logs a FULL-PAGE
  // image, which inflates WAL and brings the next forced checkpoint closer. Measured
  // on the 128-core / 252 GiB dev host (2026-09-23): 2,217 of 5,338 checkpoints
  // were REQUESTED (WAL-volume forced) rather than timed, while 43-71 of ~110
  // active backends queued on LWLock:WALInsert. Scale with the pre-cap host
  // fraction so a small/embedded host keeps the stock 1 GB (bounded disk) and a
  // big dedicated host retains room to reach checkpoint_timeout instead of
  // being forced early.
  const maxWalSizeMb = clamp(Math.round(hostScaledSharedBuffersMb / 8), 1024, 8192);
  const maxWorkerProcesses = clamp(cores, 8, 256);
  const maxParallelWorkers = clamp(cores, 8, 256);
  const maxParallelWorkersPerGather = clamp(Math.round(cores / 2), 1, 8);
  const maxParallelMaintenanceWorkers = clamp(Math.round(cores / 2), 1, 8);

  return {
    maxConnections,
    superuserReservedConnections,
    sharedBuffersMb,
    effectiveCacheSizeMb,
    maintenanceWorkMemMb,
    workMemMb,
    randomPageCost,
    effectiveIoConcurrency,
    walBuffersMb,
    maxWalSizeMb,
    maxWorkerProcesses,
    maxParallelWorkers,
    maxParallelWorkersPerGather,
    maxParallelMaintenanceWorkers,
  };
}

/**
 * The bounded size for EACH org pool (admin + app), so that all org pools across
 * all operator processes + per-process fixed overhead + other-DB pools (su-lock)
 * stay under the DB's `max_connections`. C1-1 / C5-2 of
 * backend-connection-scaling-2026-06-17 — the guard the P4-3 regression lacked
 * (it sized each pool to `pgPoolMax` with no awareness of the 2-pool × N-process
 * multiplication or the ceiling, so two server-profile operators could open ~208
 * connections against a 100-slot DB).
 *
 * Behind a transaction pooler the app pool maps to local pooler *client* slots,
 * not PG backends, so it is NOT bounded by the backend ceiling — returns
 * `desired`. By construction (when not pooled):
 *   bounded·2·procs + fixedOverhead·procs + otherDbs + superuserReserved ≤ maxConnections.
 */
export function boundedOrgPoolMax(opts: {
  /** The unbounded desired size (e.g. resource-profile pgPoolMax or an env override). */
  desired: number;
  /** The DB's max_connections ceiling (host-tuned). */
  maxConnections: number;
  /** superuser_reserved_connections (kept free for superusers). */
  superuserReserved: number;
  /** How many operator processes share this DB (dev box: :3070 + :3170 = 2). */
  expectedProcesses: number;
  /** Behind a transaction pooler → app pool ≠ PG backends; skip the bound. */
  behindPooler?: boolean;
  /** Non-org connections each process holds: admin-cache(8) + 5 LISTEN buses. */
  fixedOverheadPerProcess?: number;
  /** Connections from OTHER databases on the same instance (su-lock in papercusp_su). */
  reservedForOtherDbs?: number;
}): number {
  const desired = Math.max(1, Math.floor(Number.isFinite(opts.desired) ? opts.desired : 1));
  if (opts.behindPooler) return desired;
  const procs = Math.max(1, Math.floor(opts.expectedProcesses));
  const fixedPerProc = opts.fixedOverheadPerProcess ?? 13;
  const otherDbs = opts.reservedForOtherDbs ?? 32;
  const reserved = Math.max(0, opts.superuserReserved) + otherDbs + fixedPerProc * procs;
  const budgetForOrgPools = Math.max(2, opts.maxConnections - reserved);
  const perPoolCap = Math.floor(budgetForOrgPools / (procs * 2));
  return Math.max(1, Math.min(desired, perPoolCap));
}

/**
 * P3-2: the largest cluster request-worker count whose per-process PG pools stay
 * HEALTHY (≥ `MIN_HEALTHY_POOL`) given the host's connection budget — so enabling the
 * cluster can never over-subscribe `max_connections` (the 2026-06-17 exhaustion) or
 * starve a worker's pool to the floor. Without this, `httpWorkers = cores-1` on a
 * 128-core/512-conn box would fork 32 workers (33 procs) and force `boundedOrgPoolMax`
 * to the floor of 1 — ~539 connections against a 512 ceiling. Uses the SAME bound the
 * pool sizing applies at runtime, over `processCount = workers + 1` (the background
 * primary). Exported for tests.
 */
export function maxClusterWorkersForConnBudget(
  db: Pick<DatabaseTuning, 'maxConnections' | 'superuserReservedConnections'>,
): number {
  const MIN_HEALTHY_POOL = 8;
  for (let workers = 32; workers >= 1; workers--) {
    const perPool = boundedOrgPoolMax({
      desired: 64,
      maxConnections: db.maxConnections,
      superuserReserved: db.superuserReservedConnections,
      expectedProcesses: workers + 1,
    });
    if (perPool >= MIN_HEALTHY_POOL) return workers;
  }
  return 1;
}

/**
 * Render a {@link DatabaseTuning} into a map of Postgres GUC name → value string
 * (with MB units where the knob is a size). Feed to a `conf.d` file
 * (`${k} = ${v}`) or to embedded-postgres `-c` flags
 * (`Object.entries(...).flatMap(([k, v]) => ['-c', \`${k}=${v}\`])`).
 */
export function databaseTuningToSettings(t: DatabaseTuning): Record<string, string> {
  return {
    max_connections: String(t.maxConnections),
    superuser_reserved_connections: String(t.superuserReservedConnections),
    shared_buffers: `${t.sharedBuffersMb}MB`,
    effective_cache_size: `${t.effectiveCacheSizeMb}MB`,
    maintenance_work_mem: `${t.maintenanceWorkMemMb}MB`,
    work_mem: `${t.workMemMb}MB`,
    // WI-37533 — explicit SSD/NVMe planner profile; do not inherit the
    // rotational-disk defaults of 4.0 and 16.
    random_page_cost: String(t.randomPageCost),
    effective_io_concurrency: String(t.effectiveIoConcurrency),
    wal_buffers: `${t.walBuffersMb}MB`,
    // max_wal_size is host-scaled (see deriveDatabaseTuning). checkpoint_timeout is
    // FIXED like the JIT knobs below: it encodes a workload shape (write-heavy, many
    // hot pages rewritten per interval), not a machine size. At PG's 5 min default
    // every hot page pays a full-page image 12x an hour; 15 min cuts that to 4x.
    // Crash recovery stays bounded by max_wal_size. Both are SIGHUP-reloadable.
    max_wal_size: `${t.maxWalSizeMb}MB`,
    checkpoint_timeout: '15min',
    // wal_compression — full-page images were 77% of WAL bytes on the dev box, and
    // WAL writes dominate the root disk. A live A/B on that cluster (2026-09-27,
    // WI-10003444; exact per-image ratio from pg_waldump -b) stored images at
    // 0.431 of raw with pglz, 0.449 with zstd and 0.512 with lz4. pglz is also the
    // ONLY method every build accepts: embedded PG 18.3 is built without lz4/zstd
    // and refuses them with a FATAL at startup. Fixed, not host-scaled; reloadable.
    wal_compression: 'pglz',
    // max_slot_wal_keep_size — disk-fill-SPOF defense (WI-347; complements the
    // WARN-only detector in operator-core storage/replication-slot-alarm.ts).
    // With PG's default -1 (UNLIMITED), a stuck/abandoned replication slot pins
    // WAL forever → the data volume silently fills → whole-cluster outage; the
    // P-009 alarm only warns, it can't cap growth. A bound makes PG auto-
    // invalidate a runaway slot before the disk fills (breaks one recoverable
    // replica vs a fatal full disk). Reloadable (SIGHUP — no restart needed).
    // Fixed, not host-scaled: this is a safety ceiling, not a perf knob.
    // Papercusp federation is hyperbee/substrate-based — pg_replication_slots is
    // empty on the live cluster — so this never bites normal operation; it only
    // ever caps a pathological stuck slot. 32GB ≫ normal WAL churn (max_wal_size
    // ~1GB) and ≪ the cluster's data volume.
    max_slot_wal_keep_size: '32GB',
    // log_parameter_max_length / _on_error — log-volume disk-fill defense
    // (WI-10002867). PG's default -1 logs EVERY bound parameter of a statement
    // that crosses log_min_duration_statement at FULL length. This workload binds
    // multi-MB text/jsonb payloads (session archives, transcripts), so each slow
    // statement wrote its whole payload to the server log. Measured 2026-09-24 on
    // the dev host: 13.4 GB of a 14.2 GB day's postgresql-18-main.log was
    // `DETAIL: Parameters:` lines (56,908 of them, the largest 10.6 MB on one
    // line), peaking at ~3.9 GB/hour, which filled the root filesystem. A
    // 1 KB prefix keeps each value identifiable for diagnosis. Fixed, not
    // host-scaled: a safety ceiling like the one above. Reloadable (superuser
    // context, SIGHUP).
    log_parameter_max_length: '1024',
    log_parameter_max_length_on_error: '1024',
    // jit_inline_above_cost / jit_optimize_above_cost — LLVM-compilation defense
    // (WI-6859). Like max_slot_wal_keep_size above, these are FIXED, not
    // host-scaled: they encode a workload SHAPE (short OLTP statements), not a
    // machine size.
    //
    // PG's JIT gates its passes on the PLANNER'S COST ESTIMATE, which is only as
    // good as its selectivity model. This workload queries jsonb bodies through
    // `CROSS JOIN LATERAL jsonb_array_elements_text(...)` with correlated
    // subplans — a shape the planner cannot estimate. Measured on the
    // unanswered-directed rollup (coord:orient + coord:inbox call it on EVERY
    // orient): estimated cost 2,101,755 for a plan that touches 97 buffers,
    // reads zero pages from disk and returns zero rows. That estimate clears
    // both 500k thresholds, so PG buys the two most expensive LLVM passes for a
    // query that needs none of them:
    //
    //   jit=on (defaults)            866-885 ms  (839 ms of it compilation)
    //   inline/optimize disabled      69- 73 ms  (40 ms compilation)
    //   jit=off                        1.3 ms
    //
    // Disabling optimize also collapses EMISSION (285 ms → 34 ms): there is far
    // less optimized IR to emit. Net ~95% of the JIT cost, for a 12x speedup on
    // the hot path.
    //
    // Systemic, not one query: 300,826 s (83.6 h) of lifetime JIT compilation
    // across 258 statements, 158 of which do <100 ms of REAL work per call. A
    // live 60 s delta measured JIT at 13.68% of ALL database execution time.
    //
    // -1 rather than `jit = off`, deliberately. A blanket disable would also
    // strip JIT from the few statements that genuinely earn it — measured at
    // 38,554 / 8,673 / 5,257 ms of real work per call against only 37-70 ms of
    // JIT, because their estimates sit BELOW these thresholds and they were only
    // ever paying generation + emission. Raising the two expensive knobs removes
    // the waste without touching the queries JIT exists for.
    //
    // Both are SIGHUP-reloadable — no restart required to apply or revert.
    jit_inline_above_cost: '-1',
    jit_optimize_above_cost: '-1',
    max_worker_processes: String(t.maxWorkerProcesses),
    max_parallel_workers: String(t.maxParallelWorkers),
    max_parallel_workers_per_gather: String(t.maxParallelWorkersPerGather),
    max_parallel_maintenance_workers: String(t.maxParallelMaintenanceWorkers),
  };
}

/* ------------------------------------------------------------------ *
 * Applying the derived settings to a LIVE server, and detecting drift.
 *
 * Emitting the right numbers is only half the job: they have to reach the
 * cluster, and STAY reached. The failure this section exists to prevent is a
 * silent one — an applier whose only path is write-then-RESTART is one nobody
 * dares run on a shared box, so a later setting gets hand-appended to the
 * managed file instead, the live config forks from this source of truth, and
 * every setting added in between is dropped without a single error. Measured:
 * `max_slot_wal_keep_size` (the disk-fill-SPOF defense above) and
 * `shared_preload_libraries` both sat unapplied for weeks that way, while the
 * source, its tests and its comments all said the defense was in place.
 *
 * So two pure helpers: decide reload-vs-restart (most of what we emit is
 * SIGHUP-reloadable, so hand-editing is never necessary), and diff target
 * against live (so a fork is detectable instead of invisible).
 * ------------------------------------------------------------------ */

/**
 * GUCs emitted by {@link databaseTuningToSettings} — plus `shared_preload_libraries`,
 * which appliers add alongside it — that PostgreSQL can only apply at postmaster
 * start. Everything else we emit is SIGHUP-reloadable.
 *
 * This is a FALLBACK, not the authority: {@link pgSettingRequiresRestart} prefers
 * the live server's own `pg_settings.context` when the caller can supply it, so a
 * PostgreSQL version that reclassifies a GUC can never be wrong here. The static
 * set only answers when the server can't be asked (a --print/offline run).
 */
export const PG_RESTART_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  'max_connections',
  'superuser_reserved_connections',
  'shared_buffers',
  'wal_buffers',
  'max_worker_processes',
  'shared_preload_libraries',
]);

/** One row of the live server's own view of a setting (`pg_settings`). */
export interface PgLiveSetting {
  name: string;
  /** Raw value, expressed in `unit` when the GUC has one. */
  setting: string;
  /** e.g. `8kB`, `MB`, `ms`, or null/empty for unitless GUCs. */
  unit?: string | null;
  /** `postmaster` | `sighup` | `superuser` | `user` | … */
  context?: string | null;
}

/** A target setting whose live value does not match. */
export interface PgSettingDivergence {
  name: string;
  /** Live value, rendered with its unit so it reads like the target does. */
  live: string;
  target: string;
  /** True when applying this one needs a full restart, not a reload. */
  restartOnly: boolean;
}

export interface PgSettingsDrift {
  diverged: PgSettingDivergence[];
  /** Target settings the live server does not report at all (typo, or a GUC this PG build lacks). */
  unknown: string[];
  /** Names among `diverged` that cannot be applied by SIGHUP alone. */
  restartRequired: string[];
  /** True when there IS drift and a reload is enough to close all of it. */
  reloadSuffices: boolean;
  /** True when live already matches target on every name. */
  inSync: boolean;
}

/**
 * Whether applying `name` needs a postmaster restart. Prefers the live server's
 * own `context` (authoritative); falls back to {@link PG_RESTART_ONLY_SETTINGS}
 * when no context is available.
 */
export function pgSettingRequiresRestart(name: string, liveContext?: string | null): boolean {
  if (liveContext) return liveContext === 'postmaster' || liveContext === 'internal';
  return PG_RESTART_ONLY_SETTINGS.has(name);
}

const SIZE_UNIT_BYTES: Record<string, number> = {
  B: 1,
  kB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

/**
 * Parse a PostgreSQL size unit as used in `pg_settings.unit` — a bare unit
 * (`MB`) or a multiplier + unit (`8kB`, the block-size form). Returns bytes per
 * unit, or null when `unit` is not a size unit (`ms`, `s`, '' …).
 */
function sizeUnitToBytes(unit: string | null | undefined): number | null {
  if (!unit) return null;
  const m = /^(\d*)(B|kB|MB|GB|TB)$/.exec(unit.trim());
  if (!m) return null;
  const mult = m[1] ? Number(m[1]) : 1;
  return mult * SIZE_UNIT_BYTES[m[2]];
}

/**
 * Parse a size-valued GUC written the way a config file writes it (`32GB`,
 * `64392MB`, `8192`, `-1`) into bytes. A bare number is interpreted in
 * `defaultUnitBytes`. Returns null when the value is not a size.
 *
 * `-1` and `0` are returned as-is (they are sentinels — "unlimited" / "off" —
 * not quantities), which is what makes `-1` vs `32GB` compare as a difference
 * rather than as an unparseable pair.
 */
export function parsePgSizeToBytes(value: string, defaultUnitBytes = 1): number | null {
  const v = value.trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (!m[2]) return n * defaultUnitBytes;
  return n * SIZE_UNIT_BYTES[m[2]];
}

/**
 * Conservative huge-page reservation for a native PostgreSQL cache change.
 * The server's estimate describes its CURRENT shared_buffers, so carrying it
 * unchanged across a smaller target would refuse a safe, already-backed pool.
 * Retain the measured non-buffer overhead and at least 1,024 pages of margin.
 */
export function requiredPgHugePagesForTarget(
  targetSharedBuffersMb: number,
  liveSharedBuffers: string | null,
  liveEstimatedPages: number | null,
): number {
  const targetBufferPages = Math.ceil(targetSharedBuffersMb / 2);
  const conservativeFloor = targetBufferPages + 1024;
  const liveBufferBytes = liveSharedBuffers === null ? null : parsePgSizeToBytes(liveSharedBuffers);
  if (
    liveBufferBytes === null || !Number.isFinite(liveBufferBytes) || liveBufferBytes <= 0 ||
    liveEstimatedPages === null || !Number.isSafeInteger(liveEstimatedPages) || liveEstimatedPages <= 0
  ) return conservativeFloor;
  const liveBufferPages = Math.ceil(liveBufferBytes / (2 * 1024 ** 2));
  const measuredOtherPages = Math.max(0, liveEstimatedPages - liveBufferPages);
  return Math.max(conservativeFloor, targetBufferPages + measuredOtherPages);
}

/** PostgreSQL's time units, in milliseconds (the units `pg_settings.unit` and config files use). */
const TIME_UNIT_MS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/** A `pg_settings.unit` for a time-valued GUC (`s`, `ms`, `min`) → milliseconds; null otherwise. */
function timeUnitToMs(unit: string | null | undefined): number | null {
  if (!unit) return null;
  const m = /^(\d*)(us|ms|s|min|h|d)$/.exec(unit.trim());
  if (!m) return null;
  const mult = m[1] ? Number(m[1]) : 1;
  return mult * (TIME_UNIT_MS[m[2]] ?? 0);
}

/**
 * Parse a time-valued GUC written the way a config file writes it (`15min`, `900s`,
 * `300`) into milliseconds. A bare number is interpreted in `defaultUnitMs`. Returns
 * null when the value is not a duration.
 *
 * Without this, a target of `15min` never compares equal to the live server's
 * canonical `900` + unit `s`: the apply verify reported a correctly applied
 * `checkpoint_timeout` as "did NOT take effect", and `--check` would have failed on
 * it forever (2026-09-23).
 */
export function parsePgDurationToMs(value: string, defaultUnitMs = 1): number | null {
  const v = value.trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (!m[2]) return n * defaultUnitMs;
  return n * (TIME_UNIT_MS[m[2]] ?? 0);
}

/** `'a,b'` / `a, b` → a normalized set-comparable key, so list GUCs ignore order + quoting. */
function normalizeListValue(value: string): string {
  return value
    .trim()
    .replace(/^'(.*)'$/s, '$1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

/** True when a live value and a target value mean the same thing to PostgreSQL. */
function pgValuesEqual(target: string, live: PgLiveSetting): boolean {
  const unitBytes = sizeUnitToBytes(live.unit);
  if (unitBytes != null) {
    const t = parsePgSizeToBytes(target, unitBytes);
    const l = parsePgSizeToBytes(live.setting, unitBytes);
    if (t != null && l != null) return t === l;
  }
  const unitMs = timeUnitToMs(live.unit);
  if (unitMs != null) {
    const t = parsePgDurationToMs(target, unitMs);
    const l = parsePgDurationToMs(live.setting, unitMs);
    if (t != null && l != null) return t === l;
  }
  const tNum = Number(target.trim());
  const lNum = Number(live.setting.trim());
  if (Number.isFinite(tNum) && Number.isFinite(lNum)) return tNum === lNum;
  return normalizeListValue(target) === normalizeListValue(live.setting);
}

/** Render a live value with its unit, so it reads like the config-file form. */
function renderLive(live: PgLiveSetting): string {
  const unit = (live.unit ?? '').trim();
  return unit ? `${live.setting}${unit}` : live.setting;
}

/**
 * Diff the settings we intend to apply against what the server is actually
 * running. This is the drift detector: it answers "has the live cluster silently
 * forked from the tuning source?" and, when it has, "can a reload close it?".
 *
 * Pure — the caller supplies the `pg_settings` rows.
 */
export function diffPgSettings(
  target: Record<string, string>,
  live: readonly PgLiveSetting[],
): PgSettingsDrift {
  const byName = new Map(live.map((r) => [r.name, r]));
  const diverged: PgSettingDivergence[] = [];
  const unknown: string[] = [];

  for (const [name, want] of Object.entries(target)) {
    const row = byName.get(name);
    if (!row) {
      unknown.push(name);
      continue;
    }
    if (pgValuesEqual(want, row)) continue;
    diverged.push({
      name,
      live: renderLive(row),
      target: want,
      restartOnly: pgSettingRequiresRestart(name, row.context),
    });
  }

  const restartRequired = diverged.filter((d) => d.restartOnly).map((d) => d.name);
  return {
    diverged,
    unknown,
    restartRequired,
    reloadSuffices: diverged.length > 0 && restartRequired.length === 0,
    inSync: diverged.length === 0,
  };
}

/**
 * Pure cap derivation from raw signals. Each cap is `clamp(formula, FLOOR, CEIL)`.
 *
 * | cap                  | formula                                              | floor | ceiling |
 * |----------------------|------------------------------------------------------|-------|---------|
 * | maxSimultaneousAgents| round(cores * (embeddedPg ? 0.25 : 0.5)), then        |   1   |   16    |
 * |                      | also clamped by free RAM (~0.5 GiB budget/agent)     |       |         |
 * | dbosQueueConcurrency | round(cores * (embeddedPg ? 0.5 : 1))                |   1   |   32    |
 * |                      | request-only/utility role → halved (not the drainer) |       |         |
 * | pgPoolMax            | maxSimultaneousAgents + dbosQueueConcurrency + 4      |   4   |   64    |
 * | serializationWorkers | cores - 2  (0 ⇒ inline; only earned past ~4 cores)   |   0   |    8    |
 * | embedBatchSize       | 32 * 2^hostClassTier (laptop 32 / wkstn 64 / srv 128)|  16   |  256    |
 * | maxSwarmPeers        | min(cores * 32, totalGiB * 64)                       |  256  |  2048   |
 * | backgroundInProcess  | false only on a server-class host w/ native PG; else true | — | — |
 * | httpWorkers          | server ? min(cores-1, connBudget) : 1 (EI-3377)     |   1   |   32    |
 */
export function deriveResourceProfile(signals: ResourceSignals): ResourceProfile {
  // Normalize cores to a finite >=1 integer. A non-finite signal (NaN from a
  // failed detect, ±Infinity) would otherwise flow through Math.floor unchanged
  // — NaN poisons every cap and the host class, +Infinity misclassifies as
  // 'server' and persists a non-finite signals.cores — so it falls back to a
  // single core (the smallest-host default).
  const rawCores = Math.floor(signals.cores);
  const cores = Number.isFinite(rawCores) ? Math.max(1, rawCores) : 1;
  const { embeddedPg, hostRole } = signals;
  const onBattery = signals.onBattery === true;
  // WI-41206: `freeMemBytes` is still collected as telemetry but no longer derives any cap,
  // so there is deliberately no `freeGib` here. Re-deriving one to gate work would reinstate
  // both the policy and the os.freemem() measurement error described below.

  const hostClass: HostClass = cores <= 4 ? 'laptop' : cores <= 16 ? 'workstation' : 'server';

  // maxSimultaneousAgents: CORE-derived, halved when an embedded PG shares the box.
  //
  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: the second clamp by FREE RAM
  // (`Math.floor(freeGib / 0.5)`) is gone. Two reasons, and the second is the stronger:
  //
  //  1. Policy — running the box into paging is the operator's call to make. A host with
  //     terabytes of swap should get SLOWER under load, not silently advertise fewer agent
  //     slots than its cores can drive.
  //  2. It measured the wrong quantity. This clamp read `os.freemem()`, which EXCLUDES
  //     reclaimable page cache and therefore reads catastrophically low on any box that has
  //     been up for a while — the exact trap that `scripts/lib/budgeted-task-scheduler.mjs`
  //     and `scripts/affected-tests.mjs` both document in their own comments ("MemAvailable,
  //     never MemFree/os.freemem()"). Measured on this host at removal time: os.freemem()
  //     reported ~33 GiB while MemAvailable was ~70 GiB, i.e. it would have halved the agent
  //     budget on a host with ample headroom.
  //
  // `signals.freeMemBytes` is still COLLECTED and reported — it is useful telemetry. It just
  // no longer decides how much work this host is permitted to do.
  const agentsByCore = Math.round(cores * (embeddedPg ? 0.25 : 0.5));
  // P5-3: on battery, halve concurrency too (extends battery life, cuts heat/fan).
  const agentsBudget = agentsByCore;
  const maxSimultaneousAgents = clamp(onBattery ? Math.round(agentsBudget / 2) : agentsBudget, 1, 16);

  // DBOS queue: a request-only / utility host isn't the queue drainer, so it gets
  // half the depth a full host would.
  const queueBase = Math.round(cores * (embeddedPg ? 0.5 : 1));
  const queueRoleFactor = hostRole === 'full' ? 1 : 0.5;
  const dbosQueueConcurrency = clamp(Math.round(queueBase * queueRoleFactor), 1, 32);

  // PG pool: one connection per concurrent agent + per queue worker + a small
  // fixed overhead for request handlers, capped well under PG max_connections.
  const pgPoolMax = clamp(maxSimultaneousAgents + dbosQueueConcurrency + 4, 4, 64);

  // Serialization threads are only worth their overhead once there are spare cores;
  // 0 means run inline on the main thread. P5-3: on battery, force inline (0) — a
  // busy thread pool keeps cores clocked up and drains the battery.
  const serializationWorkers = onBattery ? 0 : clamp(cores - 2, 0, 8);

  // Embedding batch grows by host class tier.
  const tier = hostClass === 'laptop' ? 0 : hostClass === 'workstation' ? 1 : 2;
  const embedBatchSize = clamp(32 * 2 ** tier, 16, 256);

  // Peer-connection ceiling for the process-global shared Hyperswarm (`maxPeers`),
  // shared across ALL joined topics. FLOOR 256 so even a 2-core laptop can hold one
  // FULL 256-peer shared hive (P-004 harden-shared-hive-to-256-peers); scale UP with
  // cores (32/core) AND total RAM (~64 peers/GiB) so a bigger box has headroom for a
  // 256-peer hive PLUS its other topics instead of starving them; CEIL 2048 so a
  // connection-flood still can't exhaust fds/RAM. RAM uses TOTAL memory — this is a
  // static capacity ceiling, not the instantaneous free-RAM agent budget — and
  // min(byCore, byRam) keeps a core-rich / RAM-poor host from advertising slots it
  // can't actually hold. (`clamp` maps a NaN/Infinity signal to the 256 floor.)
  const totalGib = Math.max(0, Number.isFinite(signals.totalMemBytes) ? signals.totalMemBytes : 0) / GIB;
  const peersByCore = cores * 32;
  const peersByRam = Math.floor(totalGib * 64);
  const maxSwarmPeers = clamp(Math.min(peersByCore, peersByRam), 256, 2048);

  // Background placement: keep it in-process everywhere EXCEPT a server-class host
  // with a dedicated (native) PG, where a real multi-tenant box has the headroom +
  // the motivation to give background work its own process. A laptop/workstation,
  // or any host whose PG is embedded on the same box (the desktop), keeps it
  // in-process — the split would buy nothing and cost a second process.
  const backgroundInProcess = !(hostClass === 'server' && !embeddedPg);

  // PostgreSQL server knobs scaled to the same host (see deriveDatabaseTuning).
  // Computed BEFORE httpWorkers — the cluster worker count is co-bounded by the DB
  // connection budget below.
  const database = deriveDatabaseTuning(signals);

  // HTTP worker processes for a clustered deploy (P3-2). >1 ONLY on a server-class
  // host: a big multi-tenant box that benefits from spreading request serving across
  // cores. A laptop/workstation stays 1 (clustering buys nothing for one user, and a
  // desktop owns the single-socket PTY/IPC servers a round-robin cluster can't share);
  // hostClass is the robust desktop discriminator — a real embedded-PG desktop is
  // ALWAYS laptop/workstation-class, never 'server'. The count is the MIN of two
  // ceilings: cores-1 (reserve a core for the background primary), capped at 32; AND
  // the PG CONNECTION BUDGET (maxClusterWorkersForConnBudget) — without that second
  // cap, cores-1 on a 128-core/512-conn box forks 32 workers and over-subscribes
  // max_connections, re-creating the 2026-06-17 exhaustion. RECOMMENDED count only —
  // forked only when clustering is explicitly enabled (default-off); the operator
  // feeds processCount into PG pool sizing.
  //
  // EI-3377: gated on hostClass ALONE, NOT `!embeddedPg`. The papercusp detector
  // detectEmbeddedPg() misfires to true on any host with an explicit DATABASE_URL
  // (EI-2403), so a native-PG server (the whole point of clustering) wrongly read
  // embeddedPg=true and collapsed httpWorkers to 1. The connection concern embeddedPg
  // stood proxy for is already handled directly by maxClusterWorkersForConnBudget, and
  // the desktop concern by hostClass — so the embeddedPg term was both redundant and
  // (given the misfire) actively wrong. Same rationale pgbouncerEnabled()/pg-listen-hub
  // already adopted. A genuine server-with-embedded-PG only changes its RECOMMENDED
  // count; clustering is still opt-in (PAPERCUSP_CLUSTER), so nothing forks unbidden.
  const clusterable = hostClass === 'server';
  const httpWorkers = clusterable
    ? clamp(Math.min(cores - 1, maxClusterWorkersForConnBudget(database)), 1, 32)
    : 1;
  // Total operator processes: clustered ⇒ N request workers + 1 background primary;
  // otherwise a single process that both serves requests + runs background work.
  const processCount = httpWorkers > 1 ? httpWorkers + 1 : 1;

  // P5-3: widen background cadences 3x on battery so periodic work runs less often.
  const backgroundCadenceMultiplier = onBattery ? 3 : 1;

  return {
    signals: Object.freeze({ ...signals, cores }),
    hostClass,
    maxSimultaneousAgents,
    dbosQueueConcurrency,
    pgPoolMax,
    serializationWorkers,
    embedBatchSize,
    maxSwarmPeers,
    backgroundInProcess,
    httpWorkers,
    processCount,
    database,
    backgroundCadenceMultiplier,
  };
}

// ---------------------------------------------------------------------------
// Auto-detection + memoized singleton.
// ---------------------------------------------------------------------------

/**
 * Read the raw host signals from Node's `os`. Uses cgroup-quota-aware
 * `os.availableParallelism()` for `cores` (NOT `os.cpus().length`), and separately
 * captures `os.cpus().length` (NOT cgroup-quota-aware) as `physicalCores` — see
 * {@link ResourceSignals.physicalCores} for why `deriveDatabaseTuning` needs the
 * real machine's core count, not this process's quota-scoped view of it. The two
 * domain bits we can't sniff generically default conservatively: `embeddedPg: false`
 * (assume a dedicated DB unless told otherwise) and `hostRole: 'full'`.
 */
export function detectResourceSignals(overrides?: ResourceProfileConfig): ResourceSignals {
  // Node 22's synchronous built-in loader keeps node:os OUT of the static
  // import graph (pure derivation/types remain usable in a non-Node bundle),
  // works in ESM, and avoids createRequire's dynamic-require edge that webpack
  // cannot statically analyze in server bundles.
  const os = nodeBuiltin<typeof import('node:os')>('node:os');
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return {
    cores,
    physicalCores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    embeddedPg: false,
    hostRole: 'full',
    onBattery: false,
    ...overrides,
  };
}

/** A host's current power source. 'unknown' for a host with no battery (a server,
 *  a container) or where detection fails — consumers treat it as 'ac' (full power). */
export type PowerSource = 'ac' | 'battery' | 'unknown';

type NodeBuiltinLoader = <T extends object>(id: string) => T;

function nodeBuiltin<T extends object>(id: string): T {
  const loaded = process.getBuiltinModule(id);
  if (!loaded) throw new Error(`node_builtin_unavailable:${id}`);
  return loaded as T;
}

/**
 * Best-effort power-source detection (P5-3). I/O + platform-specific, so it lives
 * OUTSIDE the pure derivation: Linux reads `/sys/class/power_supply`, macOS shells
 * `pmset -g batt`. Anything else — or any failure, or a host with no battery —
 * resolves `'unknown'`, which consumers treat as AC (a server we can't read is
 * never throttled). Wire the result into the profile BEFORE the first read via
 * `configureResourceProfile({ onBattery: source === 'battery' })`.
 */
export async function detectPowerSource(): Promise<PowerSource> {
  let load: NodeBuiltinLoader;
  let platform: NodeJS.Platform;
  try {
    load = nodeBuiltin;
    platform = load<typeof import('node:os')>('node:os').platform();
  } catch {
    return 'unknown';
  }
  try {
    if (platform === 'linux') return await detectPowerSourceLinux(load);
    if (platform === 'darwin') return await detectPowerSourceDarwin(load);
  } catch {
    /* fall through to unknown — best-effort only */
  }
  return 'unknown';
}

async function detectPowerSourceLinux(load: NodeBuiltinLoader): Promise<PowerSource> {
  const fsp = load<typeof import('node:fs')>('node:fs').promises;
  const base = '/sys/class/power_supply';
  let entries: string[];
  try {
    entries = await fsp.readdir(base);
  } catch {
    return 'unknown'; // no power-supply class (a container / VM / headless server)
  }
  const read = async (rel: string): Promise<string | null> => {
    try {
      return (await fsp.readFile(`${base}/${rel}`, 'utf8')).trim();
    } catch {
      return null;
    }
  };
  // Prefer the AC adapter's 'online' flag — the most direct signal.
  for (const name of entries) {
    if ((await read(`${name}/type`)) !== 'Mains') continue;
    const online = await read(`${name}/online`);
    if (online === '1') return 'ac';
    if (online === '0') return 'battery';
  }
  // Fall back to a battery's charge status.
  for (const name of entries) {
    if ((await read(`${name}/type`)) !== 'Battery') continue;
    const status = await read(`${name}/status`);
    if (status === 'Discharging') return 'battery';
    if (status === 'Charging' || status === 'Full') return 'ac';
  }
  return 'unknown';
}

async function detectPowerSourceDarwin(load: NodeBuiltinLoader): Promise<PowerSource> {
  const { execFile } = load<typeof import('node:child_process')>('node:child_process');
  const { promisify } = load<typeof import('node:util')>('node:util');
  const { stdout } = await promisify(execFile)('pmset', ['-g', 'batt'], { timeout: 2000 });
  if (/AC Power/i.test(stdout)) return 'ac';
  if (/Battery Power/i.test(stdout)) return 'battery';
  return 'unknown';
}

let memoized: ResourceProfile | null = null;
let pendingConfig: ResourceProfileConfig | null = null;

/**
 * The seam: inject the domain signals (and optionally override detected ones)
 * BEFORE the first {@link getResourceProfile}. Idempotent until the profile is
 * realized; throws if called after the profile has already been memoized so a
 * late override can't silently no-op. Call once at boot.
 */
export function configureResourceProfile(config: ResourceProfileConfig): void {
  if (memoized) {
    throw new Error(
      'configureResourceProfile() called after the profile was already detected; ' +
        'configure it once at boot, before any getResourceProfile() consumer.',
    );
  }
  pendingConfig = { ...pendingConfig, ...config };
}

/**
 * The memoized profile. Detects the host ONCE (merging any
 * {@link configureResourceProfile} signals) and caches the derived caps for the
 * process lifetime.
 */
export function getResourceProfile(): ResourceProfile {
  if (!memoized) {
    memoized = deriveResourceProfile(detectResourceSignals(pendingConfig ?? undefined));
  }
  return memoized;
}

/** Test hook — clear the memoized profile + any pending config. */
export function resetResourceProfile(): void {
  memoized = null;
  pendingConfig = null;
}
