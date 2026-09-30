/**
 * backfill-local-state — Stage 4 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Stages 1-3 federate NEW feature/issue writes: the Stage-1 AFTER trigger
 * enqueues local-origin writes into `harness_shared.substrate_outbox`, and the
 * Stage-3 drain appends them to this device's own Hypercore log so peers'
 * read-side projections apply them. But rows that already EXISTED before
 * federation shipped never fired the capture trigger, so a later-joining peer
 * never sees them.
 *
 * `backfillLocalState` is the one-time catch-up: it enqueues every existing
 * LOCAL `*_consolidated` row for this (workspace, harness) into the outbox — the
 * SAME path a fresh write takes. It does NOT append to the log directly; the
 * drain owns the log (single writer, at-least-once, GC). After enqueueing, the
 * existing drain picks the rows up and federates them.
 *
 * IDEMPOTENT, PER-TARGET (WI-971 gap 2, 2026-07-17): each entry in
 * `BACKFILL_TARGETS` (+ the engineer_issues block) gets its OWN
 * `substrate_meta` marker keyed `backfill_done:<table>` — NOT one flat marker
 * for the whole function. This matters because `BACKFILL_TARGETS` grows over
 * time (pot_settings/pot_members landed well after the original 3 entries): a
 * flat marker meant a harness that already ran its one-time backfill BEFORE a
 * table was added (or before that table's capture trigger was even correct —
 * see mig 565) permanently skipped it forever, with no way to catch up short
 * of a manual `force` re-sweep of EVERYTHING. Per-target markers mean adding a
 * new target only backfills that target on the next boot, never re-touches
 * ones already done.
 *
 * LEGACY-MARKER MIGRATION: an already-backfilled harness has the OLD flat
 * `backfill_done` key and no per-table keys yet. On first per-target-aware
 * boot we treat that as "the targets that existed under the old scheme are
 * already done" — we stamp per-table markers for exactly those
 * (`LEGACY_MARKER_TABLES`) from the legacy marker's value, WITHOUT
 * re-enqueueing them. Only a target that is new relative to that legacy set
 * (nothing marked, nothing legacy-covers it) gets swept. This is a one-time,
 * idempotent, ON CONFLICT DO NOTHING write — never a blanket re-sweep.
 *
 * ENQUEUE BAIL CAP (WI-971 gap 2 condition (b), WI-5147): the live outbox can
 * be backlogged for reasons unrelated to this backfill (a wedged/slow drain).
 * Before enqueueing anything, we total the CANDIDATE row count across only the
 * currently-unswept targets; if that total exceeds `maxEnqueueBeforeBail`
 * (default ~1000 — generous for the small tables backfill covers today, but a
 * hard ceiling against ever silently dumping thousands of rows onto a
 * struggling drain), we log loudly and BAIL: nothing is enqueued, no per-table
 * marker is written for the unswept targets (so a *later* boot, once the
 * drain has caught up, retries them) — this is orthogonal to the existing
 * per-author cap-and-warn below (that one governs what a *peer* will ingest
 * from a log; this one governs what *this* boot dumps onto its own outbox).
 *
 * PER-AUTHOR CAP (user-approved cap-and-warn, plan open-question 2): a peer's
 * read-merge ingests at most `DEFAULT_MAX_OPS_PER_AUTHOR` (50k) ops from any one
 * author's log (read-merge.ts / boot.ts `MAX_OPS_PER_AUTHOR`). A backfill that
 * would push the own log past that cap is pointless beyond the cap (peers drop
 * the overflow anyway), so we enqueue up to the cap and `console.warn` a
 * `peer_capped`-style message naming how many rows were dropped. We do NOT chunk
 * (the cap is a hard ceiling per author, not a rate).
 *
 * NOT wired into boot here — Stage 5 calls this from boot-all.ts (best-effort,
 * before `startOutboxDrain`).
 */

