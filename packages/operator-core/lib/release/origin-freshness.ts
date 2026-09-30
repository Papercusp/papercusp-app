/**
 * origin-freshness — the PURE verdict behind the WI-5607 origin-freshness alarm.
 *
 * THE GAP (EI-13924 follow-up, "REMAINING GAP" suggestion (c)): git-sync-stall-watchdog
 * (this module's sibling) watches the LOCAL tree HEAD — the right signal for `legacy`
 * hives, where git-sync pushes origin directly every tick. For a `bridged` hive, a
 * member's local HEAD advances every tick regardless of whether the bridge writer's
 * egress to GitHub is actually landing, so git-sync-stall-watchdog is structurally blind
 * to a stuck bridge. The bridge's own divergence classifier (github-divergence.ts) is
 * ALSO not a complete backstop: it only fires on STRUCTURED residues the mechanism layers
 * report (rejectedNonFF / blockedSecrets / admission-blocked / …) — a bridge that is
 * reachable but simply stuck/slow/wedged for some OTHER reason (a starved lease, a wedged
 * executor reaping egress fires) still classifies `clear` on every tick while origin
 * silently falls behind.
 *
 * This is a standalone, independent assertion: it doesn't need to know WHY origin is
 * stale, only THAT it is — exactly like commit-staleness is to fire-staleness in
 * git-sync-stall-watchdog. Four signals, any of which alarms:
 *   1. `aheadCount`      — local canonical is >= `aheadCountMax` commits ahead of the
 *      last-known origin tip (a straight `git rev-list --count <origin>..<local>`).
 *   2. `originTipAgeMs`  — the tracked origin tip has sat UNCHANGED for `tipAgeStaleMs`
 *      while local stayed ahead of it (the head-unchanged-clock idiom
 *      git-sync-stall-watchdog uses for the local HEAD, applied here to the origin tip).
 *   3. `publishRefusedSweeps` — the publish leg says outright it will not publish (WI-5738).
 *   4. `publishBacklogSweeps` — the publish leg is publishing, admitted, and STILL not
 *      keeping up: `own_head_publish.backlogRemains === true` sustained (WI-6996). See below.
 *
 * EI-19341709637436070: this field was persisted as `drained` (assigned
 * `!resolution.complete` in own-head-publish.ts) until it was renamed — the old name read
 * as "has been drained" (healthy) while `true` actually meant the publish advanced but did
 * NOT reach the worktree head, i.e. backlog REMAINS. Wiring it the intuitive way round
 * would have silently inverted this detector into one that alarms only when the pipeline
 * is healthy. Now named `backlogRemains`, so the value agrees with its name.
 *
 * WI-6996 — WHY SIGNALS 1+2 CANNOT BE THE WHOLE STORY, and why 4 exists.
 *
 * Signals 1 and 2 both measure CANONICAL against ORIGIN. On 2026-08-02 the thing that
 * froze was canonical ITSELF: `refs/hive/staging` stuck at f7a85ad748 for ~6h, with origin
 * sitting at the identical sha because origin can only ever be a copy of canonical. So
 * `aheadCount` was 0 — not "small", exactly 0 — which took the `ahead <= 0` early return
 * below and reported `ok` on every single sweep. The two inferred signals are STRUCTURALLY
 * incapable of seeing a canonical-side freeze: they compare two values that freeze together.
 *
 * The upstream cause was a publish BACKLOG, and it was never a refusal. WI-5738 made
 * own-head publish INCREMENTAL: it drains a bounded slice per tick and CAS-writes
 * `publishedSha`. When the slice is smaller than the inflow the namespace head falls
 * permanently behind the worktree head (it reached ~114 commits back), so the integrator
 * could only announce shas that were ANCESTORS of the already-accepted watermark; the
 * bridge rejected each one non-fast-forward — a TERMINAL reason that skips-and-continues
 * and logs nothing — while `last_status` stayed 'synced'. Nothing refused, so signal 3 read
 * 0 too. Three green signals, ~6h of the fleet's work reaching nobody and no off-box backup.
 *
 * `backlogRemains` is the leg's own answer to "is there backlog left?" and it was already
 * being computed and then discarded on every tick. A detector that ignores an explicit self-report
 * in favour of inference is the detector failure — the same lesson signal 3 was added for,
 * re-learned one stage upstream. Signal 4 therefore bypasses the `ahead <= 0` early return
 * for exactly the reason signal 3 does: a backlog is true regardless of how any
 * canonical-vs-origin commit count comes out, and in this incident that count was 0.
 *
 * FALSE-ALARM FIX (same class as every sibling watchdog): local at or behind the tracked
 * origin tip (`aheadCount <= 0`) is definitionally healthy — nothing to push, so neither
 * signal can mean anything, however old the tracked tip's clock is.
 *
 * Pure + unit-testable; the DB/git wiring (tracking the origin-tip clock across sweeps,
 * reading the bare store, alarming) lives in `origin-freshness-watchdog.ts`.
 */

