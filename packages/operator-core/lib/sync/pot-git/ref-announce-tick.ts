/**
 * pot-git/ref-announce-tick.ts — P-202: the RUNTIME DRIVER for ref
 * announcements (p2p-git-live-activation-2026-07-09 P-202).
 *
 * Every piece already exists as a pure library: `ref-announce.ts` (G-3
 * build/verify/accept/handle), `sigrefs.ts` (G-4 build/read/verify),
 * `fetch-transport.ts` (G-2 transport core). NONE of it runs on a schedule
 * yet — this module is that missing tick, composed exactly the way
 * `integrator-tick.ts` (P-203) and `github-bridge-tick.ts` compose their own
 * already-landed legs (D-003: no new scheduler — the caller rides the
 * existing `system:git-sync` tick, mode-gated to `hiveGit.mode != legacy`).
 * Like `integrator-tick.ts`, this module stops at the pure tick: the actual
 * git-sync-action.ts wiring (collecting the fed-event log, persisting the
 * budget-state map, opening the real Protomux stream) is the shared P-205
 * "wiring completeness pass".
 *
 * TWO TICKS, each pure over injected git/transport seams and never-throwing:
 *
 * `runRefAnnouncePublishTick` — run after a local commit:
 *   1. Read the current namespace ref-set (excluding `SIGREFS_REF`) and
 *      compare it against the PRIOR stored sigrefs snapshot's refs (pure
 *      equality) — unchanged ⇒ no-op. Without this check every tick would
 *      rebuild+bump+announce a sigrefs version even when nothing moved,
 *      spamming the hive-wide announce channel on every idle git-sync tick.
 *   2. Changed ⇒ `buildSigrefs` (G-4, auto-incrementing version) then
 *      `buildRefAnnouncement` (G-3). Returns the signed announcement for the
 *      caller to `events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive',
 *      payload }` hive-wide — mirroring how `integrator-tick.ts` returns its
 *      `SignedStagingAdvance` for the caller to emit + persist.
 *
 * `runRefAnnounceReceiveTick` — given the pending inbound announcements the
 * caller collected off the P-009 fed-event log since its watermark (oldest
 * first, one entry per `pot-git:ref-announce` fed_event row not yet
 * processed):
 *   1. Runs `handleRefAnnouncement` per announcement, threading a per-device
 *      budget map (persisted by the caller across ticks — the same idiom
 *      `github-bridge-tick`'s caller persists `last_admitted`) and the
 *      caller's `openStream` transport seam (prod: a per-fetch Protomux
 *      sub-stream on the `papercusp/pot-git` channel — wired separately;
 *      P-201's serve plane is its server half. Tests: a socketpair, exactly
 *      like `ref-announce.integration.test.ts`).
 *   2. A rejected/failed announcement never throws or halts the batch — every
 *      leg reports through the per-announcement result, so one hostile/broken
 *      peer's announcement can never starve the rest of the batch.
 *
 * Never throws — every failure is folded into `errors`; a tick that hits one
 * always still returns its partial results.
 */
import { Duplex } from 'node:stream';
import { defaultRunGit, type RunGit, listNamespaceRefs, type NamespaceRef, deviceNamespaceKey } from './storage';
import { DEFAULT_FETCH_TIMEOUT_MS } from './fetch-transport';
import { deriveNamespaceGenesisBaseline } from './namespace-genesis-baseline';
import { SIGREFS_REF, SIGREFS_SCHEMA_VERSION_CONTEXT, buildSigrefs, readSigrefs, type SignedSigrefs } from './sigrefs';
import {
  buildRefAnnouncement,
  handleRefAnnouncement,
  type AnnounceBudgetConfig,
  type AnnounceBudgetState,
  type HandleRefAnnouncementOpts,
  type RefAnnounceHandleResult,
  type SignedRefAnnouncement,
} from './ref-announce';
import { compareGenerationVersion, signedProtocolContextMatches, isSignedProtocolContext, type SignedProtocolContext, type ExpectedSignedProtocolContext, type SignedSnapshotFloor } from './signed-context';
import {
  checkPublishGuard,
  describePublishRefusal,
  type PublishGuardCaps,
  type PublishGuardResult,
} from './publish-guard';

// ── Publish tick ─────────────────────────────────────────────────────────