import type postgres from 'postgres';
import type { BootedHarnessHandle } from './boot';
import { DEFAULT_MAX_OPS_PER_AUTHOR } from './read-merge';

/** The tables backfilled, paired with their key column (the outbox `key` ==
 *  feature_id / issue_id / …, mirroring the capture trigger) and an OPTIONAL scope
 *  column (the column matched against this harness's slug; default `harness_slug`).
 *  A Hive-scoped table whose scope column is `pot_home_slug` (not `harness_slug`)
 *  supplies it explicitly. */
const BACKFILL_TARGETS: ReadonlyArray<readonly [table: string, keyCol: string, scopeCol?: string]> = [
  ['harness_features_consolidated', 'feature_id'],
  ['harness_issues_consolidated', 'issue_id'],
  // plans-pg-canonical-migration-2026-06-03 (Stage 2): PG-canonical plans federate
  // as papercup-harness content (key == plan_slug). NB: the one-time `backfill_done`
  // marker is per-(workspace,harness), so on an install that ALREADY federated
  // features/issues the marker short-circuits and pre-existing plans are not
  // re-enqueued — only ongoing plan writes federate (via the capture trigger,
  // migration 125). Fresh installs backfill plans here. (Clearing the marker
  // re-examines all targets; since WI-2141185 that enqueues only rows with no
  // fed_ts — re-sending already-federated rows now requires `resyncFederated`.
  // It previously re-enqueued EVERYTHING, which is EI-12727's corestore ratchet:
  // each drained row is an append to an append-only log, so every forced cut grew
  // the seed by one whole projection and never shrank.)
  ['harness_plans', 'plan_slug'],
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings federate as Hive
  // state (key == setting_key), scoped to the Hive home harness slug.
  ['pot_settings', 'setting_key'],
  // shared-hive-federation-2026-06-08 (P-006): per-Hive admission records federate so
  // existing device-attestations + revocations reach a joining Swarm (not just
  // post-online writes via the mig-189 trigger). pot_members' scope column is
  // `pot_home_slug` (FK→pots; WI-3953 cup-lexicon rename, migration 557), and for
  // the Hive HOME harness harnessSlug == pot_home_slug, so the same (workspace,
  // slug) scoping holds — key == github_user_id (matches the trigger's TG_ARGV[0]
  // + the projection composeKey).
  ['pot_members', 'github_user_id', 'pot_home_slug'],
  // WI-971 gap 1 (2026-07-17): plan_item_assignments HAS a live capture trigger
  // (mig 145, generic capture_substrate_outbox('fed_key')) so post-trigger writes
  // federate fine — but it was simply never added here, so any row that predates
  // mig 145 (or predates this harness's first boot) was permanently stuck, never
  // reaching a later-joining peer. Key == fed_key (the generated `plan_slug:item_id`
  // column the capture trigger also uses); scope column defaults to harness_slug
  // (mig 140 DDL — this table is harness-scoped, not Hive-scoped).
  ['plan_item_assignments', 'fed_key'],
];

/** Legacy flat marker key (pre per-target tracking, WI-971 gap 2). Still
 *  written/read ONLY for the one-time migration below — the source of truth
 *  going forward is the per-table `backfill_done:<table>` keys. */
const BACKFILL_MARKER_KEY = 'backfill_done';

/** substrate_meta key PREFIX for the per-target marker (WI-971 gap 2). */
const BACKFILL_MARKER_KEY_PREFIX = 'backfill_done:';

const backfillMarkerKeyFor = (table: string): string => `${BACKFILL_MARKER_KEY_PREFIX}${table}`;

/**
 * The targets that were covered by the ORIGINAL flat `backfill_done` marker
 * before per-target tracking existed — i.e. every `BACKFILL_TARGETS` entry
 * that predates WI-971's plan_item_assignments addition, PLUS `engineer_issues`
 * (handled by its own code block below but gated by the SAME top-level marker
 * historically). Used only to migrate an existing flat marker into per-table
 * markers WITHOUT re-enqueueing any of them.
 */