export interface OriginFreshnessSnapshot {
  /** Commits the LOCAL canonical ref has that the last-known origin tip lacks
   *  (`git rev-list --count <originSha>..<canonicalSha>`). Null when either ref is
   *  unknown/unreadable (a fresh seed / first-ever tick) — treated as 0 (never stale). */
  aheadCount: number | null;
  /** ms the tracked origin tip has sat UNCHANGED while local has stayed ahead of it
   *  (watchdog-tracked; mirrors `GitSyncStallSnapshot.headUnchangedMs`). Null on the first
   *  observation of a given origin sha, or when there is nothing to track (aheadCount<=0)
   *  — never stale on a null age. */
  originTipAgeMs: number | null;
  /**
   * WI-5738 — the THIRD signal, and the only one that is not a proxy.
   *
   * The two signals above infer a stall from origin standing still. A publish
   * guard REFUSAL is the stall stated outright: the p2p publish leg reporting,
   * every tick, that it will not publish. It was recorded at
   * `metadata.own_head_publish.refused` and raised NOTHING — no condition, no
   * escalation, no health flag — so the 2026-07-20 wedge ran for five days
   * while the leg logged its own refusal on every single tick. A detector that
   * ignores an explicit self-report in favour of inference is the detector
   * failure, not just a missed inference.
   *
   * Count of CONSECUTIVE sweeps the publish leg has reported a refusal (0 =
   * publishing fine). Null when unknown/not applicable.
   */
  publishRefusedSweeps?: number | null;
  /** The refusal code being reported, for the alarm body (e.g. 'total-over-cap'). */
  publishRefusalCode?: string | null;
  /**
   * WI-6996 — the FOURTH signal, and the one that catches the failure the other three
   * are all blind to: the publish leg is ADMITTED (no refusal) and still not keeping up.
   *
   * Count of CONSECUTIVE sweeps the publish leg finished with backlog remaining — i.e.
   * `own_head_publish.backlogRemains === true` (see the module header for the EI-19341709637436070
   * rename this field used to be named `drained`, backwards). 0 = fully caught up (healthy).
   * Null when unknown (pre-WI-7009 metadata that never recorded the field), which is
   * treated as healthy rather than guessed at.
   *
   * A tick or two of backlog is NORMAL — that is what incremental publish IS, and it is
   * why this is a sustained-sweep count and not a boolean. What is not normal is backlog
   * that never clears: the namespace head then falls permanently behind and every
   * downstream stage silently starves.
   */
  publishBacklogSweeps?: number | null;
  /** How far `publishedSha` trails the worktree head right now, for the alarm body.
   *  Null when not computable. Reported, never thresholded — the SWEEP COUNT is the
   *  verdict, because a large backlog that is draining is healthy and a small one that
   *  never moves is not. */
  publishBacklogCommits?: number | null;
  /**
   * EI-19442274898324113 — the FIFTH signal, and the one the other four are blind to for a
   * structural reason worth stating plainly: an INTEGRATOR stall disables this whole detector.
   *
   * The pipeline is worktree -> (publish) -> device namespace -> (INTEGRATE) -> refs/hive/staging
   * -> (egress) -> GitHub origin. Signals 1-2 compare canonical-vs-origin and signals 3-4 watch
   * the PUBLISH stage. Nothing watches the INTEGRATOR stage — and when it stalls, canonical stops
   * advancing, so origin stops advancing *because* canonical did. Both comparands freeze at the
   * SAME sha, `aheadCount` is exactly 0, and the "nothing to push" early return declares the pot
   * healthy. The fault removes the detector's own signal.
   *
   * Measured live on papercusp 2026-08-03: the integrator leg declined every tick for ~5.4h
   * (`integrator_status.skipped='not_authority'` — the lease was held by a peer that publishes
   * `git-sync` but was not integrating). refs/hive/staging sat at 7450c49aa5 while this device's
   * namespace reached b226b03136, 28 commits ahead; origin/staging never moved and origin/main
   * ended up AHEAD of origin/staging. Throughout, `of_origin_sha` correctly tracked the true
   * origin ref and `of_origin_since_ms` aged past the 3h `tipAgeStaleMs` — and `of_alerted`
   * stayed false, `of_stall_sweeps` stayed 0, because ahead===0 short-circuited before either
   * could be consulted. Sibling bridged pots alarmed correctly the whole time, so the silence
   * read as health. It then SELF-HEALED, leaving nothing behind for anyone to find.
   *
   * Count of CONSECUTIVE sweeps the local device namespace has stood ahead of canonical
   * `refs/hive/staging` (0 = integrated / caught up). Null when unknown or not applicable
   * (non-bridged pot, unreadable bare store) — treated as healthy rather than guessed at.
   *
   * Like `publishBacklogSweeps` this is a SUSTAINED count, not a boolean: being a commit or two
   * ahead between 3-min ticks is the normal steady state. What is not normal is standing ahead
   * indefinitely.
   */
  integratorBacklogSweeps?: number | null;
  /** How far the local namespace stands ahead of canonical right now, for the alarm body.
   *  Null when not computable. Reported, never thresholded — same rationale as
   *  `publishBacklogCommits`: a large backlog that is draining is healthy, a small one that
   *  never moves is not, so the SWEEP COUNT is the verdict. */
  integratorBacklogCommits?: number | null;
}

