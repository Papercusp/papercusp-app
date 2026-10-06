/**
 * convergence-probe — does `ok:true` actually mean CONVERGED WITH THE POT?
 * (WI-6372, fix D; the class-level closure of WI-6364's fix C.)
 *
 * ## The defect this exists to detect
 * `bootstrapFromPeer` returns `ok:true` when a fetch COMPLETED. Nothing in the
 * bootstrap leg ever asks the only question that matters: is our mirror level
 * with the pot? So a joiner served a complete, internally-consistent pack from
 * a FROZEN store reports "COLD JOIN COMPLETE", stamps
 * `routines.metadata->'bootstrap'` `ok:true`, and every artifact a release
 * reviewer reads says GREEN. That is precisely how WI-6364 survived 7 silent
 * days on the P-302 rig: fix C stopped the superseded store ANSWERING, but any
 * other stale-yet-consistent answer would have read as success exactly the same
 * way.
 *
 * ## Why the correlator is the ref-announce plane, and why that is trustworthy
 * A signed ref-announcement (`ref-announce.ts`) carries
 * `{ device_pubkey, sigrefs_oid, version }` and rides the fed-event log keyed on
 * the HIVE — therefore **independent of `repoKey` and of the pot-git transport
 * entirely**. That independence IS the whole point: a repoKey divergence makes
 * the two channels DISAGREE while each looks internally healthy, so the
 * disagreement is a signal no single-channel check can produce. Comparing
 * pot-git against itself can only ever re-confirm its own stale view.
 *
 * THE TEST: for each attested member device D, local `readSigrefs(repoPath, D)
 * .version` versus the CURRENTLY-announced signature-verified version for D.
 * Local behind announced, PERSISTENTLY, = NOT CONVERGED — however many fetches
 * returned ok.
 *
 * ## `version` is NOT globally monotonic — it is monotonic WITHIN A LINEAGE
 * The first cut of this probe took `max(version)` per device, on the stated
 * premise that the sigrefs counter is monotonic. It is not, and the exception is
 * routine rather than exotic: a **re-key starts a fresh store lineage and the
 * counter legitimately restarts**. Observed live the same day this was written —
 * the tower went v662 → v105 across a re-key. `max()` then pins the bar to 662,
 * a high-water mark of a store THAT NO LONGER EXISTS, which local can never
 * reach. The verdict latches `converged:false` forever, the persistence clock
 * grows without bound, and the loud warning fires every tick about a device that
 * is one version behind and perfectly healthy. That is the worst possible
 * failure for a detector: not silence, but a permanent, confident false alarm
 * that teaches the fleet to ignore the one field a release reviewer was told to
 * trust.
 *
 * So the bar is the announcement most recently OBSERVED (greatest `sequence` —
 * the fed-event log id, which unlike `version` IS globally monotonic and is
 * lineage-independent), never the greatest `version`. See GUARD 7.
 *
 * ## Pure logic only
 * Mirrors this directory's established split (`federation-probe.ts` /
 * `federation-probe-store.ts`, `results-receipt.ts`): no PG, no git, no ambient
 * `Date.now`, so every guard below is unit-testable without a database. The
 * collection + persistence + logging live at the call site in
 * `git-sync-action.ts`, alongside the ref-announce leg's own fed-event read.
 *
 * NOTE: this is deliberately NOT `federation-probe.ts`, which is a different
 * plane — hop receipts for the CONTENT federation pipeline
 * (`harness_shared.federation_probes`), not pot-git ref convergence.
 */

/** How long a device may sit behind WITHOUT LOCAL PROGRESS before the lag is
 *  called NOT CONVERGED. ~3 ticks at the ~5-min git-sync cadence: long enough
 *  that a normally-advancing cold join never trips it, short enough that a
 *  genuinely stuck mirror is named within a quarter hour rather than a week. */
import { compareGenerationVersion, storeGenerationOrdinal } from './signed-context';

export const DEFAULT_CONVERGENCE_PERSISTENCE_MS = 15 * 60 * 1000;

/**
 * Release acceptance needs a fresh, exact observation rather than the
 * long-running lag detector below. Keep the window aligned with the normal
 * three-tick convergence cadence: an install that has not produced a fresh
 * signed statement inside it is UNKNOWN, never silently current.
 */