const LEGACY_MARKER_TABLES: readonly string[] = [
  'harness_features_consolidated',
  'harness_issues_consolidated',
  'harness_plans',
  'pot_settings',
  'pot_members',
  'engineer_issues',
];

/** Default hard ceiling on candidate rows across unswept targets before a boot
 *  refuses to enqueue anything (WI-971 gap 2 condition (b) / WI-5147: don't pile
 *  more rows onto an already-backlogged outbox drain). */
const DEFAULT_ENQUEUE_BAIL_CAP = 1000;

export interface BackfillOptions {
  /**
   * Ignore the per-target `backfill_done:<table>` markers (and the legacy flat
   * one) and RE-EXAMINE every target. This is for explicit maintenance/release
   * refreshes (for example cutting a complete installer seed after historical
   * rows were missed by an older backfill). Runtime boot keeps the default
   * marker-guarded behavior.
   *
   * WI-2141185: re-examining a target is NOT re-enqueueing it. Rows already
   * federated are skipped regardless of this flag — see `resyncFederated`, which
   * is the only way to re-send them. Before that split, `force` bypassed the
   * marker while the enqueue SELECTs had no fed-state predicate, so the marker
   * WAS the sole idempotence guard and `force` meant "re-enqueue the whole
   * corpus". It also skips `markTargetDone` below, so nothing recorded the sweep
   * and every subsequent forced run repeated it in full.
   */
  force?: boolean;
  /**
   * Re-enqueue rows that are ALREADY federated (fed_ts present), not just the
   * ones this backfill exists to rescue. Default FALSE — and the default is
   * load-bearing, so do not set this to make a seed "more current".
   *
   * WI-2141185: this backfill's job is rows that predate the capture trigger and
   * so never fired it (see the plan_item_assignments note in BACKFILL_TARGETS).
   * That condition is `fed_ts IS NULL`. Until this option existed the enqueue
   * SELECTs never expressed it — they selected EVERY local row — and the only
   * thing preventing a re-enqueue was the per-target `backfill_done` marker.
   * `force` bypasses exactly that marker, so `force` silently meant "re-enqueue
   * the entire corpus": the nightly release seed cut (cut-seed-cli, force:true +
   * maxOpsPerAuthor:0) re-enqueued ~150k already-federated engineer_issues rows
   * EVERY night, then blocked waiting for the outbox drain it had just flooded.
   * Measured 2026-09-02: 153,797 in-scope rows, of which 0 were unfederated —
   * i.e. the whole sweep was waste.
   *
   * A federated row is already in the own log, so re-sending it changes no
   * content (LWW converges) and costs a full corpus re-drain. Keep this false
   * unless you are deliberately re-anchoring federation state.
   */
  resyncFederated?: boolean;
  /**
   * Hard ceiling on rows enqueued, aligned with the Model B per-author ingest
   * cap (a peer won't read beyond it anyway). Default `DEFAULT_MAX_OPS_PER_AUTHOR`
   * (50k) ops from any one author's log (read-merge.ts / boot.ts `MAX_OPS_PER_AUTHOR`).
   * A backfill that would push the own log past that cap is pointless beyond the
   * cap (peers drop the overflow anyway), so we enqueue up to the cap and
   * `console.warn` a `peer_capped`-style message naming how many were dropped.
   * Set 0 to disable the cap.
   */
  maxOpsPerAuthor?: number;
  /**
   * Hard ceiling on the TOTAL candidate row count across unswept targets before
   * this boot refuses to enqueue anything at all (WI-971 gap 2 condition (b)).
   * Distinct from `maxOpsPerAuthor` (a per-peer INGEST cap that still enqueues up
   * to the cap and warns) — this is a per-BOOT bail: above it, NOTHING is
   * enqueued and NO per-table marker is written for the unswept targets, so a
   * later boot (once the outbox drain has caught up) retries them instead of
   * flooding an already-backlogged queue further. Default 1000. Set 0 to disable.
   */
  maxEnqueueBeforeBail?: number;
  /** Clock override (epoch ms) for the enqueued `ts` + marker value. Tests
   *  inject a fixed value; production omits it (Date.now). */
  now?: number;
}

