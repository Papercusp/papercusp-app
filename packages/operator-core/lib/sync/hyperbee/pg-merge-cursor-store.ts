/**
 * pg-merge-cursor-store.ts — WI-2105 REV fix: a Postgres-backed `MergeCursorStore`
 * over `harness_shared.substrate_merge_cursor`.
 *
 * The substrate boot merge folds each admitted peer log via an IN-MEMORY cursor
 * that reset to 0 on every bg-host restart. A large orphaned log (e06b8704, 70k
 * ops) then re-folded from scratch each boot, CPU-starving `routinesTick` past
 * the 240s bghost-watchdog bound → the watchdog restarted bg-host → the fold
 * never reached tail (the REV restart loop). Persisting per-log positions here
 * makes fold progress MONOTONIC across restarts. The write is persist-AFTER-apply
 * (see `read-merge.persistCursor` / the boot `onCursorAdvance` hook): a crash
 * between apply and persist re-folds the last batch idempotently (LWW put/del)
 * rather than skipping it.
 *
 * Pool policy: ONE small module-scoped pool shared across every harness boot in
 * this process (like `pg-listen-hub.ts` / `dock-layouts.ts`), NOT a pool per slug
 * or per op (the perf anti-pattern). DSN resolves via `getHarnessAdminUrl()` —
 * never a hardcoded `localhost:5432` (embedded-pg is the ship target).
 */

import { getLongLivedAdminPool } from '../../long-lived-admin-pool';
import {
  NO_SNAPSHOT_APPLY,
  type MergeApplyFailure,
  type MergeCursorPeerLifecycle,
  type MergeCursorPeerLifecycleState,
  type MergeCursorStore,
  type SnapshotApplyMark,
} from './read-merge';

/** Process-lived shared pool. `max: 2` is ample — the cursor does one load at boot + a
 *  small periodic upsert per fold, never a hot query path. Re-resolves the admin URL on
 *  every use and rebinds if the endpoint moved (EI-19306394439939264).
 *
 *  The former `_resetPgMergeCursorPoolForTests` seam is gone with the module-level `let`
 *  it reset: it had zero callers in the tree, and the registry-wide
 *  `_resetLongLivedAdminPoolsForTests()` now covers the same need centrally. */
const sql = () => getLongLivedAdminPool('pg-merge-cursor-store', { max: 2, prepare: false });
type CursorSql = ReturnType<typeof sql>;
type CursorSqlProvider = () => CursorSql;

/**
 * WI-2105 — a `MergeCursorStore` scoped to one `(workspaceId, harnessSlug)`,
 * backed by `harness_shared.substrate_merge_cursor`. `load` returns keyHex →
 * position for a boot seed; `save` upserts the current positions (unconditional
 * last-write-wins — persist-after-apply already guarantees a persisted position
 * never points past a durably-applied op, and a truncated/forked log MUST be
 * able to write a LOWER position so the next boot re-folds it from there).
 *
 * SCOPE-STAMPED (EI-18773697830188393, migration 685): each row also records the
 * `apply_binding` — the pot-home projection scope (the federation demux key) the fold
 * ran under — and `load` returns ONLY rows matching the caller's current binding. A
 * position is a claim that the ops below it were APPLIED, but an op folded through the
 * wrong hive-home binding is demux-DROPPED while the cursor still advances past it
 * (WI-559: fed-b bound the shared hive to its local slug and discarded ~49.7k rows this
 * way). Making the stamp part of the row is what lets a CORRECTED binding self-heal on a
 * cold boot — stale progress simply does not load, so the fold restarts from 0 through
 * the right scope.
 *
 * UPGRADE COST (measured, not assumed — fed-b rig 2026-07-27): pre-migration rows carry
 * NULL, which matches only a NULL binding. A genuinely non-hive harness folds under NULL
 * and is unaffected, but EVERY hive-peered harness re-folds once — the JOINER *and* the
 * OWNER's home harness, because the binding is the whole
 * `hiveHomeProjectionSlug ?? ownPotHomeSlug ?? memberHomeRebindSlug` chain and
 * `ownPotHomeSlug` is non-null for an owner (only `joinerPotHomeSlug` is
 * remote_hive-gated). On a large log that one-shot re-fold is the very shape WI-2105
 * guards against, so it is deliberately made survivable rather than cheap: positions
 * persist INTRA-pass under the NEW stamp, so the re-fold is monotonic and a watchdog
 * restart resumes it instead of restarting it.
 */
