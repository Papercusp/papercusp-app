/**
 * dependency-staleness.ts — P-008 (b): a fact goes stale when a CELL IT DECLARED
 * DEPENDING ON has changed (unified-agent-state-plane-2026-07-27, D-007/D-012/D-019).
 *
 * ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
 *
 * D-019 collapses the assumption ledger into `agent_facts`: an assumption IS a
 * fact with `confidence:'suspected'` + `dependsOn`. That collapse only pays off
 * if the `dependsOn` half actually DOES something — otherwise an assumption is a
 * conclusion wearing a weaker badge, and D-007's promise ("auto-invalidates when
 * a declared dependency changes, so no agent has to remember to retract") is
 * prose. This module is that half.
 *
 * ── THE TWO HALVES, AND WHY THEY MUST SHARE ONE DIGEST FUNCTION ──────────────
 *
 *   WRITE — {@link captureFactDependencies}: read each declared cell, digest what
 *           it resolved to, store `{cell, observedAt, digest}` on the fact.
 *   READ  — {@link markStaleDependencyFacts}: re-read those cells, digest again,
 *           compare.
 *
 * Both go through {@link digestCellValue}. That is not tidiness — it is D-038
 * axis 5 (ONE derivation, many lenses) applied to the comparison itself. Two
 * digest implementations that disagree on, say, object key ORDER would report
 * every fact stale on every read, and the failure would look like "the cell
 * keeps changing" rather than "our two hashers disagree". Hence also
 * {@link canonicalJson}: `JSON.stringify` preserves insertion order, and a
 * resolver that returns `{a,b}` on one call and `{b,a}` on the next is entirely
 * ordinary.
 *
 * ── WHY MARK, NEVER AUTO-RETRACT ─────────────────────────────────────────────
 *
 * D-007 says "auto-invalidates". This module marks and does not retract, for the
 * reason `stale-source.ts` already established for the sibling case (EI-10947):
 * a changed dependency does not make a claim FALSE. `pipeline.myChange` advancing
 * from `pushed` to `deployed` changes the cell without falsifying "my change is
 * in the candidate" — auto-retraction would delete the fact at the moment it
 * became load-bearing, and it would do so silently, on a surface whose entire
 * value is that it is TRUSTED.
 *
 * What a changed dependency means is precisely "the ground under this has moved
 * — re-verify", and only the reader can tell an expired premise from a
 * conclusion that outlived its evidence. So the reader gets the fact AND the
 * verdict. Recorded as D-066 rather than left as an implementation liberty,
 * because it narrows a decision another lane may be building against.
 *
 * The verdict is sharper than the source-staleness one it sits beside, and that
 * is the point of declaring dependencies: `stale-source` can only say "the
 * anchor closed, this MAY be stale", while this names the cell, what it was, and
 * what it is now. D-012: staleness stops being a judgement call.
 */
import { createHash } from 'node:crypto';
import type { AgentFact, FactDependency } from '../../agent-facts/store';
import { FACT_MAX_DEPENDENCIES, FACT_DEPENDENCY_OBSERVED_CHARS } from '../../agent-facts/store';
import { readCell, type CellReadEnv } from '../../cell-read';
import type { CellReader } from '../../cell-registry';

/** Digest width. 16 hex chars = 64 bits: collision-free at any plausible number
 *  of cell values, and short enough that a whole dependency set stays readable
 *  inside a fact row an agent may well read by eye. */
const DIGEST_CHARS = 16;

/**
 * Max DISTINCT (cell, subject) observations one staleness pass will dispatch.
 *
 * ⚠ THIS IS A HOT-PATH BUDGET, NOT A CORRECTNESS LIMIT. `markStaleDependencyFacts`
 * runs inside the `coord:orient` standing-facts fold, which every agent hits on
 * every wake. A fold can carry ~12 facts per selector across 3 selectors, each
 * declaring up to {@link FACT_MAX_DEPENDENCIES} dependencies — so an unbounded
 * de-duplicated set is ~400 resolver dispatches, and these resolvers run git and
 * systemd probes. That is not a slow orient, it is an unusable one.
 *
 * 8 is chosen to cover the realistic case (a handful of registered cells, a few
 * subjects) while making the pathological one impossible. Past the budget a
 * dependency reports `undeterminable` NAMING the budget — never `fresh`, because
 * "we ran out of read budget" and "nothing changed" are different facts and only
 * one of them is safe to act on.
 */
