/**
 * shared-hive-core suite — the live test list driven by the Tests tab
 * (`/adv?slug=papercup&tab=testing&testsTab=test-runs`, suite `shared-hive-core`)
 * and the test-runs orchestrator. The Shared-Hive sibling of `memory/suite/checks.ts`.
 *
 * Each check composes the REAL production federation modules (no
 * reimplementations) so a regression in the shipped logic turns a check red:
 *   - identity / topic re-key  — derive-swarm-topic.ts, identity/ed25519.ts
 *   - lock authority election  — authority/lock-authority.ts (selectAuthorityFromRows,
 *                                lockAuthorityForHive)
 *   - file-claim routing       — authority/file-lock-routing.ts (routeFileLockOp, P-009)
 *   - instant handover fold    — authority/lock-event-stream.ts (reconstructLockSet)
 *   - work-item claim/replica  — work-item-{claim,replica}-authority.ts seams
 *   - per-Hive admission union — hive-membership-store.ts + read-admission.ts (P-006)
 *
 * Most checks are HERMETIC — they drive the real functions through their injected
 * seams with synthetic in-memory inputs, so they are deterministic and safe to run
 * repeatedly against the live operator. The two PG-backed checks
 * (`presence.hive-election` and `membership.admission-union`) exercise the real SQL
 * paths; they confine ALL writes to a synthetic, run-scoped workspace/hive
 * (`__hivetest__/<runId>`) that no real authority election or admission ever queries,
 * and sweep them in a `finally`. They accept an injected `sql` so the CI guard
 * (`checks.integration.test.ts`) can point them at a throwaway testcontainer DB
 * instead of the live org PG.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

import {
  deriveHiveFederationTopic,
  deriveSwarmTopic,
  serializeBinding,
  topicAsHex,
} from '../../sync/hyperbee/derive-swarm-topic';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
  verifyEd25519,
} from '../../identity/ed25519';
import { hiveKeychainId } from '../../identity/hive-keypair';
import {
  selectAuthorityFromRows,
  lockAuthorityForHive,
  queryPresenceRowsForHive,
  DEFAULT_AUTHORITY_STALE_MS,
} from '../../authority/lock-authority';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import {
  reconstructLockSet,
  lockEventToPeerLogOp,
  peerLogOpToLockEvent,
  lockEventHbKey,
  LOCK_EVENT_TABLE,
  type LockEvent,
} from '../../authority/lock-event-stream';
import {
  LocalWorkItemClaimAuthority,
  getWorkItemClaimAuthority,
  setWorkItemClaimAuthority,
  resetWorkItemClaimAuthority,
  type WorkItemClaimAuthority,
} from '../../work-item-claim-authority';
import {
  LocalWorkItemReplicaAuthority,
  getWorkItemReplicaAuthority,
  resetWorkItemReplicaAuthority,
} from '../../work-item-replica-authority';
import { insertHiveIfAbsent, deleteHive } from '../../hive-store';
import {
  upsertHiveMember,
  addRevokedHivePubkeys,
  loadRevokedHivePubkeys,
} from '../../hive-membership-store';
import { unsafeFederatedPotScope } from '../../federated-pot-scope';
import { makeAdmissionDecider, type AdmissionInput } from '../../sync/hyperbee/read-admission';
import type { AdminTestCheckResult } from '../../admin-test-suites-shared';

type CheckResult = Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>;

export interface SharedPotSuiteDeps {
  /**
   * Postgres handle the PG-backed checks run against. Omitted in the live suite →
   * the org admin PG (`getOrgPg().sql`); injected by the CI guard with a fresh,
   * throwaway testcontainer DB so its writes never touch the dev/live DB.
   */
  sql?: Sql;
}

export interface SharedPotSuiteCheck {
  id: string;
  label: string;
  run: () => Promise<CheckResult>;
}

// ─── result helpers (mirror memory/suite/checks.ts) ──────────────────────────
function pass(actual: string, details?: string[]): CheckResult {
  return { status: 'pass', expected: 'Check completes successfully.', actual, details };
}
function fail(expected: string, actual: string, details?: string[]): CheckResult {
  return { status: 'fail', expected, actual, details };
}
function check(condition: boolean, expected: string, actualOk: string, actualFail: string, details?: string[]): CheckResult {
  return condition ? pass(actualOk, details) : fail(expected, actualFail, details);
}