export interface OriginFreshnessThresholds {
  /** Consecutive sweeps of publish-guard refusal before alarming. Default 3 —
   *  a refusal is a deliberate, sustained verdict, so this only debounces a
   *  blip (e.g. a transient git error) rather than waiting out a real wedge. */
  publishRefusedSweepsMax?: number;
  /** WI-6996: consecutive sweeps of UNDRAINED publish backlog before alarming. Default 4.
   *  The watchdog sweeps every 15 min and git-sync ticks every 3 min, so 4 sweeps = ~1h,
   *  i.e. the publish leg has had ~20 consecutive ticks to drain and has not. That is
   *  comfortably above any legitimate burst (a big but healthy range drains in a handful
   *  of ticks) and far below the ~6 DAYS the 2026-08-02 backlog actually ran undetected. */
  publishBacklogSweepsMax?: number;
  /** EI-19442274898324113: consecutive sweeps the device namespace has stood ahead of canonical
   *  `refs/hive/staging` before alarming. Default 4 — deliberately identical to
   *  `publishBacklogSweepsMax`, for the same arithmetic: the watchdog sweeps every 15 min and
   *  git-sync ticks every 3 min, so 4 sweeps = ~1h, i.e. ~20 consecutive ticks in which the
   *  integrator could have advanced canonical and did not. Comfortably above a healthy burst
   *  and far below the ~5.4h the 2026-08-03 stall actually ran undetected. */
  integratorBacklogSweepsMax?: number;
  /** Local ahead of the tracked origin tip by at least this many commits ⇒ stale,
   *  regardless of how long ago that happened (a sudden pile-up is itself a signal).
   *  Default 50 — generous enough to absorb a normal burst of commits between bridge
   *  ticks (3-min cadence) without crying wolf, small enough to catch a real backlog
   *  well before it becomes a multi-hour strand. */
  aheadCountMax?: number;
  /** The tracked origin tip has sat unchanged this long while local is ahead of it ⇒
   *  stale. Default 3h — matches git-sync-stall-watchdog's fire-stale window and the
   *  EI-13924 incident's actual stall duration (3h/25 commits before it was noticed). */
  tipAgeStaleMs?: number;
}

export interface OriginFreshnessVerdict {
  state: 'ok' | 'stale';
  aheadCountStale: boolean;
  tipAgeStale: boolean;
  /** WI-5738: the publish leg is explicitly refusing to publish, sustained. */
  publishRefused: boolean;
  /** WI-6996: the publish leg is admitted but has carried backlog for `publishBacklogSweepsMax`
   *  consecutive sweeps — publishing, and still losing ground. */
  publishBacklog: boolean;
  /** EI-19442274898324113: the device namespace has stood ahead of canonical `refs/hive/staging`
   *  for `integratorBacklogSweepsMax` consecutive sweeps — the integrator leg is not advancing
   *  canonical, which freezes origin and (because both comparands freeze together) silences
   *  every other signal here. */
  integratorBacklog: boolean;
  /** Human reason for the alarm body, or null when not stale. */
  reason: string | null;
}

/**
 * EI-19442274898324113 — does THIS sweep count as an integrator stall?
 *
 * Pure, and extracted rather than left inline in the watchdog precisely because it is the
 * subtle half of the signal. The naive form ("the namespace is ahead of canonical") is
 * WRONG and would make this detector a noise generator: git-sync commits every ~3 min while
 * the watchdog sweeps every 15, so an instantaneous delta is nonzero on any busy pot almost
 * always. Measured on papercusp minutes AFTER the 2026-08-03 incident fully cleared
 * (canonical == origin, everything healthy): the namespace was still 4 commits ahead.
 * A sweep counter keyed on that would have climbed monotonically and alarmed inside an hour.
 *
 * The real condition is "the integrator had work to do AND canonical did not move since the
 * last sweep". A remembered sha is what turns an instantaneous reading into a progress
 * verdict — the same trick `of_origin_sha` / `of_origin_since_ms` already use for the origin
 * tip. On a healthy pot canonical advances between sweeps and the counter resets to 0; during
 * the real stall canonical was pinned at 7450c49aa5 for ~5.4h and it climbs.
 *
 * A null/unknown canonical is NOT a stall — absent evidence must never manufacture an alarm.
 */
