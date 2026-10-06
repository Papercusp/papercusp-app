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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
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

/** The canonical template owns schema, triggers, roles and defaults. Only
 *  rig-local state and canonical parent records are added to a cloned cell. */
async function setupCell(sql: postgres.Sql, opts: {
  workspaceId: string; harnessSlug: string; potSlug: string;
}): Promise<void> {
  // External pipeline effects must stay local, without a CDC capture trigger.
  await sql.unsafe(`
    CREATE TABLE harness_shared.rig_side_effects (
      work_item_id TEXT NOT NULL,
      executed_by TEXT NOT NULL,
      executed_at_ms BIGINT NOT NULL,
      note TEXT
    );
  `);
  await sql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-shl', 'SharedPotLoop', 'active', ${opts.harnessSlug}, ${opts.workspaceId}, 0, 0)`;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, title, created_at, updated_at)
    VALUES (${opts.workspaceId}, ${opts.potSlug}, decode(repeat('01', 32), 'hex'),
            'kc-shl-pot', 'Composition rig pot', 0, 0)`;
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
   * Extra per-cell setup run after canonical schema provisioning and rig seeds — for tests federating
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

    // Register teardown before provisioning: a failed second clone or extra
    // setup must still release the first database and restore the environment.
    this.cleanups.push(() => {
      if (this.priorWorkspaceEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = this.priorWorkspaceEnv;
    });
    const databases: OrgTestDb[] = [];
    this.cleanups.push(() => Promise.all(databases.map((db) => db.cleanup())).then(() => {}));
    const dbA = await createOrgTestDb({ adminPoolMax: 4 });
    databases.push(dbA);
    const dbB = await createOrgTestDb({ adminPoolMax: 4 });
    databases.push(dbB);
    const schemaOpts = { workspaceId: this.workspaceId, harnessSlug: this.harnessSlug, potSlug: this.potSlug };
    // Per-cell HLC clocks (NOT process-global processHlc()): two real Swarms are
    // separate processes with independent clocks, so each simulated cell gets its
    // own — both SEND (boot stampOpHlc) and RECV (apply observeRemoteHlc) seams.
    // Without this, both cells share one global clock and their concurrent drains
    // race the same counter, deciding cross-swarm LWW by drain-interleave.
    const hlcA = new HlcClock({ physical: () => this.now() });
    const hlcB = new HlcClock({ physical: () => this.now() });
    await setupCell(dbA.adminSql, schemaOpts);
    await setupCell(dbB.adminSql, schemaOpts);
    if (this.extraCellSetup) {
      await this.extraCellSetup(dbA.adminSql, schemaOpts);
      await this.extraCellSetup(dbB.adminSql, schemaOpts);
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
    handleA = await runWithCellSql(dbA.adminSql, () => bootHarnessSubstrate({
      workspaceRoot: rootA,
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      swarmBinding: binding,
      swarmOverride: mkSwarm(),
      verifyBindingOverride: async (_pk, _login, userId) => (userId === idB.userId ? 'verified' : 'fail'),
      applyOverride: (op) => {
        applyA ??= buildCellApply(dbA.adminSql, handleA!.ownLog.keyHex, schemaOpts, this.extraProjections, hlcA);
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

    handleB = await runWithCellSql(dbB.adminSql, () => bootHarnessSubstrate({
      workspaceRoot: rootB,
      workspaceId: this.workspaceId,
      harnessSlug: this.harnessSlug,
      swarmBinding: binding,
      swarmOverride: mkSwarm(),
      verifyBindingOverride: async (_pk, _login, userId) => (userId === idA.userId ? 'verified' : 'fail'),
      applyOverride: (op) => {
        applyB ??= buildCellApply(dbB.adminSql, handleB!.ownLog.keyHex, schemaOpts, this.extraProjections, hlcB);
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
        sql: dbA.adminSql,
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
        sql: dbB.adminSql,
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
            (workspace_id, pot_home_slug, github_user_id, github_username,
             binding_status, device_attestations, revoked_pubkeys)
          VALUES (${this.workspaceId}, ${this.potSlug}, ${peer.githubUserId}, ${`swarm-${peer.name}`}, 'verified',
                  ${JSON.stringify([{ device_pubkey: peerProvenancePubkey }])}::text::jsonb,
                  ARRAY[]::text[])
          ON CONFLICT (workspace_id, pot_home_slug, github_user_id) DO NOTHING`;
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

  /** Pending rows in the stream converge() actually drives. Template-seeded
   *  plan rows and pot-scoped membership CDC retain their separate scopes. */
  async outboxDepth(cell: SwarmCell): Promise<number> {
    const rows = await cell.sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
      WHERE workspace_id = ${this.workspaceId} AND harness_slug = ${this.harnessSlug}
        AND drained_at IS NULL`;
    return Number(rows[0]?.n ?? 0);
  }
}

/** Boot a fresh 2-swarm composition rig (call `close()` in afterEach). */
export async function bootCompositionRig(opts: CompositionRigOpts = {}): Promise<CompositionRig> {
  const rig = new CompositionRig(opts);
  try {
    return await rig.boot();
  } catch (error) {
    await rig.close();
    throw error;
  }
}
