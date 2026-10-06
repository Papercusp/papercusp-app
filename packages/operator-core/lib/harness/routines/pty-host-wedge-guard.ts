/**
 * pty-host-wedge-guard — find live psu-pty hosts that have gone WAKE-DEAF, from
 * OUTSIDE the host process (EI-20287339148365013 / the owner's "I want a durable fix").
 *
 * ## The class
 * A psu-pty host is a per-session process that runs whatever code it started with,
 * forever. When its owner-composer gate believes an unsubmitted input line is staged,
 * every injected wake is DEFERRED "for the next natural turn" — and the agent simply
 * stops taking turns. Measured 2026-08-12: one host deferred 32 consecutive wakes and
 * sat idle ~50 minutes; the episode ended only because a human noticed.
 *
 * ## Why this must be an EXTERNAL observer, not more host-side code
 * Two independent reasons, both verified rather than assumed:
 *
 *  1. THE WAKE RECEIPT STRUCTURALLY CANNOT REPORT THE DEFERRAL. psu-pty-host.mjs acks
 *     `accepted` BEFORE the delivery gate runs, and says so in its own comment: every
 *     outcome the gate reaches "is already durably recorded via appendHostEvent() ...
 *     exactly as a caller ... would have had to learn it — from the durable event log
 *     or the pty's own output, NEVER from this ACK". So `woken:1 / delivered` is a
 *     statement about DELIVERY TO A HANDLE, not about a turn happening, and no amount
 *     of care at the call site can recover the difference. The per-owner
 *     `<owner>.events.jsonl` ledger is the only channel carrying the truth.
 *
 *  2. A CODE FIX CANNOT REACH A PROCESS THAT STARTED BEFORE IT. The in-host breaker
 *     (`shouldBreakComposerWedge`, b9543fc83e) closes this class going FORWARD, but 64
 *     of the 162 live hosts measured on this box predate the parse fix that stops the
 *     phantom from being staged at all, and a carry-respawn restarts the AGENT, not the
 *     HOST (measured: su-f0c6fa5e respawned 22:56:00Z and deferred its first wake at
 *     22:59:12Z against the same phantom; its host pid had been alive since 08:45:50Z).
 *     Those hosts can never self-heal. The ledger, however, is written identically by
 *     hosts of EVERY vintage — which is precisely what lets one external reader observe
 *     the population that host-side code can no longer reach.
 *
 * ## The layering property worth preserving
 * The in-host breaker trips at 5 consecutive defers. This guard's threshold sits ABOVE
 * it ({@link DEFAULT_MIN_CONSECUTIVE_DEFERS}), so a host running current code breaks its
 * own wedge long before this guard would name it. That is not a redundancy — it means a
 * firing here is itself EVIDENCE that the first-line fix did not run, which is the one
 * thing an external observer can establish and the host cannot report about itself.
 *
 * ## Two wedge CLASSES, one sweep
 * A host can be wake-deaf for two structurally different reasons, and each gets its own
 * classifier over the same ledger read:
 *
 *   `composer`  — {@link classifyComposerWedge}. The gate believes a human staged an input
 *                 line, so every wake is politely deferred. Discriminated by an unchanging
 *                 `pendingLength`.
 *   `busy-gate` — {@link classifyBusyGateWedge} (WI-2141553). The wake never reaches that
 *                 gate: the agent is never observed AT ITS PROMPT inside the busy cap, so
 *                 an accepted delivery is parked and no turn happens. Discriminated by the
 *                 longest observed quiet gap staying near zero.
 *
 * They are NOT variants of one rule. They key on different event kinds, need different
 * safety invariants, and — see {@link BUSY_GATE_STREAK_CLEARING_KINDS} — take OPPOSITE
 * readings of a respawn, for reasons that are measured rather than assumed.
 *
 * ## Scope (deliberate)
 * Phase 1 DETECTS and SURFACES. It does not kill or relaunch anything. The tempting next
 * step — teaching the wake-reachability oracle that a wedged host is not reachable — is
 * deliberately deferred: that verdict feeds loop-TERMINATION guards, so a false positive
 * there disarms live agents, and this detector's precision should be measured against the
 * live population before anything acts on it.
 *
 * That caution binds the `busy-gate` class HARDER than the composer one, because its
 * dangerous false positive is ordinary: a genuinely long turn emits output continuously,
 * so it presents to the discriminator exactly as a wedge does, and only the streak-span
 * floor separates them. Measure that floor against the live population before this class is
 * allowed to drive anything.
 */
import {
  listLiveHostsAsync,
  readHostEventTailAsync,
  hostStartedAtAsync,
  PSU_PTY_DIR,
  type PsuPtyHost,
  type PtyHostEvent,
} from '../../events/await/psu-pty-discovery';
import type { AttentionNotifyInput } from '../../attention-notify';
import { broadcastSevereEvent } from '../../severe-event-broadcast';
import type { WedgeIssueInput, WedgeIssueResult } from './pty-host-wedge-issue';
import type { WakeDeliveryHealth } from './psu-pty-delivery-rate';

/** The host event kind that records a wake being refused for a staged owner line. */
export const DEFER_KIND = 'turn-deferred-for-owner-input';

/**
 * Minimum consecutive defers before this guard will name a host.
 *
 * Sits ABOVE the in-host breaker's default of 5 (PAPERCUSP_PSU_PTY_WEDGE_BREAK_MAX_DEFERS)
 * on purpose — see the layering note in the module header. Raising the breaker's max
 * above this number would silently invert that relationship, which is why both numbers
 * are asserted against each other in the tests rather than merely documented here.
 */
export const DEFAULT_MIN_CONSECUTIVE_DEFERS = 8;