export function isIntegratorStalledThisSweep(input: {
  /** Commits the local namespace has that canonical lacks. Null/0 ⇒ nothing to integrate. */
  backlogCommits: number | null;
  /** Canonical `refs/hive/staging` as read this sweep. */
  canonicalSha: string | null;
  /** Canonical as remembered from the PREVIOUS sweep (null on the first ever observation). */
  prevCanonicalSha: string | null;
}): boolean {
  if (input.canonicalSha == null) return false; // unreadable ⇒ no signal, never an alarm
  if ((input.backlogCommits ?? 0) <= 0) return false; // nothing to integrate ⇒ healthy
  // First-ever observation (no remembered sha) counts as "advanced": we have no evidence it
  // stood still, and a detector must not alarm on its own cold start.
  if (input.prevCanonicalSha == null) return false;
  return input.canonicalSha === input.prevCanonicalSha;
}

export const DEFAULT_AHEAD_COUNT_MAX = 50;
export const DEFAULT_PUBLISH_REFUSED_SWEEPS_MAX = 3;
export const DEFAULT_PUBLISH_BACKLOG_SWEEPS_MAX = 4;
export const DEFAULT_INTEGRATOR_BACKLOG_SWEEPS_MAX = 4;
export const DEFAULT_TIP_AGE_STALE_MS = 3 * 60 * 60 * 1000; // 3h

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Decide whether a bridged hive's origin has fallen stale relative to its local canonical.
 * Pure; exported for unit testing. See the module header for the two-signal design + the
 * false-alarm fix.
 */