/** A live presence row, shaped as lock-authority's selection input. */
function presenceRow(pubkey: string, lastSeenMs: number, gh = 1) {
  return { device_pubkey: pubkey, github_user_id: gh, machine_label: pubkey, last_seen_ms: lastSeenMs };
}

// ─── identity / topic re-key ─────────────────────────────────────────────────

/**
 * The Hive federation topic is the load-bearing re-key (D-003): a deterministic
 * 32-byte SHA-256 over `papercusp-substrate-v1:hive:<pubkey>`. Same pubkey ⇒ same
 * topic across runs/machines (peers must converge on ONE topic); distinct pubkeys
 * ⇒ distinct topics (Hives don't collide). Asserts the convenience wrapper matches
 * the explicit `hive:` binding and reuses the v1 substrate namespace.
 */
function checkTopicDerivation(): CheckResult {
  const { pubkeyBase64: pkA } = generateEd25519KeypairDer();
  const { pubkeyBase64: pkB } = generateEd25519KeypairDer();
  const topicA = deriveHiveFederationTopic(pkA);
  const topicA2 = deriveHiveFederationTopic(pkA);
  const topicB = deriveHiveFederationTopic(pkB);
  const viaBinding = deriveSwarmTopic({ kind: 'hive', hive_pubkey: pkA });

  const is32 = topicA.length === 32;
  const deterministic = topicA.equals(topicA2);
  const distinct = !topicA.equals(topicB);
  const wrapperMatches = topicA.equals(viaBinding);
  const serialized = serializeBinding({ kind: 'hive', hive_pubkey: pkA }) === `hive:${pkA}`;
  let emptyRejected = false;
  try {
    serializeBinding({ kind: 'hive', hive_pubkey: '' });
  } catch {
    emptyRejected = true;
  }

  const ok = is32 && deterministic && distinct && wrapperMatches && serialized && emptyRejected;
  return check(
    ok,
    'deriveHiveFederationTopic is a deterministic, collision-free 32-byte topic equal to the hive: binding.',
    `32-byte=${is32}, deterministic=${deterministic}, distinct-pubkeys-distinct-topics=${distinct}, wrapper==binding=${wrapperMatches}.`,
    `32-byte=${is32}, deterministic=${deterministic}, distinct=${distinct}, wrapper==binding=${wrapperMatches}, serialize=${serialized}, empty-rejected=${emptyRejected}.`,
    [`topic(A)=${topicAsHex(topicA).slice(0, 16)}…`, `topic(B)=${topicAsHex(topicB).slice(0, 16)}…`],
  );
}

/**
 * Hive identity rides Ed25519 (the same primitive `loadOrGenerateHiveKeypair` /
 * `signWithHiveKey` compose): a signature verifies against the hive pubkey only,
 * and a tampered message OR a wrong key fails closed. Also asserts the per-Hive
 * keychainId is scoped by (workspace, slug) so two Hives never share an identity.
 */
function checkKeypairSignVerify(): CheckResult {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  const other = generateEd25519KeypairDer();
  const msg = Buffer.from('hive-federation-envelope');
  const sig = signWithPrivateKeyDer(privateKeyDer, msg);

  const verifies = verifyEd25519(msg, pubkeyBase64, sig);
  const tamperFails = !verifyEd25519(Buffer.from('hive-federation-envelopX'), pubkeyBase64, sig);
  const wrongKeyFails = !verifyEd25519(msg, other.pubkeyBase64, sig);
  const idScoped =
    hiveKeychainId('ws-1', 'alpha') === 'hive:ws-1:alpha' &&
    hiveKeychainId('ws-1', 'alpha') !== hiveKeychainId('ws-2', 'alpha') &&
    hiveKeychainId('ws-1', 'alpha') !== hiveKeychainId('ws-1', 'beta');

  const ok = verifies && tamperFails && wrongKeyFails && idScoped;
  return check(
    ok,
    'Ed25519 hive signature verifies against its pubkey only; tamper/wrong-key fail; keychainId is (ws,slug)-scoped.',
    'Sign/verify round-trips; tampered message and wrong key both fail closed; keychainId scoped per (workspace,slug).',
    `verifies=${verifies}, tamper-fails=${tamperFails}, wrong-key-fails=${wrongKeyFails}, id-scoped=${idScoped}.`,
  );
}