export const STALENESS_READ_BUDGET = 8;

/**
 * Order-independent JSON for hashing. Objects serialize with SORTED keys, at
 * every depth; arrays keep their order (an array's order IS data — a reordered
 * list of pipeline stages is a genuine change, while a reordered object is the
 * same value).
 *
 * Cycles are impossible from a tool result (it arrived as JSON) but are handled
 * anyway: this runs on a hot read path inside a fail-soft caller, and a throw
 * here would surface as "the fold broke" a long way from its cause. PURE.
 */
export function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value as object)) return '"[circular]"';
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => canonicalJson(v, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value as object);
  }
}

/** The ONE digest both halves use (see the header on why that matters). PURE. */
export function digestCellValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, DIGEST_CHARS);
}

/** A bounded, human-readable rendering of an observed value — stored alongside
 *  the digest purely so a reader can see what the value WAS. Never compared: a
 *  clipped rendering is lossy, and comparing lossy renderings would report two
 *  different long values as equal. PURE. */
export function renderObservedValue(value: unknown): string {
  const s = typeof value === 'string' ? value : canonicalJson(value);
  return s.length > FACT_DEPENDENCY_OBSERVED_CHARS
    ? `${s.slice(0, FACT_DEPENDENCY_OBSERVED_CHARS - 1)}…`
    : s;
}

/**
 * Per-dependency verdict. Three-valued for the same reason every cell read is
 * (D-038 axis 2): "I could not tell" is not "unchanged", and collapsing them
 * would mean an unreadable cell silently certifies a fact as fresh.
 *
 * P-021 adds a FOURTH, and it is deliberately not a fourth kind of "unknown":
 * `immaterial` is a POSITIVE verdict. The raw value moved, the cell's declared
 * material answer did not, and we know both. That is why it does not block a
 * clean roll-up the way `undeterminable` does — we are not admitting ignorance,
 * we are reporting that the news carried nothing.
 */
export type FactDependencyStatus = 'fresh' | 'changed' | 'immaterial' | 'undeterminable';

export interface FactDependencyVerdict {
  cell: string;
  /** The subject the cell was read about, when it is caller-relative. */
  subject?: string;
  status: FactDependencyStatus;
  /** When the fact was filed against this cell. */
  observedAt: string;
  /** The rendering captured at assert time, when there was one. */
  was?: string;
  /** The rendering read just now, when there was one. */
  now?: string;
  /**
   * P-021 — the MATERIAL answer, on an `immaterial` verdict.
   *
   * ⚠ NOTE WHAT AN `immaterial` ENTRY DELIBERATELY OMITS: `was`/`now`, the raw
   * before-and-after. That omission IS the deliverable — "agents learn of
   * material changes WITHOUT RECEIVING EVERY INTERMEDIATE VERSION". The
   * intermediate values are precisely the bytes the reader does not need, and
   * carrying them would reproduce the cost this verdict exists to remove.
   */
  material?: string;
  /** The declared path the material answer came from — named so a reader can
   *  audit a suppression rather than take it on trust. */
  materialPath?: string;
  /** Why a verdict is `undeterminable`. */
  detail?: string;
}

/**
 * The fact-level roll-up. `stale` iff at least one dependency CHANGED —
 * undeterminable dependencies alone never manufacture a `stale` verdict, but
 * they do block a clean `fresh` one.
 *
 * ⚠ P-021 ADDS NO FOURTH ROLL-UP STATUS, ON PURPOSE. `cell-contract.ts` states
 * the rule for its sibling enum: adding a code is a CONTRACT change, because
 * every caller's branch set changes with it. A materially-unchanged fact is not
 * stale, so it rolls up as `fresh` and the news travels in `immaterial[]` + the
 * note. Consumers that only branch on `status` keep working unchanged; the ones
 * that want the detail can read a field. That is the same shape as `changed[]`.
 */
