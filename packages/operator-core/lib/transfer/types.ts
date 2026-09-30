/**
 * Transfer-harness vocabulary (self-learning-frontier-2026-06-12 P-022 /
 * FB-08, the D-006 teach-to-learn + memory-unit-test merge).
 *
 * The harness distills candidate lessons from the day's transcripts and
 * RETAINS/PROMOTES a lesson only if a fresh student agent given the lesson
 * beats one without it on the source historical task — replayed through
 * lib/replay (P-020's substrate) and scored by the frozen eval-battery judge.
 * The student-transfer test IS the memory unit test:
 *
 *   tier 'probationary' — admitted free (D-006: admission is never gated, so
 *     the same-turn insight rule is untouched) → 'validated' on a passing
 *     test → 'retired' on repeated failures with no pass (the RETENTION
 *     decision; the memory entry is forgotten).
 *
 * Everything this harness emits is born `origin = 'replay'` (provenance
 * D-002, migration 241's vocabulary); rows live in
 * harness_shared.transfer_lessons (migration 250).
 *
 * Ports (all injectable — unit tests run with fakes, zero LLM/PG):
 *   - {@link LessonDistillerLlm}  — distills lessons from a rendered
 *     transcript (live: an Anthropic call; tests: a fake).
 *   - {@link TranscriptRefLister} — enumerates "the day's" transcript refs
 *     (default: an fs scan of the harness registry's `.papercusp/logs/`;
 *     PG-canonical runs arrive when lib/replay's TranscriptSource grows a PG
 *     leg — the source port itself is FB-06's).
 *   - {@link TransferReplayPort}  — runs the with-lesson vs baseline student
 *     comparison on the source historical task. The live adapter binds to
 *     lib/replay's battery once `frontier:replay-landed` fires; the port
 *     keeps the tick fully testable before that.
 */
import type { SignalOrigin } from '../harness/improvements/provenance';
import type { ReplayTranscript } from '../replay/types';

/** The governor registration id for this loop (migration 244 vocabulary). */
export const TRANSFER_LOOP_ID = 'frontier:transfer-harness';

/**
 * What ONE distillation attempt reserves on the governor before it calls the
 * distiller (P-005).
 *
 * The reservation has to be an up-front ASK, because its whole job is to be
 * subtracted from headroom while the call is in flight — so it cannot be the
 * measured cost, which only exists afterwards. This is that ask: a per-
 * transcript ceiling generous enough that a normal distillation settles well
 * under it (the remainder is released immediately on settlement, so an
 * over-generous ask costs nothing but a brief hold), and small enough that a
 * loop near its lifetime cap refuses the attempt instead of walking past it.
 */
export const TRANSFER_DISTILL_ATTEMPT_USD = 0.25;

/** Every transfer-harness output is born with this origin (D-002). */
export const TRANSFER_ORIGIN: SignalOrigin = 'replay';

/** D-006's two-tier memory, plus the terminal retention decision. */
export type TransferTier = 'probationary' | 'validated' | 'retired';

/** Last transfer-test disposition ('candidate' = never tested). */
export type TransferStatus = 'candidate' | 'passed' | 'failed' | 'error';

export type TransferSourceKind = 'transcript' | 'memory' | 'pack-candidate';

export interface TransferLesson {
  workspaceId: string;
  id: string;
  /** sha-256 of the normalized lesson text — the structural dedup key, and
   *  the join key to knowledge_pack_candidates (the inherit-the-bar edge). */
  signature: string;
  title: string | null;
  lessonText: string;
  sourceKind: TransferSourceKind;
  /** Transcript ref for 'transcript' (a lib/replay TranscriptSource ref). */
  sourceRef: string | null;
  tier: TransferTier;
  status: TransferStatus;
  testCount: number;
  passCount: number;
  failCount: number;
  lastTestedAt: string | null;
  lastBatteryId: string | null;
  /** with-lesson composite minus baseline composite, last test. */
  lastDelta: number | null;
  /** memory_canonical id while admitted to memory; null when not in store. */
  memoryId: string | null;
  packCandidateId: string | null;
  signalOrigin: SignalOrigin;
  /** The pot the lesson belongs to (P-002 pot-scope-all-learnings); null = pre-pot legacy or context-less. */
  potSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One distilled candidate lesson (pre-store shape). */
export interface DistilledLesson {
  title: string;
  lessonText: string;
}

/** The distillation LLM port. Returns raw model text (the caller parses). */
export type LessonDistillerLlm = (input: {
  system: string;
  user: string;
  maxTokens: number;
}) => Promise<{ text: string; costUsd: number }>;

/** Enumerates recent transcript refs for the nightly distillation pass. */
export type TranscriptRefLister = (opts: {
  windowMs: number;
  cap: number;
}) => Promise<string[]>;

/** Loads a transcript by ref — lib/replay's port, re-exported for tick deps. */
export type TransferTranscriptSource = {
  load(ref: string): Promise<ReplayTranscript>;
};

/** The with-lesson vs baseline student comparison on one historical task. */
export interface TransferTestOutcome {
  /** Frozen-judge composite for the student WITH the lesson overlay. */
  withComposite: number;
  /** Frozen-judge composite for the baseline student (no overlay). */
  baselineComposite: number;
  /** Groups the underlying replay_runs cells (replay_runs.battery_id). */
  batteryId: string;
  costUsd: number;
}

/**
 * Runs one lesson's student-transfer test. The live adapter (wired when
 * `frontier:replay-landed` fires) builds two ReplayVariants — baseline and
 * `systemOverlay: lessonText` — over a historical case cut from the lesson's
 * source transcript, runs the replay battery, and aggregates composites.
 * Throws ⇒ the lesson records status 'error' (never silently dropped).
 */
export type TransferReplayPort = (input: {
  lesson: TransferLesson;
  transcript: ReplayTranscript;
}) => Promise<TransferTestOutcome>;