// ─── lock authority election (Track B) ───────────────────────────────────────

/**
 * The pure D-005 election core: argmin(device_pubkey) over fresh peers, stale rows
 * (older than the staleness window) dropped, self added as a candidate, and an
 * empty set ⇒ alone ⇒ isSelf. Deterministic regardless of input order — every peer
 * must independently elect the SAME authority or the lock serializes nowhere.
 */
function checkElectionCore(): CheckResult {
  const now = 1_700_000_000_000;
  const fresh = now - 1_000;
  const stale = now - (DEFAULT_AUTHORITY_STALE_MS + 60_000);

  // Remote 'aaa' is the global min and fresh → it is the authority; self 'mmm' is not.
  const r1 = selectAuthorityFromRows(
    [presenceRow('mmm', fresh), presenceRow('aaa', fresh), presenceRow('zzz', fresh)],
    { githubUserId: 1, devicePubkey: 'mmm' },
    now,
    DEFAULT_AUTHORITY_STALE_MS,
  );
  // Order independence — shuffle the same rows, same winner.
  const r1b = selectAuthorityFromRows(
    [presenceRow('zzz', fresh), presenceRow('aaa', fresh), presenceRow('mmm', fresh)],
    { githubUserId: 1, devicePubkey: 'mmm' },
    now,
    DEFAULT_AUTHORITY_STALE_MS,
  );
  // The min peer 'aaa' is STALE → drops out; self 'mmm' becomes the min live → isSelf.
  const r2 = selectAuthorityFromRows(
    [presenceRow('aaa', stale), presenceRow('mmm', fresh), presenceRow('zzz', fresh)],
    { githubUserId: 1, devicePubkey: 'mmm' },
    now,
    DEFAULT_AUTHORITY_STALE_MS,
  );
  // No peers, no self identity → single box → isSelf, liveCount 0.
  const r3 = selectAuthorityFromRows([], null, now, DEFAULT_AUTHORITY_STALE_MS);

  const remoteMin = r1.isSelf === false && r1.peer?.devicePubkey === 'aaa' && r1.liveCount === 3;
  const orderStable = r1b.peer?.devicePubkey === r1.peer?.devicePubkey && r1b.liveCount === r1.liveCount;
  const staleDropped = r2.isSelf === true && r2.liveCount === 2;
  const alone = r3.isSelf === true && r3.liveCount === 0;

  const ok = remoteMin && orderStable && staleDropped && alone;
  return check(
    ok,
    'selectAuthorityFromRows elects argmin(live device_pubkey), drops stale peers, adds self, and is order-independent.',
    'argmin over fresh peers, stale dropped, self-alone ⇒ isSelf, order-independent.',
    `remote-min=${remoteMin}, order-stable=${orderStable}, stale-dropped=${staleDropped}, alone=${alone}.`,
  );
}

/**
 * The Hive-scoped orchestration `lockAuthorityForHive` over its injected presence
 * seam — ONE authority across a Hive's Swarms (P-009). Proves the real freshness +
 * self-add + argmin pipeline (not just the pure core): a remote-min Swarm ⇒ not us;
 * a self-min Swarm ⇒ us; and the eviction monitor is force-disabled for determinism.
 */
async function checkPotAuthorityOrchestration(): Promise<CheckResult> {
  const now = 1_700_000_000_000;
  const base = {
    resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'mmm' }),
    now: () => now,
    staleMs: DEFAULT_AUTHORITY_STALE_MS,
    evictionMonitor: null as null,
  };

  // A remote Swarm 'aaa' is the Hive authority (< self 'mmm').
  const remote = await lockAuthorityForHive('hive-x', {
    ...base,
    fetchHivePresenceRows: async (slug) => (slug === 'hive-x' ? [presenceRow('aaa', now - 1_000)] : []),
  });
  // Only self in the Hive presence → we are the authority.
  const selfWins = await lockAuthorityForHive('hive-x', {
    ...base,
    fetchHivePresenceRows: async () => [presenceRow('mmm', now - 1_000)],
  });
  // No Swarms at all → alone → self.
  const empty = await lockAuthorityForHive('hive-x', { ...base, fetchHivePresenceRows: async () => [] });

  const ok =
    remote.isSelf === false &&
    remote.peer?.devicePubkey === 'aaa' &&
    selfWins.isSelf === true &&
    empty.isSelf === true &&
    empty.liveCount <= 1;
  return check(
    ok,
    'lockAuthorityForHive elects one authority across the Hive Swarms: remote-min ⇒ not-self, self-min/empty ⇒ self.',
    'Remote-min Swarm ⇒ {isSelf:false, peer:aaa}; self-only and empty ⇒ {isSelf:true}.',
    `remote={isSelf:${remote.isSelf}, peer:${remote.peer?.devicePubkey}}, self={isSelf:${selfWins.isSelf}}, empty={isSelf:${empty.isSelf}}.`,
  );
}