export function evaluateOriginFreshness(
  snapshot: OriginFreshnessSnapshot,
  thresholds: OriginFreshnessThresholds = {},
): OriginFreshnessVerdict {
  const aheadCountMax = thresholds.aheadCountMax ?? DEFAULT_AHEAD_COUNT_MAX;
  const tipAgeStaleMs = thresholds.tipAgeStaleMs ?? DEFAULT_TIP_AGE_STALE_MS;
  const refusedMax = thresholds.publishRefusedSweepsMax ?? DEFAULT_PUBLISH_REFUSED_SWEEPS_MAX;
  const backlogMax = thresholds.publishBacklogSweepsMax ?? DEFAULT_PUBLISH_BACKLOG_SWEEPS_MAX;
  const integratorBacklogMax =
    thresholds.integratorBacklogSweepsMax ?? DEFAULT_INTEGRATOR_BACKLOG_SWEEPS_MAX;

  // WI-5738: an explicit, sustained publish REFUSAL alarms on its own — it is a
  // direct self-report, not an inference, so it must NOT be gated behind the
  // ahead<=0 early return below. In the 2026-07-20 wedge `ahead` was computed
  // against the wrong branch and read 24, which silenced everything; a refusal
  // is true regardless of how any commit-count comes out.
  const publishRefused = (snapshot.publishRefusedSweeps ?? 0) >= refusedMax;
  const refusalReason = publishRefused
    ? `the p2p publish leg has REFUSED to publish for ${snapshot.publishRefusedSweeps} consecutive sweeps` +
      (snapshot.publishRefusalCode ? ` (${snapshot.publishRefusalCode})` : '') +
      // EI-21517899493871930: state ONLY what the publish guard observed. The p2p publish
      // leg does not gate `git push origin` — they are separate egress paths — so a refusal
      // is not evidence about origin, and asserting one induced two CRITICAL filings that
      // were retracted within ~2 minutes. The origin leg is MEASURED (aheadCount /
      // originTipAgeMs) and reported by describeOriginFreshnessAlert, never inferred here.
      ' — nothing this device commits is reaching peers'
    : null;

  // WI-6996: an admitted-but-undrained publish backlog, sustained. Like the refusal
  // above — and for the same reason — this must NOT be gated behind the ahead<=0 early
  // return: in the 2026-08-02 wedge canonical and origin were the SAME frozen sha, so
  // `ahead` was exactly 0 and every inferred signal was silenced while the real fault
  // sat one stage upstream, reporting itself honestly on every tick and being discarded.
  const publishBacklog = (snapshot.publishBacklogSweeps ?? 0) >= backlogMax;
  const backlogReason = publishBacklog
    ? `the p2p publish leg has carried UNDRAINED backlog for ${snapshot.publishBacklogSweeps} consecutive sweeps` +
      (snapshot.publishBacklogCommits != null
        ? ` (published head trails the worktree head by ${snapshot.publishBacklogCommits} commit(s))`
        : '') +
      ' — it is publishing, but losing ground, so the namespace head is falling permanently behind'
    : null;

  // EI-19442274898324113: the integrator leg is not advancing canonical while this device's
  // namespace stands ahead of it. This MUST be computed before — and survive — the ahead<=0
  // early return below, and unlike the two publish signals that is not merely defensive
  // symmetry: an integrator stall is the one fault that GUARANTEES ahead===0, because origin
  // can only freeze here as a consequence of canonical freezing. Gating it behind that return
  // would place the signal exactly where it can never fire.
  const integratorBacklog = (snapshot.integratorBacklogSweeps ?? 0) >= integratorBacklogMax;
  const integratorReason = integratorBacklog
    ? `the INTEGRATOR leg has left the local namespace ahead of canonical refs/hive/staging for ${snapshot.integratorBacklogSweeps} consecutive sweeps` +
      (snapshot.integratorBacklogCommits != null
        ? ` (namespace is ${snapshot.integratorBacklogCommits} commit(s) ahead of canonical)`
        : '') +
      ' — canonical is frozen, so egress has nothing to push and origin cannot advance'
    : null;

  const ahead = snapshot.aheadCount ?? 0;
  // Nothing to push (local at/behind the tracked origin tip, or unknown) ⇒ never stale —
  // the false-alarm-fix idiom every sibling watchdog applies to its own "idle" state.
  // NOTE the three self-reported signals deliberately survive this return; only the two
  // INFERRED ones are suppressed here.
  if (ahead <= 0) {
    const selfReported = [refusalReason, backlogReason, integratorReason].filter(Boolean) as string[];
    return {
      state: publishRefused || publishBacklog || integratorBacklog ? 'stale' : 'ok',
      aheadCountStale: false,
      tipAgeStale: false,
      publishRefused,
      publishBacklog,
      integratorBacklog,
      reason: selfReported.length > 0 ? selfReported.join('; ') : null,
    };
  }

  const aheadCountStale = ahead >= aheadCountMax;
  const tipAgeStale = snapshot.originTipAgeMs != null && snapshot.originTipAgeMs > tipAgeStaleMs;
  const stale = aheadCountStale || tipAgeStale || publishRefused || publishBacklog || integratorBacklog;

  let reason: string | null = null;
  if (stale) {
    const parts: string[] = [];
    if (refusalReason) parts.push(refusalReason);
    if (backlogReason) parts.push(backlogReason);
    if (integratorReason) parts.push(integratorReason);
    if (aheadCountStale) {
      parts.push(
        `local canonical is ${ahead} commit(s) ahead of the last-known origin tip (>= ${aheadCountMax}) — a backlog is piling up unpushed`,
      );
    }
    if (tipAgeStale && snapshot.originTipAgeMs != null) {
      parts.push(
        `the tracked origin tip has not advanced in ~${hrs(snapshot.originTipAgeMs)}h while local stayed ${ahead} commit(s) ahead of it — origin looks frozen`,
      );
    }
    reason = parts.join('; ');
  }

  return {
    state: stale ? 'stale' : 'ok',
    aheadCountStale,
    tipAgeStale,
    publishRefused,
    publishBacklog,
    integratorBacklog,
    reason,
  };
}

/**
 * WI-6643 — which of the signals the operator should be told about.
 *
 * `publish-refused` is the direct self-report; `origin-behind` is the pair of
 * inferred signals (aheadCount / tipAge) that share one runbook.
 *
 * EI-19442274898324113 adds `integrator-backlog`. The causes are reported in PIPELINE
 * ORDER — publish (worktree -> namespace), then integrate (namespace -> canonical), then
 * origin-behind (canonical -> origin) — because each stage starves the ones downstream of
 * it, so announcing a downstream symptom buries the upstream cause. That is the same
 * reasoning the refusal precedence below already documents.
 */
export type OriginFreshnessCause =
  | 'publish-refused'
  | 'publish-backlog'
  | 'integrator-backlog'
  | 'origin-behind';

export interface OriginFreshnessAlertFraming {
  cause: OriginFreshnessCause;
  /** notifyAttention title. */
  title: string;
  /** The broadcast summary — the ONE line an agent sees in coord:inbox. */
  summary: string;
  /** The "why it matters / claim it" paragraph appended to the alarm body. */
  whyItMatters: string;
}

