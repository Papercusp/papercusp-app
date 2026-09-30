/**
 * Pilot arm assignment — the randomisation protocol for the 3-arm directed-pair pilot
 * (plan `directed-pair-work-items-2026-08-25`, P-006).
 *
 * Arms (D-007): **A** solo baseline · **B** solo + ledger-checked self-review gate ·
 * **C** directed pair.
 *
 * ## Why this is a module and not a judgement call at assignment time
 *
 * The pilot's whole claim is comparative: arm C is worth its second agent only if C's items
 * come out better than A's. That comparison is destroyed by any assignment rule correlated
 * with item difficulty — and "an agent picks which arm each item goes to" is maximally
 * correlated with difficulty, because the natural instinct is to give the scary item the
 * pair. The result looks like evidence and is not: C would carry the hard items and lose on
 * every metric no matter how much the pairing helped.
 *
 * So assignment is mechanical, seeded, and reproducible. Anyone can re-run
 * {@link assignCohort} with the recorded seed and cohort and get identical arms back;
 * a disagreement means the record was edited, not that the randomiser drifted.
 *
 * ## Permuted blocks, not a coin flip
 *
 * Within each stratum, items are grouped into blocks of three and each block receives a
 * random permutation of `[A, B, C]`. This guarantees the arms stay balanced at every block
 * boundary. Simple per-item randomisation does not: at the pilot's size a fair coin
 * plausibly returns a 10/6/5 split, and an early stop (which is the likely outcome — these
 * are real work items competing with real work) leaves arms of wildly different sizes.
 * Balance at every prefix is the property that makes a partial pilot still analysable.
 *
 * ## What this deliberately does NOT do
 *
 * It does not infer difficulty. Nothing in the row is a trustworthy a-priori difficulty
 * signal — `severity` is assigned by the filer for triage urgency, not effort, and title
 * length is noise. Rather than guess, {@link PilotCandidate.tier} is REQUIRED and the pilot
 * operator must declare it before seeing any outcome. A guessed stratum silently
 * reintroduces the confound this module exists to remove.
 *
 * @see D-007  the tier gate and the 3-arm pilot
 * @see D-020  arm B's gate is opt-in per item; `pilotArm` is the marker that opts it in
 * @see D-022  why the primary metric is continuous — the pilot is a screening study
 */

export const PILOT_ARMS = ['A', 'B', 'C'] as const;
export type PilotArm = (typeof PILOT_ARMS)[number];

/** Declared BEFORE assignment and before any outcome is known (see module note). */
export type PilotTier = 'trivial' | 'substantive' | 'high-risk';

export interface PilotCandidate {
  readonly id: string;
  /**
   * Declared by the pilot operator, never inferred. Only `substantive` enters the pilot:
   * D-007 already rules trivial work solo and high-risk work paired, so including either
   * would measure a question the plan considers settled.
   */
  readonly tier: PilotTier;
  /**
   * Blocking variable. Items are balanced across arms WITHIN each stratum, so a stratum
   * that correlates with difficulty (subsystem, severity) protects the comparison rather
   * than skewing it. Defaults to a single stratum, which is plain permuted-block
   * randomisation.
   */
  readonly stratum?: string;
  /** The work-item payload, read only to detect an assignment that already exists. */
  readonly payload?: unknown;
}

export type SkipReason = 'already-assigned' | 'not-substantive' | 'duplicate-id';

export interface ArmAssignment {
  readonly id: string;
  readonly arm: PilotArm;
  readonly stratum: string;
  /** Block ordinal within the stratum — recorded so the randomisation can be re-derived. */
  readonly blockIndex: number;
  /**
   * True when this item landed in a trailing block of fewer than three. Such blocks are
   * still assigned (dropping observations is worse than a ±1 imbalance) but the analysis
   * must know arm sizes may differ by one per stratum.
   */
  readonly partialBlock: boolean;
}

export interface SkippedCandidate {
  readonly id: string;
  readonly reason: SkipReason;
  /** For `already-assigned`, the arm it already carries — never overwritten. */
  readonly existingArm?: string;
}