export interface RefAnnouncePublishTickInput {
  repoPath: string;
  /** THIS device's identity pubkey (base64) — the announcing device. */
  devicePubkeyBase64: string;
  /** Device signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`). */
  sign: (bytes: Buffer) => Promise<Buffer>;
  nowMs?: number;
  /** Last version this device durably recorded outside the bare store. A cold
   *  join removes the store-local watermark; this floor prevents the rebuilt
   *  device from resetting to v1 and being rejected by peers as rollback. */
  versionFloor?: number;
  runGit?: RunGit;
  /** G-10 own-namespace publish-admission caps (secrets-guard.ts / P-205).
   *  Omit for the module defaults (matches foreign-mirror-quarantine's own
   *  blob-size posture). */
  publishGuardCaps?: PublishGuardCaps;
  /**
   * LAST-RESORT genesis baseline for FIRST-EVER sigrefs, used only when the
   * per-ref walk below cannot answer.
   *
   * ⚠ WI-6251: this is a WORKTREE-derived, SINGLE-BRANCH sha, and this tick
   * judges EVERY ref of this device's namespace in the BARE store. It is the
   * right answer for at most one of them. Relying on it as the primary was the
   * 4GB-heap OOM on the rig — see namespace-genesis-baseline.ts. The tick now
   * derives the baseline PER REF, in the bare store, and falls back to this
   * only when that walk returns nothing.
   */
  genesisBaselineSha?: string | null;
  /** WI-5738: workspace whose runtime secrets-guard path exemptions apply (see
   *  PublishGuardInput.workspaceId). Omitted ⇒ static FIXTURE_FILES only. */
  workspaceId?: string;
  /** Context bound into v2 sigrefs/announcements when supplied. */
  context?: SignedProtocolContext;
}

export interface RefAnnouncePublishTickOutcome {
  ran: boolean;
  /** true when the namespace ref-set changed since the prior sigrefs snapshot
   *  AND every changed ref cleared the publish guard (a fresh sigrefs +
   *  announcement were built this tick). false ⇒ nothing to announce — either
   *  the common no-op case (nothing new under this device's namespace) or a
   *  guard REFUSAL (see `refused`) — check `refused` to tell the two apart. */
  changed: boolean;
  /** Set only when `changed` — the caller MUST emit it hive-wide
   *  (`events:emit { event: REF_ANNOUNCE_EVENT_KEY, scope: 'hive', payload }`)
   *  and may persist it for observability (mirrors `announcement` on
   *  `IntegratorTickOutcome`). */
  announcement: SignedRefAnnouncement | null;
  /** Set when a changed ref's (fromOid, toOid] range was REFUSED by the G-10
   *  publish guard (secrets / oversized blob / object-flood) — the whole
   *  publish for this tick was skipped (no sigrefs bump, nothing signed,
   *  nothing announced). Namespace-wide, safe to retry next tick: nothing
   *  was exposed. A deliberate refusal, not a transient error — the caller
   *  should log it loudly (`describePublishRefusal`). */
  refused: PublishGuardResult | null;
  errors: string[];
}

function sameRefs(a: readonly NamespaceRef[], b: readonly NamespaceRef[]): boolean {
  if (a.length !== b.length) return false;
  // Both sides are already ref-sorted (listNamespaceRefs / buildSigrefs sort by ref).
  for (let i = 0; i < a.length; i++) {
    if (a[i].ref !== b[i].ref || a[i].sha !== b[i].sha) return false;
  }
  return true;
}

/**
 * ONE publish tick: announce this device's namespace advance IFF it actually
 * advanced since the last stored sigrefs snapshot. Safe to call on every
 * git-sync tick (commit-or-not) — the equality check makes a no-op tick free
 * of any git-object churn or hive-wide chatter.
 */