export const DEFAULT_RELEASE_CONSISTENCY_MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_RELEASE_CONSISTENCY_MAX_FUTURE_SKEW_MS = 60 * 1000;

/** A snapshot a device has ANNOUNCED (signature-verified by the caller before it
 *  gets here — see the guard note on {@link judgeConvergence}). */
export interface AnnouncedSnapshot {
  devicePubkeyBase64: string;
  /**
   * The sigrefs counter (G-4b) carried in the announcement. Monotonic only
   * WITHIN a store lineage — a re-key restarts it. Never order announcements by
   * this; that is the WI-6372 defect. Use {@link AnnouncedSnapshot.sequence}.
   */
  version: number;
  /**
   * Observation order — the `harness_shared.coord_event_log.id` the announcement
   * was read from. Globally monotonic and lineage-independent, so it is the ONLY
   * safe recency key. Optional purely so a caller that genuinely has no ordering
   * degrades to array order (first wins, callers supply newest-first) instead of
   * silently reverting to the max-version bug.
   */
  sequence?: number;
  sigrefsOid?: string;
  /** Receiver-local time at which the federated event was persisted. */
  observedAtMs?: number;
  /** Sender time covered by the announcement signature. */
  signedAtMs?: number;
  /**
   * Stable lineage identifier covered by the announcement signature. V1
   * announcements do not carry it; exact release consistency must therefore
   * remain UNKNOWN until the versioned protocol supplies it.
   */
  storeGeneration?: string;
}

/** What WE currently mirror for a device. */
export interface LocalMirror {
  devicePubkeyBase64: string;
  /** `null` = we hold no sigrefs for this device at all (never seeded it). */
  version: number | null;
  /** Blob OID at this device's local refs/rad/sigrefs. */
  sigrefsOid?: string | null;
  /** Stable lineage identifier read from the mirrored signed snapshot. */
  storeGeneration?: string | null;
}

/**
 * Exact release-readiness state. This is intentionally NOT a boolean: missing
 * evidence is different from observed lag, and neither may collapse into the
 * health detector's permissive `converged:true` value.
 */
export type ReleaseConsistencyState = 'unknown' | 'catching-up' | 'current';

export type ReleaseConsistencyIssueCode =
  | 'expected-peer-set-empty'
  | 'missing-announcement'
  | 'missing-receiver-sequence'
  | 'missing-observation-time'
  | 'stale-observation'
  | 'future-observation'
  | 'missing-signed-time'
  | 'stale-signed-snapshot'
  | 'future-signed-snapshot'
  | 'missing-store-generation'
  | 'missing-generation-sequence'
  | 'missing-snapshot-oid'
  | 'replayed-announcement'
  | 'missing-local-mirror'
  | 'missing-local-store-generation'
  | 'missing-local-generation-sequence'
  | 'missing-local-snapshot-oid'
  | 'store-generation-mismatch'
  | 'generation-sequence-mismatch'
  | 'snapshot-oid-mismatch';

export interface ReleaseConsistencyIssue {
  /** null only for a whole-evaluation issue such as an empty expected set. */
  devicePubkeyBase64: string | null;
  code: ReleaseConsistencyIssueCode;
  detail: string;
}

export interface ReleaseConsistencyPeerVerdict {
  devicePubkeyBase64: string;
  state: ReleaseConsistencyState;
  receiverSequence: number | null;
  storeGeneration: string | null;
  announcedVersion: number | null;
  localVersion: number | null;
  announcedSigrefsOid: string | null;
  localSigrefsOid: string | null;
  observedAtMs: number | null;
  signedAtMs: number | null;
  issues: ReleaseConsistencyIssue[];
}

export interface ReleaseConsistencyVerdict {
  state: ReleaseConsistencyState;
  /** The explicit, deduplicated peer set this verdict promises to cover. */
  expectedDevicePubkeys: string[];
  currentDevicePubkeys: string[];
  /** Greatest receiver event id represented by the selected peer snapshots. */
  watermarkSequence: number | null;
  evaluatedAtMs: number;
  maxObservationAgeMs: number;
  peers: ReleaseConsistencyPeerVerdict[];
  issues: ReleaseConsistencyIssue[];
}

