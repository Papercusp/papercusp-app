/**
 * Storage category taxonomy — the single source of truth for the Settings →
 * Storage page (storage-settings-page-2026-06-15 P-002 / P-003).
 *
 * D-002: usage is grouped by CATEGORY. Each category maps to either a PG table
 * (with a federation class derived from the harness-state table-registry) or an
 * on-disk store. The federation class drives the page's affordances:
 *
 *   • local-diagnostic — `sync:'none'` telemetry/diagnostic tables that never
 *                        leave this install. SAFE to trim by age.
 *   • bloat-queue      — `sync:'none'` queue table whose logical delete does NOT
 *                        return disk (substrate_outbox, audit R1) → trim + a
 *                        VACUUM FULL reclaim (coordinated via the db:migrate
 *                        resource lock).
 *   • federated        — `sync:'git'|'peer-log'` tables that peers see. Trimming
 *                        changes shared state → surfaced READ-ONLY with a warning;
 *                        the prune endpoint REFUSES them (fail-safe; D-002/D-003).
 *
 * On-disk stores (agent session dirs, scratch, flight-recorder) are always
 * local; their trim reuses the audited GC helpers (session-dir-gc) so a live or
 * resumable session is never collected.
 *
 * The federation class for every PG category is asserted against the live
 * registry by categories.test.ts — so a table that changes sync authority can't
 * silently become trimmable-while-federated (or vice-versa).
 */
import { resolveTableSpec } from '../harness-state/table-registry';

export type StorageFederation = 'federated' | 'local-diagnostic' | 'bloat-queue';
/** How the age column encodes time: a real timestamptz, or epoch-milliseconds in a bigint. */
export type AgeColumnType = 'timestamptz' | 'epoch_ms';
/** Which on-disk store a disk category maps to (resolved at runtime). */
export type DiskStore =
  | 'session-dirs'
  | 'scratch'
  | 'flight-recorder'
  | 'wake-spills'
  | 'glob-files';

export interface PgStorageCategory {
  id: string;
  label: string;
  kind: 'pg';
  /** schema-qualified target (always harness_shared today). */
  schema: string;
  table: string;
  /** age column for delete-by-age + the age distribution. Omitted for federated
   *  (read-only) categories where no trim happens. */
  ageColumn?: string;
  ageColumnType?: AgeColumnType;
  federation: StorageFederation;
  /** logical delete alone does not return disk → reclaim needs VACUUM FULL. */
  bloats?: boolean;
  /** only rows already drained to the peer-log are dead weight (substrate_outbox). */
  drainedGuard?: boolean;
  description: string;
}

export interface DiskStorageCategory {
  id: string;
  label: string;
  kind: 'disk';
  store: DiskStore;
  federation: 'local-diagnostic';
  /** Retention floor: never trim more aggressively than this, whatever age the
   *  caller asks for. For `session-dirs` it is the audited GC window that protects
   *  a crashed-but-resumable session; for a plain store it protects entries whose
   *  only copy lives here and whose reader may not have run yet (wake-spills).
   *  Enforced for BOTH paths — see `pruneDiskPlain`, which used to ignore it. */
  minOlderThanDays?: number;
  /** glob-files store ONLY: enumerate <root>/<prefix>*<suffix> (files only, a
   *  safe prefix+suffix match — never the whole root). rootKind resolves in disk.ts
   *  so the taxonomy stays a pure data module (no fs/os import). */
  glob?: { rootKind: 'papercusp-home'; prefix: string; suffix: string };
  description: string;
}

export type StorageCategory = PgStorageCategory | DiskStorageCategory;

/**
 * The category set. New entries are additive; the federation class of a PG
 * category MUST agree with resolveTableSpec (asserted in the test).
 */