/**
 * Minimum wall-clock span the streak must cover.
 *
 * A burst of wakes can produce many defers in seconds — e.g. a fleet leader waking every
 * member at once, or a retry loop. That is backpressure, not a wedge. A wedge is defined
 * by DURATION: the line never moves and the agent never takes a turn. 10 minutes is well
 * past any legitimate burst and still far inside the ~50-minute strands measured.
 */
export const DEFAULT_MIN_STREAK_SPAN_MS = 10 * 60_000;

/**
 * How long a host must have produced NO pty output before a recovery action could be
 * considered safe. A wedged host can still be mid-turn — measured: su-f0c6fa5e was
 * actively producing output at 23:00:22Z while unable to RECEIVE wakes — so idleness is
 * the discriminator between "safe to replace" and "would destroy in-flight work".
 * Reported, not acted on, in Phase 1.
 */
export const DEFAULT_RECOVERY_IDLE_MS = 15 * 60_000;

/** Tail bytes scanned per host. A defer row is ~150 bytes and a streak of interest is
 *  tens of rows, but respawn-heavy ledgers interleave thousands of unrelated rows, so
 *  this is sized for the interleaving rather than for the streak. */
const WEDGE_SCAN_TAIL_BYTES = 256 * 1024;

/**
 * Event kinds that PROVE the staged line went away, and therefore end a streak.
 *
 * Kept DELIBERATELY MINIMAL, because the cost of the two errors is asymmetric: a kind
 * wrongly listed here truncates a real wedge and the guard goes blind, while a kind
 * wrongly omitted at worst lengthens a run whose verdict is already governed by the
 * same-length rule below. Two kinds were removed from an earlier draft of this set after
 * measurement contradicted them, and the measurement is worth keeping:
 *
 *   `respawn-carry-delivered` / `compact-carry-delivered` LOOK like proof — carry text
 *   reached the composer, so surely the gate let it through. It is not. On su-91ef0643
 *   the sequence runs: defer(len=11) … `respawned` … `respawn-carry-delivered` …
 *   defer(len=11) four minutes later, twice over, across four hours. The phantom SURVIVES
 *   a carry delivery. Trusting those kinds cut recall from 3 known-wedged hosts to 1.
 *
 * Also deliberately absent: `respawned`. A respawn replaces the AGENT while the host —
 * and its composer model — persist, which is why the wedge survives one.
 */
const STREAK_CLEARING_KINDS = new Set<string>([
  // The in-host breaker fired and cleared the line itself.
  'owner-composer-wedge-cleared',
  // A respawn cleared a staged line (the current host's respawn-time clear).
  'owner-composer-cleared-on-respawn',
  // A human typed. Whatever else is true, this composer is not an abandoned phantom.
  'owner-input-during-compact-wait',
]);