export interface JudgeReleaseConsistencyInput {
  /** Named release population. Empty is UNKNOWN, not vacuous success. */
  expectedDevicePubkeys: readonly string[];
  /** Signature-verified announcements, potentially including relays/replays. */
  announced: readonly AnnouncedSnapshot[];
  /** Local mirrored snapshots for the expected devices. */
  local: readonly LocalMirror[];
  nowMs: number;
  maxObservationAgeMs?: number;
  maxFutureSkewMs?: number;
}

const RELEASE_CONSISTENCY_UNKNOWN_CODES = new Set<ReleaseConsistencyIssueCode>([
  'expected-peer-set-empty',
  'missing-announcement',
  'missing-receiver-sequence',
  'missing-observation-time',
  'stale-observation',
  'future-observation',
  'missing-signed-time',
  'stale-signed-snapshot',
  'future-signed-snapshot',
  'missing-store-generation',
  'missing-generation-sequence',
  'missing-snapshot-oid',
  'replayed-announcement',
  'missing-local-store-generation',
  'missing-local-generation-sequence',
  'missing-local-snapshot-oid',
]);

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function safeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Exact release-consistency judge.
 *
 * Unlike {@link judgeConvergence}, this function never grants a warm-up period,
 * never treats an absent peer as success, and never uses `local >= announced`.
 * Every expected peer needs a fresh receiver observation and fresh signed
 * statement, a signed store generation, an exact per-generation sequence, and
 * the identical sigrefs OID in the local mirror. Missing protocol fields are
 * UNKNOWN; complete-but-different evidence is CATCHING-UP; only exact equality
 * across the entire named set is CURRENT.
 */