export interface FactDependencyStaleness {
  status: 'fresh' | 'stale' | 'undeterminable';
  /** Cells whose value moved since the fact was filed. */
  changed: string[];
  /** P-021 — cells whose RAW value moved while their declared material answer
   *  did not. Not stale, and not silently dropped either: this is the channel
   *  that keeps a suppression auditable. */
  immaterial: string[];
  /** Cells that could not be compared, either then or now. */
  undeterminable: string[];
  deps: FactDependencyVerdict[];
  /** Rendered loudly wherever the fact is delivered — mirrors
   *  `FactSourceStaleness.note`, which readers already know to look for. */
  note: string;
}

/** What a cell resolves to RIGHT NOW, as far as the comparison is concerned. */
export interface CurrentCellObservation {
  digest?: string;
  observed?: string;
  /** Set instead of `digest` when the cell yields no value now. */
  unknown?: string;
  /** P-021 — digest of the cell's declared MATERIAL answer, read from the same
   *  dispatch as `digest`. Absent when the cell declares no materiality (or its
   *  declared path did not resolve), which forces the loud reading. */
  materialDigest?: string;
  /** Bounded rendering of that material answer, for the reader. */
  material?: string;
  /** The path it was read from. */
  materialPath?: string;
}

export type FactWithDependencyStaleness = AgentFact & { depsStale?: FactDependencyStaleness };

/**
 * THE PURE COMPARISON. Given a fact's stored dependencies and what those cells
 * resolve to now, produce the verdict. No IO — every branch is unit-testable
 * without PG, a cell registry, or a dispatcher, which is what makes the
 * three-valued logic here worth trusting.
 *
 * Returns null when the fact declared no dependencies: a fact that cannot go
 * stale on declared terms should carry no staleness field at all, rather than a
 * `fresh` verdict that would read as "checked and confirmed current".
 */
export function evaluateDependencyStaleness(
  deps: readonly FactDependency[],
  current: ReadonlyMap<string, CurrentCellObservation>,
): FactDependencyStaleness | null {
  if (deps.length === 0) return null;
  const verdicts: FactDependencyVerdict[] = [];
  const changed: string[] = [];
  const immaterial: string[] = [];
  const undeterminable: string[] = [];

  for (const dep of deps) {
    // Keyed by cell AND subject: the same cell read about two different subjects
    // is two different questions, and collapsing them would compare one file's
    // pipeline position against another's.
    const now = current.get(observationKey(dep.cell, dep.subject));
    const base: FactDependencyVerdict = {
      cell: dep.cell,
      ...(dep.subject ? { subject: dep.subject } : {}),
      status: 'undeterminable',
      observedAt: dep.observedAt,
      ...(dep.observed ? { was: dep.observed } : {}),
    };
    // Never observed when the fact was filed — there is no anchor to compare
    // against. Reporting `fresh` here would be the exact laundering the stored
    // `unknown` code exists to prevent.
    if (!dep.digest) {
      verdicts.push({
        ...base,
        detail:
          `this dependency was already unreadable when the fact was filed (${dep.unknown ?? 'unknown'}), ` +
          'so there is no anchor to compare against — it has never been verifiable, not merely unverifiable now.',
      });
      undeterminable.push(dep.cell);
      continue;
    }
    // Readable then, unreadable now. The fact may be perfectly current; we
    // cannot say. `not-measured`'s lever applies: obtain the access, then re-read.
    if (!now || !now.digest) {
      verdicts.push({
        ...base,
        detail:
          `the cell was readable when the fact was filed but yields no value now (${now?.unknown ?? 'absent'}) — ` +
          'the fact may still be current, but this read cannot confirm it.',
      });
      undeterminable.push(dep.cell);
      continue;
    }
    // P-021 — THE MATERIALITY GATE, and note the ORDER: the material answer is
    // compared FIRST, before the raw digest, and a material change is reported
    // `changed` even when the raw value sat still.
    //
    // That ordering is not tidiness. The two paths are SIBLINGS in one result,
    // not a value and a summary of it, so they can move independently. Gating
    // materiality behind "did the raw value change?" would mean a cell whose
    // headline is static while its material answer flips — `judgingSha` unchanged
    // because the same candidate is being re-judged, `judgingContainsPath`
    // flipping because YOUR file moved — reports `fresh`. That is a false
    // all-clear on precisely the change the reader cares most about, produced by
    // the mechanism meant to protect them. So materiality can only ever SUPPRESS
    // a raw change, never MASK a material one.
    //
    // ⚠ AND THE PATH MUST MATCH. If the spec's materiality path has been re-aimed
    // since the fact was filed, the stored anchor and the fresh reading are
    // answers to DIFFERENT QUESTIONS, and comparing them is not a weaker check —
    // it is a wrong one. This is `FactDependency.subject`'s rule verbatim, for
    // the same reason: a comparison that silently changes the question reports
    // "unchanged" about something nobody asked.
    const pathStable = dep.materialPath === undefined || now.materialPath === undefined || dep.materialPath === now.materialPath;
    const materiallyComparable = dep.materialDigest !== undefined && now.materialDigest !== undefined && pathStable;
    if (materiallyComparable && now.materialDigest !== dep.materialDigest) {
      verdicts.push({
        ...base,
        status: 'changed',
        ...(now.observed ? { now: now.observed } : {}),
        ...(now.material ? { material: now.material } : {}),
        ...(now.materialPath ? { materialPath: now.materialPath } : {}),
      });
      changed.push(dep.cell);
      continue;
    }
    if (now.digest === dep.digest) {
      verdicts.push({ ...base, status: 'fresh', ...(now.observed ? { now: now.observed } : {}) });
      continue;
    }
    // The raw value moved. If the cell declared a material answer and that answer
    // held, this is a version bump — carried, but not raised.
    if (materiallyComparable) {
      // `was`/`now` are DROPPED here: the intermediate raw values are exactly
      // what the item says the reader should stop receiving. Destructured out
      // rather than set to `undefined`, so the key is genuinely absent from the
      // object and not merely absent after a JSON round-trip.
      const { was: _rawBefore, ...baseWithoutRaw } = base;
      verdicts.push({
        ...baseWithoutRaw,
        status: 'immaterial',
        // `material` (the ANSWER) is carried — it is what lets a reader audit the
        // suppression. `materialPath` is NOT: it is a registry CONSTANT, and
        // copying it onto every row of every fact in every fold is both the
        // repetition this item exists to remove and a transcription that rots
        // when the resolver's shape moves (`state:subscribe`'s own warning). The
        // path lives on the spec, which is where a reader should get it.
        ...(now.material ? { material: now.material } : {}),
      });
      immaterial.push(dep.cell);
      continue;
    }
    verdicts.push({
      ...base,
      status: 'changed',
      ...(now.observed ? { now: now.observed } : {}),
    });
    changed.push(dep.cell);
  }

  const status: FactDependencyStaleness['status'] =
    changed.length > 0 ? 'stale' : undeterminable.length > 0 ? 'undeterminable' : 'fresh';
  return {
    status,
    changed,
    immaterial,
    undeterminable,
    deps: verdicts,
    note: renderNote(status, verdicts, changed, immaterial, undeterminable),
  };
}