export function createPgMergeCursorStore(
  workspaceId: string,
  harnessSlug: string,
  sqlProvider: CursorSqlProvider = sql,
): MergeCursorStore {
  return {
    async load(applyBinding: string | null): Promise<Map<string, number>> {
      // `IS NOT DISTINCT FROM` (not `=`) so a NULL binding — a non-hive harness, or a
      // hive OWNER, whose scope is genuinely "no pot-home" — matches the NULL stamp
      // instead of the `= NULL` three-valued miss that would silently re-fold every
      // such harness on every boot. The ::text cast pins the parameter type for the
      // NULL case (postgres cannot infer it from a bare NULL parameter).
      const rows = await sqlProvider()<{ log_keyhex: string; position: string | number }[]>`
        SELECT log_keyhex, position
        FROM harness_shared.substrate_merge_cursor
        WHERE workspace_id = ${workspaceId}
          AND harness_slug = ${harnessSlug}
          AND apply_binding IS NOT DISTINCT FROM ${applyBinding}::text
      `;
      const out = new Map<string, number>();
      for (const r of rows) out.set(r.log_keyhex, Number(r.position));
      return out;
    },
    async loadApplyFailures(applyBinding: string | null): Promise<Map<string, MergeApplyFailure>> {
      const rows = await sqlProvider()<{ log_keyhex: string; apply_failure: MergeApplyFailure }[]>`
        SELECT log_keyhex, apply_failure
        FROM harness_shared.substrate_merge_cursor
        WHERE workspace_id = ${workspaceId}
          AND harness_slug = ${harnessSlug}
          AND apply_binding IS NOT DISTINCT FROM ${applyBinding}::text
          AND apply_failure IS NOT NULL
      `;
      return new Map(rows.map((row) => [row.log_keyhex, row.apply_failure]));
    },
    async loadSnapshotMarks(applyBinding: string | null): Promise<Map<string, SnapshotApplyMark>> {
      // P-008 (migration 1206): the marks are trustworthy ONLY where their stamp equals
      // the row's current position. A save that did not carry marks (an older build, a
      // rolled-back build) moves `position` and leaves the stamp behind, and so does a
      // hand edit of `position`. Both then read as unstamped (owe the next set), never
      // as "skip".
      const rows = await sqlProvider()<
        { log_keyhex: string; snapshot_apply_through: string | number | null; snapshot_hole: string | number | null }[]
      >`
        SELECT log_keyhex, snapshot_apply_through, snapshot_hole
        FROM harness_shared.substrate_merge_cursor
        WHERE workspace_id = ${workspaceId}
          AND harness_slug = ${harnessSlug}
          AND apply_binding IS NOT DISTINCT FROM ${applyBinding}::text
          AND snapshot_mark_position = position
      `;
      const out = new Map<string, SnapshotApplyMark>();
      for (const r of rows) {
        out.set(r.log_keyhex, {
          applyThrough: r.snapshot_apply_through === null ? NO_SNAPSHOT_APPLY : Number(r.snapshot_apply_through),
          hole: r.snapshot_hole === null ? null : Number(r.snapshot_hole),
        });
      }
      return out;
    },
    async save(
      positions: ReadonlyMap<string, number>,
      applyBinding: string | null,
      applyFailures?: ReadonlyMap<string, MergeApplyFailure>,
      snapshotMarks?: ReadonlyMap<string, SnapshotApplyMark>,
    ): Promise<void> {
      if (positions.size === 0) return;
      const s = sqlProvider();
      const now = new Date();
      const values = [...positions].map(([log_keyhex, position]) => {
        // P-008: a log with no mark in a marks-carrying save gets a NULL stamp, so it
        // reads back as unstamped instead of inheriting a mark from a stale position.
        const mark = snapshotMarks?.get(log_keyhex);
        return {
          workspace_id: workspaceId,
          harness_slug: harnessSlug,
          log_keyhex,
          position,
          apply_binding: applyBinding,
          updated_at: now,
          ...(applyFailures ? { apply_failure: applyFailures.has(log_keyhex) ? s.json({ ...applyFailures.get(log_keyhex)! }) : null } : {}),
          ...(snapshotMarks
            ? {
                snapshot_apply_through: mark && mark.applyThrough > NO_SNAPSHOT_APPLY ? mark.applyThrough : null,
                snapshot_hole: mark ? mark.hole : null,
                snapshot_mark_position: mark ? position : null,
              }
            : {}),
        };
      });
      await s`
        INSERT INTO harness_shared.substrate_merge_cursor ${s(
          values,
          'workspace_id',
          'harness_slug',
          'log_keyhex',
          'position',
          'apply_binding',
          'updated_at',
          ...(applyFailures ? ['apply_failure' as const] : []),
          ...(snapshotMarks
            ? (['snapshot_apply_through', 'snapshot_hole', 'snapshot_mark_position'] as const)
            : []),
        )}
        ON CONFLICT (workspace_id, harness_slug, log_keyhex)
        DO UPDATE SET position = EXCLUDED.position,
                      -- Re-stamp on every write: after a rebind the fold re-runs under the
                      -- NEW scope, so the row must stop advertising the old one (otherwise
                      -- the healed progress would be discarded again on the next boot).
                      apply_binding = EXCLUDED.apply_binding,
                      ${applyFailures ? s`apply_failure = EXCLUDED.apply_failure,` : s``}
                      ${
                        snapshotMarks
                          ? s`snapshot_apply_through = EXCLUDED.snapshot_apply_through,
                              snapshot_hole = EXCLUDED.snapshot_hole,
                              snapshot_mark_position = EXCLUDED.snapshot_mark_position,`
                          : s``
                      }
                      updated_at = EXCLUDED.updated_at
      `;
    },
    peerLifecycle: {
      async load(): Promise<Map<string, MergeCursorPeerLifecycle>> {
        const rows = await sqlProvider()<
          {
            log_keyhex: string;
            peer_device_pubkey: string | null;
            peer_lifecycle_state: MergeCursorPeerLifecycleState;
            peer_lifecycle_updated_at: Date | string | null;
          }[]
        >`
          SELECT log_keyhex,
                 peer_device_pubkey,
                 peer_lifecycle_state,
                 peer_lifecycle_updated_at
          FROM harness_shared.substrate_merge_cursor
          WHERE workspace_id = ${workspaceId}
            AND harness_slug = ${harnessSlug}
        `;
        const out = new Map<string, MergeCursorPeerLifecycle>();
        for (const row of rows) {
          out.set(row.log_keyhex, {
            logKeyHex: row.log_keyhex,
            devicePubkey: row.peer_device_pubkey,
            state: row.peer_lifecycle_state,
            updatedAt: row.peer_lifecycle_updated_at === null ? null : new Date(row.peer_lifecycle_updated_at),
          });
        }
        return out;
      },
      async upsert(updates, applyBinding): Promise<void> {
        if (updates.length === 0) return;
        const s = sqlProvider();
        const now = new Date();
        const values = updates.map((update) => ({
          workspace_id: workspaceId,
          harness_slug: harnessSlug,
          log_keyhex: update.logKeyHex,
          // A lifecycle event can precede the first fold. Position 0 is the only
          // safe seed for a newly materialized row; conflict updates below never
          // touch an existing row's position or apply binding.
          position: 0,
          apply_binding: applyBinding,
          peer_device_pubkey: update.devicePubkey,
          peer_lifecycle_state: update.state,
          peer_lifecycle_updated_at: now,
          updated_at: now,
        }));
        await s`
          INSERT INTO harness_shared.substrate_merge_cursor ${s(
            values,
            'workspace_id',
            'harness_slug',
            'log_keyhex',
            'position',
            'apply_binding',
            'peer_device_pubkey',
            'peer_lifecycle_state',
            'peer_lifecycle_updated_at',
            'updated_at',
          )}
          ON CONFLICT (workspace_id, harness_slug, log_keyhex)
          DO UPDATE SET peer_device_pubkey = EXCLUDED.peer_device_pubkey,
                        peer_lifecycle_state = EXCLUDED.peer_lifecycle_state,
                        peer_lifecycle_updated_at = EXCLUDED.peer_lifecycle_updated_at
        `;
      },
    },
  };
}