export const STORAGE_CATEGORIES: readonly StorageCategory[] = [
  // ── local-diagnostic PG (sync:'none') — safe to trim by age ──────────────
  {
    id: 'route-invocations',
    label: 'HTTP route telemetry',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'route_invocations',
    ageColumn: 'invoked_at',
    ageColumnType: 'timestamptz',
    federation: 'local-diagnostic',
    description:
      'Per-request HTTP endpoint telemetry (method, path, status, duration). Never federated; the largest single diagnostic table.',
  },
  {
    id: 'tool-invocations',
    label: 'Tool-call telemetry',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'tool_invocations',
    ageColumn: 'invoked_at',
    ageColumnType: 'timestamptz',
    federation: 'local-diagnostic',
    description:
      "Every defineTool dispatch this install ran (args, duration, outcome). Local-only diagnostic.",
  },
  {
    id: 'decision-ledger',
    label: 'Autonomy decision ledger',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'decision_ledger',
    ageColumn: 'ts',
    ageColumnType: 'timestamptz',
    federation: 'local-diagnostic',
    description:
      'The governed-action chokepoint log (what the Mug decided + its disposition). Workspace-local.',
  },
  {
    id: 'agent-activity',
    label: 'Fleet activity bridge',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'agent_activity',
    ageColumn: 'created_at',
    ageColumnType: 'timestamptz',
    federation: 'local-diagnostic',
    description:
      'Cross-CLI worker activity (tool calls / lifecycle / todos) powering the fleet view. Local-only.',
  },
  {
    id: 'memory-recall-query-text',
    label: 'Memory recall query text',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'memory_recall_query_text',
    ageColumn: 'created_at',
    ageColumnType: 'timestamptz',
    federation: 'local-diagnostic',
    description:
      'Retrieval query TEXT joined to memory_recall_stats (migration 771). The only recall telemetry holding agent-authored text, so it is age-bounded deliberately — the stats row it hangs off is kept indefinitely and is unaffected by this prune.',
  },
  {
    id: 'harness-run-output',
    label: 'Harness run output (logs)',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'harness_run_output',
    ageColumn: 'ended_at',
    ageColumnType: 'epoch_ms',
    federation: 'local-diagnostic',
    description:
      'Captured prompt / stdout / stderr / jsonl bodies per agent run. Local-only diagnostic; one of the larger tables.',
  },
  // ── bloat-queue (sync:'none', logical delete ≠ disk reclaim) ─────────────
  {
    id: 'substrate-outbox',
    label: 'Federation outbox (drained)',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'substrate_outbox',
    ageColumn: 'ts',
    ageColumnType: 'epoch_ms',
    federation: 'bloat-queue',
    bloats: true,
    drainedGuard: true,
    description:
      'The CDC outbox queue. Rows already drained to peers are dead weight; trimming + VACUUM FULL reclaims the disk (audit R1: logical delete alone does not).',
  },
  // ── federated PG (sync:'git'|'peer-log') — READ-ONLY, warn (no trim) ──────
  {
    id: 'plans',
    label: 'Plans',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'harness_plans',
    federation: 'federated',
    description:
      'Project plans. Federated across the Hive (peer-log) — trimming changes what peers see, so it is read-only here.',
  },
  {
    id: 'coord-log',
    label: 'Coordination log',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'coord_event_log',
    federation: 'federated',
    description:
      'Inter-agent messages / handoffs / escalations. Harness-scoped rows federate over the peer-log — read-only here.',
  },
  {
    id: 'features',
    label: 'Features',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'harness_features_consolidated',
    federation: 'federated',
    description: 'The feature pipeline state. Federated (peer-log) — read-only here.',
  },
  {
    id: 'issues',
    label: 'Issues',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'harness_issues_consolidated',
    federation: 'federated',
    description: 'The issue/bug queue. Federated (peer-log) — read-only here.',
  },
  {
    id: 'shared-presence',
    label: 'Shared presence roster',
    kind: 'pg',
    schema: 'harness_shared',
    table: 'shared_presence',
    federation: 'federated',
    description:
      'Cross-machine presence roster projected from the peer log. Read-only here because trimming changes what peers see; weekly index-bloat maintenance runs through telemetry-retention.',
  },
  // ── on-disk stores (always local) ────────────────────────────────────────
  {
    id: 'agent-sessions',
    label: 'Agent session dirs (homes & transcripts)',
    kind: 'disk',
    store: 'session-dirs',
    federation: 'local-diagnostic',
    // The audited GC floor — a live or resumable session is always protected, and
    // a not-live dir is only collectible past this window (resume grace).
    minOlderThanDays: 7,
    description:
      'Per-session CLAUDE_CONFIG_DIR / CODEX_HOME / signed .mcp.json (transcripts + rollouts). Live and resumable sessions are always protected.',
  },
  {
    id: 'scratch',
    label: 'Tool-output scratch',
    kind: 'disk',
    store: 'scratch',
    federation: 'local-diagnostic',
    description:
      'Large tool outputs (CSV, repomix bundles, screenshots) staged under ~/.papercusp/scratch.',
  },
  {
    id: 'flight-recorder',
    label: 'Flight recorder',
    kind: 'disk',
    store: 'flight-recorder',
    federation: 'local-diagnostic',
    description: 'Spawn flight-recorder traces under ~/.papercusp/flight-recorder.',
  },
  {
    id: 'wake-spills',
    label: 'Wake spills',
    kind: 'disk',
    store: 'wake-spills',
    federation: 'local-diagnostic',
    // A spill is the ONLY copy of a wake's full text (applyInjectionDoor delivers a
    // truncated tail plus a pointer here), so unlike scratch/flight-recorder this
    // store carries a floor: a recipient that has not taken its next turn yet must
    // still find its spill. Entry mtime is the per-owner dir's last write, so a dead
    // owner's whole directory ages out together without any liveness lookup.
    minOlderThanDays: 3,
    description:
      'Full wake text spilled past the per-hop injection door, under ~/.papercusp/wake-spills/<owner>/. Each file self-describes as safe to delete after reading; nothing else collects them.',
  },
  {
    id: 'perf-tarballs',
    label: 'Perf-test tarballs',
    kind: 'disk',
    store: 'glob-files',
    glob: { rootKind: 'papercusp-home', prefix: 'p2p-perf-runtime-', suffix: '.tgz' },
    federation: 'local-diagnostic',
    description:
      'p2p perf-test runtime tarballs (~/.papercusp/p2p-perf-runtime-*.tgz) — disposable benchmark debris.',
  },
];

/** Lookup a category by id. */
export function getStorageCategory(id: string): StorageCategory | undefined {
  return STORAGE_CATEGORIES.find((c) => c.id === id);
}

/** A category is trimmable iff it is not federated (D-002/D-003 fail-safe). */
export function isTrimmable(cat: StorageCategory): boolean {
  return cat.federation !== 'federated';
}

/** Type guard. */
export function isPgCategory(cat: StorageCategory): cat is PgStorageCategory {
  return cat.kind === 'pg';
}

/**
 * The federation class a PG table's registry spec implies. `sync:'none'` →
 * local (diagnostic or bloat-queue, distinguished by the category's own
 * `bloats` flag); any sync authority → federated. The taxonomy above hard-codes
 * the class for legibility; categories.test.ts asserts it matches this.
 */
export function registryFederationClass(table: string): 'local' | 'federated' {
  return resolveTableSpec(table).sync === 'none' ? 'local' : 'federated';
}
