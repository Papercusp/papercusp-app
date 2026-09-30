/**
 * composition-rig.ts — the hermetic 2-swarm COMPOSITION rig for
 * `shared-hive-loop-e2e-testing-2026-06-10` Phase 1 (P-001..P-007).
 *
 * Two Swarm cells of ONE shared Hive run in one process, each with its OWN
 * Postgres database and its OWN Hypercore log, composed exactly as production
 * composes them (plan D-001 — test the loop as a system, never a layer alone):
 *
 *   steering   — a SCRIPTED Mug turn reads the federated backlog from its
 *                cell's PG and steers with the REAL `setWorkItemPriority`
 *                (`feature_order`, the column claim_next orders by);
 *   dispatch   — the REAL `claimNextWorkItem` (SKIP LOCKED, priority-ordered,
 *                affinity/redundancy-aware: the flags-ON shape, D-003) runs
 *                against each cell's own PG via the `cell-scope` ALS seam,
 *                then the per-Hive AUTHORITY lease is acquired through the
 *                REAL `routeToAuthorityForHive` + `HttpPeerRpcTransport` over
 *                loopback (authority = argmin pubkey = cell A), exactly the
 *                claim-agent / two-instance shape;
 *   execution  — a FAKE pipeline (zero LLM) stands in for the DBOS
 *                featurePipelineWorkflow: per-cell idempotency keyed on the
 *                real workflow-id shape (`pipeline:<slug>:<item>:e<epoch>`),
 *                an EXTERNAL side-effect ledger row (the stand-in for git
 *                commits/spawns — deliberately NOT federated), and status
 *                writes on the cell's own PG. The DBOS durability axis itself
 *                is hive-loop-e2e's lane (D-006) — inherited, not re-tested;
 *   convergence— the REAL CDC chain end to end: migration-102 capture trigger
 *                → substrate_outbox → `drainOutboxOnce` → own Hypercore log →
 *                real Hyperswarm replication (local testnet DHT) → peer
 *                read-merge → the REAL PG projections (EI-117 skipOwnOps +
 *                LWW-guard shape) + the migration-214 local-stamp trigger;
 *   redundancy — the work_item_replicas store (migration 195) on the
 *                authority's PG for the BOINC fan-out scenarios (P-007).
 *
 * Claim-store persistence note: each cell's Hive-lease store is the
 * `InMemoryWorkItemClaimStore` (the documented coordinator seam — semantics
 * proven identical to the SQL store by work-item-claim-mem-store tests; the
 * SQL store's authority-fronted serialization is proven on real PG by
 * work-item-claims-two-instance). The local SKIP-LOCKED claim layer
 * (`taken_by`) runs on REAL per-cell PG here, so the lease axis loses no
 * coverage while the rig keeps an injectable clock — which is what lets the
 * lease-expiry (P-004) and authority-staleness (P-003) windows compress from
 * hours/90s to milliseconds.
 *
 * Chaos knobs: `killAuthority()` (HTTP endpoint dies; presence freezes so the
 * staleness window — compressed via `staleMs` — drives re-election),
 * `setPartitioned(true)` (authority RPC becomes unreachable → fail-open local
 * leases; heal + `converge()` + `reconcileAll` resolves), `advanceClock(ms)`
 * (lease expiry / staleness, without wall-clock sleeps).
 *
 * Test-file wiring (required once per test file — vi.mock hoists per-file):
 *
 *   vi.mock('@papercusp/db-org', async () => {
 *     const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
 *     const { currentCellSql } = await import('./cell-scope');
 *     return {
 *       ...actual,
 *       getOrgPg: () => {
 *         const sql = currentCellSql();
 *         if (!sql) throw new Error('getOrgPg outside cell scope — wrap in rig.runAsCell()');
 *         return { sql };
 *       },
 *     };
 *   });
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../sync/hyperbee/boot';
import { type HyperswarmLike } from '../sync/hyperbee/swarm';
import type { OpEnvelope } from '../sync/hyperbee/op-envelope-types';
import { _resetBootHistoryForTests } from '../sync/hyperbee/boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../sync/hyperbee/corestore';
import { drainOutboxOnce } from '../sync/hyperbee/outbox-drain';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../sync/hyperbee/projection';
import { buildHarnessFeaturesProjection } from '../sync/hyperbee/projections/harness-features';
import { buildIssuesProjection } from '../sync/hyperbee/projections/issues';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
import { ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import {
  WORK_ITEM_CLAIM_OP_KINDS,
  type AcquireOpts,
  type AcquireResult,
  type WorkItemClaim,
} from '../work-item-claims';
import { InMemoryWorkItemClaimStore } from '../work-item-claim-mem-store';
import { HlcClock } from '@papercusp/locks-core';
import { registerWorkItemClaimAuthorityOps } from '../work-item-claim-authority-ops';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../authority/authority-op-registry';
import {
  routeToAuthorityForHive,
  lockAuthorityForHive,
  type LockAuthorityDeps,
} from '../authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../authority/http-peer-rpc-transport';
import { __resetRemotePeersCacheForTests } from '../authority/remote-peers-cache';
import {
  claimNextWorkItem,
  releaseWorkItem,
  setWorkItemPriority,
  setWorkItemSwarmAffinity,
  type WorkItem,
} from '../work-items';
import { runWithCellSql } from './cell-scope';
import type { BacklogRow, SideEffectRow } from './composition-oracles';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib/shared-hive-loop → packages/operator-core → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Identity / swarm helpers (mirror feature-content-federation Stage 6) ─────

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

/** Cluster-global framework roles the migration GRANTs reference (idempotent). */
const FRAMEWORK_ROLES_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
      CREATE ROLE harness_app LOGIN PASSWORD 'harness_app_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
      CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
      CREATE ROLE harness_zero LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd';
    END IF;
  END $pg$;