/** Milliseconds for an event's `ts`, or null when it is missing/unparseable. */
function eventTimeMs(ev: PtyHostEvent): number | null {
  if (typeof ev.ts !== 'string') return null;
  const t = Date.parse(ev.ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * What EVERY wedge class must report, whatever mechanism wedged the host.
 *
 * Extracted (WI-2141553) when a second class arrived, so the sweep can sort, render and
 * page over a mixed population without knowing which mechanism produced a verdict. Each
 * class then adds only its own discriminator — the field its streak invariant is built on.
 */
export interface WedgeVerdictCommon {
  /** Does this host meet EVERY wedge criterion for this class? */
  wedged: boolean;
  /** Length of the trailing consecutive-defer run, scoped to this host's own lifetime. */
  consecutiveDefers: number;
  /** Wall-clock span from the run's first defer to its last. */
  streakSpanMs: number;
  /** Age of the most recent defer, or null when there were none. */
  lastDeferAgeMs: number | null;
  /** One honest line, always present — including for the not-wedged verdicts. */
  reason: string;
}

export interface ComposerWedgeVerdict extends WedgeVerdictCommon {
  /** The one staged length shared by every defer in the run (the run ends at any change). */
  pendingLength: number | null;
  /**
   * Did these defers carry `pendingAgeMs`/`ownerQuietMs`?
   *
   * Their ABSENCE is a precise, cheap signature that the host predates the forensics the
   * in-host breaker keys on — i.e. that it cannot self-recover. Measured across the live
   * population: the wedged group was 0/N on both fields; the healthy group was N/N.
   */
  emitsForensics: boolean;
}

export interface ClassifyComposerWedgeInput {
  /** The host's ledger tail, oldest-first (as {@link readHostEventTail} returns it). */
  events: PtyHostEvent[];
  /** Epoch ms this host process started. Events at or before it belong to a PREDECESSOR. */
  startedAtMs: number;
  now?: number;
  minConsecutiveDefers?: number;
  minStreakSpanMs?: number;
}

/**
 * Classify one host's ledger tail. PURE — no I/O, injectable clock.
 *
 * The discriminator that carries the verdict is CONSTANT `pendingLength`, and it is
 * chosen from measurement rather than intuition: every wedged host in the live
 * population showed the same 11 characters on every defer (VTE's XTVERSION reply
 * `>|VTE(7600)`, mis-parsed into the composer), while healthy backpressure showed lengths
 * that moved (53/48/80). It also happens to be the safe rule for the case this must never
 * get wrong: a person types, so their line's length changes, so a person can never
 * accumulate a streak no matter how long they leave an unsent message staged.
 */
export function classifyComposerWedge(input: ClassifyComposerWedgeInput): ComposerWedgeVerdict {
  const {
    events,
    startedAtMs,
    now = Date.now(),
    minConsecutiveDefers = DEFAULT_MIN_CONSECUTIVE_DEFERS,
    minStreakSpanMs = DEFAULT_MIN_STREAK_SPAN_MS,
  } = input;

  const notWedged = (reason: string, over: Partial<ComposerWedgeVerdict> = {}): ComposerWedgeVerdict => ({
    wedged: false,
    consecutiveDefers: 0,
    pendingLength: null,
    streakSpanMs: 0,
    lastDeferAgeMs: null,
    emitsForensics: false,
    reason,
    ...over,
  });

  // Walk BACKWARDS from the tail, collecting the trailing run of defers that all share ONE
  // staged length. Anything in STREAK_CLEARING_KINDS ends the run; every other kind is
  // neutral and is stepped over (a wedged host still respawns, reconnects MCP and drops
  // stale fires throughout, and none of those touch the composer).
  //
  // A DIFFERENT pendingLength also ends the run, rather than marking it "varied". The
  // distinction matters and was learned from data: on su-efa8b152 a long len=11 phantom
  // episode is followed by a single len=31 defer. Poisoning the whole run as "varied"
  // reports that host as healthy AND loses the episode; treating the change as a BOUNDARY
  // says the true thing — one staged line blocked wakes for hours, then a different line
  // replaced it. It is also the stricter rule for the case that must never be wrong: a
  // person types, so their line's length moves, so each of their defers starts a fresh run
  // of length 1 and a human can never accumulate a streak.
  const run: PtyHostEvent[] = [];
  let runLength: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const ts = eventTimeMs(ev);

    // THE SCOPING RULE. The ledger is per-OWNER and outlives any one host process, so an
    // event from before this host started belongs to a PREVIOUS incarnation. Counting
    // unscoped charged four hosts with their predecessors' incidents (2026-08-12) — the
    // impossibility that caught it was "defers timestamped before the host they were
    // attributed to had started". An event with no readable ts cannot be proven to be
    // ours, so it stops the walk rather than being credited to us.
    if (ts == null) break;
    if (ts <= startedAtMs) break;

    if (STREAK_CLEARING_KINDS.has(kind)) break;
    if (kind !== DEFER_KIND) continue;

    const len = typeof ev.pendingLength === 'number' ? ev.pendingLength : null;
    if (runLength == null) runLength = len;
    else if (len !== runLength) break; // a different staged line — a new episode
    run.push(ev);
  }

  if (run.length === 0) return notWedged('no deferrals in this host’s own lifetime');

  // run is newest-first; read the ends accordingly.
  const newest = run[0];
  const oldest = run[run.length - 1];
  const newestTs = eventTimeMs(newest) ?? now;
  const oldestTs = eventTimeMs(oldest) ?? newestTs;
  const streakSpanMs = Math.max(0, newestTs - oldestTs);
  const lastDeferAgeMs = Math.max(0, now - newestTs);

  // Uniform BY CONSTRUCTION — the walk above ends the run at any length change — so this
  // reads the run's one length rather than re-deriving whether it varied.
  const pendingLength = runLength;
  const emitsForensics = run.some(
    (e) => typeof e.pendingAgeMs === 'number' || typeof e.ownerQuietMs === 'number',
  );

  const base = {
    consecutiveDefers: run.length,
    pendingLength,
    streakSpanMs,
    lastDeferAgeMs,
    emitsForensics,
  };

  if (pendingLength == null || pendingLength <= 0) {
    return notWedged(
      `${run.length} consecutive deferral(s) with no usable pendingLength — cannot distinguish a ` +
        'phantom from a person, so refusing to name this host',
      base,
    );
  }
  if (run.length < minConsecutiveDefers) {
    return notWedged(
      `${run.length} consecutive deferral(s) — below the ${minConsecutiveDefers} floor (the in-host ` +
        'breaker is still expected to handle this)',
      base,
    );
  }
  if (streakSpanMs < minStreakSpanMs) {
    return notWedged(
      `${run.length} consecutive deferral(s) but only over ${Math.round(streakSpanMs / 1000)}s — a ` +
        'burst of wakes is backpressure, not a wedge',
      base,
    );
  }

  return {
    ...base,
    wedged: true,
    reason:
      `${run.length} consecutive wake deferral(s) over ${Math.round(streakSpanMs / 60_000)}m, every ` +
      `one against the SAME ${pendingLength}-char staged line, with no intervening submit` +
      (emitsForensics
        ? ''
        : ' — and no pendingAgeMs/ownerQuietMs on any of them, the signature of a host too old to ' +
          'run the in-host breaker at all'),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * WEDGE CLASS 2 — the busy-gate streak (WI-2141553)
 *
 * A DIFFERENT way to be wake-deaf, with a different mechanism and therefore its own
 * classifier. Class 1 above is a composer phantom: the gate believes a human staged a
 * line, so it politely defers. This one never reaches that gate — the delivery is dropped
 * because the agent is never observed AT ITS PROMPT within the busy cap, so an accepted
 * wake is parked and no turn happens. Measured shape (EI-22102038982840555, su-be3900dd,
 * 2026-09-01 20:15–23:16Z): 15 accepted-but-parked deliveries over ~2.5h, ended not by the
 * wake channel noticing but by an UNRELATED host-code-staleness respawn.
 *
 * Until WI-2141048 this was undiagnosable even after the fact — the row was emitted only
 * for `carry-respawn`, so a turn/reset/recycle killed here left a stderr line and nothing
 * durable. A census of 6,795 ledgers on 2026-09-02 found 11,544 carry-respawn rows and
 * ZERO turn-mode siblings of any spelling. That fix is what makes this classifier possible
 * at all; nothing here needs a further change to psu-pty-host.mjs.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The host event kind recording a delivery dropped because the agent stayed mid-turn. */
export const BUSY_GATE_KIND = 'busy-gate-expired';

/**
 * Delivery modes this classifier counts.
 *
 * `carry-respawn` is deliberately EXCLUDED — that path already had durable coverage before
 * WI-2141048 and owns its own re-arm/supersede/drop lifecycle downstream of this row. A
 * carry-respawn defer is therefore stepped over as NEUTRAL: not counted, and not treated as
 * clearing, because it is evidence of the very same condition and ending a run on it would
 * truncate real streaks.
 *
 * ⚠ This set is an ALLOW-list, and that is load-bearing: the live population carries at
 * least one mode reaching this gate that reading `runGatedDelivery`'s `msg.mode ===` branches
 * does NOT enumerate — `mcp-reconnect` (measured 2026-09-02, on 3 of the 9 emitting hosts).
 * A DENY-list built from that source read would have silently counted it. Anything not named
 * here is neutral, so a mode nobody has enumerated yet can never inflate a streak.
 */
export const BUSY_GATE_WEDGE_MODES: ReadonlySet<string> = new Set(['turn', 'reset', 'recycle']);

/**
 * Minimum consecutive busy-gate defers before this guard will name a host.
 *
 * Unlike {@link DEFAULT_MIN_CONSECUTIVE_DEFERS} this number is NOT anchored to an in-host
 * breaker, because this class has none — nothing inside the host recovers a busy-gate
 * streak, which is precisely why the incident ran 2.5h. It is set for repetition alone: one
 * anomalous wake against one long turn must never be enough.
 */
export const DEFAULT_MIN_BUSY_GATE_DEFERS = 8;

/**
 * Minimum wall-clock span for a busy-gate streak — deliberately MUCH longer than the
 * composer class's 10 minutes, and this is the single most important number here.
 *
 * The dangerous false positive for this class is A LONG, LEGITIMATE TURN. An agent that is
 * genuinely working emits output continuously, so its longest quiet gap is also ≈0 and it
 * looks exactly like a wedge to the discriminator below. Long turns are ordinary on this
 * box: the green-checkpoint gate suite alone runs ~55 minutes, and an agent running it
 * would defer every wake for that whole time while being perfectly healthy. 90 minutes
 * clears that documented worst case with margin and still sits well inside the 2.5h
 * incident this guard is built from.
 *
 * ⚠ This bound is REASONED from the longest legitimate turn documented on this box, not
 * yet measured against the live host population. Calibrating it is the explicit
 * precondition WI-2141553 sets before this class is ever allowed to drive an action.
 */
export const DEFAULT_MIN_BUSY_STREAK_SPAN_MS = 90 * 60_000;

/**
 * How close to zero the longest observed quiet gap must stay, as a fraction of the defer's
 * OWN `quietMs` threshold.
 *
 * A fraction rather than an absolute millisecond count because the row carries the
 * threshold it was judged against, so this self-calibrates to whatever a host was
 * configured with instead of hard-coding a copy of it that could drift.
 *
 * ## Calibrated against the live population, after 0.1 proved INERT
 *
 * This started at 0.1 — a plausible reading of the emitter's phrase "gaps ≈ 0ms". Measured
 * against the live box on 2026-09-02 (81 live hosts, 9 emitting `busy-gate-expired`), that
 * value admitted NOTHING: every observation in the whole population sat between 188ms and
 * 1322ms against a uniform 1500ms cap, so the lowest real reading was still ~25% above the
 * 150ms ceiling 0.1 implied. The classifier broke its run on the FIRST row for every host
 * and could not have fired on any input the box actually produces.
 *
 * That failure mode is worth naming, because its symptom is indistinguishable from success:
 * an inert detector reports zero wedged hosts forever, which reads exactly like a healthy
 * fleet. "Zero false positives" from a rule that can never fire is not evidence.
 *
 * The measured distribution is bimodal in the way the emitter describes, just shifted:
 * continuously-redrawing hosts cluster at ~190–500ms (a TUI repainting a few times a
 * second — never silent, but not silent at MILLISECOND granularity either), while genuine
 * near-misses sit at ~1275–1322ms, i.e. 85–88% of the cap, having very nearly settled. 0.5
 * separates those two clusters with wide margin on both sides.
 *
 * ⚠ What this calibration does NOT establish: the population contained ZERO wedged hosts,
 * so this bound is fitted to the NEGATIVE class only. It is now known not to exclude
 * everything; it is not known to admit a true wedge. That is the same gap
 * {@link DEFAULT_MIN_BUSY_STREAK_SPAN_MS} carries, and the reason this class stays
 * detect-only.
 */
export const DEFAULT_BUSY_GATE_MAX_QUIET_FRACTION = 0.5;

/**
 * Kinds that end a busy-gate streak — and note this set is NOT the composer class's.
 *
 * The two classes need OPPOSITE treatment of a respawn, which is worth stating because it
 * looks like an inconsistency and is not. A composer phantom provably SURVIVES a respawn
 * (measured on su-91ef0643: the same 11-char line keeps deferring across `respawned` +
 * `respawn-carry-delivered`, twice, over four hours) because the host — and its composer
 * model — outlive the agent. A busy-gate verdict is a statement about the CHILD's output,
 * and a respawn replaces that child. Quiet observations either side of one therefore
 * describe different processes, and merging them into a single streak would repeat exactly
 * the unscoped-attribution error that the host-lifetime rule below exists to prevent — the
 * same mistake one level down.
 */
const BUSY_GATE_STREAK_CLEARING_KINDS = new Set<string>(['respawned']);

/** A finite number from an untyped ledger field, or null. */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface BusyGateWedgeVerdict extends WedgeVerdictCommon {
  /**
   * The LARGEST quiet gap seen across the run, in ms.
   *
   * Near 0 is the wedge shape: the pty never fell silent even briefly, so the agent was
   * never observed at its prompt. Compare against {@link quietCapMs} — a value approaching
   * that cap is the opposite finding (a near-miss, where the threshold is merely too tight
   * and the condition resolves on its own).
   */
  observedMaxQuietMs: number | null;
  /** The `quietMs` threshold those observations were judged against, from the rows. */
  quietCapMs: number | null;
  /** Which delivery modes appeared in the run, sorted — turn/reset/recycle. */
  modes: string[];
}

export interface ClassifyBusyGateWedgeInput {
  /** The host's ledger tail, oldest-first (as {@link readHostEventTail} returns it). */
  events: PtyHostEvent[];
  /** Epoch ms this host process started. Events at or before it belong to a PREDECESSOR. */
  startedAtMs: number;
  now?: number;
  minConsecutiveDefers?: number;
  minStreakSpanMs?: number;
  maxQuietFraction?: number;
}

/**
 * Classify one host's ledger tail for a busy-gate streak. PURE — no I/O, injectable clock.
 *
 * The discriminator is the run's `observedMaxQuietMs` staying near zero, and it plays the
 * same structural role `pendingLength` plays for the composer class: a per-row invariant
 * that must hold across the WHOLE run, where any row breaking it is read as an episode
 * BOUNDARY rather than as poisoning the run.
 *
 * What it separates, per the emitter's own comment (psu-pty-host.mjs), is a pty being
 * redrawn continuously from a near-miss against a too-tight cap — "those two have OPPOSITE
 * fixes". What it does NOT separate on its own is a wedged agent from a genuinely busy one,
 * since both emit continuously; that job belongs to {@link DEFAULT_MIN_BUSY_STREAK_SPAN_MS},
 * which is why that bound carries the calibration caveat and this one does not.
 *
 * ⚠ THE NULL TRAP. Both quiet fields are nullable at the emitter (`Number.isFinite(...) ?
 * ... : null`). A null must never be read as "near zero" — that would manufacture a wedge
 * verdict out of MISSING DATA, on a detector whose own module doc says its precision has to
 * be measured before anything acts on it. An unmeasurable row ends the run instead.
 */
export function classifyBusyGateWedge(input: ClassifyBusyGateWedgeInput): BusyGateWedgeVerdict {
  const {
    events,
    startedAtMs,
    now = Date.now(),
    minConsecutiveDefers = DEFAULT_MIN_BUSY_GATE_DEFERS,
    minStreakSpanMs = DEFAULT_MIN_BUSY_STREAK_SPAN_MS,
    maxQuietFraction = DEFAULT_BUSY_GATE_MAX_QUIET_FRACTION,
  } = input;

  const notWedged = (reason: string, over: Partial<BusyGateWedgeVerdict> = {}): BusyGateWedgeVerdict => ({
    wedged: false,
    consecutiveDefers: 0,
    streakSpanMs: 0,
    lastDeferAgeMs: null,
    observedMaxQuietMs: null,
    quietCapMs: null,
    modes: [],
    reason,
    ...over,
  });

  const run: PtyHostEvent[] = [];
  const modes = new Set<string>();
  let observedMaxQuietMs = 0;
  let quietCapMs: number | null = null;
  let unmeasurable = false;
  let nearMissBoundary = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const ts = eventTimeMs(ev);

    // Same scoping rule as the composer walk: the ledger is per-OWNER and outlives any one
    // host process, so anything at or before this host's start belongs to a predecessor,
    // and a row with no readable ts cannot be proven to be ours.
    if (ts == null) break;
    if (ts <= startedAtMs) break;

    if (BUSY_GATE_STREAK_CLEARING_KINDS.has(kind)) break;
    if (kind !== BUSY_GATE_KIND) continue;

    const mode = typeof ev.mode === 'string' ? ev.mode : null;
    if (mode == null || !BUSY_GATE_WEDGE_MODES.has(mode)) continue; // carry-respawn: neutral

    const observed = finiteNumber(ev.observedMaxQuietMs);
    const cap = finiteNumber(ev.quietMs);
    if (observed == null || cap == null || cap <= 0) {
      // Cannot be judged, so it is not credited either way — see THE NULL TRAP above.
      unmeasurable = true;
      break;
    }
    if (observed > cap * maxQuietFraction) {
      nearMissBoundary = true;
      break; // the cap was merely too tight here — a different episode
    }

    if (quietCapMs == null) quietCapMs = cap;
    if (observed > observedMaxQuietMs) observedMaxQuietMs = observed;
    modes.add(mode);
    run.push(ev);
  }

  if (run.length === 0) {
    if (unmeasurable) {
      return notWedged(
        'the most recent busy-gate defer carried no usable observedMaxQuietMs/quietMs — refusing to ' +
          'read missing data as a wedge',
      );
    }
    if (nearMissBoundary) {
      return notWedged(
        'the most recent busy-gate defer observed a quiet gap near its own cap — a near-miss against a ' +
          'too-tight threshold, which resolves on its own',
      );
    }
    return notWedged('no busy-gate deferrals in this host’s own lifetime');
  }

  // run is newest-first; read the ends accordingly.
  const newestTs = eventTimeMs(run[0]) ?? now;
  const oldestTs = eventTimeMs(run[run.length - 1]) ?? newestTs;
  const streakSpanMs = Math.max(0, newestTs - oldestTs);
  const lastDeferAgeMs = Math.max(0, now - newestTs);

  const base = {
    consecutiveDefers: run.length,
    streakSpanMs,
    lastDeferAgeMs,
    observedMaxQuietMs,
    quietCapMs,
    modes: [...modes].sort(),
  };

  if (run.length < minConsecutiveDefers) {
    return notWedged(
      `${run.length} consecutive busy-gate deferral(s) — below the ${minConsecutiveDefers} floor`,
      base,
    );
  }
  if (streakSpanMs < minStreakSpanMs) {
    return notWedged(
      `${run.length} consecutive busy-gate deferral(s) but only over ` +
        `${Math.round(streakSpanMs / 60_000)}m — inside the ${Math.round(minStreakSpanMs / 60_000)}m ` +
        'floor, where a long legitimate turn looks identical',
      base,
    );
  }

  return {
    ...base,
    wedged: true,
    reason:
      `${run.length} consecutive ${base.modes.join('/')} deliver(ies) dropped over ` +
      `${Math.round(streakSpanMs / 60_000)}m because the agent was never observed at its prompt — the ` +
      `longest quiet gap in the whole run was ${observedMaxQuietMs}ms against a ${quietCapMs}ms ` +
      'threshold, i.e. the pty never fell silent even briefly',
  };
}

export interface WedgedHostReport {
  ownerId: string;
  pid: number;
  /** Epoch ms the host process started. */
  startedAt: number;
  /** How long this host process has been alive. */
  hostAgeMs: number;
  /** Idle time from the host's own activity stamps, or null when none are readable. */
  idleMs: number | null;
  /**
   * Would a recovery action be safe RIGHT NOW?
   *
   * `idle` — no pty output for {@link DEFAULT_RECOVERY_IDLE_MS}; replacing this host would
   *   not interrupt anything in flight.
   * `busy` — the agent is still emitting. It is wedged (cannot RECEIVE wakes) yet working,
   *   so trampling it would destroy real work. Surface, never act.
   * `unknown` — no readable activity stamp. Fails toward `busy`, deliberately: the guard's
   *   dangerous error is destroying live work, so absent evidence must not authorise action.
   */
  recoverySafety: 'idle' | 'busy' | 'unknown';
  /**
   * The psu-pty-host build this host actually LOADED (WI-38292), or null on a host too
   * old to advertise one.
   *
   * Carried because it is the AUTHORITATIVE answer to the question this guard otherwise
   * has to infer from the absence of forensics fields: is this host running code that
   * could have healed itself? A null here is not missing data — on this population it is
   * itself the finding, since only a host predating the field can produce one, and those
   * are exactly the hosts no code fix can ever reach.
   */
  hostCodeVersion: string | null;
  /**
   * WHICH mechanism wedged this host.
   *
   * Carried rather than inferred from the verdict's shape because the two classes need
   * different reading by whoever gets paged: a `composer` host is deferring against a
   * staged line that never moves, a `busy-gate` host never reaches its prompt at all. A
   * host can legitimately appear under BOTH, as two reports with the same ownerId.
   */
  wedgeClass: WedgeClass;
  verdict: ComposerWedgeVerdict | BusyGateWedgeVerdict;
}

export type WedgeClass = 'composer' | 'busy-gate';

export interface PtyHostWedgeSweepResult {
  /** Live hosts examined. */
  checked: number;
  /** Hosts meeting every wedge criterion, worst (longest streak) first. */
  wedged: WedgedHostReport[];
  /** Hosts whose ledger yielded no readable events — an absence, NOT a clean bill of health. */
  unreadable: string[];
  dryRun: boolean;
}

export interface PtyHostWedgeSweepDeps {
  /** Injectable for tests; defaults to the real live-host census. */
  listHosts?: (dir?: string) => PsuPtyHost[] | Promise<PsuPtyHost[]>;
  /** Injectable for tests; defaults to the real bounded-tail ledger read. */
  readEvents?: (ownerId: string, dir?: string, maxBytes?: number) => PtyHostEvent[] | Promise<PtyHostEvent[]>;
  /** Injectable for tests; defaults to the real discovery-file start-time read. */
  readStartedAt?: (ownerId: string, dir?: string) => number | null | Promise<number | null>;
  /** Injectable for tests; defaults to the real fleet-wide broadcast. */
  broadcast?: typeof broadcastSevereEvent;
  /**
   * Injectable for tests; defaults to the real OWNER page, imported dynamically at call
   * time (matching stalled-loops-guard): `attention-notify` pulls in the push/SSE
   * transports, and a routine that runs on a cadence must not carry them just to page on
   * the rare wedge.
   */
  notify?: (input: AttentionNotifyInput) => Promise<void>;
  /**
   * P-008: file/update the durable work-item for a wedge class. Injectable for tests;
   * defaults to the real issue-store path, imported dynamically at call time for the same
   * reason `notify` is — `issues-engineer` pulls in the coord thread store, and a detector
   * that runs every 20 minutes must not carry it just to file on the rare wedge.
   */
  recordEpisode?: (input: WedgeIssueInput) => Promise<WedgeIssueResult>;
  /**
   * P-007 telemetry read folded into the durable record. Injectable; defaults to the real
   * aggregate. Returns an explicitly UNMEASURED reading rather than throwing, so a missing
   * migration or empty window degrades the report instead of failing the sweep.
   */
  readHealth?: (ownerIds: readonly string[]) => Promise<WakeDeliveryHealth>;
  now?: number;
}

export interface PtyHostWedgeSweepOptions {
  dryRun?: boolean;
  dir?: string;
  /** Composer-class thresholds. */
  minConsecutiveDefers?: number;
  minStreakSpanMs?: number;
  recoveryIdleMs?: number;
  /**
   * Busy-gate-class thresholds, kept SEPARATE from the composer ones rather than shared.
   *
   * The two classes are calibrated against different things — the composer floor is
   * anchored to the in-host breaker, the busy-gate span to the longest legitimate turn —
   * so one dial moving both would silently retune a class its operator was not thinking
   * about.
   */
  busyGateMinDefers?: number;
  busyGateMinStreakSpanMs?: number;
  busyGateMaxQuietFraction?: number;
}

/**
 * One pass over every live psu-pty host on this box.
 *
 * Cost is one small discovery read plus one bounded tail read per host — no PG, no
 * sockets, and nothing that can perturb a host it is observing. Fail-soft throughout: a
 * host whose ledger cannot be read is REPORTED as unreadable rather than skipped
 * silently, because "I could not see" and "there is nothing there" are the two readings
 * this guard must never conflate.
 */
export async function sweepWedgedPtyHosts(
  opts: PtyHostWedgeSweepOptions = {},
  deps: PtyHostWedgeSweepDeps = {},
): Promise<PtyHostWedgeSweepResult> {
  const {
    dryRun = false,
    dir = PSU_PTY_DIR,
    minConsecutiveDefers = DEFAULT_MIN_CONSECUTIVE_DEFERS,
    minStreakSpanMs = DEFAULT_MIN_STREAK_SPAN_MS,
    recoveryIdleMs = DEFAULT_RECOVERY_IDLE_MS,
    busyGateMinDefers = DEFAULT_MIN_BUSY_GATE_DEFERS,
    busyGateMinStreakSpanMs = DEFAULT_MIN_BUSY_STREAK_SPAN_MS,
    busyGateMaxQuietFraction = DEFAULT_BUSY_GATE_MAX_QUIET_FRACTION,
  } = opts;
  const now = deps.now ?? Date.now();
  // Async default (WI-10004587): a sync psu-pty directory scan blocks the main thread.
  const listHosts = deps.listHosts ?? ((d?: string) => listLiveHostsAsync(d ?? dir));
  // Per-host reads are async too (WI-10006344): the sync forms ran once per live host
  // (~thousands of ledger files) on the main thread, and under host IO pressure a single
  // readSync of a 1.5 kB ledger was measured parked for 1.7 s — long enough to stall the
  // event loop and starve the stall profiler's own Profiler.enable request.
  const readEvents =
    deps.readEvents ?? ((o: string, d?: string, m?: number) => readHostEventTailAsync(o, d ?? dir, m));
  const readStartedAt = deps.readStartedAt ?? ((o: string, d?: string) => hostStartedAtAsync(o, d ?? dir));

  const hosts = await listHosts(dir);
  const wedged: WedgedHostReport[] = [];
  const unreadable: string[] = [];

  for (const host of hosts) {
    const events = await readEvents(host.ownerId, dir, WEDGE_SCAN_TAIL_BYTES);
    if (events.length === 0) {
      unreadable.push(host.ownerId);
      continue;
    }
    // Prefer the discovery file's own startedAt; fall back to the host record we already
    // hold. Without a boundary we cannot tell this host's incidents from its
    // predecessor's, so refusing is the only honest option.
    const startedAtMs = (await readStartedAt(host.ownerId, dir)) ?? host.startedAt;
    if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) {
      unreadable.push(host.ownerId);
      continue;
    }

    // TWO classifiers, ONE ledger read. Both walk the same `events` array already in hand,
    // which is what keeps the sweep's cost at one bounded tail read per host however many
    // wedge classes it learns to recognise.
    const verdicts: Array<{ wedgeClass: WedgeClass; verdict: ComposerWedgeVerdict | BusyGateWedgeVerdict }> = [
      {
        wedgeClass: 'composer',
        verdict: classifyComposerWedge({ events, startedAtMs, now, minConsecutiveDefers, minStreakSpanMs }),
      },
      {
        wedgeClass: 'busy-gate',
        verdict: classifyBusyGateWedge({
          events,
          startedAtMs,
          now,
          minConsecutiveDefers: busyGateMinDefers,
          minStreakSpanMs: busyGateMinStreakSpanMs,
          maxQuietFraction: busyGateMaxQuietFraction,
        }),
      },
    ];
    const hits = verdicts.filter((v) => v.verdict.wedged);
    if (hits.length === 0) continue;

    const stamps = [host.lastActivityAt, host.lastOutputAt, host.lastInputAt].filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    );
    const idleMs = stamps.length ? Math.max(0, now - Math.max(...stamps)) : null;
    const recoverySafety: WedgedHostReport['recoverySafety'] =
      idleMs == null ? 'unknown' : idleMs >= recoveryIdleMs ? 'idle' : 'busy';

    for (const { wedgeClass, verdict } of hits) {
      wedged.push({
        ownerId: host.ownerId,
        pid: host.pid,
        startedAt: startedAtMs,
        hostAgeMs: Math.max(0, now - startedAtMs),
        idleMs,
        recoverySafety,
        hostCodeVersion: host.hostCodeVersion ?? null,
        wedgeClass,
        verdict,
      });
    }
  }

  wedged.sort((a, b) => b.verdict.consecutiveDefers - a.verdict.consecutiveDefers);

  const distinctOwners = [...new Set(wedged.map((w) => w.ownerId))];

  if (wedged.length > 0 && !dryRun) {
    const renderHost = (w: WedgedHostReport) =>
      `- ${w.ownerId} (pid ${w.pid}, host up ${Math.round(w.hostAgeMs / 60_000)}m, ` +
      `${w.recoverySafety}${w.idleMs == null ? '' : ` ${Math.round(w.idleMs / 60_000)}m`}): ${w.verdict.reason}`;

    const SAFETY_NOTE = [
      'A host marked `idle` can be replaced without destroying in-flight work; one marked `busy` is',
      'still emitting output and must NOT be trampled — it is working, it simply cannot be reached.',
    ];

    // ONE BROADCAST PER CLASS, under its OWN conditionKey. These are different faults with
    // different remedies, and they are `oneShot` — sharing a key would let whichever fired
    // first silently swallow the other, reporting a solved problem while the second class
    // stayed invisible.
    const classes: Array<{
      wedgeClass: WedgeClass;
      conditionKey: string;
      headline: (n: number, worst: WedgedHostReport) => string;
      preamble: string[];
    }> = [
      {
        wedgeClass: 'composer',
        conditionKey: 'pty-host-wedge',
        headline: (n, worst) =>
          `${n}/${hosts.length} live psu-pty host(s) are WAKE-DEAF — every wake to them is being ` +
          `deferred against a staged input line that never moves (worst: ${worst.ownerId}, ` +
          `${worst.verdict.consecutiveDefers} consecutive deferrals)`,
        preamble: [
          'Each host below acked its wakes as `delivered` and then took no turn. That receipt is not a',
          'bug at the call site: psu-pty-host acks BEFORE its delivery gate runs, so a deferral can only',
          'ever be observed here, in the on-disk ledger.',
        ],
      },
      {
        wedgeClass: 'busy-gate',
        conditionKey: 'pty-host-busy-gate-wedge',
        headline: (n, worst) =>
          `${n}/${hosts.length} live psu-pty host(s) are dropping every wake at the BUSY GATE — the ` +
          `agent is never observed at its prompt, so accepted deliveries are parked and no turn ` +
          `happens (worst: ${worst.ownerId}, ${worst.verdict.consecutiveDefers} dropped deliveries)`,
        preamble: [
          'These hosts are NOT deferring against a staged line — they never reach that gate. The pty',
          'never falls silent, so each delivery expires against the busy cap and is dropped.',
          '',
          '⚠ READ BEFORE ACTING: this class is DETECT-ONLY and its precision is NOT yet measured. A',
          'genuinely long turn emits continuously too and looks identical to the discriminator; only',
          'the streak-span floor separates them, and that floor is reasoned rather than calibrated.',
          'Treat each host below as a candidate to CONFIRM, not as an established fault.',
        ],
      },
    ];

    const broadcast = deps.broadcast ?? broadcastSevereEvent;

    // P-007 telemetry, read ONCE for the whole sweep and scoped to the wedged hosts: the
    // question a reader has is "are these hosts actually failing to receive wakes", which a
    // fleet-wide average would dilute rather than answer. Fail-soft — an unmeasured reading
    // is a legitimate, explicitly-labelled outcome, never a 0%.
    const readHealth =
      deps.readHealth ??
      (async (ownerIds: readonly string[]) => {
        const { readWakeDeliveryHealth } = await import('./psu-pty-delivery-rate');
        return readWakeDeliveryHealth({ ownerIds });
      });

    // P-008: the durable record. Defaulted here rather than at module scope so the
    // issue-store import (and its coord thread store) is only paid on an actual wedge.
    const recordEpisode =
      deps.recordEpisode ??
      (async (input: WedgeIssueInput) => {
        const [{ recordWedgeEpisode }, issues] = await Promise.all([
          import('./pty-host-wedge-issue'),
          import('../../issues-engineer'),
        ]);
        return recordWedgeEpisode(input, {
          listIssues: (filter) => issues.listIssues(filter as Parameters<typeof issues.listIssues>[0]),
          createIssue: (createInput) =>
            issues.createIssue({
              ...createInput,
              // Forwarded EXPLICITLY rather than left to the blanket cast below. This is
              // a work-item filing seam, and `work_items.admission` has no column
              // default: anything that fails to arrive here mints NULL, which reads as
              // "pre-gate legacy, admitted" and is immediately claimable. Naming the
              // field keeps that decision visible at the seam instead of depending on a
              // spread nobody re-reads — `recordWedgeEpisode` chooses the value (it
              // files born-pending); this wiring only carries it faithfully.
              admission: createInput.admission ?? null,
            } as Parameters<typeof issues.createIssue>[0]),
          commentIssue: (id, body, authorId) => issues.commentIssue(id, body, authorId),
          mergeIssuePayload: (id, patch) => issues.mergeIssuePayload(id, patch),
        });
      });

    for (const cls of classes) {
      const hits = wedged.filter((w) => w.wedgeClass === cls.wedgeClass);
      if (hits.length === 0) continue;
      const owners = new Set(hits.map((h) => h.ownerId));
      try {
        await broadcast({
          summary: cls.headline(owners.size, hits[0]),
          body: [...cls.preamble, '', ...hits.map(renderHost), '', ...SAFETY_NOTE].join('\n'),
          conditionKey: cls.conditionKey,
          oneShot: true,
        });
      } catch {
        /* best-effort — a broadcast failure must never fail the sweep */
      }

      // The durable half. Unlike the broadcast above this is NOT one-shot: it is the record
      // that outlives the episode, so a recurrence appends to an owned item instead of
      // re-firing an alarm nobody can be accountable for.
      try {
        const ownerIds = [...owners];
        const health = await readHealth(ownerIds).catch(() => undefined);
        await recordEpisode({
          wedgeClass: cls.wedgeClass,
          ownerIds,
          detail: hits.map(renderHost),
          ...(health ? { health } : {}),
          nowIso: new Date(now).toISOString(),
        });
      } catch {
        /* best-effort — bookkeeping must never fail the detector that found the outage */
      }
    }

    try {
      const notify = deps.notify ?? (await import('../../attention-notify')).notifyAttention;
      // ONE page for the whole sweep even though the broadcasts split by class: the human
      // decision ("go look at these sessions") is the same one either way, and two pages for
      // one sweep is how a page stops being read.
      //
      // `needs-human` rather than `intervention`: a BUSY wedged host must not be trampled
      // by an automated actuator, and even an idle one is being replaced only because a
      // human decided to — this page exists to put the decision in front of someone.
      const byClass = classes
        .map((c) => ({ c, n: new Set(wedged.filter((w) => w.wedgeClass === c.wedgeClass).map((w) => w.ownerId)).size }))
        .filter((x) => x.n > 0);
      await notify({
        kind: 'needs-human',
        title: `${distinctOwners.length} agent session(s) cannot receive wakes`,
        body:
          `${distinctOwners.length}/${hosts.length} live psu-pty host(s) are wake-deaf — ` +
          byClass.map((x) => `${x.n} ${x.c.wedgeClass}`).join(', '),
        importance: 'high',
        data: {
          wedged: distinctOwners.length,
          checked: hosts.length,
          owners: distinctOwners,
          idleOwners: [
            ...new Set(wedged.filter((w) => w.recoverySafety === 'idle').map((w) => w.ownerId)),
          ],
          byClass: Object.fromEntries(byClass.map((x) => [x.c.wedgeClass, x.n])),
        },
      });
    } catch {
      /* best-effort — paging is not the sweep's contract */
    }
  }

  return { checked: hosts.length, wedged, unreadable, dryRun };
}