export function judgeReleaseConsistency(input: JudgeReleaseConsistencyInput): ReleaseConsistencyVerdict {
  const maxObservationAgeMs =
    input.maxObservationAgeMs ?? DEFAULT_RELEASE_CONSISTENCY_MAX_OBSERVATION_AGE_MS;
  const maxFutureSkewMs = input.maxFutureSkewMs ?? DEFAULT_RELEASE_CONSISTENCY_MAX_FUTURE_SKEW_MS;
  const expectedDevicePubkeys = [...new Set(input.expectedDevicePubkeys.filter((d) => d.length > 0))].sort();

  if (expectedDevicePubkeys.length === 0) {
    const issue: ReleaseConsistencyIssue = {
      devicePubkeyBase64: null,
      code: 'expected-peer-set-empty',
      detail: 'release consistency requires an explicit non-empty expected peer set',
    };
    return {
      state: 'unknown',
      expectedDevicePubkeys,
      currentDevicePubkeys: [],
      watermarkSequence: null,
      evaluatedAtMs: input.nowMs,
      maxObservationAgeMs,
      peers: [],
      issues: [issue],
    };
  }

  const expected = new Set(expectedDevicePubkeys);
  const announcementsByDevice = new Map<string, AnnouncedSnapshot[]>();
  for (const announcement of input.announced) {
    if (!expected.has(announcement.devicePubkeyBase64)) continue;
    const list = announcementsByDevice.get(announcement.devicePubkeyBase64) ?? [];
    list.push(announcement);
    announcementsByDevice.set(announcement.devicePubkeyBase64, list);
  }
  const localByDevice = new Map(input.local.map((mirror) => [mirror.devicePubkeyBase64, mirror]));

  const peers: ReleaseConsistencyPeerVerdict[] = [];
  const issues: ReleaseConsistencyIssue[] = [];
  const currentDevicePubkeys: string[] = [];
  let watermarkSequence: number | null = null;

  const addIssue = (
    peerIssues: ReleaseConsistencyIssue[],
    devicePubkeyBase64: string,
    code: ReleaseConsistencyIssueCode,
    detail: string,
  ): void => {
    const issue = { devicePubkeyBase64, code, detail } satisfies ReleaseConsistencyIssue;
    peerIssues.push(issue);
    issues.push(issue);
  };

  for (const devicePubkeyBase64 of expectedDevicePubkeys) {
    const deviceAnnouncements = announcementsByDevice.get(devicePubkeyBase64) ?? [];
    const receiverOrdered = deviceAnnouncements
      .map((announcement) => ({ announcement, receiverSequence: safeNonNegativeInteger(announcement.sequence) }))
      .filter((entry): entry is { announcement: AnnouncedSnapshot; receiverSequence: number } =>
        entry.receiverSequence !== null,
      )
      .sort((a, b) => b.receiverSequence - a.receiverSequence);
    const lastObserved = receiverOrdered[0] ?? null;
    // Modern generations have a signed total order. Receiver arrival order
    // remains only the legacy fallback and a tie-breaker for observations.
    const latest = [...receiverOrdered].sort((a, b) => {
      const aModern = storeGenerationOrdinal(a.announcement.storeGeneration) !== null;
      const bModern = storeGenerationOrdinal(b.announcement.storeGeneration) !== null;
      if (aModern !== bModern) return aModern ? -1 : 1;
      if (aModern) {
        const order = compareGenerationVersion(
          { version: a.announcement.version, store_generation: a.announcement.storeGeneration },
          { version: b.announcement.version, store_generation: b.announcement.storeGeneration },
        );
        if (order !== null && order !== 0) return -order;
      }
      return b.receiverSequence - a.receiverSequence;
    })[0] ?? null;
    const local = localByDevice.get(devicePubkeyBase64) ?? null;
    const peerIssues: ReleaseConsistencyIssue[] = [];
    if (latest && lastObserved && latest !== lastObserved && latest.receiverSequence < lastObserved.receiverSequence) {
      addIssue(peerIssues, devicePubkeyBase64, 'replayed-announcement',
        'the newest receiver event replays an older signed generation or sequence');
    }

    if (!latest) {
      addIssue(
        peerIssues,
        devicePubkeyBase64,
        deviceAnnouncements.length > 0 ? 'missing-receiver-sequence' : 'missing-announcement',
        deviceAnnouncements.length > 0
          ? 'announcements exist but none carries a valid receiver event sequence'
          : 'the expected peer has no signature-verified announcement',
      );
    }

    const announcement = latest?.announcement ?? null;
    const receiverSequence = latest?.receiverSequence ?? null;
    if (receiverSequence !== null) {
      watermarkSequence = Math.max(watermarkSequence ?? receiverSequence, receiverSequence);
    }

    const storeGeneration = nonEmptyString(announcement?.storeGeneration);
    const announcedVersion = safeNonNegativeInteger(announcement?.version);
    const announcedSigrefsOid = nonEmptyString(announcement?.sigrefsOid);
    const observedAtMs = safeFiniteNumber(announcement?.observedAtMs);
    const signedAtMs = safeFiniteNumber(announcement?.signedAtMs);

    if (announcement) {
      if (observedAtMs === null) {
        addIssue(peerIssues, devicePubkeyBase64, 'missing-observation-time', 'receiver observation time is absent');
      } else if (observedAtMs > input.nowMs + maxFutureSkewMs) {
        addIssue(peerIssues, devicePubkeyBase64, 'future-observation', 'receiver observation time is implausibly future');
      } else if (input.nowMs - observedAtMs > maxObservationAgeMs) {
        addIssue(peerIssues, devicePubkeyBase64, 'stale-observation', 'receiver observation is outside the freshness window');
      }

      if (signedAtMs === null) {
        addIssue(peerIssues, devicePubkeyBase64, 'missing-signed-time', 'signed snapshot time is absent');
      } else if (signedAtMs > input.nowMs + maxFutureSkewMs) {
        addIssue(peerIssues, devicePubkeyBase64, 'future-signed-snapshot', 'signed snapshot time is implausibly future');
      } else if (input.nowMs - signedAtMs > maxObservationAgeMs) {
        addIssue(peerIssues, devicePubkeyBase64, 'stale-signed-snapshot', 'signed snapshot is outside the freshness window');
      }

      if (storeGeneration === null) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'missing-store-generation',
          'announcement does not bind a signed store generation',
        );
      }
      if (announcedVersion === null) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'missing-generation-sequence',
          'announcement does not carry a valid per-generation sequence',
        );
      }
      if (announcedSigrefsOid === null) {
        addIssue(peerIssues, devicePubkeyBase64, 'missing-snapshot-oid', 'announcement does not bind a sigrefs OID');
      }

      if (storeGeneration !== null && announcedVersion !== null) {
        const sameGeneration = receiverOrdered.filter(
          ({ announcement: candidate }) => candidate.storeGeneration === storeGeneration,
        );
        const priorHigherSequence = sameGeneration.some(
          ({ announcement: candidate }) =>
            safeNonNegativeInteger(candidate.version) !== null && candidate.version > announcedVersion,
        );
        const exactSignedReplay = sameGeneration.filter(({ announcement: candidate }) => candidate !== announcement).some(({ announcement: candidate }) =>
          candidate.version === announcedVersion &&
          candidate.sigrefsOid === announcedSigrefsOid &&
          candidate.signedAtMs === signedAtMs,
        );
        if (priorHigherSequence || exactSignedReplay) {
          addIssue(
            peerIssues,
            devicePubkeyBase64,
            'replayed-announcement',
            priorHigherSequence
              ? 'the newest receiver event lowers the signed sequence within the same store generation'
              : 'the newest receiver event repeats an identical signed snapshot',
          );
        }
      }
    }

    const localVersion = safeNonNegativeInteger(local?.version);
    const localStoreGeneration = nonEmptyString(local?.storeGeneration);
    const localSigrefsOid = nonEmptyString(local?.sigrefsOid);

    if (announcement && (!local || local.version === null)) {
      addIssue(peerIssues, devicePubkeyBase64, 'missing-local-mirror', 'no local mirror exists for the expected peer');
    } else if (announcement && local) {
      if (localStoreGeneration === null) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'missing-local-store-generation',
          'local mirrored snapshot does not expose a signed store generation',
        );
      }
      if (localVersion === null) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'missing-local-generation-sequence',
          'local mirrored snapshot does not expose a valid per-generation sequence',
        );
      }
      if (localSigrefsOid === null) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'missing-local-snapshot-oid',
          'local mirror does not expose its sigrefs OID',
        );
      }

      if (storeGeneration !== null && localStoreGeneration !== null && storeGeneration !== localStoreGeneration) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'store-generation-mismatch',
          `local generation ${localStoreGeneration} does not equal announced generation ${storeGeneration}`,
        );
      }
      if (announcedVersion !== null && localVersion !== null && announcedVersion !== localVersion) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'generation-sequence-mismatch',
          `local sequence ${localVersion} does not equal announced sequence ${announcedVersion}`,
        );
      }
      if (announcedSigrefsOid !== null && localSigrefsOid !== null && announcedSigrefsOid !== localSigrefsOid) {
        addIssue(
          peerIssues,
          devicePubkeyBase64,
          'snapshot-oid-mismatch',
          `local sigrefs ${localSigrefsOid} does not equal announced sigrefs ${announcedSigrefsOid}`,
        );
      }
    }

    const peerState: ReleaseConsistencyState = peerIssues.some((issue) =>
      RELEASE_CONSISTENCY_UNKNOWN_CODES.has(issue.code),
    )
      ? 'unknown'
      : peerIssues.length > 0
        ? 'catching-up'
        : 'current';
    if (peerState === 'current') currentDevicePubkeys.push(devicePubkeyBase64);
    peers.push({
      devicePubkeyBase64,
      state: peerState,
      receiverSequence,
      storeGeneration,
      announcedVersion,
      localVersion,
      announcedSigrefsOid,
      localSigrefsOid,
      observedAtMs,
      signedAtMs,
      issues: peerIssues,
    });
  }

  const state: ReleaseConsistencyState = peers.some((peer) => peer.state === 'unknown')
    ? 'unknown'
    : peers.some((peer) => peer.state === 'catching-up')
      ? 'catching-up'
      : 'current';

  return {
    state,
    expectedDevicePubkeys,
    currentDevicePubkeys,
    watermarkSequence,
    evaluatedAtMs: input.nowMs,
    maxObservationAgeMs,
    peers,
    issues,
  };
}