export async function runRefAnnouncePublishTick(
  input: RefAnnouncePublishTickInput,
): Promise<RefAnnouncePublishTickOutcome> {
  const errors: string[] = [];
  const runGit = input.runGit ?? defaultRunGit;
  const nowMs = input.nowMs ?? Date.now();
  const noop: RefAnnouncePublishTickOutcome = { ran: false, changed: false, announcement: null, refused: null, errors };
  if (
    input.versionFloor !== undefined &&
    (!Number.isSafeInteger(input.versionFloor) || input.versionFloor < 0)
  ) {
    errors.push('versionFloor must be a non-negative safe integer');
    return noop;
  }

  let currentRefs: NamespaceRef[];
  try {
    currentRefs = (await listNamespaceRefs(input.repoPath, input.devicePubkeyBase64, runGit)).filter(
      (r) => r.ref !== SIGREFS_REF,
    );
  } catch (e) {
    errors.push(`listing namespace refs failed: ${e instanceof Error ? e.message : e}`);
    return noop;
  }
  if (currentRefs.length === 0) {
    // Nothing published under this namespace yet — buildRefAnnouncement would
    // throw (no sigrefs to announce). A legitimate no-op, not an error.
    return { ran: true, changed: false, announcement: null, refused: null, errors };
  }

  let prior: SignedSigrefs | null = null;
  try {
    prior = await readSigrefs(input.repoPath, input.devicePubkeyBase64, runGit);
  } catch (e) {
    // A read failure is NOT "nothing changed" — proceed as if there were no
    // prior snapshot. Worst case: one extra announce; never a missed one.
    errors.push(
      `reading prior sigrefs failed (proceeding as if first-ever snapshot): ${e instanceof Error ? e.message : e}`,
    );
  }
  if (prior && (!input.context || signedProtocolContextMatches(prior, input.context)) &&
      sameRefs(prior.refs, currentRefs) &&
      (input.versionFloor === undefined || prior.version === input.versionFloor)) {
    return { ran: true, changed: false, announcement: null, refused: null, errors };
  }

  // G-10 own-namespace publish guard (publish-guard.ts / P-205): judge every
  // NEW-or-CHANGED ref's (fromOid, toOid] range BEFORE any of it is signed
  // into a sigrefs snapshot or announced hive-wide. One refusal blocks the
  // WHOLE publish this tick — namespace-wide, safe to retry: nothing was
  // exposed under the namespace ref, so a peer can't have fetched it either.
  const priorShaByRef = new Map((prior?.refs ?? []).map((r) => [r.ref, r.sha] as const));
  const namespaceHex = deviceNamespaceKey(input.devicePubkeyBase64);
  for (const r of currentRefs) {
    // Genesis: no prior sigrefs entry for this ref → judge from the verified
    // already-exposed baseline instead of the whole history (see input doc).
    // WI-6251: derive that baseline PER REF and IN THIS STORE — a single
    // worktree-derived sha is the right answer for at most one namespace ref,
    // and is catastrophically wrong for one on a different line of history.
    const fromOid =
      priorShaByRef.get(r.ref) ??
      (await deriveNamespaceGenesisBaseline(
        input.repoPath,
        `refs/namespaces/${namespaceHex}/${r.ref}`,
        namespaceHex,
        runGit,
      )) ??
      input.genesisBaselineSha ??
      null;
    if (fromOid === r.sha) continue; // this ref didn't move (or nothing under it is unexposed)
    let guard: PublishGuardResult;
    try {
      guard = await checkPublishGuard({
        repoPath: input.repoPath,
        fromOid,
        toOid: r.sha,
        caps: input.publishGuardCaps,
        runGit,
        workspaceId: input.workspaceId,
        // WI-5738: SECOND-LINE guard. Everything under this device's namespace
        // got there through own-head-publish, which already enforced the volume
        // caps commit-by-commit one hop earlier. Re-measuring the same bytes as
        // one big range here is double-jeopardy — and because this guard's
        // baseline is SIGREFS (not the namespace ref), a volume refusal here is
        // its own separate terminal ratchet: on 2026-07-20 ref-announce stayed
        // wedged for hours AFTER own-head-publish had been manually unwedged,
        // because re-basing the namespace ref never touched sigrefs. Hard gates
        // (oversized blob / secrets) still refuse — those are safety, not rate.
        volumeGates: 'warn',
        // WI-10003528: the same already-exposed exclusion the genesis baseline
        // above uses, applied to every later range as well.
        selfNamespaceHex: namespaceHex,
      });
    } catch (e) {
      errors.push(`publish guard threw judging ${r.ref} (refusing, fail-closed): ${e instanceof Error ? e.message : e}`);
      return { ran: true, changed: false, announcement: null, refused: null, errors };
    }
    if (!guard.ok) {
      errors.push(`publish guard refused ${r.ref}: ${describePublishRefusal(guard)}`);
      return { ran: true, changed: false, announcement: null, refused: guard, errors };
    }
  }

  try {
    await buildSigrefs(input.repoPath, input.devicePubkeyBase64, input.sign, {
      nowMs,
      versionFloor: input.versionFloor,
      runGit,
      context: input.context,
    });
    const announcement = await buildRefAnnouncement(input.repoPath, input.devicePubkeyBase64, input.sign, {
      nowMs,
      runGit,
      context: input.context,
    });
    return { ran: true, changed: true, announcement, refused: null, errors };
  } catch (e) {
    errors.push(`buildSigrefs/buildRefAnnouncement failed: ${e instanceof Error ? e.message : e}`);
    return { ran: true, changed: false, announcement: null, refused: null, errors };
  }
}

