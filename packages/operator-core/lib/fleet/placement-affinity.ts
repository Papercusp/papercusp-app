/**
 * fleet/placement-affinity — the PURE task↔bee affinity ranker for batch
 * placement (queen-autonomous-execution-2026-06-13, B-07 / P-002).
 *
 * Lifts the Queen's prompt-only affinity order — **explicit-intent > file-overlap
 * > recent-activity > queue-similarity** (queen.md "For each task, find the best
 * placement using affinity signals") — into a callable scorer the batch step
 * (batch-placement.ts / fleet:place_batch) uses to assign ready tasks to warm
 * bees. Each signal is normalized to [0,1]; the default weights are strictly
 * lexicographic (a fully-fired higher signal outranks the SUM of every lower one)
 * so the documented priority always holds, while graded values still break ties
 * within a tier.
 *
 * PURE: no PG, no wall clock — the caller injects `now`. The tool layer maps live
 * presence / fleet-assignment / nursery rows into PlacementBee + PlacementTask.
 */

/** One placeable unit of the ready frontier (a work-item, mapped). */
export interface PlacementTask {
  /** WI-/F-/EI- id. */
  id: string;
  /** Member harness the work lives in (the home for a fresh-spawn). */
  harness: string | null;
  title: string;
  /** Files the task is expected to touch, if known (from the feature payload /
   *  caller hints). Drives the file-overlap signal; empty ⇒ that signal is 0. */
  files?: string[];
  /** Optional subsystem / path-prefix hint (a weak queue-similarity fallback). */
  subsystem?: string | null;
  /** Plan this task belongs to, if any (strengthens explicit-intent). */
  planSlug?: string | null;
  /** Per-lane situational brief carried from the work-item's `payload.brief`
   *  (queen-wave-dispatch P-021/P-031) — the context the placed bee is MISSING,
   *  not a restatement of the item. Merged with the Queen's batch overlay at
   *  spawn / warm-inject so each placed bee gets ITS lane's brief, not just the
   *  one batch-wide overlay. */
  brief?: string | null;
}

/** One live fleet bee, mapped from presence + fleet-assignment + the nursery. */
export interface PlacementBee {
  /** taken_by / coord owner id (the bee's `s-…` spawn id) — the warm-inject + claim target. */
  ownerId: string;
  label?: string | null;
  /** The bee's home harness (its nursery row's harness_slug). */
  harness?: string | null;
  /** Self-declared intent (coord:presence). */
  intent?: string;
  /** Files the bee is editing NOW (coord:presence current_files). */
  currentFiles?: string[];
  /** Self-declared current plan (coord:presence). */
  currentPlanSlug?: string | null;
  /** Harness of the bee's head-of-line work-item (fleet:assignments `doing`). */
  doingHarness?: string | null;
  /** Harnesses across the bee's queued work-list (fleet:assignments `queued`). */
  queuedHarnesses?: string[];
  /** Work-item count — the load signal for warm-inject vs a fresh slot. */
  load: number;
  /** Epoch-ms of the bee's last heartbeat / activity (recency). */
  lastActiveMs?: number | null;
  /** Fresh-heartbeat liveness — only live bees are warm-inject candidates. */
  alive: boolean;
}

export interface AffinitySignals {
  /** Bee's declared intent / current plan points at this task. */
  explicitIntent: number;
  /** Bee's open files overlap the task's files. */
  fileOverlap: number;
  /** Bee was recently active in the task's harness. */
  recentActivity: number;
  /** Bee's work-list (doing / queued) is the same harness / subsystem. */
  queueSimilarity: number;
}

export interface AffinityWeights {
  explicitIntent: number;
  fileOverlap: number;
  recentActivity: number;
  queueSimilarity: number;
}

/**
 * Strictly-lexicographic defaults encoding explicit-intent > file-overlap >
 * recent-activity > queue-similarity: 8 > 4+2+1, 4 > 2+1, 2 > 1 — so a fully-fired
 * higher signal always outranks every lower signal combined, yet graded values
 * still discriminate WITHIN a tier.
 */
export const DEFAULT_AFFINITY_WEIGHTS: AffinityWeights = {
  explicitIntent: 8,
  fileOverlap: 4,
  recentActivity: 2,
  queueSimilarity: 1,
};