/** One-line release-focused summary; never aliases the lag-health wording. */
export function formatReleaseConsistencyVerdict(verdict: ReleaseConsistencyVerdict): string {
  if (verdict.state === 'current') {
    return `CURRENT: exact signed snapshot match for ${verdict.currentDevicePubkeys.length}/${verdict.expectedDevicePubkeys.length}` +
      ` expected peer(s) at receiver watermark ${verdict.watermarkSequence ?? 'unknown'}`;
  }
  const issueSummary = [...new Set(verdict.issues.map((issue) => issue.code))].join(', ') || 'unclassified';
  return `${verdict.state.toUpperCase()}: ${verdict.currentDevicePubkeys.length}/${verdict.expectedDevicePubkeys.length}` +
    ` expected peer(s) exact (${issueSummary})`;
}

/** Per-device lag carried ACROSS ticks — the persistence watermark. */
export interface DeviceLagState {
  /** Highest announced version observed at the time of the observation. */
  announced: number;
  /** Our local version at the time of the observation (`null` = not mirrored). */
  local: number | null;
  /** Epoch ms at which this lag was first observed WITHOUT local progress. */
  since: number;
}

/** The persisted map (device pubkey → lag state) round-tripped via routine metadata. */
export type ConvergenceState = Record<string, DeviceLagState>;