// ── Receive tick ─────────────────────────────────────────────────────────

export interface RefAnnounceReceiveTickInput {
  repoPath: string;
  /** Pending inbound announcements collected off the fed-event log since the
   *  caller's watermark, OLDEST FIRST. A stale replay (or an older
   *  announcement superseded by a newer one from the same device later in
   *  this same batch) simply rejects cheaply against the mirror watermark —
   *  no extra client-side dedup needed. */
  pending: readonly SignedRefAnnouncement[];
  selfDevice?: string;
  allowedDevices?: readonly string[];
  /** Per-device budget state, persisted by the caller across ticks (the same
   *  idiom `github-bridge-tick`'s caller persists `last_admitted`). Omitted
   *  device ⇒ first sighting. */
  budgetStates?: ReadonlyMap<string, AnnounceBudgetState | null>;
  budgetConfig?: AnnounceBudgetConfig;
  nowMs?: number;
  /** Open a per-fetch duplex to the ANNOUNCING peer (prod: a Protomux
   *  sub-stream on the `papercusp/pot-git` channel — P-201's serve plane is
   *  its server half; wired separately). Only called when a fetch is
   *  actually needed (mirrors `HandleRefAnnouncementOpts.openStream`). */
  openStream: (peerDevicePubkeyBase64: string) => Promise<Duplex> | Duplex;
  timeoutMs?: number;
  runGit?: RunGit;
  /** Stable receiver scope; legacy requires an explicit negotiated opt-in. */
  expectedContext?: ExpectedSignedProtocolContext;
  allowLegacy?: boolean;
  replayFloors?: Readonly<Record<string, SignedSnapshotFloor>>;
}

export interface RefAnnounceReceiveResult {
  device: string;
  version: number;
  result: RefAnnounceHandleResult;
}

/**
 * The receive leg's per-fetch IDLE ceiling — the transport default, on
 * purpose (WI-2039873 / P-203 Leg A).
 *
 * The caller used to pass a bare `15_000` here, and that number was the
 * livelock: serve-wiring's admission rule protects a serve that moved bytes
 * within {@link DEFAULT_SERVE_PROGRESS_WINDOW_MS} (30s) and is documented as
 * sized "far under the requester's own 120s idle ceiling". A requester that
 * gives up at 15s inverts that relationship. Measured on the two-machine rig
 * 2026-09-02T11:53:33Z, cold-joining a multi-thousand-commit mirror: the VM
 * received 20,306,337 bytes of pack, the tower's `pack-objects` went quiet for
 * 15s (CPU-bound host, event-loop lag up to 4.2s), the VM SIGKILLed its git at
 * the ceiling, the tower kept the orphaned-but-recent serve protected, and the
 * next eleven announcement-driven re-requests were refused `busy-streaming` /
 * cut off `early EOF` in turn. No attempt could outlive the silent phase, so
 * the mirror could not converge at any link speed — the exact WI-6412 shape,
 * generated by our own leg.
 *
 * The absolute ceiling ({@link DEFAULT_FETCH_MAX_MS}) still bounds a fetch that
 * keeps trickling; this only stops a HEALTHY transfer being killed for pausing.
 * ref-announce-tick.test.ts pins the relationship to the serve window.
 */
export const REF_ANNOUNCE_RECEIVE_IDLE_MS = DEFAULT_FETCH_TIMEOUT_MS;

export interface RefAnnounceReceiveTickOutcome {
  ran: boolean;
  results: RefAnnounceReceiveResult[];
  /** Updated per-device budget state — the caller MUST persist this as the
   *  new map for the next tick. */
  budgetStates: Map<string, AnnounceBudgetState | null>;
  replayFloors: Record<string, SignedSnapshotFloor>;
  errors: string[];
}

/**
 * ONE receive tick: process every pending inbound ref-announcement against
 * the local mirror, in order. Never throws; a broken/hostile announcement's
 * result is folded into `results` (rejected/fetch-failed) and the batch
 * continues — one bad peer can never starve the rest.
 */