// ─── file-claim routing (P-009) ──────────────────────────────────────────────

/**
 * `routeFileLockOp` scope resolution: a Hive member's file-claim serializes at the
 * HIVE authority (local when we're it, fail-open with a `hive "…"` warning when a
 * remote Swarm is the min); a non-Hive harness stays harness-scoped; an unmanaged
 * domain runs locally; and a Hive with no remote Swarms takes the local fast-path
 * (no authority query). Synthetic, run-scoped slugs keep the remote-peers cache
 * isolated from real routing entries.
 */
async function checkFileLockRouting(runId: string): Promise<CheckResult> {
  const now = 1_700_000_000_000;
  const HARNESS = `__hivetest_h_${runId}`;
  const HIVE = `__hivetest_route_${runId}`;
  // WI-5190: HRW_RENDEZVOUS_AUTHORITY graduated to default-ON 2026-07-17 — without
  // pinning it, resolveUseHrwRendezvous() reads the LIVE flag and this check
  // silently started exercising selectAuthorityRendezvous's hash-based winner
  // instead of the row-argmin selectAuthorityFromRows this check's fixtures were
  // written against, breaking the hive-fail-open sub-assertion. This check's job
  // is file-claim ROUTING SCOPE (P-009: hive vs harness vs local) — WHICH authority
  // algorithm picks the peer within a tier is exercised by its own dedicated
  // suite (rendezvous-authority.test.ts), so pin it OFF here to keep this check
  // isolated to what it actually tests, independent of that unrelated flag.
  const forced = { domainToHarnessSlug: () => HARNESS, now: () => now, skipRemotePeersFastPath: true, useHrwRendezvous: false };

  // Hive member, we are the authority (no remote Swarm) → local.
  let ranLocal = false;
  const hiveLocal = await routeFileLockOp(
    '/repo',
    { local: async () => { ranLocal = true; return 1; } },
    { ...forced, harnessToPotSlug: () => HIVE, fetchHivePresenceRows: async () => [], resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }) },
  );
  // Hive member, a remote Swarm 'aaa' is the authority and we're 'zzz' → fail-open, hive-scoped warning.
  const potFailOpen = await routeFileLockOp(
    '/repo',
    { local: async () => 2 },
    { ...forced, harnessToPotSlug: () => HIVE, fetchHivePresenceRows: async () => [presenceRow('aaa', now)], resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'zzz' }) },
  );
  // NON-Hive harness → harness-scoped authority (unchanged behaviour).
  const harnessScoped = await routeFileLockOp(
    '/repo',
    { local: async () => 3 },
    { ...forced, harnessToPotSlug: () => null, fetchPresenceRows: async () => [presenceRow('aaa', now)], resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'zzz' }) },
  );
  // Unmanaged domain → local.
  const unmanaged = await routeFileLockOp('/x', { local: async () => 5 }, { domainToHarnessSlug: () => null });
  // No remote Swarms → local fast-path (no authority query, no skip flag).
  let ranFast = false;
  const fastPath = await routeFileLockOp(
    '/repo',
    { local: async () => { ranFast = true; return 6; } },
    { domainToHarnessSlug: () => HARNESS, harnessToPotSlug: () => `${HIVE}-fp`, now: () => now, fetchHivePresenceRows: async () => [], resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }) },
  );

  const potLocalOk = ranLocal && hiveLocal.via === 'local-authority';
  const potFailOpenOk = potFailOpen.via === 'fail-open' && potFailOpen.value === 2 && /hive "/.test(potFailOpen.warning ?? '') && potFailOpen.warning?.includes(HIVE) === true;
  const harnessOk = harnessScoped.via === 'fail-open' && /harness "/.test(harnessScoped.warning ?? '') && harnessScoped.warning?.includes(HARNESS) === true;
  const unmanagedOk = unmanaged.via === 'local-authority' && unmanaged.value === 5;
  const fastOk = ranFast && fastPath.via === 'local-authority';

  const ok = potLocalOk && potFailOpenOk && harnessOk && unmanagedOk && fastOk;
  return check(
    ok,
    'routeFileLockOp routes Hive members to the Hive authority, non-members to the harness authority, and fails open / fast-paths locally.',
    'Hive-local, Hive-fail-open (hive warning), harness-scoped (harness warning), unmanaged-local, no-peer fast-path all correct.',
    `hive-local=${potLocalOk}, hive-fail-open=${potFailOpenOk}, harness=${harnessOk}, unmanaged=${unmanagedOk}, fast-path=${fastOk}.`,
    [`hive warning: ${potFailOpen.warning ?? '(none)'}`, `harness warning: ${harnessScoped.warning ?? '(none)'}`],
  );
}