export interface AssignmentPlan {
  readonly seed: string;
  readonly assignments: readonly ArmAssignment[];
  readonly skipped: readonly SkippedCandidate[];
  /** Count per arm across the whole cohort, including any pre-existing assignments. */
  readonly balance: Readonly<Record<PilotArm, number>>;
  /** Ids that landed in a trailing partial block — the analysis reads this, not the prose. */
  readonly partialBlockIds: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Deterministic PRNG.
 *
 * Seeded per (seed, stratum, blockIndex) so each block's permutation is independent and
 * re-derivable in isolation — you can audit one block without replaying the cohort.
 * ------------------------------------------------------------------ */

/** FNV-1a, 32-bit. Chosen for being short enough to verify by eye, not for cryptography. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, well-distributed, and fully determined by its 32-bit state. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, drawing from `rand`. Returns a new array; never mutates the input. */
function permute<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The PRNG key for one block.
 *
 * JSON-encoded rather than string-joined so the encoding is INJECTIVE: no choice of
 * separator can collide, because a separator appearing inside a value is escaped by the
 * encoder rather than being mistaken for a field boundary. With a naive `${seed}|${stratum}`
 * join, `seed:"a|b", stratum:"c"` and `seed:"a", stratum:"b|c"` produce the same key and
 * therefore the same arm permutation.
 *
 * Exported so injectivity can be asserted directly. It cannot be tested through
 * {@link blockPermutation} alone: there are only 6 permutations of 3 arms, so two genuinely
 * distinct keys collide by chance one time in six, and a test written against the
 * permutation would fail on correct code (as this one first did).
 */
export function blockKey(seed: string, stratum: string, blockIndex: number): string {
  return JSON.stringify([seed, stratum, blockIndex]);
}

/**
 * The permutation of `[A, B, C]` for one block. Exported so a reviewer can verify a single
 * recorded assignment without re-running the cohort.
 */
export function blockPermutation(
  seed: string,
  stratum: string,
  blockIndex: number,
): readonly PilotArm[] {
  const rand = mulberry32(hashString(blockKey(seed, stratum, blockIndex)));
  return permute(PILOT_ARMS, rand);
}

/* ------------------------------------------------------------------ *
 * Existing-assignment detection
 * ------------------------------------------------------------------ */

/**
 * The arm already stamped on an item, if any.
 *
 * Deliberately reads ANY non-empty `pilotArm` string, not just a valid arm letter: an
 * unrecognised value still means somebody assigned this item, and silently re-randomising it
 * would be the arm-shopping this module exists to prevent. Recognising only `A|B|C` here
 * would make a typo look like an unassigned item.
 */
export function existingArm(
  item: { payload?: unknown } | null | undefined,
): string | undefined {
  const payload = item?.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const arm = (payload as { pilotArm?: unknown }).pilotArm;
  if (typeof arm !== 'string') return undefined;
  const trimmed = arm.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Normalise a recognised arm letter; returns undefined for anything else. */
export function asPilotArm(value: string | undefined): PilotArm | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase();
  return (PILOT_ARMS as readonly string[]).includes(upper) ? (upper as PilotArm) : undefined;
}

/* ------------------------------------------------------------------ *
 * Assignment
 * ------------------------------------------------------------------ */

/**
 * Assign a cohort to arms. Pure: same `seed` + same candidate set produces identical output.
 *
 * Candidates are sorted by id within each stratum before blocking, so the caller's argument
 * ORDER cannot influence the result. That matters more than it looks: without it, re-running
 * assignment with a shuffled input would hand back different arms, and "re-run until the
 * split looks right" is arm-shopping with extra steps.
 *
 * Items that already carry `payload.pilotArm` are never reassigned — they are reported under
 * `skipped` with their existing arm and counted in `balance`.
 *
 * Intended as a ONE-SHOT call over the whole cohort. Calling it again with extra candidates
 * preserves every existing assignment, but the new items block among themselves, so
 * per-stratum balance is only guaranteed within each assignment round.
 */
export function assignCohort(
  candidates: readonly PilotCandidate[],
  seed: string,
): AssignmentPlan {
  const assignments: ArmAssignment[] = [];
  const skipped: SkippedCandidate[] = [];
  const balance: Record<PilotArm, number> = { A: 0, B: 0, C: 0 };
  const partialBlockIds: string[] = [];

  const byStratum = new Map<string, PilotCandidate[]>();
  const seenIds = new Set<string>();

  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) {
      skipped.push({ id: candidate.id, reason: 'duplicate-id' });
      continue;
    }
    seenIds.add(candidate.id);