export async function runRefAnnounceReceiveTick(
  input: RefAnnounceReceiveTickInput,
): Promise<RefAnnounceReceiveTickOutcome> {
  const errors: string[] = [];
  const nowMs = input.nowMs ?? Date.now();
  const budgetStates = new Map(input.budgetStates ?? []);
  const replayFloors = Object.fromEntries(Object.entries(input.replayFloors ?? {})
    .filter(([, floor]) => !input.expectedContext || signedProtocolContextMatches(floor, input.expectedContext)));
  const results: RefAnnounceReceiveResult[] = [];
  if (input.pending.length === 0) return { ran: false, results, budgetStates, replayFloors, errors };

  // WI-2039873 / P-203 Leg A: ONE dial per device per tick once its fetch has
  // failed. A device's fetch mirrors its WHOLE namespace, so after one success
  // every later announcement from it in this batch rejects cheaply as already
  // mirrored — a second dial only ever happens after a FAILURE, and then every
  // queued announcement from that device re-dials in turn (twelve were queued
  // on the rig). Each re-request lands on the serving peer as a fresh
  // same-repo same-channel fetch while its previous serve is still winding
  // down, which is what serve-wiring's `busy-streaming` refusal and its
  // supersession exist to police — from the requester's side that read as a
  // storm of distinct transport errors for what was one unreachable (or one
  // slow) peer. The parked re-drive (`decideRefAnnounceReceiveCursor`) already
  // carries the newest announcement per device to next tick, so nothing is
  // lost by refusing the repeats here; they fail fast, without a dial.
  const fetchFailedDevices = new Set<string>();
  const openStream = (device: string): Promise<Duplex> | Duplex => {
    if (!fetchFailedDevices.has(device)) return input.openStream(device);
    // Mirror the production "no live dial" idiom: an already-destroyed duplex
    // (error listener attached first so the host never sees an unhandled
    // 'error'), which the handler reports as a fetch that failed before git ran.
    const stub = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    stub.on('error', () => {});
    stub.destroy(new Error(`dial skipped: a fetch from ${device.slice(0, 12)} already failed this tick — re-driven next tick`));
    return stub;
  };

  for (const incoming of input.pending) {
    const device = incoming.device_pubkey;
    const opts: HandleRefAnnouncementOpts = {
      selfDevice: input.selfDevice,
      allowedDevices: input.allowedDevices,
      budget: { state: budgetStates.get(device) ?? null, config: input.budgetConfig },
      nowMs,
      openStream: () => openStream(device),
      timeoutMs: input.timeoutMs,
      runGit: input.runGit,
      expectedContext: input.expectedContext,
      allowLegacy: input.allowLegacy,
      ...(input.replayFloors !== undefined ? { replayFloor: replayFloors[device] ?? null } : {}),
    };
    try {
      const result = await handleRefAnnouncement(input.repoPath, incoming, opts);
      if (result.action === 'fetched' && result.sigrefs.accepted && result.mismatches.length === 0 &&
          result.sigrefs.snapshot.v === SIGREFS_SCHEMA_VERSION_CONTEXT &&
          isSignedProtocolContext(result.sigrefs.snapshot)) {
        replayFloors[device] = {
          hive_id: result.sigrefs.snapshot.hive_id,
          repo_key: result.sigrefs.snapshot.repo_key,
          store_generation: result.sigrefs.snapshot.store_generation,
          version: result.sigrefs.snapshot.version,
          // WI-2142873: the ACCEPTED snapshot's own blob. It can be newer than the
          // announcement that drove the fetch (the peer advanced before we dialed),
          // and a floor pairing the fetched version with the announced oid would
          // never match `exactAcceptedSnapshot` again.
          sigrefs_oid: result.sigrefsOid ?? incoming.sigrefs_oid,
        };
      }
      budgetStates.set(device, result.budgetState);
      if (result.action === 'fetch-failed') fetchFailedDevices.add(device);
      results.push({ device, version: incoming.version, result });
    } catch (e) {
      // handleRefAnnouncement is documented never-throw, but the tick must
      // survive a seam bug (a broken openStream, etc.) without losing the
      // rest of the batch. EI-15335: surface the throw as a `fetch-failed`
      // result (positionally aligned to `pending`, exactly one result per
      // incoming) rather than silently dropping this announcement's slot — a
      // thrown receive is a failed receive, so the caller's cursor logic can
      // hold + re-dial it next tick instead of advancing past a lost announce.
      const stderr = e instanceof Error ? e.message : String(e);
      fetchFailedDevices.add(device);
      errors.push(`handleRefAnnouncement(${device.slice(0, 12)}@v${incoming.version}) threw: ${stderr}`);
      results.push({
        device,
        version: incoming.version,
        result: {
          action: 'fetch-failed',
          stderr,
          // A THROWN receive: no git process ran (so no exit status) and this is
          // not the ceiling path. `stderr` already carries the exception message,
          // which is the informative part here.
          timedOut: false,
          code: -1,
          budgetState: budgetStates.get(device) ?? null,
        },
      });
    }
  }
  return { ran: true, results, budgetStates, replayFloors, errors };
}