/**
 * WI-6643 — name the alarm after the cause that actually fired.
 *
 * Until now the title, summary and "why it matters" runbook were hardcoded to the
 * origin-behind framing, and `verdict.reason` (which DOES state a refusal correctly)
 * was buried in the body. On 2026-07-28 that misdirected the responding agent for
 * ~25min: the guard had refused the publish over a secrets finding, and the alarm
 * announced "GitHub origin is falling behind local; bridge divergence classifier
 * reports clear" and told them to go inspect `metadata.github_bridge` and the
 * integrator lease — a bridge that was in fact working fine. The detector was
 * right and the ANNOUNCEMENT sent them to the wrong subsystem.
 *
 * A refusal takes precedence over the inferred signals because it is both the
 * direct self-report AND the actionable one: while the publish leg refuses, origin
 * falls behind as a CONSEQUENCE, so reporting the consequence buries the cause.
 */
/** Sub-hour ages rendered as minutes — `hrs()` alone prints a 3-minute-old tip as "0h",
 *  which reads as "unknown/zero" exactly where the freshest evidence lives. */
function ageLabel(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${hrs(ms)}h`;
}

/**
 * EI-21517899493871930 — the origin blast radius of a p2p-publish signal, MEASURED.
 *
 * The p2p publish leg and `git push origin` are SEPARATE egress paths: a bridged install can
 * be refusing every publish while origin advances on its ordinary git-sync cadence. Measured
 * 2026-08-26T12:16:38Z on `papercusp` (hiveGit.mode = 'bridged'), within a minute of the alarm
 * firing and immediately after an explicit `git fetch origin staging`: origin was ONE commit and
 * ~3 minutes behind local — i.e. healthy — while the alarm asserted "nothing this device commits
 * reaches peers or origin". That overstatement induced two CRITICAL filings (WI-40760,
 * EI-21201399884691584) that were retracted after 114s and 63s respectively.
 *
 * The correction is not softer wording — it is a different DERIVATION. The watchdog computes
 * `aheadCount` and `originTipAgeMs` a few lines before it builds this framing, so the alarm
 * reports the origin leg it already measured instead of inferring it from the p2p refusal.
 *
 * The UNMEASURED branch deliberately does NOT fall back to "affected". An alarm that guesses
 * wide gets discounted wholesale, and the half that is genuinely broken — the p2p half — stops
 * being believed along with it.
 */
function describeMeasuredOriginLeg(
  verdict: Pick<OriginFreshnessVerdict, 'aheadCountStale' | 'tipAgeStale'>,
  ctx: { aheadCount?: number | null; originTipAgeMs?: number | null },
): string {
  const ahead = ctx.aheadCount ?? null;
  const ageMs = ctx.originTipAgeMs ?? null;
  if (ahead == null && ageMs == null) {
    return 'Origin egress is NOT measured by this signal — do not infer that it is affected.';
  }
  const parts: string[] = [];
  if (ahead != null) parts.push(`local is ${ahead} commit(s) ahead of the tracked origin tip`);
  if (ageMs != null) parts.push(`that tip last moved ${ageLabel(ageMs)} ago`);
  const measured = parts.join('; ');
  return verdict.aheadCountStale || verdict.tipAgeStale
    ? `Origin is ALSO measurably behind (${measured}).`
    : `Origin egress is measured separately and is UNAFFECTED (${measured}).`;
}

export function describeOriginFreshnessAlert(
  verdict: OriginFreshnessVerdict,
  ctx: {
    slug: string;
    potHomeSlug?: string | null;
    publishRefusalCode?: string | null;
    publishBacklogCommits?: number | null;
    /** EI-19442274898324113: how far the namespace stands ahead of canonical, for the body. */
    integratorBacklogCommits?: number | null;
    /** EI-21517899493871930: the MEASURED origin leg, so a p2p-publish alarm reports origin's
     *  actual state instead of inferring it. Same values the snapshot was evaluated from —
     *  `git rev-list --count <originSha>..<canonicalSha>` and the age of the tracked origin
     *  tip. OMITTED/null means UNMEASURED, and the alarm then says exactly that: it never
     *  falls back to asserting impact. */
    aheadCount?: number | null;
    originTipAgeMs?: number | null;
  },
): OriginFreshnessAlertFraming {
  const where = ctx.potHomeSlug ? `${ctx.slug} (bridged hive ${ctx.potHomeSlug})` : ctx.slug;
  const originLeg = describeMeasuredOriginLeg(verdict, ctx);

  if (verdict.publishRefused) {
    const code = ctx.publishRefusalCode ?? 'unknown';
    // The recovery lever is code-specific: a `secrets` refusal is the one an agent
    // can clear itself (WI-5591 runtime path exemptions, reachable from an ordinary
    // workspace-scoped session as of WI-6641).
    const lever =
      code === 'secrets'
        ? `Claim it: the publish guard found a secret-shaped string in the range it is judging. Inspect the git-sync ` +
          `journal for the offending path:line, then — if and ONLY if it is a false positive (a detector fixture, a ` +
          `documented example credential, a placeholder, never a REAL live secret) — register it with ` +
          `\`pot_git:secrets_exemptions {action:'add', path, reason}\` and the next tick retries. If it IS a real ` +
          `credential, rotate it; editing the file is NOT enough, because the offending blob is already in history.`
        : `Claim it: inspect the git-sync routine's \`metadata.own_head_publish\` for the refusal detail, and the ` +
          `git-sync journal for the guard's own log line naming the offending commit.`;
    return {
      cause: 'publish-refused',
      // EI-21517899493871930: the title and summary state the PEER leg only — that is all the
      // publish guard observed. The origin leg is appended from `originLeg`, which reports the
      // measurement or says plainly that there is none.
      title: `p2p publish REFUSED (${code}) — this device's commits are reaching no peers`,
      summary:
        `p2p publish REFUSED on ${ctx.slug} (${code}) — the publish guard is refusing every tick, so nothing this ` +
        `device commits is reaching PEERS. ${originLeg} This is NOT a bridge/egress fault.`,
      whyItMatters:
        `Why it matters: the publish guard's baseline only advances through an ADMITTED publish, so a hard refusal ` +
        `re-judges the SAME range on every tick and stays refused until the finding is resolved — it does not ` +
        `self-heal. If origin is ALSO behind, that is a downstream SYMPTOM here; the bridge and its divergence ` +
        `classifier are working correctly and are not where to look.\n\n${lever}`,
    };
  }

  // WI-6996 — a BACKLOG outranks the inferred signals for the same reason a refusal does:
  // origin falling behind is the downstream consequence, so announcing the consequence
  // sends the responder to the bridge, which is working correctly. On 2026-08-02 that
  // misdirection cost ~6h across five agents — the same mistake WI-6643 fixed for
  // refusals, recurring here because the framing was per-cause but the CAUSE was missing.
  if (verdict.publishBacklog) {
    const trails =
      ctx.publishBacklogCommits != null ? ` The published head trails by ${ctx.publishBacklogCommits} commit(s).` : '';
    return {
      cause: 'publish-backlog',
      title: 'p2p publish is LOSING GROUND — backlog never drains, nothing is refused',
      summary:
        `p2p publish BACKLOG on ${ctx.slug} — the publish leg is admitted (NOT refusing) but ends every tick with ` +
        `backlog remaining, so the namespace head is falling permanently behind.${trails} This is NOT a bridge/egress fault.`,
      whyItMatters:
        `Why it matters: own-head publish is INCREMENTAL (WI-5738) — it drains a bounded slice per tick. When the ` +
        `slice is smaller than the inflow, the namespace head loses ground indefinitely and there is no refusal to ` +
        `see, because nothing is being refused. Downstream this is SILENT by construction: the integrator can only ` +
        `announce shas that are ANCESTORS of the already-accepted watermark, the bridge rejects each one ` +
        `non-fast-forward (a TERMINAL reason that skips-and-continues and logs nothing), and \`last_status\` stays ` +
        `'synced' throughout. Canonical then freezes, and because origin is only ever a copy of canonical, the ` +
        `aheadCount/tipAge signals compare two values that are frozen TOGETHER and report healthy.\n\n` +
        `Claim it: read \`metadata.own_head_publish\` on the ${where} git-sync routine — compare \`publishedSha\` ` +
        `(what actually became servable) against \`sha\` (the worktree head judged this tick), and check ` +
        `\`blockedAtCommit\` / \`oversizedCommit\` for a single commit wedging the range. A large blob landing ` +
        `repeatedly in the range (e.g. regenerated multi-MB generated files) throttles the byte cap and is the ` +
        `usual cause of a slice that cannot keep up.`,
    };
  }

  // EI-19442274898324113 — the SAME "canonical and origin freeze together" endgame the
  // publish-backlog framing above describes, reached from a different stage: publish is
  // HEALTHY here (the namespace has the commits) and the INTEGRATOR is what never advances
  // canonical. It needs its own framing because the levers are disjoint: nothing in
  // `own_head_publish` will look wrong, so an operator sent to that field by the neighbouring
  // alarm finds a clean leg and concludes the alarm is noise.
  if (verdict.integratorBacklog) {
    const trails =
      ctx.integratorBacklogCommits != null
        ? ` The namespace stands ${ctx.integratorBacklogCommits} commit(s) ahead of canonical.`
        : '';
    return {
      cause: 'integrator-backlog',
      title: 'INTEGRATOR is not advancing canonical — namespace ahead, origin frozen',
      summary:
        `INTEGRATOR BACKLOG on ${ctx.slug} — this device has published its commits to its namespace, but ` +
        `canonical refs/hive/staging is not advancing, so egress has nothing to push and GitHub origin is frozen.` +
        `${trails} Publish is HEALTHY — do not go looking at own_head_publish.`,
      whyItMatters:
        `Why it matters: this fault DISABLES ITS OWN DETECTOR, which is why it runs for hours in silence. origin ` +
        `can only ever be a copy of canonical, so when the integrator stops, BOTH freeze at the same sha, ` +
        `\`aheadCount\` is exactly 0, and the "nothing to push ⇒ never stale" early return declares the pot healthy ` +
        `while the origin-tip clock ages past its threshold unread. Measured on papercusp 2026-08-03: ~5.4h and 28 ` +
        `commits with \`of_alerted\` false, \`of_stall_sweeps\` 0, and sibling pots alarming correctly the whole ` +
        `time — then it SELF-HEALED, leaving nothing behind to find. A tell that needs no tooling: origin/main ` +
        `AHEAD of origin/staging, which is structurally impossible unless two different mechanisms advance them ` +
        `(green-checkpoint pushes main directly; staging goes via the bridge).\n\n` +
        `Claim it: read \`metadata.integrator_status\` on the ${where} git-sync routine. \`skipped:'not_authority'\` ` +
        `names the lease HOLDER — check whether that peer is actually integrating, because publishing \`git-sync\` ` +
        `in \`shared_presence.active_routines\` proves only that the routine is ARMED, not that the device advances ` +
        `THIS pot's canonical ref. Compare \`metadata.integrator.at\` (last REAL integration) against now, and ` +
        `\`git rev-list --count refs/hive/staging..refs/namespaces/<self>/refs/heads/staging\` in the pot's bare ` +
        `store. Taking over is safe by the integrator leg's own contract (FF-only + CAS + epoch fence, proven ` +
        `P-308) — it documents that two nodes briefly both integrating is accepted and strictly better than freezing.`,
    };
  }

  return {
    cause: 'origin-behind',
    title: 'origin freshness STALLED — GitHub origin is falling behind local',
    summary: `origin freshness STALLED on ${ctx.slug} (bridged) — GitHub origin is falling behind local; bridge divergence classifier reports clear.`,
    whyItMatters:
      `Why it matters: the github-bridge divergence classifier only fires on structured residues ` +
      `(rejectedNonFF / blockedSecrets / …) — a bridge that is reachable but simply stuck (a starved integrator lease, ` +
      `a wedged egress fire) still reports 'clear' while origin freezes. Claim it: inspect the ${where} git-sync ` +
      `routine's metadata.github_bridge for the last tick's outcome, and check whether the bridge writer (integrator ` +
      `lock-authority lease holder) is actually running.`,
  };
}