export interface BackfillResult {
  /** True when EVERY target's marker was already present and we did nothing. */
  skipped: boolean;
  /** Rows enqueued into the outbox this run (0 when skipped or bailed). */
  enqueued: number;
  /** Rows that existed but were NOT enqueued because they exceeded the per-author cap. */
  dropped: number;
  /** True when the enqueue-bail cap tripped — nothing was enqueued or marked
   *  done for the unswept targets; retry on a later boot. */
  bailed?: boolean;
  /** The candidate row total that tripped the bail cap (only set when `bailed`). */
  candidateTotal?: number;
}

/**
 * One-time enqueue of existing LOCAL `*_consolidated` rows into
 * `substrate_outbox` for this handle's (workspace, harness), per-target
 * idempotent via `substrate_meta` markers (`backfill_done:<table>`). Returns how
 * many rows were enqueued / dropped, `{ skipped: true }` if every target's
 * marker was already present, or `{ bailed: true }` if the candidate total
 * across unswept targets exceeded the enqueue cap (nothing done; retry later).
 */
export async function backfillLocalState(
  handle: BootedHarnessHandle,
  pg: postgres.Sql,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const { workspaceId, harnessSlug } = handle;

  const now = opts.now ?? Date.now();
  const cap =
    opts.maxOpsPerAuthor === undefined ? DEFAULT_MAX_OPS_PER_AUTHOR : opts.maxOpsPerAuthor;
  const bailCap =
    opts.maxEnqueueBeforeBail === undefined ? DEFAULT_ENQUEUE_BAIL_CAP : opts.maxEnqueueBeforeBail;
  // WI-2141185: candidates are rows this backfill must RESCUE — ones that never
  // fired the capture trigger, i.e. fed_ts IS NULL. Threaded into every count and
  // every enqueue below so the two can never disagree about what a candidate is
  // (a count that disagrees with its enqueue is how the bail cap guarded nothing).
  const resyncFederated = opts.resyncFederated === true;

  // ── Per-target marker read + legacy-flat-marker migration ────────────────
  // (skipped entirely under `force` — every target is treated as unswept).
  const doneTargets = new Set<string>();
  if (!opts.force) {
    const markerRows = await pg<{ key: string }[]>`
      SELECT key FROM harness_shared.substrate_meta
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harnessSlug}
         AND key LIKE ${BACKFILL_MARKER_KEY_PREFIX + '%'}`;
    for (const row of markerRows) {
      doneTargets.add(row.key.slice(BACKFILL_MARKER_KEY_PREFIX.length));
    }

    // No per-table markers yet — check for the LEGACY flat marker. If present,
    // this harness already ran a (pre-per-target) backfill: stamp per-table
    // markers for exactly the targets that existed under that old scheme,
    // WITHOUT re-enqueueing them. A genuinely NEW target (not in
    // LEGACY_MARKER_TABLES — e.g. plan_item_assignments) stays unmarked and
    // gets swept below, same as a target added going forward.
    if (doneTargets.size === 0) {
      const legacy = await pg<{ value: string }[]>`
        SELECT value FROM harness_shared.substrate_meta
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harnessSlug}
           AND key = ${BACKFILL_MARKER_KEY}
         LIMIT 1`;
      if (legacy.length > 0) {
        for (const table of LEGACY_MARKER_TABLES) {
          await pg`
            INSERT INTO harness_shared.substrate_meta (workspace_id, harness_slug, key, value)
            VALUES (${workspaceId}, ${harnessSlug}, ${backfillMarkerKeyFor(table)}, ${legacy[0].value})
            ON CONFLICT (workspace_id, harness_slug, key) DO NOTHING`;
          doneTargets.add(table);
        }
      }
    }
  }

  // ── Gather candidates for every unswept BACKFILL_TARGETS entry ───────────
  const candidates: Array<{
    tableName: string;
    keyCol: string;
    scopeCol: string;
    total: number;
  }> = [];
  for (const [tableName, keyCol, scopeColRaw] of BACKFILL_TARGETS) {
    if (!opts.force && doneTargets.has(tableName)) continue;
    const scopeCol = scopeColRaw ?? 'harness_slug';
    const [{ total }] = await pg<{ total: number }[]>`
      SELECT count(*)::int AS total
        FROM harness_shared.${pg(tableName)}
       WHERE workspace_id = ${workspaceId}
         AND ${pg(scopeCol)} = ${harnessSlug}
         AND COALESCE(origin, 'local') = 'local'
         AND (${resyncFederated}::bool OR fed_ts IS NULL)`;
    candidates.push({ tableName, keyCol, scopeCol, total });
  }

  // ── engineer_issues candidate count (fed-reanchor B5 — separate scope shape) ──
  // NB: the scope predicate is built INLINE at each use site (not hoisted into a
  // variable) — a nested `pg\`...\`` fragment's type isn't worth risking a
  // cross-branch type-widening mismatch for; `eiOperatorOwnedHere` (a plain
  // boolean) is all that needs to survive between the count query and the later
  // enqueue query.
  const eiUnswept = opts.force || !doneTargets.has('engineer_issues');
  const eiApplicable = Boolean(eiUnswept && workspaceId && workspaceId !== '*');
  let eiTotal = 0;
  let eiOperatorOwnedHere = false;
  if (eiApplicable) {
    const [{ home }] = await pg<{ home: string | null }[]>`
      SELECT CASE WHEN count(*) = 1 THEN min(pot_home_slug) ELSE NULL END AS home
        FROM harness_shared.pots WHERE workspace_id = ${workspaceId}`;
    eiOperatorOwnedHere = home != null && home === harnessSlug;

    const [{ total }] = eiOperatorOwnedHere
      ? await pg<{ total: number }[]>`
          SELECT count(*)::int AS total
            FROM harness_shared.engineer_issues c
           WHERE c.workspace_id = ${workspaceId}
             AND COALESCE(c.origin, 'local') = 'local'
             AND (c.scope = ${'harness:' + harnessSlug} OR c.scope = 'operator')
             AND (${resyncFederated}::bool OR c.fed_ts IS NULL)`
      : await pg<{ total: number }[]>`
          SELECT count(*)::int AS total
            FROM harness_shared.engineer_issues c
           WHERE c.workspace_id = ${workspaceId}
             AND COALESCE(c.origin, 'local') = 'local'
             AND c.scope = ${'harness:' + harnessSlug}
             AND (${resyncFederated}::bool OR c.fed_ts IS NULL)`;
    eiTotal = total;
  }

  // ── Enqueue bail cap (WI-971 gap 2 condition (b) / WI-5147) ──────────────
  // Total the CANDIDATE rows across only the unswept targets; above the cap,
  // enqueue NOTHING and mark NOTHING done — a later boot (once the outbox
  // drain has caught up) retries. Skipped entirely under `force` (an explicit
  // maintenance action already accepts the re-sweep cost).
  const candidateTotal = candidates.reduce((sum, c) => sum + c.total, 0) + eiTotal;
  if (!opts.force && bailCap > 0 && candidateTotal > bailCap) {

    console.error(
      `[backfill-local-state] BAIL: ${workspaceId}::${harnessSlug} would enqueue ` +
        `${candidateTotal} row(s) across unswept target(s) (cap ${bailCap}) — refusing ` +
        `to add load to a possibly-backlogged outbox drain (WI-5147). Nothing enqueued, ` +
        `no target marked done — retry on a later boot once the drain has caught up.`,
    );
    return { skipped: false, enqueued: 0, dropped: 0, bailed: true, candidateTotal };
  }

  // cap <= 0 means "no cap" — treat as Infinity for the per-author budget math.
  let budget = cap > 0 ? cap : Number.POSITIVE_INFINITY;

  let enqueued = 0;
  let dropped = 0;
  const anyTargetsConsidered = candidates.length > 0 || eiApplicable;

  for (const { tableName, keyCol, scopeCol, total } of candidates) {
    if (total === 0) {
      if (!opts.force) await markTargetDone(pg, workspaceId, harnessSlug, tableName, now);
      continue;
    }

    const take = budget === Number.POSITIVE_INFINITY ? total : Math.min(total, budget);
    dropped += total - take;

    if (take > 0) {
      // INSERT-to-outbox (NOT a direct log append — the drain owns the log).
      // Mirror exactly what the capture trigger produces: op='put',
      // key=<keyCol>, row=to_jsonb(row), ts, op_hlc, drained_at NULL. ORDER BY
      // the PK for a deterministic which-rows-kept under the cap.
      //
      // D-001 / mig 446 symmetry (THE convergence fix): a stamp-regime row
      // (fed_hlc present ⇒ the mig-314 BEFORE trigger stamped fed_ts atomically
      // with it) must thread its OWN fed_ts/fed_hlc onto the wire op, so the
      // author and every receiver persist the SAME LWW ordering key
      // (fed_order_key(fed_hlc, fed_ts)). The projection persists op.ts as the
      // receiver's fed_ts and op_hlc as its fed_hlc — so re-stamping the wire ts
      // with boot-time ${now} (the pre-fix bug) inflated fed_ts by the
      // boot-minus-write delta, letting a STALE backfilled row (e.g. a joiner's
      // never-touched `todo`) beat a genuinely-newer one (the owner's `passed`)
      // under LWW and clobber it both ways. Unstamped rows (fed_hlc NULL) keep
      // ${now} — the drain's stampOpHlc mints a fallback HLC, matching mig 446.
      const inserted = await pg<{ key: string }[]>`
        INSERT INTO harness_shared.substrate_outbox
          (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc, drained_at)
        SELECT
          ${workspaceId}, ${harnessSlug}, ${tableName}, 'put',
          c.${pg(keyCol)}::text, to_jsonb(c),
          CASE WHEN c.fed_hlc IS NOT NULL THEN COALESCE(c.fed_ts, ${now}) ELSE ${now} END,
          c.fed_hlc, NULL
          FROM harness_shared.${pg(tableName)} c
         WHERE c.workspace_id = ${workspaceId}
           AND c.${pg(scopeCol)} = ${harnessSlug}
           AND COALESCE(c.origin, 'local') = 'local'
           AND (${resyncFederated}::bool OR c.fed_ts IS NULL)
         ORDER BY c.${pg(scopeCol)}, c.${pg(keyCol)}
         LIMIT ${take}
        RETURNING key`;
      enqueued += inserted.length;
      if (budget !== Number.POSITIVE_INFINITY) budget -= inserted.length;
    }

    if (!opts.force) await markTargetDone(pg, workspaceId, harnessSlug, tableName, now);
  }

  // engineer_issues (fed-reanchor B5) — the work-queue's issue/task family. Its
  // federation scope lives in the `scope` column ('harness:<slug>' | 'operator'), not a
  // bare slug column, so the generic scopeCol-equality target above can't express it.
  // Mirror the mig-197 capture derivation: enqueue local rows scoped to THIS harness
  // (scope = 'harness:<harnessSlug>'), PLUS operator-scope rows iff this harness is the
  // workspace's single Hive home (the canonical "operator coordination rides the
  // kind:'hive' home"). Stamp harness_slug into the row jsonb for the projection demux.
  if (eiApplicable) {
    if (eiTotal > 0) {
      const take = budget === Number.POSITIVE_INFINITY ? eiTotal : Math.min(eiTotal, budget);
      dropped += eiTotal - take;
      if (take > 0) {
        const inserted = eiOperatorOwnedHere
          ? await pg<{ key: string }[]>`
              INSERT INTO harness_shared.substrate_outbox
                (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc, drained_at)
              SELECT
                ${workspaceId}, ${harnessSlug}, 'engineer_issues', 'put',
                c.issue_id::text,
                to_jsonb(c) || jsonb_build_object('harness_slug', ${harnessSlug}::text),
                CASE WHEN c.fed_hlc IS NOT NULL THEN COALESCE(c.fed_ts, ${now}) ELSE ${now} END,
                c.fed_hlc, NULL
                FROM harness_shared.engineer_issues c
               WHERE c.workspace_id = ${workspaceId}
                 AND COALESCE(c.origin, 'local') = 'local'
                 AND (c.scope = ${'harness:' + harnessSlug} OR c.scope = 'operator')
                 AND (${resyncFederated}::bool OR c.fed_ts IS NULL)
               ORDER BY c.issue_id
               LIMIT ${take}
              RETURNING key`
          : await pg<{ key: string }[]>`
              INSERT INTO harness_shared.substrate_outbox
                (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc, drained_at)
              SELECT
                ${workspaceId}, ${harnessSlug}, 'engineer_issues', 'put',
                c.issue_id::text,
                to_jsonb(c) || jsonb_build_object('harness_slug', ${harnessSlug}::text),
                -- mig 446 symmetry (see the features INSERT above): thread the row's
                -- own fed_ts/fed_hlc so backfilled issues carry their genuine LWW key
                -- instead of a boot-time re-stamp that would clobber newer peers.
                CASE WHEN c.fed_hlc IS NOT NULL THEN COALESCE(c.fed_ts, ${now}) ELSE ${now} END,
                c.fed_hlc, NULL
                FROM harness_shared.engineer_issues c
               WHERE c.workspace_id = ${workspaceId}
                 AND COALESCE(c.origin, 'local') = 'local'
                 AND c.scope = ${'harness:' + harnessSlug}
                 AND (${resyncFederated}::bool OR c.fed_ts IS NULL)
               ORDER BY c.issue_id
               LIMIT ${take}
              RETURNING key`;
        enqueued += inserted.length;
        if (budget !== Number.POSITIVE_INFINITY) budget -= inserted.length;
      }
    }
    if (!opts.force) await markTargetDone(pg, workspaceId, harnessSlug, 'engineer_issues', now);
  }

  // Cap-and-warn: a peer's read-merge drops anything past the per-author cap, so
  // warn (rather than chunk) when we couldn't enqueue everything.
  if (dropped > 0) {

    console.warn(
      `[backfill-local-state] peer_capped: ${workspaceId}::${harnessSlug} backfill ` +
        `exceeded the per-author cap (${cap}); enqueued ${enqueued}, DROPPED ${dropped} ` +
        `local row(s) — peers would not ingest them beyond the cap anyway.`,
    );
  }

  // `skipped` is true only when there was NOTHING left to consider this run
  // (every target's marker was already present before we started).
  const skipped = !opts.force && !anyTargetsConsidered;
  return { skipped, enqueued, dropped: skipped ? 0 : dropped };
}

/** Write (or refresh) one target's per-table marker. ON CONFLICT keeps it
 *  idempotent if two boots race (the marker-check above already short-circuits
 *  the common case). */
async function markTargetDone(
  pg: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  tableName: string,
  now: number,
): Promise<void> {
  await pg`
    INSERT INTO harness_shared.substrate_meta (workspace_id, harness_slug, key, value)
    VALUES (${workspaceId}, ${harnessSlug}, ${backfillMarkerKeyFor(tableName)}, ${String(now)})
    ON CONFLICT (workspace_id, harness_slug, key) DO NOTHING`;
}