// ── Receive census (WI-2142873 detector) ──────────────────────────────────

/**
 * One line summarising a receive pass. Every action is counted, and rejections
 * are broken out by reason, so a pot that is not converging shows WHY in the
 * log. Before this, rejected announcements left no trace at all, and a leg that
 * never ran looked identical to one that rejected every row.
 */
/**
 * Fed-event rows the receive leg reads per git-sync tick.
 *
 * WI-2142873, measured on the Mac VM on 2026-09-27: after an 11h receive
 * starvation, 8,576 papercusp announcements were queued behind the cursor. At
 * the old 200 rows per 10-minute tick, the leg drained 20 rows/min against a
 * steady production of about 6.7/min. That is about 14 ticks (2h20m) before
 * the first acceptable row and about 10.7h to drain. Until the drain finished,
 * the mirror stayed frozen at its first post-stall fetch: one fetch mirrors a
 * device's whole namespace, so older queued rows reject as stale and the next
 * fetch waits for rows emitted after it.
 *
 * A large batch is cheap. A superseded row costs one signature check and a
 * watermark compare, and a device is dialed at most once per tick (after a
 * success, the rest of its rows reject as already mirrored; after a failure,
 * there is one dial per device per tick). So the batch size bounds only the
 * per-tick bytes read. It does not bound fetches.
 */
export const REF_ANNOUNCE_RECEIVE_BATCH_LIMIT = 2000;