/**
 * WI-6643 — the recovery line, worded for the cause that had alarmed. Recovering
 * from a refusal is NOT "origin caught back up" (the 2026-07-28 recovery said
 * exactly that when what actually happened was a secrets exemption landing).
 */
export function describeOriginFreshnessRecovery(cause: OriginFreshnessCause, slug: string): string {
  if (cause === 'publish-refused') {
    return `p2p publish RECOVERED on ${slug} — the publish guard is admitting again; the earlier refusal alarm is stale.`;
  }
  if (cause === 'publish-backlog') {
    // WI-6996: recovering from a backlog is "the leg caught up", NOT "origin caught back
    // up" — origin catching up is the downstream consequence, and wording it that way is
    // the same conflation that made the original alarm point at the wrong subsystem.
    return `p2p publish DRAINED on ${slug} — the publish leg has caught up and is fully drained; the earlier backlog alarm is stale.`;
  }
  if (cause === 'integrator-backlog') {
    // Same discipline as the publish-backlog wording above: recovery is "the INTEGRATOR
    // advanced canonical", not "origin caught up". Origin catching up is downstream, and
    // saying so would credit the wrong stage — which matters here more than anywhere,
    // because this fault self-heals and the recovery line is often the ONLY durable
    // record anyone ever reads of it.
    return `INTEGRATOR RECOVERED on ${slug} — canonical refs/hive/staging has advanced and the namespace backlog is integrated; the earlier integrator alarm is stale.`;
  }
  return `origin freshness RECOVERED on ${slug} — GitHub origin has caught back up; the earlier stall alarm is stale.`;
}

/**
 * Thin alias matching the exact signature WI-5607 sketched as the suggested
 * implementation (`originFreshness({ aheadCount, originTipAgeMs }, thresholds) → 'ok' |
 * 'stale'`), for anyone grepping for that name. `evaluateOriginFreshness` above (with the
 * `reason` + per-signal breakdown) is what the watchdog actually consumes.
 */
export function originFreshness(
  snapshot: OriginFreshnessSnapshot,
  thresholds: OriginFreshnessThresholds = {},
): 'ok' | 'stale' {
  return evaluateOriginFreshness(snapshot, thresholds).state;
}