/** The loud line. Names the cell, what it was, and what it is now — the whole
 *  reason declaring a dependency beats an age heuristic. */
function renderNote(
  status: FactDependencyStaleness['status'],
  verdicts: readonly FactDependencyVerdict[],
  changed: readonly string[],
  immaterial: readonly string[],
  undeterminable: readonly string[],
): string {
  if (status === 'fresh') {
    // P-021 — a fold that said "still reads as it did" over a cell that HAS
    // moved would be false, and falsely reassuring. So the immaterial case gets
    // its own line: short, because being short is the deliverable, but explicit
    // about what was suppressed and against which declared answer, because a
    // suppression a reader cannot audit is a blind spot rather than a threshold.
    if (immaterial.length > 0) {
      // ⚠ SHORT BY DESIGN — this is the "carries the rest SILENTLY" half.
      //
      // `note` is documented as the line rendered LOUDLY wherever the fact is
      // delivered, and its job is to PROMPT AN ACTION: the stale note asks the
      // reader to re-verify. A version bump asks for nothing, so a paragraph
      // explaining it is pure cost — paid per fact, per fold, per agent, 335
      // times a day. The audit trail does not live here: it lives in the
      // machine-readable `immaterial[]` and each dep's `material` answer, which
      // a reader can check without every reader paying to be told.
      return `✓ no material change (${immaterial.length} version bump${immaterial.length === 1 ? '' : 's'} not reproduced).`;
    }
    return `✓ every declared dependency (${verdicts.map((v) => v.cell).join(', ')}) still reads as it did when this fact was filed.`;
  }
  if (status === 'undeterminable') {
    return (
      `? this fact's dependencies could not be compared (${undeterminable.join(', ')}). It is NOT confirmed current — ` +
      'and it is not known to be stale either. Re-read the cells yourself before relying on it.'
    );
  }
  const detail = verdicts
    .filter((v) => v.status === 'changed')
    .map((v) => `${v.cell}: "${v.was ?? '?'}" → "${v.now ?? '?'}"`)
    .join('; ');
  return (
    `⚠ STALE — this fact declared it rests on ${changed.length === 1 ? 'a cell' : 'cells'} that ${changed.length === 1 ? 'has' : 'have'} since CHANGED (${detail}). ` +
    'It is still being folded verbatim as binding context. A changed dependency does not make the claim false — it means ' +
    'the ground under it moved. Re-verify, then re-assert to refresh it (which re-observes the dependency and silences ' +
    'this), or facts:retract if it no longer holds.'
  );
}