/** The blueprint's `affinity.kind` (hive-blueprint-generalization Phase 3 schema). */
export type AffinityKind = 'file-overlap' | 'topic-overlap' | 'entity-overlap';

/**
 * Affinity-kind weight presets (hive-blueprint-generalization P-011) — a hive's
 * `affinity.kind` selects which signal dominates, the de-coding of the Queen's "cut on
 * file-scope" into "cut on <scope-seam>". All keep explicit-intent on top and stay
 * lexicographic (a fired higher signal outranks the sum of the lower ones):
 *   - file-overlap (coding default): explicit 8 > file 4 > recent 2 > queue 1 (unchanged).
 *   - topic-overlap (generic/research): a bee shares a SUBJECT, not files — title/subsystem
 *     similarity (queue-similarity) dominates file overlap, which a repo-less bee lacks.
 *   - entity-overlap: same-harness/work-list (the entity scope) dominates file overlap.
 */
export const AFFINITY_WEIGHTS_BY_KIND: Record<AffinityKind, AffinityWeights> = {
  'file-overlap': DEFAULT_AFFINITY_WEIGHTS,
  'topic-overlap': { explicitIntent: 8, fileOverlap: 1, recentActivity: 2, queueSimilarity: 4 },
  'entity-overlap': { explicitIntent: 8, fileOverlap: 1, recentActivity: 4, queueSimilarity: 2 },
};

/** Resolve placement weights: an explicit `weights` wins; else the `affinityKind`
 *  preset; else the file-overlap default (so existing callers are unchanged). */
export function weightsForAffinity(opts: { weights?: AffinityWeights; affinityKind?: AffinityKind }): AffinityWeights {
  if (opts.weights) return opts.weights;
  if (opts.affinityKind) return AFFINITY_WEIGHTS_BY_KIND[opts.affinityKind];
  return DEFAULT_AFFINITY_WEIGHTS;
}

/** The recency window: activity newer than FRESH_MS scores 1.0, decaying linearly to 0 at STALE_MS. */
const RECENCY_FRESH_MS = 2 * 60_000;
const RECENCY_STALE_MS = 30 * 60_000;

export interface AffinityScore {
  /** The bee's ownerId. */
  bee: string;
  /** Weighted total (Σ weightᵢ · signalᵢ). */
  score: number;
  signals: AffinitySignals;
  /** Short human-readable contributions, strongest first. */
  reasons: string[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'into',
  'fix', 'add', 'update', 'make', 'wire', 'use', 'via', 'per', 'this', 'that',
  'is', 'it', 'be', 'as', 'at', 'by', 'from', 'new', 'so', 'not',
]);

/** Lowercase word tokens ≥3 chars, stopwords dropped. */
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Normalize a repo path: lowercase, strip a leading `./`, collapse `//`, drop trailing `/`. */
function normPath(p: string): string {
  return p
    .toLowerCase()
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .trim();
}

/** Two paths overlap when equal or one is a path-segment suffix of the other
 *  (`a/b/foo.ts` overlaps `foo.ts` and `b/foo.ts`, never `bar/foo.ts`-vs-`xfoo.ts`). */
function pathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('/' + b) || b.endsWith('/' + a);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** Explicit-intent: the bee's declared plan / intent text names the task. */
export function scoreExplicitIntent(task: PlacementTask, bee: PlacementBee): number {
  // Strongest: the bee declared the SAME plan this task belongs to.
  if (task.planSlug && bee.currentPlanSlug && task.planSlug === bee.currentPlanSlug) return 1;
  const intent = (bee.intent ?? '').toLowerCase();
  if (!intent) return 0;
  // The bee's intent text names this work-item id outright.
  if (task.id && intent.includes(task.id.toLowerCase())) return 1;
  if (task.planSlug && intent.includes(task.planSlug.toLowerCase())) return 0.9;
  // Otherwise keyword overlap between the intent and the task title — a weaker,
  // graded signal capped below the id/plan matches above.
  const titleTokens = tokenize(task.title);
  if (titleTokens.size === 0) return 0;
  const intentTokens = tokenize(intent);
  const overlap = intersectionSize(titleTokens, intentTokens) / titleTokens.size;
  return Math.min(0.8, overlap);
}