export interface LaggingDevice {
  devicePubkeyBase64: string;
  announced: number;
  local: number | null;
  since: number;
  /** How long we have been behind this device with NO local progress. */
  lagMs: number;
  /** true once `lagMs >= persistenceMs` — the loud set. */
  persistent: boolean;
}

export interface ConvergenceVerdict {
  /**
   * `false` ONLY when at least one device is PERSISTENTLY behind. A transient
   * trail (peer announced seconds ago; a cold join still climbing the ladder)
   * is healthy and leaves this `true`.
   */
  converged: boolean;
  /** Every device currently behind — transient AND persistent. */
  behind: LaggingDevice[];
  /** The subset whose lag outlived `persistenceMs`; non-empty ⇒ NOT CONVERGED. */
  notConverged: LaggingDevice[];
  /** How many devices were judgeable at all (attested + has an announcement). */
  judged: number;
  /**
   * Devices whose announced counter went BACKWARDS since the last tick — i.e. a
   * re-key started a fresh store lineage. Informational only: it never flips
   * `converged` by itself (a lineage reset is a normal event, not a fault), but
   * it is the fact that explains why a persistence clock was dropped, and it is
   * what a debugger otherwise reconstructs by hand from two ticks of metadata.
   */
  lineageResets: Array<{ devicePubkeyBase64: string; priorAnnounced: number; announced: number }>;
  /** The state to persist for the next tick. */
  state: ConvergenceState;
}

/**
 * GUARD 1's input, built in ONE place (WI-10006394): the attested member devices,
 * minus self, minus REVOKED devices, de-duplicated in first-seen order.
 *
 * Revocation is how a device that is gone for good (a deleted VM, a wiped laptop)
 * is retired. Without this filter its last announcement stays judgeable and pins
 * the pot NOT CONVERGED forever, because nothing can bring the local mirror up to
 * a snapshot only the departed device held. Measured: 63 h on hello-world-3-pot
 * after the S1 capacity-test VM was deleted, its attestation still listed under
 * the member that lent it a GitHub identity.
 *
 * A silent device is deliberately NOT aged out. A laptop offline for a weekend
 * with unpulled commits is a REAL non-convergence; only an explicit revocation
 * can say that device's data is not coming back.
 */
export function selectConvergenceCandidates(input: {
  memberDevicePubkeys: readonly string[];
  selfDevicePubkey: string | null | undefined;
  revokedDevicePubkeys: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const device of input.memberDevicePubkeys) {
    if (!device || seen.has(device)) continue;
    seen.add(device);
    if (device === input.selfDevicePubkey) continue;
    if (input.revokedDevicePubkeys.has(device)) continue;
    out.push(device);
  }
  return out;
}

export interface JudgeConvergenceInput {
  /**
   * GUARD 1 — the ONLY devices that may be judged: attested hive members,
   * EXCLUDING self and REVOKED devices (build it with
   * `selectConvergenceCandidates`). Anything announcing from outside this set
   * is ignored.
   */
  candidateDevicePubkeys: readonly string[];
  /**
   * Announcements, already SIGNATURE-VERIFIED by the caller. Duplicates and
   * replays are fine: the highest version per device wins.
   */
  announced: readonly AnnouncedSnapshot[];
  local: readonly LocalMirror[];
  /** Prior tick's persisted state (`null` on a cold process). */
  priorState: ConvergenceState | null;
  nowMs: number;
  persistenceMs?: number;
}