// ─── instant lock-authority handover fold (P-015) ────────────────────────────

/**
 * `reconstructLockSet` — the pure fold a NEW authority applies to the peer-log
 * lock-event stream on takeover (instant handover, no heartbeat wait): an
 * unexpired acquire is held; the latest-ts event per (scope,path) wins so a release
 * frees and a re-acquire re-holds; an expired-TTL acquire is freed; a same-ts tie
 * resolves to free (the safe state); and the event order does not change the result.
 */
function checkLockEventFold(): CheckResult {
  const t0 = 1_700_000_000_000;
  const acq = (path: string, owner: string, ts: number, ttl = 60_000): LockEvent => ({ kind: 'acquire', scope: 'h', path, owner, expiresAtMs: ts + ttl, ts });
  const rel = (path: string, owner: string, ts: number): LockEvent => ({ kind: 'release', scope: 'h', path, owner, ts });

  const held = reconstructLockSet([acq('a.ts', 'p1', t0)], t0 + 1_000);
  const heldOk = held.length === 1 && held[0].path === 'a.ts' && held[0].owner === 'p1';

  const released = reconstructLockSet([acq('a.ts', 'p1', t0), rel('a.ts', 'p1', t0 + 100)], t0 + 1_000);
  const reAcq = reconstructLockSet([acq('a.ts', 'p1', t0), rel('a.ts', 'p1', t0 + 100), acq('a.ts', 'p2', t0 + 200)], t0 + 1_000);
  const reAcqOk = released.length === 0 && reAcq.length === 1 && reAcq[0].owner === 'p2';

  const expired = reconstructLockSet([acq('a.ts', 'p1', t0, 5_000)], t0 + 6_000);
  const tie = reconstructLockSet([acq('a.ts', 'p1', t0), rel('a.ts', 'p1', t0)], t0 + 1_000);
  const expiredTieOk = expired.length === 0 && tie.length === 0;

  const ordered = reconstructLockSet([acq('a.ts', 'p1', t0), rel('a.ts', 'p1', t0 + 100)], t0 + 1_000);
  const reversed = reconstructLockSet([rel('a.ts', 'p1', t0 + 100), acq('a.ts', 'p1', t0)], t0 + 1_000);
  const orderOk = JSON.stringify(ordered) === JSON.stringify(reversed) && reversed.length === 0;

  // peer-log carriage round-trip: event → PeerLogOp → event; foreign op → null.
  const ev = acq('a.ts', 'p1', t0);
  const op = lockEventToPeerLogOp(ev, 'authorkey');
  const roundTrips =
    op.table === LOCK_EVENT_TABLE &&
    op.hbKey === lockEventHbKey('h', 'a.ts') &&
    JSON.stringify(peerLogOpToLockEvent(op)) === JSON.stringify(ev) &&
    peerLogOpToLockEvent({ type: 'put', table: 'working-set', hbKey: 'x', value: {}, ts: t0, schema_version: 1, author_pubkey: '' }) === null;

  const ok = heldOk && reAcqOk && expiredTieOk && orderOk && roundTrips;
  return check(
    ok,
    'reconstructLockSet folds acquire/release/TTL latest-wins (order-independent) and round-trips events through the peer-log op.',
    'Held, released/re-acquired, expired+tie freed, order-independent, peer-log op round-trips.',
    `held=${heldOk}, re-acquire=${reAcqOk}, expired/tie=${expiredTieOk}, order=${orderOk}, round-trip=${roundTrips}.`,
  );
}