/**
 * WRITE HALF — resolve a caller's declared cell ids into stored dependencies.
 *
 * FAIL-SOFT PER CELL, never for the whole assert. A cell that cannot be read
 * records its enumerated unknown code and the assert proceeds: refusing the
 * write would mean an agent loses a conclusion because an unrelated resolver was
 * down, which is the "hard reject cost 7 whole facts in 14d" failure this
 * table's rules already forbid.
 *
 * @param subjects optional per-cell subject for a `callerRelativity:'parameter'`
 *   cell (see `readCell`'s `subject`). A cell needing one and not given one
 *   records `insufficient-data`, exactly as a direct read would.
 */
export async function captureFactDependencies(
  cells: readonly string[],
  reader: CellReader,
  env: CellReadEnv,
  subjects?: Readonly<Record<string, string>>,
): Promise<FactDependency[]> {
  const wanted = dedupeCells(cells);
  if (wanted.length === 0) return [];
  const observedAt = new Date().toISOString();
  // These are independent read-only resolver calls. Dispatch them together so
  // two slow cells cost roughly the slower read, not the sum of both reads —
  // the serial loop let a pair of otherwise healthy dependencies outlive the
  // caller's request timeout and made the fact assertion look like it failed.
  // Keep the fail-soft boundary PER CELL: one resolver failure must still be
  // recorded as unknown without discarding the other observations.
  const observations = await Promise.all(
    wanted.map(async (cell) => {
      const subject = subjects?.[cell];
      let obs: CurrentCellObservation;
      try {
        obs = await observeCell(cell, reader, env, subject);
      } catch {
        // readCell is documented TOTAL, but this is a write path on a shared
        // table: a belt here costs nothing and a thrown assert costs a fact.
        obs = { unknown: 'resolver-failed' };
      }
      return { cell, subject, obs };
    }),
  );

  return observations.map(({ cell, subject, obs }) => ({
    cell,
    // Persisted so the re-read asks the SAME question — see FactDependency.subject.
    ...(subject ? { subject } : {}),
    observedAt,
    ...(obs.digest
      ? {
          digest: obs.digest,
          ...(obs.observed ? { observed: obs.observed } : {}),
          // P-021 — the material ANCHOR. Without one stored at assert time
          // there is nothing to compare a later material answer against, so
          // the re-read correctly degrades to the loud reading.
          ...(obs.materialDigest
            ? {
                materialDigest: obs.materialDigest,
                ...(obs.material ? { material: obs.material } : {}),
                ...(obs.materialPath ? { materialPath: obs.materialPath } : {}),
              }
            : {}),
        }
      : { unknown: (obs.unknown ?? 'resolver-failed') as FactDependency['unknown'] }),
  }));
}

/**
 * READ HALF — attach `depsStale` to every fact that declared dependencies.
 *
 * Each DISTINCT cell is read ONCE for the whole batch, not once per fact. That
 * bound is what makes this affordable on the orient fold: a fold carries at most
 * ~12 facts per selector and the registry holds a handful of cells, so the cost
 * is a small constant number of resolver dispatches — and ZERO when nothing in
 * the fold declared a dependency, which is every fold today. An agent that files
 * an assumption buys the re-check; nobody else pays for it.
 *
 * FAIL-SOFT BY CONTRACT, matching `markStaleSourceFacts`: on any failure the
 * facts come back UNMARKED rather than failing the orient. An unmarked fold is
 * today's behaviour; a thrown orient is not.
 */