/**
 * Judge whether our mirror is level with what the pot has ANNOUNCED.
 *
 * The guards are the substance of this function — a convergence detector that
 * cries wolf on a healthy pair is strictly worse than none, because the fleet
 * learns to ignore it and the one true alarm is lost in the noise. They are
 * written first and ordered so a healthy case exits before any lag arithmetic
 * runs:
 *
 *   1. Only devices in `candidateDevicePubkeys` are judged. Drops self (our own
 *      local always equals our own announcement by construction), drops former
 *      members, drops REVOKED devices of current members (a departed device is
 *      retired by revoking it — see `selectConvergenceCandidates`), and drops any
 *      unknown/hostile announcer.
 *   2. A device with NO announcement is NEVER judged behind — absence of a
 *      claim is not evidence of lag.
 *   3. `local >= announced` ⇒ converged; any prior lag state for that device is
 *      DROPPED, so a recovered device starts clean.
 *   4. Versions are compared ONLY within the same device. The sigrefs counter is
 *      monotonic PER DEVICE and cross-device comparison is meaningless.
 *   5. Malformed versions are skipped rather than trusted (belt-and-braces with
 *      the caller's signature check — an unsigned `coord_event_log` row must
 *      never be able to pin us NOT-CONVERGED forever).
 *   6. THE ONE THAT MATTERS — the persistence clock keys on LOCAL PROGRESS, not
 *      on behind-ness. A peer that keeps advancing while we trail it by a tick
 *      is HEALTHY and must never trip the alarm, however long it trails; the
 *      broken case is a mirror that does not move AT ALL while the pot runs
 *      ahead. So `since` is carried forward only while our local version is
 *      UNCHANGED, and resets the moment we make any progress. Without this the
 *      detector would eventually fire on every busy, perfectly-healthy pot —
 *      the exact false-positive that would get it disabled.
 *   7. THE BAR IS THE NEWEST ANNOUNCEMENT, NOT THE HIGHEST. `version` restarts
 *      on a re-key, so `max()` pins the bar to a dead lineage's high-water mark
 *      that local can never reach — a PERMANENT false alarm (see the header).
 *      Devices are therefore keyed by greatest `sequence`, and an announced
 *      counter that moved BACKWARDS is read as a lineage reset: the persistence
 *      clock for that device is dropped rather than carried, because every
 *      millisecond it accumulated was measured against the old lineage's bar.
 *
 *      Trade-off, stated explicitly: a REPLAYED older announcement (validly
 *      signed, re-posted) would arrive with the newest `sequence` and so LOWER
 *      the bar for a tick, costing us a detection. That is the conservative
 *      direction this file already commits to — "a detector that cries wolf on a
 *      healthy pair is strictly worse than none" — and the lag is re-detected on
 *      the next genuine announcement. Ordering by `version` to dodge a transient
 *      miss is what buys the permanent false alarm, which is the strictly worse
 *      bargain.
 */