// ─── work-item claim / replica authority seams ───────────────────────────────

/**
 * The work-item claim & replica authority seams (decentralized-dispatch-scaling
 * D-002 / EI-266). On a single box the default is the Local authority: `isSelf` is
 * always true and `route` runs the op's local leg. The swap-in point installs a
 * real router with no store change; reset restores Local. Proves the passthrough
 * invariant the claim/replica stores depend on.
 */
async function checkClaimReplicaSeam(): Promise<CheckResult> {
  try {
    const claimDefaultLocal = getWorkItemClaimAuthority() instanceof LocalWorkItemClaimAuthority;
    const local = new LocalWorkItemClaimAuthority();
    const isSelf = await local.isSelf('hive-x');
    let ran = false;
    const routed = await local.route('hive-x', { local: async () => { ran = true; return 42; } });
    const routedOk = isSelf === true && ran && routed === 42;

    // Swap in a fake router, confirm the seam returns it, then reset to Local.
    const fake: WorkItemClaimAuthority = { isSelf: async () => false, route: async (_h, op) => op.local() };
    setWorkItemClaimAuthority(fake);
    const swapped = getWorkItemClaimAuthority() === fake;
    resetWorkItemClaimAuthority();
    const resetOk = getWorkItemClaimAuthority() instanceof LocalWorkItemClaimAuthority;

    // Replica seam mirrors the claim seam.
    const replicaDefaultLocal = getWorkItemReplicaAuthority() instanceof LocalWorkItemReplicaAuthority;
    const replicaIsSelf = await new LocalWorkItemReplicaAuthority().isSelf('hive-x');
    resetWorkItemReplicaAuthority();

    const ok = claimDefaultLocal && routedOk && swapped && resetOk && replicaDefaultLocal && replicaIsSelf;
    return check(
      ok,
      'The claim/replica authority seams default to Local (isSelf=true, route runs local), swap, and reset.',
      'Local default, local routing, swap-in + reset both work for claim and replica seams.',
      `claim-default-local=${claimDefaultLocal}, routed=${routedOk}, swapped=${swapped}, reset=${resetOk}, replica-default-local=${replicaDefaultLocal}, replica-isSelf=${replicaIsSelf}.`,
    );
  } finally {
    // Never leave a fake router installed for the live operator.
    resetWorkItemClaimAuthority();
    resetWorkItemReplicaAuthority();
  }
}

// ─── PG-backed: real shared_presence election (P-009) ────────────────────────

const SUITE_WS = (runId: string) => `__hivetest__/${runId}`;

/**
 * Confines all PG writes to the run-scoped synthetic workspace, so cleanup is a
 * single sweep and no real election/admission ever sees the rows.
 */
async function sweepSuiteWorkspace(sql: Sql, runId: string): Promise<void> {
  const ws = SUITE_WS(runId);
  await sql.unsafe(`DELETE FROM harness_shared.shared_presence WHERE workspace_id = $1`, [ws]).catch(() => undefined);
  // pot_members FK-cascades from pots; delete the pot last.
  await sql.unsafe(`DELETE FROM harness_shared.pots WHERE workspace_id = $1`, [ws]).catch(() => undefined);
}

/**
 * The REAL Hive presence query feeding the REAL election. Seeds `shared_presence`
 * rows under a run-scoped synthetic Hive, proves `queryPresenceRowsForHive` returns
 * exactly that Hive's Swarms — excluding a DIFFERENT Hive's row, a NULL-hive_slug
 * row (a non-Hive harness's presence, which must never pollute a Hive election), and
 * an empty-pubkey row (the SQL `WHERE hive_slug = ? AND device_pubkey <> ''`) — and
 * that piping the real query into `lockAuthorityForHive` elects the live argmin (the
 * stale Swarm dropped by the TS freshness filter). The other-Hive and NULL-slug rows
 * use `000-*` pubkeys (global minima) so any scoping leak would visibly change both
 * the returned set AND the elected winner.
 */