/** File-overlap: fraction of the task's files the bee already has open. */
export function scoreFileOverlap(task: PlacementTask, bee: PlacementBee): number {
  const taskFiles = (task.files ?? []).map(normPath).filter(Boolean);
  const beeFiles = (bee.currentFiles ?? []).map(normPath).filter(Boolean);
  if (taskFiles.length === 0 || beeFiles.length === 0) return 0;
  let covered = 0;
  for (const tf of taskFiles) {
    if (beeFiles.some((bf) => pathsOverlap(tf, bf))) covered++;
  }
  return covered / taskFiles.length;
}

/** Recent-activity: how recently the bee was active, weighted by same-harness. */
export function scoreRecentActivity(task: PlacementTask, bee: PlacementBee, now: number): number {
  if (bee.lastActiveMs == null) return 0;
  const age = now - bee.lastActiveMs;
  let recency: number;
  if (age <= RECENCY_FRESH_MS) recency = 1;
  else if (age >= RECENCY_STALE_MS) recency = 0;
  else recency = 1 - (age - RECENCY_FRESH_MS) / (RECENCY_STALE_MS - RECENCY_FRESH_MS);
  if (recency <= 0) return 0;
  // Recent activity in ANOTHER repo is only weakly relevant to this task.
  const sameHarness =
    !!task.harness &&
    (bee.harness === task.harness || bee.doingHarness === task.harness);
  return recency * (sameHarness ? 1 : 0.4);
}

/** Queue-similarity: the bee's work-list is the same harness / subsystem as the task. */
export function scoreQueueSimilarity(task: PlacementTask, bee: PlacementBee): number {
  if (task.harness) {
    if (bee.doingHarness === task.harness) return 1;
    if ((bee.queuedHarnesses ?? []).includes(task.harness)) return 0.6;
  }
  // Weak subsystem fallback: the bee's open files / home share the task's subsystem prefix.
  const sub = (task.subsystem ?? '').trim().toLowerCase();
  if (sub) {
    const files = (bee.currentFiles ?? []).map(normPath);
    if (files.some((f) => f.startsWith(sub))) return 0.3;
  }
  return 0;
}

/** Score one task↔bee pairing across all four signals. */
export function scoreAffinity(
  task: PlacementTask,
  bee: PlacementBee,
  opts: { weights?: AffinityWeights; now?: number; affinityKind?: AffinityKind } = {},
): AffinityScore {
  const w = weightsForAffinity(opts);
  const now = opts.now ?? 0;
  const signals: AffinitySignals = {
    explicitIntent: scoreExplicitIntent(task, bee),
    fileOverlap: scoreFileOverlap(task, bee),
    recentActivity: scoreRecentActivity(task, bee, now),
    queueSimilarity: scoreQueueSimilarity(task, bee),
  };
  const score =
    w.explicitIntent * signals.explicitIntent +
    w.fileOverlap * signals.fileOverlap +
    w.recentActivity * signals.recentActivity +
    w.queueSimilarity * signals.queueSimilarity;
  const reasons: string[] = [];
  if (signals.explicitIntent > 0) reasons.push(`explicit-intent ${signals.explicitIntent.toFixed(2)}`);
  if (signals.fileOverlap > 0) reasons.push(`file-overlap ${signals.fileOverlap.toFixed(2)}`);
  if (signals.recentActivity > 0) reasons.push(`recent-activity ${signals.recentActivity.toFixed(2)}`);
  if (signals.queueSimilarity > 0) reasons.push(`queue-similarity ${signals.queueSimilarity.toFixed(2)}`);
  return { bee: bee.ownerId, score, signals, reasons };
}

/**
 * Rank live bees for one task, strongest affinity first. Dead bees are excluded
 * (they cannot be warm-inject targets). Ties break toward the LESS-loaded bee,
 * then a stable ownerId order.
 */
export function rankBeesForTask(
  task: PlacementTask,
  bees: PlacementBee[],
  opts: { weights?: AffinityWeights; now?: number; affinityKind?: AffinityKind } = {},
): AffinityScore[] {
  const loadByBee = new Map(bees.map((b) => [b.ownerId, b.load]));
  return bees
    .filter((b) => b.alive)
    .map((b) => scoreAffinity(task, b, opts))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const la = loadByBee.get(a.bee) ?? 0;
      const lb = loadByBee.get(b.bee) ?? 0;
      if (la !== lb) return la - lb;
      return a.bee < b.bee ? -1 : a.bee > b.bee ? 1 : 0;
    });
}