export function judgeConvergence(input: JudgeConvergenceInput): ConvergenceVerdict {
  const persistenceMs = input.persistenceMs ?? DEFAULT_CONVERGENCE_PERSISTENCE_MS;

  // GUARD 1 — the judgeable set.
  const judgeable = new Set(input.candidateDevicePubkeys);

  // GUARD 7 — the CURRENT announcement per judgeable device: greatest
  // `sequence` (observation order), NOT greatest `version`. When no caller
  // supplies `sequence` we fall back to array order, first-wins, matching the
  // call site's documented `ORDER BY id DESC` newest-first read. Deliberately
  // never `version`: see the header (a re-key restarts it and `max()` latches a
  // permanent false alarm). GUARD 4 + GUARD 5 also apply here.
  const currentAnnounced = new Map<string, AnnouncedSnapshot>();
  for (const a of input.announced) {
    if (!judgeable.has(a.devicePubkeyBase64)) continue; // GUARD 1
    if (!Number.isInteger(a.version) || a.version < 0) continue; // GUARD 5
    const prev = currentAnnounced.get(a.devicePubkeyBase64);
    if (prev === undefined) {
      currentAnnounced.set(a.devicePubkeyBase64, a);
      continue;
    }
    // A malformed/absent `sequence` must never displace a well-ordered one.
    const aSeq = Number.isInteger(a.sequence as number) ? (a.sequence as number) : null;
    const prevSeq = Number.isInteger(prev.sequence as number) ? (prev.sequence as number) : null;
    if (aSeq !== null && (prevSeq === null || aSeq > prevSeq)) currentAnnounced.set(a.devicePubkeyBase64, a);
  }

  const localByDevice = new Map<string, number | null>();
  for (const l of input.local) {
    if (!judgeable.has(l.devicePubkeyBase64)) continue; // GUARD 1
    const v = l.version;
    localByDevice.set(l.devicePubkeyBase64, Number.isInteger(v as number) && (v as number) >= 0 ? v : null);
  }

  const state: ConvergenceState = {};
  const behind: LaggingDevice[] = [];
  const lineageResets: ConvergenceVerdict['lineageResets'] = [];

  // GUARD 2 — iterate the ANNOUNCED set: a device that never announced is
  // never even considered.
  for (const [devicePubkeyBase64, announcement] of currentAnnounced) {
    const announced = announcement.version;
    const local = localByDevice.get(devicePubkeyBase64) ?? null;
    const prior = input.priorState?.[devicePubkeyBase64];

    // GUARD 7 — the announced counter moved BACKWARDS: the peer re-keyed and
    // restarted its lineage. Record it, and treat the prior lag state as void —
    // it was accumulated against a bar that no longer exists.
    const lineageReset = prior !== undefined && prior.announced > announced;
    if (lineageReset) {
      lineageResets.push({ devicePubkeyBase64, priorAnnounced: prior.announced, announced });
    }

    // GUARD 3 — level or ahead ⇒ converged, and the prior lag state is dropped
    // (deliberately NOT copied into `state`).
    if (local !== null && local >= announced) continue;

    // GUARD 6 — the persistence clock tracks LOCAL PROGRESS, not behind-ness.
    // GUARD 7 — ...but a lineage reset voids the carried clock outright, so a
    // re-keyed peer starts its lag measurement fresh instead of inheriting the
    // (unbounded) time it spent behind an unreachable dead-lineage bar.
    const localUnchanged = prior !== undefined && prior.local === local && !lineageReset;
    const since = localUnchanged ? prior.since : input.nowMs;

    // Clamp: a `since` in the future (clock skew, or metadata restored from
    // another machine) must read as "no lag yet", never as instant failure.
    const lagMs = Math.max(0, input.nowMs - since);

    const entry: LaggingDevice = {
      devicePubkeyBase64,
      announced,
      local,
      since,
      lagMs,
      persistent: lagMs >= persistenceMs,
    };
    behind.push(entry);
    state[devicePubkeyBase64] = { announced, local, since };
  }

  behind.sort((a, b) => b.lagMs - a.lagMs);
  const notConverged = behind.filter((d) => d.persistent);

  return {
    converged: notConverged.length === 0,
    behind,
    notConverged,
    judged: currentAnnounced.size,
    lineageResets,
    state,
  };
}

/**
 * One-line human summary for the tick log. Says WHICH device, HOW far behind,
 * and FOR HOW LONG — the three facts a debugger otherwise has to reconstruct
 * from a cross-machine log read.
 */
export function formatConvergenceVerdict(verdict: ConvergenceVerdict): string {
  // A re-key is the single most confusing thing to see in these logs (the peer's
  // version appears to fall off a cliff), so it is named explicitly wherever it
  // happened — including on the converged path, which is the common case.
  const resets = verdict.lineageResets.length
    ? ` [lineage reset: ${verdict.lineageResets
        .map((r) => `${r.devicePubkeyBase64.slice(0, 8)} v${r.priorAnnounced}→v${r.announced} (re-key; clock dropped)`)
        .join('; ')}]`
    : '';
  if (verdict.judged === 0) return 'no announced peer snapshots to compare against yet';
  if (verdict.converged && verdict.behind.length === 0) {
    return `converged with ${verdict.judged} announced peer snapshot(s)${resets}`;
  }
  const describe = (d: LaggingDevice): string =>
    `${d.devicePubkeyBase64.slice(0, 8)} local ${d.local === null ? 'ABSENT' : `v${d.local}`} < announced v${d.announced}` +
    ` (${Math.round(d.lagMs / 60_000)}m without local progress)`;
  if (verdict.converged) {
    return `trailing (healthy, still advancing): ${verdict.behind.map(describe).join('; ')}${resets}`;
  }
  return `NOT CONVERGED: ${verdict.notConverged.map(describe).join('; ')}${resets}`;
}