async function checkPresenceElectionPg(runId: string, sql: Sql): Promise<CheckResult> {
  const ws = SUITE_WS(runId);
  const hive = `__hivetest_hive_${runId}`;
  const otherHive = `__hivetest_other_${runId}`;
  const harness = `__hivetest_h_${runId}`;
  const now = Date.now();
  const seed = async (pubkey: string, ml: string, lastSeenMs: number, potSlug: string | null) =>
    sql.unsafe(
      `INSERT INTO harness_shared.shared_presence
         (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey, pot_slug, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000.0))`,
      [ws, harness, 1, ml, pubkey, potSlug, lastSeenMs],
    );
  try {
    await seed('aaa-fresh', 'm-aaa', now - 1_000, hive); // global-min live → authority
    await seed('mmm-fresh', 'm-mmm', now - 1_000, hive);
    await seed('bbb-stale', 'm-bbb', now - (DEFAULT_AUTHORITY_STALE_MS + 60_000), hive); // dropped by freshness
    await seed('000-other', 'm-oth', now - 1_000, otherHive); // different Hive — must NOT leak
    await seed('000-nullhive', 'm-null', now - 1_000, null); // non-Hive harness (hive_slug NULL) — must NOT leak
    await seed('', 'm-empty', now - 1_000, hive); // empty pubkey — excluded by SQL

    const rows = await queryPresenceRowsForHive(sql as never, hive);
    const got = rows.map((r) => r.device_pubkey).sort();
    const queryOk = got.length === 3 && got.join(',') === ['aaa-fresh', 'bbb-stale', 'mmm-fresh'].join(',');

    const resolution = await lockAuthorityForHive(hive, {
      fetchHivePresenceRows: async () => queryPresenceRowsForHive(sql as never, hive),
      resolveSelf: async () => null, // a read-only observer with no swarm identity
      now: () => now,
      staleMs: DEFAULT_AUTHORITY_STALE_MS,
      evictionMonitor: null,
    });
    // self=null + remote authority → fail-open path returns the remote peer.
    const electionOk = resolution.isSelf === false && resolution.peer?.devicePubkey === 'aaa-fresh' && resolution.liveCount === 2;

    const ok = queryOk && electionOk;
    return check(
      ok,
      'queryPresenceRowsForHive returns only the Hive Swarms (no other-Hive/empty leak) and feeds the real election to the live argmin.',
      `Query returned [${got.join(', ')}]; election authority = ${resolution.peer?.devicePubkey} over ${resolution.liveCount} live.`,
      `query-ok=${queryOk} (got [${got.join(', ')}]), election-ok=${electionOk} (authority=${resolution.peer?.devicePubkey}, live=${resolution.liveCount}).`,
    );
  } finally {
    await sql.unsafe(`DELETE FROM harness_shared.shared_presence WHERE workspace_id = $1`, [ws]).catch(() => undefined);
  }
}

// ─── PG-backed: per-Hive admission union (P-006) ─────────────────────────────

/**
 * The per-Hive admission UNION (shared-hive-federation P-006): a contributor revoked
 * at the HIVE grain is refused on every member harness. Seeds a synthetic Hive,
 * revokes a target device pubkey on the owner's row (`addRevokedHivePubkeys` —
 * single-writer-own-row), proves `loadRevokedHivePubkeys` returns the union, and
 * that the REUSED read-admission decider (`makeAdmissionDecider`) refuses the revoked
 * pubkey (`reason:'revoked'`, BEFORE the binding gate) while admitting a fresh one.
 */