    const already = existingArm(candidate);
    if (already !== undefined) {
      skipped.push({ id: candidate.id, reason: 'already-assigned', existingArm: already });
      const arm = asPilotArm(already);
      if (arm) balance[arm] += 1;
      continue;
    }

    if (candidate.tier !== 'substantive') {
      skipped.push({ id: candidate.id, reason: 'not-substantive' });
      continue;
    }

    const stratum = candidate.stratum?.trim() || 'default';
    const bucket = byStratum.get(stratum);
    if (bucket) bucket.push(candidate);
    else byStratum.set(stratum, [candidate]);
  }

  // Sort strata too, so the output order is stable across callers.
  for (const stratum of [...byStratum.keys()].sort()) {
    const bucket = byStratum.get(stratum)!;
    // Order by id, NOT by argument order — see the doc note above.
    bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (let i = 0; i < bucket.length; i++) {
      const blockIndex = Math.floor(i / PILOT_ARMS.length);
      const positionInBlock = i % PILOT_ARMS.length;
      const blockStart = blockIndex * PILOT_ARMS.length;
      const partialBlock = bucket.length - blockStart < PILOT_ARMS.length;

      const arm = blockPermutation(seed, stratum, blockIndex)[positionInBlock];
      assignments.push({ id: bucket[i].id, arm, stratum, blockIndex, partialBlock });
      balance[arm] += 1;
      if (partialBlock) partialBlockIds.push(bucket[i].id);
    }
  }

  return { seed, assignments, skipped, balance, partialBlockIds };
}

/**
 * The payload patch that records an assignment on the work item.
 *
 * `pilotArm` is the marker `itemIsArmB` reads (D-020); the sibling fields exist so the
 * assignment can be audited — a bare letter cannot tell you which seed produced it, and an
 * unreproducible assignment is indistinguishable from a hand-picked one.
 */
export function assignmentPayloadPatch(
  assignment: ArmAssignment,
  seed: string,
): {
  readonly pilotArm: PilotArm;
  readonly pilotSeed: string;
  readonly pilotStratum: string;
  readonly pilotBlockIndex: number;
} {
  return {
    pilotArm: assignment.arm,
    pilotSeed: seed,
    pilotStratum: assignment.stratum,
    pilotBlockIndex: assignment.blockIndex,
  };
}

/**
 * Re-derive an assignment plan and compare it to what is recorded on the items.
 *
 * The point of a seeded randomiser is that it can be checked. This is the check: it re-runs
 * the assignment from the recorded seed and reports any item whose stamped arm disagrees.
 * A mismatch means the record was edited after the fact — the one failure mode that would
 * otherwise be invisible, because a hand-edited `pilotArm` looks exactly like a real one.
 */
export function verifyAssignments(
  candidates: readonly PilotCandidate[],
  seed: string,
): {
  readonly ok: boolean;
  readonly mismatches: readonly { id: string; recorded: string; expected: PilotArm }[];
  readonly unverifiable: readonly string[];
} {
  // Re-derive from the cohort as if nothing were stamped.
  const stripped = candidates.map((c) => ({ ...c, payload: undefined }));
  const plan = assignCohort(stripped, seed);
  const expectedById = new Map(plan.assignments.map((a) => [a.id, a.arm]));

  const mismatches: { id: string; recorded: string; expected: PilotArm }[] = [];
  const unverifiable: string[] = [];

  for (const candidate of candidates) {
    const recorded = existingArm(candidate);
    if (recorded === undefined) continue;
    const expected = expectedById.get(candidate.id);
    if (expected === undefined) {
      // Stamped but not derivable from this cohort+seed — e.g. assigned in another round.
      unverifiable.push(candidate.id);
      continue;
    }
    if (asPilotArm(recorded) !== expected) {
      mismatches.push({ id: candidate.id, recorded, expected });
    }
  }

  return { ok: mismatches.length === 0, mismatches, unverifiable };
}