export function formatRefAnnounceReceiveCensus(
  slug: string,
  results: readonly RefAnnounceReceiveResult[],
  meta: {
    batch: number;
    fromCursor: number;
    toCursor: number;
    parked: number;
    /** Fed-event rows the tick read, before the per-install filter. */
    rowsRead?: number;
    /** The read's LIMIT. When rowsRead reaches it, more rows are queued. */
    limit?: number;
  },
): string {
  const actions = new Map<string, number>();
  const reasons = new Map<string, number>();
  // WI-2142873: a fetch that landed but whose snapshot was NOT accepted counted
  // as a plain `fetched=1`, which read as success while the replay floor never
  // advanced and the worktree bridge held on `unknown-generation`. Break it out.
  const unaccepted = new Map<string, number>();
  const devices = new Set<string>();
  for (const r of results) {
    devices.add(r.device);
    actions.set(r.result.action, (actions.get(r.result.action) ?? 0) + 1);
    if (r.result.action === 'rejected') {
      reasons.set(r.result.reason, (reasons.get(r.result.reason) ?? 0) + 1);
    } else if (r.result.action === 'fetched' && !r.result.sigrefs.accepted) {
      unaccepted.set(r.result.sigrefs.reason, (unaccepted.get(r.result.sigrefs.reason) ?? 0) + 1);
    }
  }
  const fmt = (m: Map<string, number>): string =>
    [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
  return (
    `[git-sync] ${slug}: ref-announce receive census — batch=${meta.batch} driven=${results.length} ` +
    `devices=${devices.size} ${fmt(actions) || 'no-results'}` +
    (reasons.size ? ` rejectedBy{${fmt(reasons)}}` : '') +
    (unaccepted.size ? ` fetchedNotAcceptedBy{${fmt(unaccepted)}}` : '') +
    ` parked=${meta.parked} cursor ${meta.fromCursor}→${meta.toCursor}` +
    (meta.limit !== undefined && meta.rowsRead !== undefined && meta.rowsRead >= meta.limit
      ? ` BACKLOG: read a full ${meta.limit}-row batch, more rows are queued behind the cursor`
      : '')
  );
}

/** Receive-leg staleness past which the NOT CONVERGED alarm calls it out. */
export const REF_ANNOUNCE_RECEIVE_STALE_MS = 60 * 60_000;

/**
 * WI-2142873: the NOT CONVERGED alarm's missing half. It renders the receive
 * leg's last persisted pass (routine metadata `ref_announce.at` /
 * `lastEventId`), so a leg STARVED by an earlier leg's action timeout reads
 * differently from one that runs and rejects.
 */
export function formatRefAnnounceReceiveFreshness(at: string | null, cursor: string | null, now: number): string {
  const atMs = at === null ? NaN : Number(at);
  if (!Number.isFinite(atMs)) {
    return 'ref-announce receive has NEVER persisted a pass for this install — check that the leg runs at all.';
  }
  const ageMs = Math.max(0, now - atMs);
  const stale =
    ageMs >= REF_ANNOUNCE_RECEIVE_STALE_MS
      ? ' — STALE: the receive leg is not completing; look for an earlier git-sync leg timing out'
      : '';
  return (
    `ref-announce receive last persisted ${Math.round(ageMs / 60_000)}m ago at ` +
    `${new Date(atMs).toISOString()} (cursor ${cursor ?? '?'})${stale}.`
  );
}

// ── Receive fed-event cursor decision ─────────────────────────────────────

/**
 * One announcement this install could not mirror yet, carried OUTSIDE the
 * fed-event cursor (in the routine's `ref_announce.parked` metadata) so it is
 * re-driven next tick WITHOUT pinning the cursor for every other announcer.
 * Only the NEWEST un-mirrored announcement per device is kept: a device's
 * later announcement supersedes its earlier one (the fetch it triggers brings
 * everything the earlier one named), so an older parked version is dropped the
 * moment a newer fresh row for the same device is read.
 */
export interface ParkedRefAnnouncement {
  /** The coord_event_log row the announcement was read from (diagnostics). */
  rowId: number;
  announcement: SignedRefAnnouncement;
  /** When this DEVICE first entered the parked set (survives version bumps). */
  parkedSinceMs: number;
  /** Consecutive ticks the device's newest announcement failed to mirror. */
  attempts: number;
}

/** Keyed by announcing device pubkey (base64). */
export type ParkedRefAnnouncements = Record<string, ParkedRefAnnouncement>;

/** One row of a receive batch: a fresh fed-event row, or a parked announcement
 *  re-driven from the previous tick (`parked: true`). */
export interface RefAnnounceReceiveBatchRow {
  rowId: number;
  announcement: SignedRefAnnouncement;
  parked?: boolean;
}

export interface RefAnnounceReceiveCursorDecision {
  /** The fed-event cursor the caller MUST persist — always the full
   *  `fallbackCursor` (advance past everything read). Un-mirrored announcements
   *  are carried in `parked`, never by holding this back. */
  cursor: number;
  /** Ordered fetch-failed rows for the caller to LOG loudly — a transient
   *  transport failure that left the announced namespace UN-mirrored. */
  fetchFailed: { rowId: number; device: string; stderr: string; timedOut: boolean; code: number }[];
  /** The parked set the caller MUST persist for the next tick. */
  parked: ParkedRefAnnouncements;
  /** Devices whose parked announcement SETTLED this tick (mirrored, stale, or
   *  rejected) — so the operator line that opened the story can be closed. */
  unparked: { device: string; rowId: number; version: number; attempts: number; parkedSinceMs: number; action: string }[];
}

/**
 * Build the receive batch: previously-parked announcements FIRST (oldest row
 * first), then the fresh fed-event rows in id order. A parked entry whose
 * device has a fresh row at the same or a higher version is superseded and
 * dropped here — the fresh row will be driven instead. Pure.
 */
export function mergeParkedIntoReceiveBatch(
  parked: Readonly<ParkedRefAnnouncements>,
  fresh: readonly RefAnnounceReceiveBatchRow[],
): RefAnnounceReceiveBatchRow[] {
  const newestFreshVersion = new Map<string, SignedRefAnnouncement>();
  for (const row of fresh) {
    const d = row.announcement.device_pubkey;
    const previous = newestFreshVersion.get(d);
    if (!previous || compareGenerationVersion(row.announcement, previous) === 1) newestFreshVersion.set(d, row.announcement);
  }
  const parkedRows: RefAnnounceReceiveBatchRow[] = [];
  for (const p of Object.values(parked)) {
    if (!p?.announcement) continue;
    const superseding = newestFreshVersion.get(p.announcement.device_pubkey);
    const order = superseding ? compareGenerationVersion(superseding, p.announcement) : null;
    if (order === 1 || order === 0) continue;
    parkedRows.push({ rowId: p.rowId, announcement: p.announcement, parked: true });
  }
  parkedRows.sort((a, b) => a.rowId - b.rowId);
  return [...parkedRows, ...fresh.map((r) => ({ rowId: r.rowId, announcement: r.announcement }))];
}

/**
 * EI-15335 / P-203 Leg A — decide the fed-event cursor and the parked set after
 * a receive tick.
 *
 * `results` are positionally aligned to `rows` (one result per driven
 * announcement, in order — the receive tick guarantees this even on a seam-bug
 * throw).
 *
 * A `fetch-failed` result means the announced namespace was NEVER mirrored.
 * Advancing the cursor past it and forgetting it would drop the announce
 * forever — a silent, permanent namespace-mirror gap until the remote happens
 * to announce again (the EI-15335 bug). The ORIGINAL repair held the cursor
 * below the oldest failed row so the next tick re-read and re-dialed it. That
 * hold is head-of-line blocking by construction: ONE announcer nobody can reach
 * (live-caught 2026-09-02 on the two-machine rig — a pot member's device that
 * never joins this pot's swarm topic, so every dial is "no live dial path"
 * forever) pins the cursor for the whole pot, and once the bounded read window
 * fills with rows behind that pin, every OTHER member's announcements are never
 * read at all. The mirror is then stale for a peer that is perfectly reachable.
 *
 * So the cursor now ALWAYS advances, and an un-mirrored announcement is PARKED
 * instead: carried by value (newest per device) and re-driven at the head of
 * the next tick's batch. It stays parked until it mirrors, is superseded by a
 * newer fresh announcement from the same device, or settles as `stale-version`
 * / `rejected` — the announcement is never silently lost, and no announcer can
 * starve another. `already-in-flight` (WI-6418) parks the same way: the
 * announcement is genuinely not mirrored yet, but nothing went wrong, so it is
 * NOT added to `fetchFailed` (never logged as a transport error).
 *
 * Pure + never-throws — a missing/short `results[i]` (defensive) is skipped,
 * and such a row is re-parked so a seam bug cannot drop it either.
 */
export function decideRefAnnounceReceiveCursor(
  results: readonly (RefAnnounceReceiveResult | undefined)[],
  rows: readonly RefAnnounceReceiveBatchRow[],
  fallbackCursor: number,
  priorParked: Readonly<ParkedRefAnnouncements> = {},
  nowMs: number = Date.now(),
): RefAnnounceReceiveCursorDecision {
  const fetchFailed: RefAnnounceReceiveCursorDecision['fetchFailed'] = [];
  // The LAST driven row per device decides that device's disposition: rows are
  // in ascending order (parked first, then fresh by id), so the last one is the
  // newest — and an older failure below a newer success is moot (the success
  // brought the older refs too).
  const lastByDevice = new Map<string, { row: RefAnnounceReceiveBatchRow; action: string | null }>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const res = results[i];
    const device = row.announcement.device_pubkey;
    const action = res?.result.action ?? null;
    const previous = lastByDevice.get(device);
    const order = previous ? compareGenerationVersion(row.announcement, previous.row.announcement) : 1;
    if (order === 1 || order === 0) lastByDevice.set(device, { row, action });
    if (res?.result.action === 'fetch-failed') {
      // WI-6277: carry the discriminators, not just stderr — a SIGKILLed git
      // (the ceiling path) writes no stderr, so stderr alone renders the one
      // positively-identifiable failure as an empty string.
      fetchFailed.push({
        rowId: row.rowId,
        device: res.device,
        stderr: res.result.stderr,
        timedOut: res.result.timedOut,
        code: res.result.code,
      });
    }
  }
  const parked: ParkedRefAnnouncements = {};
  const unparked: RefAnnounceReceiveCursorDecision['unparked'] = [];
  for (const [device, { row, action }] of lastByDevice) {
    const prior = priorParked[device];
    // `null` = no result for this row (a misaligned/short results array): the
    // announcement was not driven, so it is not mirrored — keep it.
    const unsettled = action === null || action === 'fetch-failed' || action === 'already-in-flight';
    if (unsettled) {
      parked[device] = {
        rowId: row.rowId,
        announcement: row.announcement,
        parkedSinceMs: prior?.parkedSinceMs ?? nowMs,
        attempts: (prior?.attempts ?? 0) + 1,
      };
    } else if (prior) {
      unparked.push({
        device,
        rowId: row.rowId,
        version: row.announcement.version,
        attempts: prior.attempts,
        parkedSinceMs: prior.parkedSinceMs,
        action,
      });
    }
  }
  // A parked device that was superseded out of this batch (dropped by
  // `mergeParkedIntoReceiveBatch`) always has its newer row IN the batch, so it
  // is covered above; a device absent from the batch entirely cannot have been
  // parked (parked rows are always driven). Nothing else to carry.
  return { cursor: fallbackCursor, fetchFailed, parked, unparked };
}