async function checkAdmissionUnionPg(runId: string, sql: Sql): Promise<CheckResult> {
  const ws = SUITE_WS(runId);
  const hive = `__hivetest_adm_${runId}`;
  const revokedPk = `revoked-${runId}`;
  const freshPk = `fresh-${runId}`;
  try {
    await insertHiveIfAbsent(
      { workspaceId: ws, homeSlug: hive, pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64, keychainId: hiveKeychainId(ws, hive) },
      sql,
    );
    // EI-18777176681958978 / WI-6312: certified — `hive` is a synthetic slug this check both
    // WRITES (insertHiveIfAbsent/upsertHiveMember below) and READS, so local == federated by
    // construction; there is no joiner topology in a self-contained suite fixture.
    // Declared BEFORE the first write so the write side is certified too, not just the reads.
    const scope = unsafeFederatedPotScope(hive, 'suite fixture writes and reads the same synthetic pot slug');

    await upsertHiveMember({ workspaceId: ws, potHomeSlug: scope, githubUserId: 1, githubUsername: 'owner', bindingStatus: 'verified' }, sql);

    // Empty union before any revoke.
    const before = await loadRevokedHivePubkeys(ws, scope, sql);
    const startsEmpty = before.size === 0;

    await addRevokedHivePubkeys(ws, scope, 1, [revokedPk], sql);
    const revoked = await loadRevokedHivePubkeys(ws, scope, sql);
    const unionHasRevoked = revoked.has(revokedPk) && !revoked.has(freshPk);

    const decide = makeAdmissionDecider({ revoked, verifyBinding: async () => 'verified' });
    const announce = (pk: string): AdmissionInput => ({ device_pubkey: pk, github_login: 'octo', github_user_id: 1, attestation_gist_id: 'g', sigValid: true });
    const revokedDecision = await decide(announce(revokedPk));
    const freshDecision = await decide(announce(freshPk));
    const refusesRevoked = revokedDecision.admit === false && revokedDecision.reason === 'revoked';
    const admitsFresh = freshDecision.admit === true;

    const ok = startsEmpty && unionHasRevoked && refusesRevoked && admitsFresh;
    return check(
      ok,
      'A Hive-grain revoked pubkey enters the admission union and is refused (reason:revoked) by the reused decider; a fresh pubkey is admitted.',
      'Union empty → revoke → union has it → decider refuses revoked (reason:revoked), admits fresh.',
      `starts-empty=${startsEmpty}, union-has-revoked=${unionHasRevoked}, refuses-revoked=${refusesRevoked} (reason=${revokedDecision.admit ? 'n/a' : revokedDecision.reason}), admits-fresh=${admitsFresh}.`,
    );
  } finally {
    await deleteHive(ws, hive, sql).catch(() => undefined);
  }
}

// ─── suite assembly ──────────────────────────────────────────────────────────

export function buildSharedHiveCoreChecks(runId: string, deps: SharedPotSuiteDeps = {}): SharedPotSuiteCheck[] {
  const sql = (): Sql => deps.sql ?? getOrgPg().sql;
  return [
    { id: 'setup', label: 'Suite setup', run: async () => {
      // Sweep any debris from a prior crashed run under this runId before seeding.
      await sweepSuiteWorkspace(sql(), runId);
      return pass(`Synthetic workspace ${SUITE_WS(runId)} swept; federation modules loaded.`);
    } },
    { id: 'identity.topic-rekey', label: 'Hive federation topic re-key', run: async () => checkTopicDerivation() },
    { id: 'identity.keypair-sign-verify', label: 'Hive Ed25519 sign/verify', run: async () => checkKeypairSignVerify() },
    { id: 'authority.election-core', label: 'Lock authority election core (D-005)', run: async () => checkElectionCore() },
    { id: 'authority.hive-orchestration', label: 'Per-Hive lock authority (P-009)', run: checkPotAuthorityOrchestration },
    { id: 'authority.file-lock-routing', label: 'File-claim routing scope (P-009)', run: async () => checkFileLockRouting(runId) },
    { id: 'authority.lock-event-fold', label: 'Instant handover lock-event fold (P-015)', run: async () => checkLockEventFold() },
    { id: 'dispatch.claim-replica-seam', label: 'Work-item claim/replica authority seam', run: checkClaimReplicaSeam },
    { id: 'presence.hive-election', label: 'Real shared_presence Hive election', run: async () => checkPresenceElectionPg(runId, sql()) },
    { id: 'membership.admission-union', label: 'Per-Hive admission union (P-006)', run: async () => checkAdmissionUnionPg(runId, sql()) },
    { id: 'cleanup', label: 'Cleanup: sweep synthetic workspace', run: async () => {
      await sweepSuiteWorkspace(sql(), runId);
      return pass(`Synthetic workspace ${SUITE_WS(runId)} swept.`);
    } },
  ];
}