export async function markStaleDependencyFacts<T extends AgentFact>(
  facts: readonly T[],
  reader: CellReader,
  env: CellReadEnv,
): Promise<Array<T & { depsStale?: FactDependencyStaleness }>> {
  if (facts.length === 0) return [];
  // De-duplicate on (cell, subject), not on cell alone: two facts resting on the
  // same cell about DIFFERENT subjects need two reads, and one read reused for
  // both would answer the wrong question for one of them.
  const targets = new Map<string, { cell: string; subject?: string }>();
  const overBudget: string[] = [];
  for (const f of facts) {
    for (const d of f.dependsOn ?? []) {
      const key = observationKey(d.cell, d.subject);
      if (targets.has(key)) continue;
      if (targets.size >= STALENESS_READ_BUDGET) {
        overBudget.push(key);
        continue;
      }
      targets.set(key, { cell: d.cell, ...(d.subject ? { subject: d.subject } : {}) });
    }
  }
  if (targets.size === 0) return facts.map((f) => ({ ...f }));

  const current = new Map<string, CurrentCellObservation>();
  // Anything past the budget is reported UNDETERMINABLE, naming the budget as the
  // reason. Leaving it out of the map would also yield `undeterminable`, but with
  // the wrong explanation ("the cell yields no value now") — and a reader chasing
  // a stale fact would go looking for a broken resolver that is working fine.
  for (const key of overBudget) current.set(key, { unknown: 'read-budget-exceeded' });
  try {
    for (const [key, t] of targets) {
      current.set(key, await observeCell(t.cell, reader, env, t.subject));
    }
  } catch {
    // Fail-soft: return everything unmarked rather than half-marked. A partial
    // map would be worse than none — the facts whose cells happened to resolve
    // before the failure would carry verdicts, and the rest would look like
    // facts with no dependencies at all.
    return facts.map((f) => ({ ...f }));
  }

  return facts.map((f) => {
    const verdict = evaluateDependencyStaleness(f.dependsOn ?? [], current);
    return verdict ? { ...f, depsStale: verdict } : { ...f };
  });
}

/** Read one cell and reduce it to the comparison's terms. `absent` is kept
 *  DISTINCT from the cell-contract unknown codes: it means "this cell does not
 *  exist for you" (unregistered, or outside your audience — P-019 makes those
 *  indistinguishable on purpose), which is a different thing from a cell that
 *  exists and declined to answer, and a reader chasing a stale fact needs to
 *  know which one they are looking at. */
async function observeCell(
  cell: string,
  reader: CellReader,
  env: CellReadEnv,
  subject?: string,
): Promise<CurrentCellObservation> {
  const read = await readCell(cell, reader, env, subject);
  if (read.status === 'value') {
    return {
      digest: digestCellValue(read.value),
      observed: renderObservedValue(read.value),
      // P-021 — same dispatch, no extra resolver call. Absent unless the spec
      // declares materiality AND that path resolved, which is what makes an
      // unanchored comparison fall back to the loud reading.
      ...(read.material
        ? {
            materialDigest: digestCellValue(read.material.value),
            material: renderObservedValue(read.material.value),
            materialPath: read.material.path,
          }
        : {}),
    };
  }
  if (read.status === 'unknown') return { unknown: read.unknown.code };
  return { unknown: 'absent' };
}

/**
 * The key a cell OBSERVATION is stored under. A caller-relative cell answers a
 * different question per subject, so the subject is part of the identity of the
 * reading — keying on the bare cell id would let one file's pipeline position
 * stand in for another's. Shared by the write and read halves so they cannot
 * disagree about what counts as "the same observation". PURE.
 */
export function observationKey(cell: string, subject?: string): string {
  return subject ? `${cell}\x00${subject}` : cell;
}

/** Trim, drop empties, de-duplicate, and bound — shared by both halves so the
 *  write and read sides can never disagree about which cells are in play. PURE. */
function dedupeCells(cells: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cells) {
    const cell = (raw ?? '').trim();
    if (!cell || seen.has(cell)) continue;
    seen.add(cell);
    out.push(cell);
    if (out.length >= FACT_MAX_DEPENDENCIES) break;
  }
  return out;
}