`;

/**
 * Build the minimal-but-faithful schema in one cell's DB: the consolidated
 * feature/issue tables with the FULL dispatch column set (item_kind,
 * feature_order, swarm_affinity, assignee_rank — migrations 136/178; redundancy
 * arrives via 195 verbatim), then the REAL migration files verbatim for every
 * load-bearing trigger/table: 102 (outbox + capture), 103 (workspace fill),
 * 188 (work_item_claims), 195 (redundancy replicas), 214's local-stamp
 * function (attached to the two tables present here), and the 181-shape
 * fed_ts-masked UPDATE capture guards. Mirrors (and extends) the proven
 * Stage-6 federation-test schema.
 */
async function setupCellSchema(sql: postgres.Sql, opts: { workspaceId: string; harnessSlug: string }): Promise<void> {
  await sql.unsafe(FRAMEWORK_ROLES_DDL);
  // Await-event notify delivery persists through the canonical coord log even
  // in rigs that do not opt into the full coord federation helper. Reuse the
  // production bootstrap so appendLine sees the real fresh-database shape.
  await ensureCoordEventLogTable(sql);

  await sql.unsafe(`
    -- hive-epoch-boot-deps (2026-08-27): bootHarnessSubstrate now reads this table
    -- on EVERY boot (buildHiveRekeyBootDeps → potHomeSlugForHarness →
    -- loadHarnessRegistry → readOperatorState('harness_registry')), even for a
    -- non-hive harness — an empty registry correctly resolves "not a hive" (no
    -- rekey deps) with no row required, but the TABLE itself must exist or the
    -- read throws and boot fails closed (EI-18815759786278298).
    CREATE TABLE harness_shared.harness_registry (
      workspace_id text NOT NULL,
      payload      jsonb NOT NULL,
      updated_at   bigint DEFAULT 0 NOT NULL
    );

    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id        TEXT NOT NULL DEFAULT '',
      harness_slug        TEXT NOT NULL,
      feature_id          TEXT NOT NULL,
      title               TEXT,
      summary             TEXT,
      status              TEXT,
      attempts            INT,
      claims              TEXT,
      notes               TEXT,
      metadata            JSONB,
      kind                TEXT,
      project_id          TEXT,
      expected_cost_cents INT,
      tags                JSONB,
      needs_human_review  BOOLEAN,
      ts                  BIGINT,
      created_ts          BIGINT,
      updated_ts          BIGINT,
      parent_id           TEXT,
      goal_id             TEXT,
      taken_by            TEXT,
      taken_at            TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      author_pubkey       TEXT,
      origin              TEXT NOT NULL DEFAULT 'local',
      -- G2 admission gate columns the claim/place paths reference via
      -- autoPickableWhereSql (audit_verdict: P-005; verified_author_github_user_id:
      -- the P-008/P-010 trust leg, read whenever a workspaceId is passed).
      audit_verdict       TEXT,
      verified_author_github_user_id BIGINT,
      fed_ts              BIGINT,
      fed_hlc             TEXT,
      -- migration 136: the work-item family discriminator claim_next filters on
      item_kind           TEXT NOT NULL DEFAULT 'feature',
      -- migration 136-era payload column FEATURE_COLS returns
      payload             JSONB,
      -- decentralized-dispatch (D-003/D-009): the Mug's backlog steering column
      feature_order       INT,
      -- hive-coordination-model P-002: the Mug's co-location lever
      swarm_affinity      TEXT,
      -- migration 178: the per-assignee post-claim queue rank
      assignee_rank       INT,
      rank_writer         TEXT,
      rank_updated_at     TIMESTAMPTZ,
      -- migration 307 (work-queue-stuck-item-recovery D-007): the durable
      -- stale-reclaim requeue counter setWorkItemState resets on a terminal
      -- transition. Without it the real setWorkItemState UPDATE errors with a
      -- missing-column (requeue_count) failure.
      requeue_count       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (harness_slug, feature_id)
    );
    -- G2 trust leg (P-010): the claim/place paths' autoPickableWhereSql(sql, ws)
    -- consult this table; the real claimNextWorkItem the rig drives needs it.
    CREATE TABLE harness_shared.user_trust_list (
      workspace_id text NOT NULL,
      trusted_github_user_id bigint NOT NULL,
      note text,
      created_ts bigint NOT NULL,
      PRIMARY KEY (workspace_id, trusted_github_user_id)
    );
    -- P-008 producer side: the harness-features projection resolves a REMOTE
    -- row's author_pubkey → verified_author_github_user_id via a verified,
    -- non-revoked hive_members device attestation (resolveVerifiedAuthorGithubId).
    -- Only the columns that resolver reads (the real table has more); seedTrust()
    -- attests each peer cell so cross-swarm federated work is trust-admissible.
    CREATE TABLE harness_shared.pot_members (
      workspace_id        text NOT NULL,
      pot_home_slug      text,
      github_user_id      bigint,
      binding_status      text,
      device_attestations jsonb,
      revoked_pubkeys     text[],
      author_pubkey       text,
      origin              text NOT NULL DEFAULT 'local',
      fed_ts              bigint,
      fed_hlc             text,
      PRIMARY KEY (workspace_id, github_user_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      harness_slug      TEXT NOT NULL,
      issue_id          TEXT NOT NULL,
      title             TEXT NOT NULL,
      severity          TEXT NOT NULL,
      source            TEXT NOT NULL,
      status            TEXT NOT NULL,
      found_at          TIMESTAMPTZ NOT NULL,
      found_during      TEXT,
      repro             TEXT,
      evidence          TEXT,
      suggested_fix     TEXT,
      code_pointer      TEXT,
      linked_feature_id TEXT,
      attempts          INT NOT NULL DEFAULT 0,
      notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_ts        BIGINT NOT NULL,
      updated_ts        BIGINT NOT NULL,
      author_pubkey     TEXT,
      origin            TEXT NOT NULL DEFAULT 'local',
      fed_ts            BIGINT,
      fed_hlc           TEXT,
      PRIMARY KEY (harness_slug, issue_id)
    );
    CREATE TABLE harness_shared.projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      slug         TEXT,
      workspace_id TEXT,
      created_ts   BIGINT NOT NULL,
      updated_ts   BIGINT NOT NULL
    );
    -- The rig's EXTERNAL side-effect ledger: the stand-in for the duplicable,
    -- non-federated actions a real pipeline performs (git commits, spawns).
    -- Deliberately NO capture trigger — it must NOT converge across cells.
    CREATE TABLE harness_shared.rig_side_effects (
      work_item_id   TEXT NOT NULL,
      executed_by    TEXT NOT NULL,
      executed_at_ms BIGINT NOT NULL,
      note           TEXT
    );
    -- work-item-deps-and-readiness-2026-06-22 P-005 (F1 fix): the REAL claimNextWorkItem
    -- the rig drives now RESPECTS blocking — its readiness AND-clause reads work_item_deps
    -- (dep_type='blocks'), so the table must exist or the claim SELECT errors. (migration 367.)
    CREATE TABLE harness_shared.work_item_deps (
      id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id  TEXT        NOT NULL DEFAULT 'default',
      blocked_kind  TEXT        NOT NULL,
      blocked_ref   TEXT        NOT NULL,
      blocker_kind  TEXT        NOT NULL,
      blocker_ref   TEXT        NOT NULL,
      dep_type      TEXT        NOT NULL DEFAULT 'blocks',
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- EI-20723522274831539: the holder-LIVENESS tables. sweepOrphanedTakenBy now
    -- embeds work-items-stale-claims.ts's live/parked holder fragments (a claim is
    -- reclaimable only if its holder is neither live nor briefly-parked), and those
    -- fragments read coord_presence + spawned_agents + agent_activity. Same rationale
    -- as datatype_registry/harness_plans below: the subqueries just need to RUN —
    -- EMPTY is the correct rig state, because the P-003 case this rig exercises is a
    -- dead peer SWARM that never had a local presence row, so an empty presence set
    -- means "holder not live here" and the sweep reclaims exactly as designed. Without
    -- the tables every sweep SELECT errors 42P01 (undefined_table), which is how
    -- fleet-monitors + revoked-swarm went red on the fix's first run.
    -- FULL real column sets (generated from live information_schema, types verbatim)
    -- per the schema-COMPLETENESS discipline below: a fixture column costs nothing,
    -- the rig asserts on none of these values, and completing them here is what stops
    -- the next liveness-fragment column from restarting the layered-42703 cycle.
    CREATE TABLE harness_shared.coord_presence (
      owner_id             TEXT PRIMARY KEY,
      owner_label          TEXT,
      workspace_id         TEXT,
      source               TEXT,
      intent               TEXT,
      current_plan_slug    TEXT,
      current_files        JSONB,
      host                 TEXT,
      pid                  INTEGER,
      started_at           TIMESTAMPTZ,
      heartbeat_at         TIMESTAMPTZ,
      last_active_at       TIMESTAMPTZ,
      agent_role           TEXT,
      fleet_slug           TEXT,
      fleet_role           TEXT,
      compaction_limit     INTEGER,
      context_tokens       INTEGER,
      context_estimated_at TIMESTAMPTZ,
      pot_slug             TEXT,
      intent_declared_at   TIMESTAMPTZ,
      capability_tags      JSONB,
      tty                  TEXT
    );
    CREATE TABLE harness_shared.spawned_agents (
      spawn_id             TEXT PRIMARY KEY,
      workspace_id         TEXT,
      harness_slug         TEXT,
      parent_spawn_id      TEXT,
      parent_role          TEXT,
      child_role           TEXT,
      feature_id           TEXT,
      chunk_id             TEXT,
      run_id               TEXT,
      status               TEXT NOT NULL DEFAULT 'running',
      started_at           TIMESTAMPTZ,
      finished_at          TIMESTAMPTZ,
      duration_ms          BIGINT,
      exit_code            INTEGER,
      output_tail          TEXT,
      error_message        TEXT,
      cancel_requested     BOOLEAN,
      session_owner        TEXT,
      coordination_domain  TEXT,
      plan_slug            TEXT,
      item_id              TEXT,
      restart_strategy     TEXT,
      restart_count        INTEGER,
      restart_window_start TIMESTAMPTZ,
      cancel_reason        TEXT,
      cancelled_at         TIMESTAMPTZ,
      heartbeat_at         TIMESTAMPTZ,
      session_id           TEXT,
      idempotency_key      TEXT,
      pid                  INTEGER,
      launcher_host        TEXT,
      model_spec           TEXT,
      model_tier           TEXT,
      brief                TEXT,
      last_output_at       TIMESTAMPTZ,
      launcher_boot_id     TEXT,
      fleet_slug           TEXT,
      result_path          TEXT
    );
    CREATE TABLE harness_shared.agent_activity (
      id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id TEXT,
      owner_id     TEXT        NOT NULL,
      agent        TEXT,
      session_id   TEXT,
      harness_slug TEXT,
      kind         TEXT,
      tool_name    TEXT,
      phase        TEXT,
      tool_use_id  TEXT,
      summary      TEXT,
      status       TEXT,
      detail       JSONB,
      cwd          TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- WI-1644: reflexive-platform-extensibility-datatypes (migration 421) — the REAL
    -- claimFloorsWhereSql the rig drives ANDs in frontierPlacementKindClause, which
    -- subqueries this table (opted-in generic-kind datatypes' work_item_kind) so a
    -- built-in-only frontier (the rig's whole test surface) can stay DARK — the
    -- subquery just needs to run, not match anything. Minimal columns only (no
    -- vector/embedding/title_tsv — the rig never dedups or searches datatypes).
    CREATE TABLE harness_shared.datatype_registry (
      workspace_id   TEXT NOT NULL,
      id             TEXT NOT NULL,
      tier           TEXT NOT NULL DEFAULT 'generic-kind',
      work_item_kind TEXT,
      status         TEXT NOT NULL DEFAULT 'active',
      tags           TEXT[] NOT NULL DEFAULT '{}',
      PRIMARY KEY (workspace_id, id)
    );
    -- WI-2118 reserved-plan-lane floor: the REAL claim paths the rig drives now AND in
    -- reservedPlanLaneExclusionSql, whose EXISTS subqueries read harness_plans (plan_slug,
    -- status) + plan_item_claims (plan_slug, item_id, owner, expires_ts). Same rationale as
    -- datatype_registry above: the subqueries just need to RUN (empty ⇒ no exclusion), or
    -- every claim/diagnose SELECT errors with 42P01 (undefined_table) — which is exactly how
    -- fleet-monitors / composition-chaos went red on the 2026-07-05 green gate. Prod-faithful
    -- key columns (test-friendly DEFAULTs), matching migration 141 / the live harness_plans
    -- key, so a test layering the real DDL in either order composes instead of colliding.
    CREATE TABLE harness_shared.harness_plans (
      workspace_id TEXT NOT NULL DEFAULT 'default',
      harness_slug TEXT NOT NULL DEFAULT 'papercup',
      plan_slug    TEXT NOT NULL,
      status       TEXT,
      -- NOTE: this table is completed to the FULL real column set by the
      -- schema-completeness block below (EI-20099366410545026) — the key
      -- columns stay here so the composition/collision rationale above still
      -- reads as one piece.
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_item_claims (
      workspace_id     TEXT NOT NULL DEFAULT 'default',
      harness_slug     TEXT NOT NULL DEFAULT 'papercup',
      plan_slug        TEXT NOT NULL,
      item_id          TEXT NOT NULL,
      claim_id         UUID DEFAULT gen_random_uuid() NOT NULL,
      owner            TEXT NOT NULL,
      owner_label      TEXT,
      owner_name       TEXT,
      intent           TEXT DEFAULT '' NOT NULL,
      liveness_mode    TEXT DEFAULT 'availability' NOT NULL,
      ttl_sec          INTEGER DEFAULT 1200 NOT NULL,
      acquired_ts      TIMESTAMPTZ DEFAULT clock_timestamp() NOT NULL,
      expires_ts       TIMESTAMPTZ NOT NULL,
      last_activity_ts TIMESTAMPTZ DEFAULT clock_timestamp() NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
    );
    -- The watchdog recovery-window floor is unconditional in the claim SQL.
    -- Keep the minimal read shape here: the rig does not exercise the watchdog
    -- writer, but claim attempts must be able to observe an empty tick history.
    CREATE TABLE harness_shared.watchdog_ticks (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      tick_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'ran',
      known_open_keys text[]
    );
  `);

  // WI-1644: the writeToPg projection (harness-features.ts) INSERTs a wider
  // column set than this schema's original CREATE TABLE carried — columns
  // migrations 357 (last_progress_at) and the design/source-plan/wave/
  // completion-ref set (000-baseline's harness_features_consolidated shape,
  // predating this rig's slice point) added. Condensed here the same way the
  // engineer_issues ALTER block below condenses 136/142/152/178 — the rig
  // never asserts on these columns' behavior, they only need to EXIST so the
  // real projection's INSERT/UPDATE column list doesn't 42703 (undefined_column).
  await sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
      ADD COLUMN IF NOT EXISTS deprecation_reason text,
      ADD COLUMN IF NOT EXISTS see_also text[] DEFAULT '{}'::text[] NOT NULL,
      ADD COLUMN IF NOT EXISTS needs_design boolean DEFAULT false NOT NULL,
      ADD COLUMN IF NOT EXISTS design_status text,
      ADD COLUMN IF NOT EXISTS design_spec_id text,
      ADD COLUMN IF NOT EXISTS discarded_design_work boolean DEFAULT false NOT NULL,
      ADD COLUMN IF NOT EXISTS completion_ref jsonb,
      ADD COLUMN IF NOT EXISTS source_plan_slug text,
      ADD COLUMN IF NOT EXISTS source_plan_item_ids text[],
      ADD COLUMN IF NOT EXISTS wave text,
      -- migration 432 (work-item-completion-integrity): FEATURE_COLS' RETURNING
      -- list (claimFeatureRow) selects these — a genuine-completion evidence pair.
      ADD COLUMN IF NOT EXISTS terminal_owner text,
      ADD COLUMN IF NOT EXISTS terminal_completion_ref text,
      -- migration 485 (fleet-scheduler-hardening-2026-07-03 P-005, EI-6956):
      -- releaseWorkItem's UPDATE sets last_released_by/_at on the row it frees,
      -- and claimFeatureRow's floors read them for the release-cooldown window —
      -- both hit "column does not exist" without these (EI-6887 drift, caught by
      -- composition-rig-schema-drift.integration.test.ts / EI-6794).
      ADD COLUMN IF NOT EXISTS last_released_by text,
      ADD COLUMN IF NOT EXISTS last_released_at timestamptz;
  `);

  // Map the harness slug → the workspace_id the booted handle drains on (the
  // migration-103 fill trigger stamps it on projection inserts).
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-shl', 'SharedPotLoop', 'active', ${opts.harnessSlug}, ${opts.workspaceId}, 0, 0)
  `;

  // The REAL migration files, verbatim — minus psql meta-commands (`\set …`)
  // and the standalone BEGIN;/COMMIT; wrappers, both of which the embedded-pg
  // migration runner handles and raw pooled sql.unsafe rejects. (plpgsql BEGIN
  // bodies are indented/inline — the line-anchored match never touches them.)
  for (const file of [
    // Empty coordination/Pot relations are still required: the awaited-event
    // subscriber lookup and fail-soft federation-scope resolver must return an
    // empty result, not emit a 42P01 warning that vitest treats as a failure.
    '123-coordination-substrate.sql',
    'archive/102-substrate-outbox.sql',
    'archive/103-issues-workspace-id-fill-trigger.sql',
    '131-engineer-issues.sql',
    // Event-await registrations and durable wake deliveries used by awaited
    // emits on releaseWorkItem (migration 163).
    '163-await-event-subscriptions.sql',
    // Event-await schema follow-ons used by the current store and delivery
    // paths. Keep this list in migration order so each ALTER/table addition
    // sees the shape established by its canonical predecessor.
    '175-watch-floor-coalesce-cols.sql',
    '183-event-awaits-inbox-wake-one-per-agent.sql',
    '184-hives-table.sql',
    '188-work-item-claims.sql',
    '195-work-item-redundancy.sql',
    // Signal provenance (frontier P-002, migration 241): ISSUE_COLS selects signal_origin.
    '241-signal-provenance-origin.sql',
    '387-event-wake-delivery-source.sql',
    '480-event-awaits-pattern-index.sql',
    '533-add-event-awaits-payload-filter.sql',
    '541-predicate-watches.sql',
    '550-event-awaits-announce-scope.sql',
    '557-cup-lexicon-db-rename-phase3.sql',
    '569-event-awaits-policy-allow-announce.sql',
    '572-event-await-nodes-threshold-tree.sql',
    '599-event-announcement-generation.sql',
    '602-work-item-follow-blockers.sql',
    // Migration 675 normalizes the canonical plan content into plan_items /
    // plan_decisions. The claim-floor path reads plan_items even when a rig test
    // seeds no plan-linked rows, so omitting this derived relation makes every
    // claim attempt fail with 42P01 before the test reaches its assertion.
    // Event fire latch used by the same awaited emit path (migration 632).
    '632-event-key-fire-latch.sql',
    '675-normalize-plan-items-decisions.sql',
    '686-pots-canonical-home-slug-fk.sql',
    '710-event-awaits-effective-deadline-view.sql',
    '825-verified-wait-producer-health.sql',
    '871-lifecycle-bound-watches.sql',
    '925-fleet-leader-watch-suppression.sql',
  ]) {
    // EI-6887: shared strip-psql-meta-commands-and-txn-wrapper + apply helper.
    await applyMigrationForTest(sql, join(SQL_DIR, file));
  }

  // D-007 pot-rename: mig 188 creates work_item_claims.hive_slug; mig 523 renamed it →
  // pot_slug. The condensed set above predates 523, so apply the rename in-place — the
  // real claim code paths this rig drives (claimNextWorkItem, work-item-claims store)
  // write pot_slug and 42703 otherwise.
  await sql.unsafe(`ALTER TABLE harness_shared.work_item_claims RENAME COLUMN hive_slug TO pot_slug`);

  // The unified work-item lookup probes the issue family too (getIssue's
  // ISSUE_COLS) — columns later migrations (136/142/152/178) added to the
  // mig-131 table, condensed here since those migrations touch tables this
  // schema doesn't carry. The rig never writes issue-family rows; the columns
  // only need to exist for the SELECT.
  await sql.unsafe(`
    ALTER TABLE harness_shared.engineer_issues
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bug',
      ADD COLUMN IF NOT EXISTS assigned_by text,
      ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
      -- issue-family progress signal (mig 509, mirrors the feature-family's) —
      -- getIssueInWorkspace's ISSUE_COLS selects it, so it must EXIST or 42703.
      ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
      ADD COLUMN IF NOT EXISTS payload jsonb,
      ADD COLUMN IF NOT EXISTS assignee_rank integer,
      ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      -- EI-10579: migration 588 (issue-family-priority-view-column) added
      -- feature_order to the engineer_issues VIEW, and EI-10421 made ISSUE_COLS
      -- select it unconditionally (issueToWorkItem now reads i.featureOrder). The
      -- rig's engineer_issues is a REAL table, not that view, so every read of it
      -- via ISSUE_COLS — including getWorkItem()'s issue-family probe, which
      -- setWorkItemPriority (mugTurn) calls first — 42703'd ("column feature_order
      -- does not exist"), turning this whole file's split-brain probe (and any
      -- rig test touching a getWorkItem / setWorkItemPriority issue-family path)
      -- deterministically red from the moment 588 landed. The rig never writes an
      -- issue-family feature_order; the column only needs to EXIST for the SELECT.
      ADD COLUMN IF NOT EXISTS feature_order integer,
      -- Same EI-10579 drift class, next instance: agent-protocol-authority-semantics
      -- -2026-07-26 P-004/D-009 added the bare "authority" column and ISSUE_COLS
      -- (issues-engineer.ts) now selects it unconditionally, so the rig's REAL
      -- engineer_issues table 42703'd on every getWorkItem issue-family probe.
      -- Real column is text NULL; the rig never writes it, it only must EXIST.
      -- NOTE: no backticks in this comment on purpose — this SQL lives inside a TS
      -- template literal, so a backtick here terminates it (EI-18748484115079154).
      ADD COLUMN IF NOT EXISTS authority text,
      -- Same EI-10579 drift class again: EI-18820653360383242 (migration 698) added
      -- closed_ts, the set-once close timestamp, and ISSUE_COLS now selects it
      -- unconditionally. On the REAL schema this column is maintained by a base-table
      -- trigger and is never written by a caller; here it only has to EXIST so the
      -- SELECT does not 42703. Real column is bigint NULL (epoch ms, the *_ts family
      -- convention), NOT a timestamptz -- do not "fix" it to match the *_at columns.
      ADD COLUMN IF NOT EXISTS closed_ts bigint,
      -- Same EI-10579 drift class again: WI-37711 (migration 790) exposed goal_id on
      -- the engineer_issues VIEW and ISSUE_COLS now selects it unconditionally, so the
      -- rig's REAL engineer_issues table would 42703 on every getWorkItem issue-family
      -- probe. On the real schema goal_id lives on the work_items base table and is
      -- written by stampGoalProvenance; the rig never writes it, it only must EXIST for
      -- the SELECT. Real column is text NULL.
      ADD COLUMN IF NOT EXISTS goal_id text,
      -- Migration 803 appended parent_id to the engineer_issues VIEW and
      -- ISSUE_COLS now selects it unconditionally. The rig's issue table is a
      -- real fixture, so it needs the nullable text column for that read path.
      ADD COLUMN IF NOT EXISTS parent_id text,
      -- Same EI-10579 drift class again: migration 815
      -- (expose-claim-spec-fields-on-engineer-issues-view) appended the five
      -- claim-spec columns below to the engineer_issues VIEW and ISSUE_COLS now
      -- selects them unconditionally, so the rig's REAL engineer_issues table
      -- 42703'd on every getWorkItem / setWorkItemPriority issue-family probe.
      -- On the real schema these live on the work_items base table; the rig
      -- never writes them, they only have to EXIST for the SELECT. Types match
      -- the real columns -- do not "simplify" source_plan_item_ids to text or
      -- expected_cost_cents to integer.
      ADD COLUMN IF NOT EXISTS tags jsonb,
      ADD COLUMN IF NOT EXISTS source_plan_slug text,
      ADD COLUMN IF NOT EXISTS source_plan_item_ids text[],
      ADD COLUMN IF NOT EXISTS redundancy integer,
      ADD COLUMN IF NOT EXISTS expected_cost_cents bigint;
  `);

  // WI-1644 (part 4): migration 432 (work-item-completion-integrity, POST-379 —
  // not in the verbatim/condensed set above) adds terminal_owner /
  // terminal_completion_ref to the base work_items table so setWorkItemState /
  // setIssueState's completion-integrity gate can record "who closed it + what
  // proves it". claimFeatureRow's FEATURE_COLS and issues-engineer.ts's
  // ISSUE_COLS both select these columns unconditionally, so their absence
  // 42703s ("column terminal_owner does not exist") the moment a claim/close
  // path runs — exactly the failure this test reaches once the 374 rename
  // (below) lets it get past seedBacklog. Condensed the same way 136/142/152/178
  // were above: ADD the two columns to BOTH real tables this rig carries (the
  // work_items base table the 374 block below renames the feature table to,
  // and the rig's own real engineer_issues table for the issue family —
  // migration 432's rewrite of engineer_issues as a compat VIEW does not apply
  // here, since the rig's engineer_issues is a real table, not the
  // 374-cutover view). The harness_features_consolidated compat view the 374
  // block creates below is a fresh `CREATE VIEW … SELECT *`, so it picks up
  // these columns automatically — no separate refresh needed here.
  await sql.unsafe(`
    ALTER TABLE harness_shared.engineer_issues
      ADD COLUMN IF NOT EXISTS terminal_owner text,
      ADD COLUMN IF NOT EXISTS terminal_completion_ref text;
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS terminal_owner text,
      ADD COLUMN IF NOT EXISTS terminal_completion_ref text,
      -- Same drift class, next instance (EI-20094613443189011): migration 638
      -- (unify-workitem-status) added terminal_reason to the base work_items
      -- table, and setWorkItemState's terminal path WRITES it -- the close leg
      -- (work-items.ts, "SET terminal_reason = ...") and the reopen leg, which
      -- resets it to NULL. UNLIKE every other column in this block, it appears
      -- in NO read column list (it is absent from FEATURE_COLS), so no SELECT
      -- ever reveals its absence: the rig boots clean and 42703s only once a
      -- close/reopen actually runs. That is why it surfaced as 18 failures deep
      -- inside shared-pot-loop tests instead of at setupCellSchema time, and it
      -- is why the rig-columns-exist-in-real-schema guard cannot catch this
      -- direction of drift. The rig never asserts on the value; it only needs to
      -- EXIST. Real column is text NULL.
      ADD COLUMN IF NOT EXISTS terminal_reason text,
      -- Same class, and the reason the terminal_reason fix ALONE left this rig
      -- red: the engineer_issues block above already ADDs authority (mig 677-era)
      -- and closed_ts (mig 698) -- but ONLY to the issue-family table. The
      -- feature-family projection writes them too: harness-features.ts's
      -- writeToPg INSERT column list carries terminal_owner,
      -- terminal_completion_ref, terminal_reason, authority, closed_ts as one
      -- contiguous group. Adding a column to the issue side and not the feature
      -- side is the single most repeated shape of this drift. Real columns are
      -- text NULL and bigint NULL (epoch ms, the *_ts convention -- do NOT
      -- "fix" closed_ts to timestamptz to match the *_at columns).
      ADD COLUMN IF NOT EXISTS authority text,
      ADD COLUMN IF NOT EXISTS closed_ts bigint;
  `);

  // ── Schema COMPLETENESS (EI-20099366410545026) ────────────────────────────
  // Everything above this line is the historical pattern: a column drifts in,
  // an integration test 42703s, someone adds that ONE column. That has now
  // recurred at least seven times (EI-10579, EI-18820653360383242, WI-37711,
  // EI-20094613443189011 + its authority/closed_ts follow-up, then
  // op_status/items and lane on 2026-08-10), and the per-instance fix does not
  // converge, for two compounding reasons:
  //
  //   1. LAYERED FAILURE. Postgres reports ONE missing column per query, so
  //      each fix only reveals the next one — a fresh ~3.5min integration
  //      cycle per column. A single session on 2026-08-10 peeled three layers
  //      (terminal_reason -> op_status -> lane) without reaching the bottom.
  //   2. THE EXISTING GUARDS CANNOT SEE IT. Both drift guards check
  //      "the rig declares a column the REAL schema lacks"; this is the
  //      opposite direction. A source-text guard for THIS direction was
  //      prototyped and REJECTED on 2026-08-10: the references are often
  //      COMPOSED at runtime (a fragment like "lane IS DISTINCT FROM …"
  //      interpolated behind a table prefix), so the required column never
  //      appears as literal source text. The prototype reported a confident
  //      "0 missing" against a tree that was red on a missing column at that
  //      very moment -- a false green, i.e. strictly worse than no guard.
  //
  // So the fix is not a better detector — it is removing the drift surface.
  // These two tables are now completed to the FULL real column set, generated
  // from live information_schema (types verbatim, including the GENERATED
  // expression for work_items.lane), which makes a missing-column 42703
  // structurally impossible here rather than merely detected. Adding columns
  // to a fixture is free: the rig asserts on none of these values, they only
  // need to EXIST with a faithful type.
  //
  // EXCLUDED, deliberately: `_search` (tsvector GENERATED — needs the exact
  // to_tsvector expression and buys the rig nothing, no full-text path runs
  // here) and `embedding` (pgvector USER-DEFINED type — would make the rig
  // depend on the extension being installed in a throwaway PG). If a future
  // code path ever reads either, it will need that extension anyway.
  //
  // ⚠ Keep this block in sync by REGENERATING, never by hand-adding one column
  // when the next 42703 appears — that is the habit this block replaces:
  //   SELECT column_name, udt_name, is_generated, generation_expression
  //     FROM information_schema.columns
  //    WHERE table_schema='harness_shared' AND table_name IN ('work_items','harness_plans');
  await sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated
      ADD COLUMN IF NOT EXISTS audit_reasons text,
      ADD COLUMN IF NOT EXISTS audited_at timestamptz,
      ADD COLUMN IF NOT EXISTS condition_key text,
      ADD COLUMN IF NOT EXISTS created_by_github_user_id bigint,
      ADD COLUMN IF NOT EXISTS embedding_mode text,
      ADD COLUMN IF NOT EXISTS embedding_recipe smallint,
      ADD COLUMN IF NOT EXISTS run_seq integer,
      ADD COLUMN IF NOT EXISTS schedule jsonb,
      ADD COLUMN IF NOT EXISTS schedule_active boolean,
      ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
      ADD COLUMN IF NOT EXISTS template_slug text,
      ADD COLUMN IF NOT EXISTS tzid text,
      ADD COLUMN IF NOT EXISTS verified_done_at_remote_ts timestamptz,
      ADD COLUMN IF NOT EXISTS verifier_last_checked_at timestamptz,
      ADD COLUMN IF NOT EXISTS verifier_last_error text,
      ADD COLUMN IF NOT EXISTS worked_by_history jsonb,
      ADD COLUMN IF NOT EXISTS working_users bigint[];
    ALTER TABLE harness_shared.harness_plans
      ADD COLUMN IF NOT EXISTS archived boolean,
      ADD COLUMN IF NOT EXISTS author_pubkey text,
      ADD COLUMN IF NOT EXISTS content text,
      ADD COLUMN IF NOT EXISTS content_hash text,
      ADD COLUMN IF NOT EXISTS created text,
      ADD COLUMN IF NOT EXISTS created_at timestamptz,
      ADD COLUMN IF NOT EXISTS current_wave text,
      ADD COLUMN IF NOT EXISTS decisions jsonb,
      ADD COLUMN IF NOT EXISTS expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS fed_hlc text,
      ADD COLUMN IF NOT EXISTS fed_ts bigint,
      ADD COLUMN IF NOT EXISTS goal_id text,
      ADD COLUMN IF NOT EXISTS initiative text,
      ADD COLUMN IF NOT EXISTS input_schema jsonb,
      ADD COLUMN IF NOT EXISTS is_legacy boolean,
      ADD COLUMN IF NOT EXISTS items jsonb,
      ADD COLUMN IF NOT EXISTS now_next text,
      ADD COLUMN IF NOT EXISTS now_state text,
      ADD COLUMN IF NOT EXISTS op_priority integer,
      ADD COLUMN IF NOT EXISTS op_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS op_status text,
      ADD COLUMN IF NOT EXISTS op_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS origin text,
      ADD COLUMN IF NOT EXISTS owner text,
      ADD COLUMN IF NOT EXISTS owner_author_pubkey text,
      ADD COLUMN IF NOT EXISTS promote_policy jsonb,
      ADD COLUMN IF NOT EXISTS run_seq integer,
      ADD COLUMN IF NOT EXISTS schedule jsonb,
      ADD COLUMN IF NOT EXISTS schedule_active boolean,
      ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
      ADD COLUMN IF NOT EXISTS superseded_by text,
      ADD COLUMN IF NOT EXISTS supersedes text[],
      ADD COLUMN IF NOT EXISTS template text,
      ADD COLUMN IF NOT EXISTS template_data jsonb,
      ADD COLUMN IF NOT EXISTS template_slug text,
      ADD COLUMN IF NOT EXISTS title text,
      ADD COLUMN IF NOT EXISTS tzid text,
      ADD COLUMN IF NOT EXISTS updated text,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS version bigint;
  `);

  // WI-1644: mirror migration 374's structural cutover (P-010 work-item
  // unification) — production RENAMEs harness_features_consolidated to the
  // TRUE base table `work_items`, then re-creates harness_features_consolidated
  // as a simple (auto-updatable) compat view filtered to the feature-family
  // kinds. The rig built the pre-374 shape only (a real
  // harness_features_consolidated table, no work_items relation at all), while
  // application code it drives (composition-rig's own seedBacklog below, and
  // every real work_items:* / claimNextWorkItem code path) targets the
  // POST-374 name — so `INSERT INTO harness_shared.work_items` failed
  // "relation does not exist". Run the rename AFTER the verbatim migrations
  // above (188/195 ALTER the table by its pre-cutover name) and BEFORE the
  // trigger attachments below (a view can't carry BEFORE/AFTER triggers, so
  // those move to the new base table). Plain SELECT/UPDATE/INSERT against
  // harness_features_consolidated elsewhere in this file (stamp() at
  // runFakePipeline, readBacklog) keep working unmodified — Postgres
  // transparently rewrites simple-view DML onto the base relation.
  await sql.unsafe(`
    ALTER TABLE harness_shared.harness_features_consolidated RENAME TO work_items;
    ALTER TABLE harness_shared.work_items
      RENAME CONSTRAINT harness_features_consolidated_pkey TO work_items_pkey;
    CREATE VIEW harness_shared.harness_features_consolidated AS
      SELECT * FROM harness_shared.work_items
      WHERE item_kind NOT IN ('bug', 'change', 'task')
      WITH CASCADED CHECK OPTION;
  `);

  // Completeness columns that live ONLY on the base table, added AFTER the rename
  // and AFTER the compat view is built — deliberately, so the rig mirrors
  // production exactly (EI-20099366410545026). In the real schema these three are
  // on work_items but ABSENT from the harness_features_consolidated view, because
  // that view is a `SELECT *` snapshot taken before they were added and a view's
  // column list does not track its base table. Adding them ABOVE (pre-rename)
  // would put them in the rig's view too, which then fails
  // composition-rig-schema-drift.integration.test.ts — that guard asserts every
  // rig column EXISTS on the real view, and lane/condition_key/embedding_recipe
  // do not. Verified against live information_schema: 15 of the 18 completeness
  // columns are on the view, these 3 are not.
  //
  // `lane` must be reproduced as its real GENERATED column (migration 721), not
  // plain text: a plain column would sit NULL and silently change the meaning of
  // every "lane IS DISTINCT FROM 'observation'" claim floor instead of erroring —
  // a false GREEN, which is worse than the 42703 this whole block removes.
  await sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS condition_key text,
      ADD COLUMN IF NOT EXISTS embedding_recipe smallint,
      ADD COLUMN IF NOT EXISTS lane text GENERATED ALWAYS AS (payload ->> 'lane') STORED;
  `);

  // WI-2923: install migration 314's SUPERSEDING clock + stamp function, NOT the
  // obsolete 214 slice. 214's stamp refreshed fed_ts but left a previously-applied
  // fed_hlc in place — and fed_order_key PREFERS the hlc — so a locally-rewritten
  // row's LWW key regressed to the stale hlc and ANY remote op (even strictly
  // older) overwrote newer local content on heal: the exact F-003 winner a/b swap
  // this rig's P-002 chaos leg kept red. Production runs 314's function (local
  // writes stamp fed_hlc := hlc_now(), recv-advanced past every seen remote hlc,
  // so keys never regress); the rig must match. Slices: §1 (hlc_clock singleton +
  // hlc_now/hlc_recv) and §3 (the stamp fn); §2's 11-table ALTERs are skipped —
  // this schema's two tables already carry fed_hlc.
  const mig314 = readFileSync(join(SQL_DIR, '314-d001-hlc-ordering-key.sql'), 'utf8');
  const s1 = mig314.indexOf('-- \u2500\u2500 1.');
  const s2 = mig314.indexOf('-- \u2500\u2500 2.');
  const s3 = mig314.indexOf('-- \u2500\u2500 3.');
  const s3b = mig314.indexOf('-- \u2500\u2500 3b.');
  if (s1 < 0 || s2 < 0 || s3 < 0 || s3b < 0) {
    throw new Error('composition-rig: migration 314 shape changed — update the slice points');
  }
  await sql.unsafe(mig314.slice(s1, s2));
  await sql.unsafe(mig314.slice(s3, s3b));
  await sql.unsafe(`
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.harness_issues_consolidated
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
  `);

  // The 181-shape UPDATE capture guard for harness_issues_consolidated (the
  // rig's OWN separate legacy table — untouched by the 374/375 cutover, so it
  // keeps riding the generic capture_substrate_outbox() unmodified).
  await sql.unsafe(`
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_issues_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
  `);

  // WI-1644 (part 2): the rename above leaves the archive/102 GENERIC capture
  // triggers (capture_substrate_outbox_trg / _upd_trg, verbatim-loaded above
  // while the table was still named harness_features_consolidated) attached to
  // the renamed work_items table — same defect migration 375 documents: they
  // stamp table_name=TG_TABLE_NAME='work_items' for EVERY row regardless of
  // item_kind, but the read-side projections demux by the LOGICAL table_name
  // ('harness_features_consolidated' / 'engineer_issues' — see
  // TABLE_NAME_TO_TABLE_TAG in feature-issue-op-keys.ts), so every captured
  // row became unmappable ("[outbox-drain] skipping outbox rows for unmapped
  // table 'work_items'"). Load migration 375 verbatim: it DROPs those stale
  // generic triggers and installs the real kind-branching capture
  // (capture_work_items_outbox) that stamps the correct logical table_name —
  // exactly the fix production itself needed post-374.
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '375-work-items-cdc-capture.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l))
      .join('\n'),
  );

  // Migration 645 persists outbox poison-row quarantine. The fleet monitor
  // deliberately excludes quarantined rows from depth/age SLOs and its test
  // seeds one, so keep the fixture on the real column shape.
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '645-outbox-quarantine-persist.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
      .join('\n'),
  );

  // Migration 495 added drained_log_key so outbox-drain can attribute each drained
  // row to the live own-log key and detect prior-era orphan tails. The composition
  // rig uses a sliced baseline/migration subset, so keep the fixture schema aligned
  // with the current drain writer.
  await sql.unsafe(`ALTER TABLE harness_shared.substrate_outbox ADD COLUMN IF NOT EXISTS drained_log_key TEXT`);

  // EI-20579195481991931: `scanPeerFederationSilence` (fleet-monitors.ts) reads
  // per-remote-log fold progress to detect a PEER that stopped federating — the
  // failure `scanOutboxHealth` is host-local-blind to. This rig's sliced
  // baseline predates migration 493, so the table was absent and the monitor
  // pass died with 42P01 mid-scan. Loaded VERBATIM (like 375/379 above) rather
  // than restated, so the fixture cannot drift from the real DDL again — the
  // recurring inline-CREATE-TABLE drift class (EI-19359711978838614).
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '493-substrate-merge-cursor.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l))
      .join('\n'),
  );

  // EI-20617273180156712: 493 creates the table WITHOUT `apply_binding`; migration
  // 685 adds it, and the judge now SELECTs it (a cursor under a superseded binding
  // is unreachable residue, not a silent peer). Loading only 493 leaves the fixture
  // exactly one column behind the reader — and because `scanPeerFederationSilence`
  // deliberately CATCHES its own scan errors, the 42703 would not fail the pass
  // loudly: it degrades to `unmeasuredReason:'scan-failed'` and the peer-silence
  // leg silently measures nothing while the suite stays green. That is the same
  // fixture-drift class the comment above records, one column deeper, so the
  // migration that moved the reader is loaded here beside the one that made it.
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '685-substrate-merge-cursor-apply-binding.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l))
      .join('\n'),
  );

  // Migration 854 adds the explicit lifecycle/identity columns selected by
  // scanPeerFederationSilence. Without it, that monitor catches the undefined
  // column and reports scan-failed instead of the honest no-remote-log state.
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '854-substrate-merge-cursor-peer-lifecycle.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
      .join('\n'),
  );

  // The SAME fixture-drift class again, one table wider: the judge now also reads
  // `substrate_booted_handles_status` to learn which log is OUR OWN, so it can
  // take it out of the peer population (the own log is re-stamped by our own
  // writes, so counting it as a peer supplies an eternally-advancing false
  // "positive control" and the all-silent branch can never fire). Without 739 the
  // new SELECT raises 42P01 and — because the scan catches its own errors — the
  // leg degrades to `scan-failed` and measures NOTHING while the suite stays
  // green. Two independent recurrences (493, then 685) say a comment does not
  // prevent this; the assertion in fleet-monitors.integration.test.ts does.
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '739-substrate-booted-handles-status.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l))
      .join('\n'),
  );

  // WI-1644 (part 3): SCHEDULER_MAINTAINED_READY reads live as ON in this test
  // environment (flags are NOT mocked here), so claimFloorsWhereSql's
  // useMaintainedReady branch queries harness_shared.work_item_blocked — the
  // local, non-federated readiness sidecar migration 379 introduces, entirely
  // in terms of the POST-374/375 `work_items` name (it was authored after that
  // cutover shipped). Load it verbatim now that work_items is real.
  await sql.unsafe(
    readFileSync(join(SQL_DIR, '379-maintained-ready-column.sql'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l))
      .join('\n'),
  );
}

/** Per-peer projection apply bound to THIS cell's sql (the Stage-6 seam). */
function buildCellApply(
  sql: postgres.Sql,
  ownLogKeyHex: string,
  opts: { workspaceId: string; harnessSlug: string },
  extraProjections?: CompositionRigOpts['extraProjections'],
  hlcClock?: HlcClock,
): (op: OpEnvelope) => Promise<boolean> {
  const popts = { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, sql };
  const scoped = new Map<string, TableProjection<unknown>>();
  const projections = [
    buildHarnessFeaturesProjection(popts),
    buildIssuesProjection(popts),
    ...(extraProjections ? extraProjections(popts) : []),
  ] as TableProjection<unknown>[];
  for (const p of projections) {
    scoped.set(p.tableTag, p);
  }
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  // hlcClock: this cell's OWN HLC (RECV seam advances it on remote ops) — NOT
  // the process-global one, so two cells in one process don't share a clock.
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex, hlcClock });
}

// ── The rig ──────────────────────────────────────────────────────────────────

export type CellName = 'a' | 'b';

export interface SwarmCell {
  name: CellName;
  /** Injected ELECTION identity (argmin ⇒ cell a is the authority). */
  electionPubkey: string;
  /** The substrate ANNOUNCE identity (Ed25519 device pubkey) — what
   *  `handle.revoke(devicePubkey)` takes and what op provenance carries. */
  announcePubkey: string;
  githubUserId: number;
  /** Claim owner string (distinct per cell — two Swarms are distinct holders). */
  owner: string;
  sql: postgres.Sql;
  handle: BootedHarnessHandle;
  /** This cell's Hive-lease store (the coordinator seam; clock-injected). */
  store: InMemoryWorkItemClaimStore;
  deps: LockAuthorityDeps;
  /** Per-cell pipeline idempotency ledger — the DBOS workflow-id dedup analog. */
  pipelineRuns: Map<string, FakePipelineResult>;
}

export interface ClaimNextOutcome {
  item: WorkItem;
  via: 'local-authority' | 'remote-authority' | 'fail-open';
  /** false ⇒ the Hive lease is held by the other Swarm; the local claim was released. */
  leased: boolean;
  claim: WorkItemClaim | null;
}

export interface FakePipelineResult {
  ok: boolean;
  workItemId: string;
  executedBy: CellName;
  /** True when this call was deduped by the per-cell idempotency ledger. */
  deduped: boolean;
}

export interface CompositionRigOpts {
  workspaceId?: string;
  harnessSlug?: string;
  potSlug?: string;
  /** Authority-election presence staleness window (compressed in chaos tests). */
  staleMs?: number;
  /** Hive-lease TTL for claim_next-style claims (seconds). */
  claimTtlSec?: number;
  /** Authority RPC timeout — short so a dead/partitioned authority fails open fast. */
  rpcTimeoutMs?: number;
  log?: (m: string) => void;
  /**
   * Extra per-cell DDL run after `setupCellSchema` — for tests federating
   * surfaces beyond the work-item family (e.g. coord-e2e P-005 adds the
   * coord_event_log + its migration-147 capture triggers per cell).
   */
  extraCellSetup?: (sql: postgres.Sql, opts: { workspaceId: string; harnessSlug: string }) => Promise<void>;
  /**
   * Extra projections registered into each cell's apply chain alongside the
   * feature/issue ones (same `popts` contract as the production builders).
   */
  extraProjections?: (popts: { workspaceId: string; harnessSlug: string; sql: postgres.Sql }) => TableProjection<unknown>[];
}

export class CompositionRig {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly potSlug: string;
  readonly staleMs: number;
  readonly claimTtlSec: number;
  cells!: { a: SwarmCell; b: SwarmCell };

  /** Injectable clock: advanceClock() compresses lease/staleness windows. */
  private clockOffsetMs = 0;
  readonly now = (): number => Date.now() + this.clockOffsetMs;

  private partitioned = false;
  private server: Server | null = null;
  private serverUrl = '';
  private authorityKilled = false;
  /** Announce/device pubkeys the AUTHORITY cell has revoked — mirrored off cell
   *  A's handle.revoke so the EI-284 caller-standing gate sees the same view
   *  the substrate's announce-time refusal does. */
  private readonly revokedByAuthority = new Set<string>();
  /** Frozen presence timestamps for killed cells (live cells read the clock). */
  private frozenLastSeen = new Map<string, number>();
  private cleanups: Array<() => void | Promise<void>> = [];
  private priorWorkspaceEnv: string | undefined;
  private readonly log: (m: string) => void;

  constructor(opts: CompositionRigOpts = {}) {
    this.workspaceId = opts.workspaceId ?? 'ws-shl-comp';
    this.harnessSlug = opts.harnessSlug ?? 'shl';
    this.potSlug = opts.potSlug ?? 'shl-hive';
    this.staleMs = opts.staleMs ?? 10 * 60_000;
    this.claimTtlSec = opts.claimTtlSec ?? 300;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 1_500;
    this.log = opts.log ?? (() => {});
    this.extraCellSetup = opts.extraCellSetup;
    this.extraProjections = opts.extraProjections;
  }
  private readonly rpcTimeoutMs: number;
  private readonly extraCellSetup?: CompositionRigOpts['extraCellSetup'];
  private readonly extraProjections?: CompositionRigOpts['extraProjections'];

  advanceClock(ms: number): void {
    this.clockOffsetMs += ms;
  }

  /** Run `fn` with this cell's PG as the production `getOrgPg()` target. */
  runAsCell<T>(cell: SwarmCell, fn: () => Promise<T>): Promise<T> {
    return runWithCellSql(cell.sql, fn);
  }

  // ── Boot / teardown ────────────────────────────────────────────────────────

  async boot(): Promise<this> {
    // Pin the workspace claimNextWorkItem filters on (env wins over registry).
    this.priorWorkspaceEnv = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = this.workspaceId;

    const dbA: FreshPgDb = await createFreshPgDb('shlA');
    this.cleanups.push(() => dbA.cleanup());
    const dbB: FreshPgDb = await createFreshPgDb('shlB');
    this.cleanups.push(() => dbB.cleanup());
    const schemaOpts = { workspaceId: this.workspaceId, harnessSlug: this.harnessSlug };
    // Per-cell HLC clocks (NOT process-global processHlc()): two real Swarms are
    // separate processes with independent clocks, so each simulated cell gets its
    // own — both SEND (boot stampOpHlc) and RECV (apply observeRemoteHlc) seams.
    // Without this, both cells share one global clock and their concurrent drains
    // race the same counter, deciding cross-swarm LWW by drain-interleave.
    const hlcA = new HlcClock({ physical: () => this.now() });
    const hlcB = new HlcClock({ physical: () => this.now() });
    await setupCellSchema(dbA.sql, schemaOpts);
    await setupCellSchema(dbB.sql, schemaOpts);
    if (this.extraCellSetup) {
      await this.extraCellSetup(dbA.sql, schemaOpts);
      await this.extraCellSetup(dbB.sql, schemaOpts);
    }

    const testnet = await createTestnet(3);
    this.cleanups.push(async () => {
      try {
        await testnet.destroy();
      } catch {
        /* ignore */
      }
    });

    const idA = makeIdentityOverride('swarm-a', 4201, 'kc-shl-a');
    const idB = makeIdentityOverride('swarm-b', 4202, 'kc-shl-b');
    const mkSwarm = (): HyperswarmLike => {
      const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap }) as unknown as HyperswarmLike & {
        destroy(): Promise<void>;
      };
      this.cleanups.push(async () => {
        try {
          await swarm.destroy();
        } catch {
          /* ignore */
        }
      });
      return swarm;
    };
    const mkRoot = (prefix: string): string => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      this.cleanups.push(() => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
      return dir;
    };

    const binding = { kind: 'local' as const, workspace_id: this.workspaceId, harness_slug: this.harnessSlug };
    const rootA = mkRoot('shl-A-');
    const rootB = mkRoot('shl-B-');

    let handleA: BootedHarnessHandle | undefined;
    let handleB: BootedHarnessHandle | undefined;
    let applyA: ((op: OpEnvelope) => Promise<boolean>) | undefined;
    let applyB: ((op: OpEnvelope) => Promise<boolean>) | undefined;

    // WI-1206492 / EI-18815759786278298: bootHarnessSubstrate now (2026-08-27,
    // hive-epoch-boot-deps) touches getOrgPg() during boot (buildHiveRekeyBootDeps →
    // potHomeSlugForHarness → loadHarnessRegistry → readOperatorState) — a call the
    // rig's own db-org mocks (see cell-scope.ts's documented pattern, and the
    // strict throw-on-no-scope variant in cross-swarm-supervision.integration.test.ts)
    // expect to be reachable ONLY inside `runAsCell`. Each cell's own boot must run
    // inside ITS OWN cell scope so that incidental getOrgPg() calls during boot are
    // routed to (or validated against) the right cell's PG, exactly like every other
    // production code path this rig exercises post-boot via `runAsCell`.
    handleA = await runWithCellSql(dbA.sql, () => bootHarnessSubstrate({
      workspaceRoot: rootA,
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      swarmBinding: binding,
      swarmOverride: mkSwarm(),
      verifyBindingOverride: async (_pk, _login, userId) => (userId === idB.userId ? 'verified' : 'fail'),
      applyOverride: (op) => {
        applyA ??= buildCellApply(dbA.sql, handleA!.ownLog.keyHex, schemaOpts, this.extraProjections, hlcA);
        return applyA(op);
      },
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: idA.override,
      hlcClock: hlcA,
    }));
    this.cleanups.push(async () => {
      await handleA?.close();
      await closeHarnessStore({ workspaceRoot: rootA, harnessSlug: this.harnessSlug });
    });

    handleB = await runWithCellSql(dbB.sql, () => bootHarnessSubstrate({
      workspaceRoot: rootB,
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      swarmBinding: binding,
      swarmOverride: mkSwarm(),
      verifyBindingOverride: async (_pk, _login, userId) => (userId === idA.userId ? 'verified' : 'fail'),
      applyOverride: (op) => {
        applyB ??= buildCellApply(dbB.sql, handleB!.ownLog.keyHex, schemaOpts, this.extraProjections, hlcB);
        return applyB(op);
      },
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: idB.override,
      hlcClock: hlcB,
    }));
    this.cleanups.push(async () => {
      await handleB?.close();
      await closeHarnessStore({ workspaceRoot: rootB, harnessSlug: this.harnessSlug });
    });

    if (!handleA.swarm || !handleB.swarm || handleA.swarm.topicHex !== handleB.swarm.topicHex) {
      throw new Error('composition-rig: cells failed to join the same swarm topic');
    }

    // ── Hive-lease stores + the authority endpoint (cell a = argmin). ──
    // Election pubkeys are INJECTED (deterministic) — distinct from the
    // substrate's Ed25519 announce identities, exactly like claim-agent.
    const ELECT_A = 'aaaa-shl-authority-election-pubkey';
    const ELECT_B = 'mmmm-shl-peer-election-pubkey';
    const storeA = new InMemoryWorkItemClaimStore({ now: this.now });
    const storeB = new InMemoryWorkItemClaimStore({ now: this.now });

    const roster = [
      { pubkey: ELECT_A, uid: 4201, label: 'shl-cell-a' },
      { pubkey: ELECT_B, uid: 4202, label: 'shl-cell-b' },
    ];
    const presenceRows = async () =>
      roster.map((r) => ({
        device_pubkey: r.pubkey,
        github_user_id: r.uid,
        machine_label: r.label,
        last_seen_ms: this.frozenLastSeen.get(r.pubkey) ?? this.now(),
      }));
    const mkDeps = (selfPubkey: string, uid: number): LockAuthorityDeps => ({
      now: this.now,
      staleMs: this.staleMs,
      resolveSelf: async () => ({ githubUserId: uid, devicePubkey: selfPubkey }),
      fetchHivePresenceRows: presenceRows,
      // WI-5192 (same class as WI-5190): HRW_RENDEZVOUS_AUTHORITY graduated to
      // default-ON 2026-07-17 — without pinning it, resolveUseHrwRendezvous()
      // reads the LIVE flag and silently switches which peer-selection algorithm
      // decides the authority from selectAuthorityFromRows (row-argmin) to the
      // hash-based selectAuthorityRendezvous. This rig's whole roster/election
      // fixture is deliberately built for argmin ("cell a = argmin", see above)
      // to make cell A the deterministic authority — pin it OFF so the chaos
      // scenarios (partition/kill-authority/re-election) keep exercising THAT
      // deterministic election, independent of the unrelated flag. The hash
      // algorithm itself is covered by its own dedicated rendezvous-authority
      // test suite.
      useHrwRendezvous: false,
    });
    const depsA = mkDeps(ELECT_A, 4201);
    const depsB = mkDeps(ELECT_B, 4202);

    // The authority's RPC ops run against the AUTHORITY cell's store, with the
    // EI-284 caller-standing gate wired to the authority instance's revocation
    // view: claims carry the caller's ELECTION pubkey while revocation operates
    // on ANNOUNCE/device pubkeys, so the rig's checker bridges the domains via
    // its cell table + the revocations mirrored off cell A's handle.revoke
    // (production bridges the same way: holder_pubkey is the device pubkey, and
    // the default check reads contributors.revoked_pubkeys).
    __resetAuthorityOpsForTests();
    registerWorkItemClaimAuthorityOps(storeA.asCoordinator(), {
      isCallerRevoked: async (holderPubkey) => {
        const cells = Object.values(this.cells ?? {});
        const announce =
          cells.find((c) => c.electionPubkey === holderPubkey)?.announcePubkey ?? holderPubkey;
        return this.revokedByAuthority.has(announce);
      },
    });
    this.cleanups.push(() => __resetAuthorityOpsForTests());

    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          const env = JSON.parse(raw) as AuthorityRpcEnvelope;
          const result = await handleAuthorityRpc(env, {
            verifyIsAuthority: async (slug) => (await lockAuthorityForHive(slug, depsA)).isSelf,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'handler_error', message: String(err) }));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as { port: number }).port;
    this.serverUrl = `http://127.0.0.1:${port}`;
    this.cleanups.push(
      () =>
        new Promise<void>((r) => {
          // killAuthority() may already have closed + nulled the server — an
          // optional-chained close would never fire its callback (a hang).
          if (!this.server) return r();
          this.server.closeAllConnections?.();
          this.server.close(() => r());
          this.server = null;
        }),
    );

    // One process-global transport (the production seam): the authority's URL
    // for cell a's pubkey; a partition swaps in a fast-refusing address.
    setPeerRpcTransport(
      new HttpPeerRpcTransport({
        resolveAddress: (peer) => {
          if (this.partitioned) return 'http://127.0.0.1:9'; // discard port — refused fast
          return peer.devicePubkey === ELECT_A ? this.serverUrl : null;
        },
        timeoutMs: this.rpcTimeoutMs,
      }),
    );
    this.cleanups.push(() => {
      __resetPeerRpcTransportForTests();
      __resetRemotePeersCacheForTests();
    });
    this.cleanups.push(() => {
      _resetCacheForTests();
      _resetBootHistoryForTests();
      if (this.priorWorkspaceEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = this.priorWorkspaceEnv;
    });

    // Mirror cell A's revocations into the authority's standing view (EI-284):
    // the test revokes via the substrate handle; the claim-op gate must see it.
    {
      const origRevoke = handleA.revoke.bind(handleA);
      handleA.revoke = async (devicePubkey: string) => {
        this.revokedByAuthority.add(devicePubkey);
        await origRevoke(devicePubkey);
      };
    }

    this.cells = {
      a: {
        name: 'a',
        electionPubkey: ELECT_A,
        announcePubkey: idA.devicePubkey,
        githubUserId: 4201,
        owner: 'shl-swarm-a',
        sql: dbA.sql,
        handle: handleA,
        store: storeA,
        deps: depsA,
        pipelineRuns: new Map(),
      },
      b: {
        name: 'b',
        electionPubkey: ELECT_B,
        announcePubkey: idB.devicePubkey,
        githubUserId: 4202,
        owner: 'shl-swarm-b',
        sql: dbB.sql,
        handle: handleB,
        store: storeB,
        deps: depsB,
        pipelineRuns: new Map(),
      },
    };
    // P-008/P-010 trust precondition (the gate landed in 674bd0fcd): each cell
    // ADMITS its peer Hive members' federated work. A remote row's author_pubkey
    // is the SENDING cell's own-log identity (`handle.ownLog.keyHex` — exactly
    // what log-snapshot stamps as op provenance, a hex log key, NOT the base64
    // announce device pubkey); the harness-features projection resolves it →
    // verified_author_github_user_id via a verified, non-revoked hive_members
    // device attestation, and the claim's trust leg (autoPickableWhereSql) then
    // admits it because that github id is in the local trust list. WITHOUT this,
    // autoPickableWhereSql CORRECTLY refuses cross-swarm work (remote +
    // un-admitted) and a peer's claim_next returns nothing — modeling a
    // legitimately-trusted shared Hive is the happy path's precondition.
    const allCells = [this.cells.a, this.cells.b];
    for (const self of allCells) {
      for (const peer of allCells) {
        if (peer === self) continue;
        const peerProvenancePubkey = peer.handle.ownLog.keyHex;
        await self.sql`
          INSERT INTO harness_shared.pot_members
            (workspace_id, github_user_id, binding_status, device_attestations, revoked_pubkeys)
          VALUES (${this.workspaceId}, ${peer.githubUserId}, 'verified',
                  ${JSON.stringify([{ device_pubkey: peerProvenancePubkey }])}::text::jsonb,
                  ARRAY[]::text[])
          ON CONFLICT (workspace_id, github_user_id) DO NOTHING`;
        await self.sql`
          INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id, created_ts)
          VALUES (${this.workspaceId}, ${peer.githubUserId}, ${this.now()})
          ON CONFLICT (workspace_id, trusted_github_user_id) DO NOTHING`;
      }
    }
    this.log(`rig up — topic ${handleA.swarm.topicHex.slice(0, 12)}…, authority ${this.serverUrl}`);
    return this;
  }

  async close(): Promise<void> {
    while (this.cleanups.length) {
      try {
        await this.cleanups.pop()!();
      } catch {
        /* best-effort — a thrown assertion must not leak a swarm/db/server */
      }
    }
  }

  // ── Chaos knobs ────────────────────────────────────────────────────────────

  /** The authority Swarm dies: its RPC endpoint closes and its presence FREEZES
   *  (so once `staleMs` passes — advance the clock — the survivor re-elects). */
  async killAuthority(): Promise<void> {
    this.authorityKilled = true;
    this.frozenLastSeen.set(this.cells.a.electionPubkey, this.now());
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.log('authority (cell a) killed — endpoint closed, presence frozen');
  }

  /** Partition the swarms: authority RPC unreachable (fail-open path). The CDC
   *  convergence "pause" is modeled by simply not calling converge() while
   *  partitioned — merge/drain are rig-driven (mergePollMs 0). */
  setPartitioned(on: boolean): void {
    this.partitioned = on;
    __resetRemotePeersCacheForTests();
    this.log(on ? 'partitioned — authority RPC now refused' : 'partition healed');
  }

  get isAuthorityKilled(): boolean {
    return this.authorityKilled;
  }

  // ── The composition verbs ──────────────────────────────────────────────────

  /** Seed backlog items on a cell (status todo, origin local → they federate). */
  async seedBacklog(
    cell: SwarmCell,
    items: Array<{ id: string; title?: string; kind?: 'feature' | 'chunk'; redundancy?: number }>,
  ): Promise<void> {
    const base = this.now();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // Staggered created_ts — the claim path tiebreaks on created_ts ASC, so
      // seeded ties would make the no-steering claim order nondeterministic.
      const t = base + i;
      // `redundancy` MUST be seeded (migration 195 loaded above adds the column).
      // P-007 (redundancy-two-swarm) + P-012/P-013 (fleet-monitors) assert the
      // marker federates / the double-completion scanner stays quiet on declared
      // redundancy — both go red if this column is dropped from the INSERT (it
      // was, once, on a "column doesn't exist" misdiagnosis — it does exist).
      // STATUS: 'open', NOT 'todo' (EI-20099366410545026). work-item-status-full-unify
      // (2026-07-19) retired the feature-family 'todo' token in favour of a single
      // claimable token shared with the issue family, and claimFloorsWhereSql defaults
      // to `states = ['open']` -- so a row seeded at 'todo' passes every other floor and
      // is then silently invisible to claimNextWorkItem, which returns null rather than
      // erroring. That is why P-001/P-012 asserted `expected undefined to be 'F-004'`
      // with a perfectly healthy rig. These suites last passed 2026-07-18 -- the DAY
      // BEFORE that cutover -- and the schema drift fixed above then piled 42703s on top,
      // masking this for three weeks. work-items.ts:3503 states the invariant this
      // fixture was violating: "no writer produces 'todo' and no row sits at it".
      await cell.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_human_review, ts, created_ts, updated_ts, redundancy)
        VALUES
          (${this.workspaceId}, ${this.harnessSlug}, ${it.id},
           ${it.title ?? `Item ${it.id}`}, ${'seeded by the composition rig'}, 'open', 0,
           ${it.kind ?? 'feature'}, FALSE, ${t}, ${t}, ${t}, ${it.redundancy ?? null})
        ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    }
  }

  /** Acquire the per-Hive authority lease for one item from one cell — the
   *  REAL route (local when self is authority, RPC otherwise, fail-open on
   *  unreachability), each cell's local leg bound to ITS OWN store. */
  async acquirePotLease(
    cell: SwarmCell,
    workItemId: string,
    opts: { owner?: string; ttlSec?: number; intent?: string } = {},
  ): Promise<{ via: ClaimNextOutcome['via']; value: AcquireResult }> {
    const payload: AcquireOpts = {
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      workItemId,
      potSlug: this.potSlug,
      owner: opts.owner ?? cell.owner,
      ownerLabel: `shl-cell-${cell.name}`,
      holderPubkey: cell.electionPubkey,
      ttlSec: opts.ttlSec ?? this.claimTtlSec,
      intent: opts.intent ?? 'work-stealing claim (claim_next)',
    };
    const route = await routeToAuthorityForHive<AcquireResult>(
      this.potSlug,
      {
        local: () => cell.store.acquire(payload),
        remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload, decode: (raw) => raw as AcquireResult },
      },
      cell.deps,
    );
    return { via: route.via, value: route.value };
  }

  /**
   * The production claim_next chain, flags-ON (D-003): the REAL
   * `claimNextWorkItem` (priority-ordered, affinity- and redundancy-aware
   * SKIP-LOCKED claim) on this cell's PG, then the per-Hive authority lease;
   * a lost lease releases the local claim (the loser's item returns to the
   * backlog) — byte-for-byte the work_items:claim_next tool's logic.
   */
  async claimNext(cell: SwarmCell): Promise<ClaimNextOutcome | null> {
    return this.runAsCell(cell, async () => {
      const wi = await claimNextWorkItem({
        harness: this.harnessSlug,
        assignee: cell.owner,
        swarmId: cell.electionPubkey,
        excludeRedundant: true,
      });
      if (!wi) return null;
      const lease = await this.acquirePotLease(cell, wi.id);
      if (!lease.value.ok) {
        await releaseWorkItem(wi.id, { harness: this.harnessSlug });
        return { item: wi, via: lease.via, leased: false, claim: null };
      }
      return { item: wi, via: lease.via, leased: true, claim: lease.value.claim };
    });
  }

  /**
   * The FAKE pipeline — the DBOS featurePipelineWorkflow stand-in (zero LLM).
   * Per-cell idempotency on the real workflow-id shape (a re-run on the SAME
   * Swarm dedupes — DBOS dedup analog; a re-run on the OTHER Swarm does NOT —
   * idempotency keys are per-swarm, the P-004 edge). Writes one EXTERNAL
   * side-effect ledger row (non-federated, the duplication detector's input)
   * and flips the item's status on this cell's PG (origin re-stamped local by
   * the migration-214 trigger → the completion federates back).
   */
  async runFakePipeline(
    cell: SwarmCell,
    workItemId: string,
    opts: { epoch?: number; midRun?: () => Promise<void>; terminalStatus?: string } = {},
  ): Promise<FakePipelineResult> {
    const key = `pipeline:${this.harnessSlug}:${workItemId}:e${opts.epoch ?? 0}`;
    const prior = cell.pipelineRuns.get(key);
    if (prior) return { ...prior, deduped: true };

    const stamp = (status: string) => cell.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET status = ${status}, updated_ts = ${this.now()}
       WHERE harness_slug = ${this.harnessSlug} AND feature_id = ${workItemId}`;

    await stamp('in-progress');
    await opts.midRun?.();
    // The EXTERNAL side effect — exactly once per (cell, item, epoch).
    await cell.sql`
      INSERT INTO harness_shared.rig_side_effects (work_item_id, executed_by, executed_at_ms, note)
      VALUES (${workItemId}, ${cell.name}, ${this.now()}, ${key})`;
    await stamp(opts.terminalStatus ?? 'passed');

    const result: FakePipelineResult = { ok: true, workItemId, executedBy: cell.name, deduped: false };
    cell.pipelineRuns.set(key, result);
    return result;
  }

  /**
   * The scripted Mug turn: read the federated backlog view from THIS cell's
   * PG, then steer with the REAL `setWorkItemPriority` (feature_order — the
   * exact column claim_next orders by). Returns the view it read (turn N+1's
   * view is the steering-monotonicity evidence).
   */
  async mugTurn(
    cell: SwarmCell,
    steer?: (view: BacklogRow[]) => Array<{ id: string; priority: number }>,
  ): Promise<{ view: BacklogRow[]; steered: Array<{ id: string; priority: number }> }> {
    const view = await this.readBacklog(cell);
    const steered = steer ? steer(view) : [];
    await this.runAsCell(cell, async () => {
      for (const s of steered) {
        const r = await setWorkItemPriority(s.id, s.priority, { harness: this.harnessSlug });
        if (!r || !r.applicable) throw new Error(`mugTurn: steering ${s.id} failed (${JSON.stringify(r)})`);
      }
    });
    return { view, steered };
  }

  /**
   * The Mug's CO-LOCATION lever (hive-coordination-model P-002): pin items
   * to swarms with the REAL `setWorkItemSwarmAffinity`. Under the lease flag,
   * claim_next SKIPS work affined to another swarm and PREFERS work affined
   * to the claimant — the production mechanism that makes concurrent
   * cross-swarm dispatch deterministic instead of a pure race.
   */
  async mugPinAffinity(cell: SwarmCell, pins: Array<{ id: string; swarmPubkey: string | null }>): Promise<void> {
    await this.runAsCell(cell, async () => {
      for (const p of pins) {
        const r = await setWorkItemSwarmAffinity(p.id, p.swarmPubkey, { harness: this.harnessSlug });
        if (!r) throw new Error(`mugPinAffinity: pinning ${p.id} failed`);
      }
    });
  }

  /**
   * Drive merge+drain to a HELD fixed point (the Stage-6 loop). `cells`
   * restricts which cells are driven — a killed swarm is modeled by simply
   * never driving it again (its replicated log stays readable to survivors).
   */
  async converge(opts: { maxPasses?: number; cells?: CellName[] } = {}): Promise<{ passes: number; fixedPoint: boolean }> {
    const max = opts.maxPasses ?? 12;
    const driven = (opts.cells ?? ['a', 'b']).map((n) => this.cells[n]);
    for (let pass = 1; pass <= max; pass++) {
      await Promise.all(driven.map((c) => c.handle.mergeNow()));
      const drains = await Promise.all(driven.map((c) => drainOutboxOnce(c.handle, c.sql)));
      if (drains.every((d) => d === 0)) {
        // Confirm the fixed point HOLDS across one more full cycle.
        await Promise.all(driven.map((c) => c.handle.mergeNow()));
        const again = await Promise.all(driven.map((c) => drainOutboxOnce(c.handle, c.sql)));
        if (again.every((d) => d === 0)) return { passes: pass, fixedPoint: true };
      }
      // Real swarm replication needs a beat between passes.
      await sleep(150);
    }
    return { passes: max, fixedPoint: false };
  }

  // ── Evidence readers ───────────────────────────────────────────────────────

  async readBacklog(cell: SwarmCell): Promise<BacklogRow[]> {
    return cell.sql<BacklogRow[]>`
      SELECT feature_id, status, taken_by, feature_order, item_kind, origin
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${this.harnessSlug}
       ORDER BY feature_id`;
  }

  async sideEffects(cell: SwarmCell): Promise<SideEffectRow[]> {
    return cell.sql<SideEffectRow[]>`
      SELECT work_item_id, executed_by, executed_at_ms
        FROM harness_shared.rig_side_effects
       ORDER BY executed_at_ms, work_item_id`;
  }

  async outboxDepth(cell: SwarmCell): Promise<number> {
    const rows = await cell.sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
    return Number(rows[0]?.n ?? 0);
  }
}

/** Boot a fresh 2-swarm composition rig (call `close()` in afterEach). */
export async function bootCompositionRig(opts: CompositionRigOpts = {}): Promise<CompositionRig> {
  return new CompositionRig(opts).boot();
}
