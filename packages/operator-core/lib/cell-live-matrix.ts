/**
 * cell-live-matrix.ts — THE LIVE READ MATRIX'S VERDICT LOGIC
 * (agent-state-plane-verification-2026-07-27 P-004).
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────
 *
 * P-004 asks for every registered cell to be exercised through `state:read` against a
 * RUNNING operator, across four conditions, with the tri-state and the hoist asserted on
 * every nullable cell. That is a live-data check: it needs a real operator, a real
 * repository, and a real fleet.
 *
 * This module is the half of that which is NOT live: given OBSERVATIONS (what a read
 * actually returned), it decides what each square MEANS. It performs no I/O, imports no
 * dispatcher, and knows nothing about ports. That split is deliberate and load-bearing:
 *
 *   • the verdict logic is the part that can be WRONG in a way nobody notices, so it is
 *     unit-tested hermetically in CI (`cell-live-matrix.test.ts`);
 *   • the live driver (`scripts/check-cell-live-matrix.ts`) is the part that cannot run
 *     in CI at all, and says so in its own header.
 *
 * ⚠ WHY THE LIVE HALF MUST NOT BE WIRED INTO CI (WI-6476). CI has no running operator.
 * A live matrix pointed at nothing observes zero squares, finds zero violations, and
 * exits 0 — presenting as coverage while asserting nothing. That is the same vacuity
 * trap P-001's census and P-003's ratchet hit, and it is why `assessMatrix` REFUSES an
 * empty observation set (see `no-observations` below) rather than reporting a clean zero.
 *
 * ── ⚠ THE A/B IS NO LONGER A FIXED-vs-UNFIXED CONTROL ────────────────────────
 *
 * P-004's text says to "probe :3170 against :3070 as an unfixed control", because that
 * A/B is what proved WI-6444. WI-6444 is now CLOSED and its fix is deployed to BOTH
 * ports — measured 2026-07-27, the two ports' matrices are byte-identical on every
 * square. So the A/B no longer discriminates fixed from unfixed, and a successor must
 * not read agreement as evidence that a fix is present.
 *
 * What the A/B still buys, and why the driver keeps it: DIVERGENCE DETECTION. :3170 runs
 * the integration tree and :3070 the release checkout, so a square that differs between
 * them localises a change to the deploy boundary — either a regression that has not
 * reached release yet, or a fix that has not. Agreement is reported as agreement, never
 * as correctness.
 *
 * ── ASSESSMENT-FIRST CUTOVER ────────────────────────────────────────────────
 *
 * D-001/D-003 replaced inference from a raw headline plus its unknown channel with
 * an explicit, decision-ready assessment. For a cell that declares an assessment:
 * a resolved assessment is the complete semantic answer even when the separate raw
 * measurement is honestly `null` (for example `no-active-run`); an unavailable or
 * missing assessment is a live failure. The raw-null rules below remain for legacy
 * fixtures/cells that do not declare an assessment. Applying them to an assessed
 * cell would reconstruct the retired falsifier-era contract.
 *
 * ── THE FOUR VERDICTS FOR "THE ANSWER CARRIES NO MEASUREMENT" ────────────────
 *
 * This plan has now hit the same shape at every layer (P-001 `no-producer` vs `no-data`;
 * P-002 write-only vs read-only vs not-declared; P-003 `regressed` vs
 * `never-interpretable`), and the rule each time is the same: SAME SYMPTOM, OPPOSITE
 * CAUSE STAYS A SEPARATE VERDICT. Collapsing them makes a live defect read as an unbuilt
 * feature, and nobody is paged. Here the family is four wide:
 *
 *   • `unexplained-null`  — the read succeeded, the headline carries no measurement, and
 *                           the declared hoist channel is MEASURED-EMPTY (`[]`). Per
 *                           `cell-read.ts`'s CellHoist contract an empty array means "the
 *                           resolver looked and found nothing unknown", so the cell is
 *                           asserting a measurement it did not make. The reason exists in
 *                           the resolver's own result and was dropped.
 *                           FIX: populate the channel. Live: WI-6484, WI-6485.
 *   • `hoist-drifted`     — the declared key was ABSENT from the resolver result, so
 *                           `readCell` set `drifted: true`. The channel is BROKEN, not
 *                           silent. FIX: the resolver's shape and the registration have
 *                           moved apart — reconcile them.
 *   • `hoist-missing`     — the spec declares `unknownHoist` and the read emitted no
 *                           `unknownHoist` field at all. This is WI-6444's ORIGINAL
 *                           symptom (declared on six cells, enforced at registration,
 *                           emitted by nothing). FIX: emit it. Distinct from `drifted`,
 *                           which proves the emit path RAN.
 *   • `wrong-status`      — the square produced a status its condition forbids.
 *
 * The first three are indistinguishable to a hurried reader and have three different
 * fixes, which is exactly why they are three tokens and not one.
 */

/* -------------------------------------------------------------------------- */
/* The four conditions P-004 enumerates                                        */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ THESE ARE PROPERTIES OF THE PROBE, NOT OF THE ANSWER. The condition says what the
 * driver ASKED — which subject it chose and why — and the verdict is then "did the
 * answer honour that question". Deriving the condition from the answer instead would
 * make the check circular: a cell that answers null for everything would be scored
 * against the expectation that it answers null.
 */
export type MatrixCondition =
  /** (a) a subject known to HAVE a value — a real, committed, deployed path; a live agent. */
  | 'subject-with-value'
  /** (b) a subject whose headline must degrade — a path no commit has ever touched. */
  | 'subject-degrades'
  /** (c) a cell outside the caller's audience, or never registered at all. */
  | 'out-of-audience'
  /** (d) no subject supplied where the cell's callerRelativity requires one. */
  | 'subject-missing';

export const MATRIX_CONDITIONS: readonly MatrixCondition[] = [
  'subject-with-value',
  'subject-degrades',
  'out-of-audience',
  'subject-missing',
] as const;

/* -------------------------------------------------------------------------- */
/* What a live read produced, reduced to the comparable shape                   */
/* -------------------------------------------------------------------------- */

/**
 * The hoist as it reached the caller. `null` means the read emitted NO `unknownHoist`
 * field — which is a different fact from an empty one, and the two must not be merged
 * on the way in (that would erase `hoist-missing` before the verdict logic ever sees it).
 */
export interface ObservedHoist {
  key: string;
  value: unknown;
  drifted?: true;
}

export interface CellObservation {
  cell: string;
  condition: MatrixCondition;
  /** Which operator answered — ':3170' | ':3070'. Carried for the A/B, never for the verdict. */
  port?: string;
  status: 'value' | 'unknown' | 'absent';
  /** Present on `status:'value'`. */
  value?: unknown;
  /** Present on `status:'unknown'` — the branchable code, never the prose. */
  unknownCode?: string;
  /**
   * The emitted hoist, or `null` for "no `unknownHoist` field was present".
   * `undefined` means the cell declares none, so its absence is correct.
   */
  hoist?: ObservedHoist | null;
  /** True when the SPEC declares `unknownHoist` — so an absent hoist can be judged. */
  declaresHoist: boolean;
  /** Explicit decision-ready semantic result carried by the same resolver payload. */
  assessment?: import('./cell-read').CellAssessmentRead | null;
  /** True when the cell SPEC declares an assessment (omission is then a failure). */
  declaresAssessment?: boolean;
  /** Top-level key set of the tool payload, sorted. Used only by the (c) non-oracle check. */
  keys?: readonly string[];
  /** Set when the read itself failed (transport, envelope, unparseable body). */
  readError?: string;
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

export type MatrixVerdict =
  | 'ok'
  | 'assessment-missing'
  | 'assessment-unavailable'
  | 'unexplained-null'
  | 'hoist-drifted'
  | 'hoist-missing'
  | 'wrong-status'
  | 'oracle-leak'
  /** The read never happened. NOT a pass and NOT a cell defect — an infrastructure fact,
   *  kept separate so a dead operator can never be scored as a clean matrix. */
  | 'unreadable';

export interface SquareResult {
  cell: string;
  condition: MatrixCondition;
  port?: string;
  verdict: MatrixVerdict;
  /** Why, in one line — the thing a reader acts on. */
  detail: string;
  /** Set when this square's failure is a FILED, still-open defect (see KNOWN_GAPS). */
  knownGap?: string;
}

/**
 * A measured silence: the resolver looked and reported nothing unknown. Per
 * `cell-read.ts`'s CellHoist contract this is a POSITIVE claim ("a real negative result,
 * and the one worth trusting"), which is precisely why serving it alongside a headline
 * that carries no measurement is a lie rather than a shrug.
 */
function isMeasuredEmpty(h: ObservedHoist): boolean {
  if (h.drifted) return false;
  if (h.value === null || h.value === undefined) return true;
  if (Array.isArray(h.value)) return h.value.length === 0;
  return false;
}

/**
 * "The headline carries no measurement."
 *
 * ⚠ DELIBERATELY NARROW — `null`/`undefined` ONLY, never a general falsiness test.
 * `gate.greenCheckpoint.verdict`'s headline is `gate.consecutiveReds`, whose honest
 * healthy answer is `0`, and `git.mainBehindStaging`'s is a real measured `false`. A
 * truthiness check would flag both as unexplained and the gate would be pure noise
 * within a day — the failure mode where a warning is trained away.
 */
function carriesNoMeasurement(value: unknown): boolean {
  return value === null || value === undefined;
}

/* -------------------------------------------------------------------------- */
/* Known gaps — filed, open, and deliberately unfixed                          */
/* -------------------------------------------------------------------------- */

/**
 * (cell, condition) squares with a FILED defect. A square listed here reports
 * `filed-gap` instead of `failing`, and the gate stays green — the defect is tracked,
 * not hidden.
 *
 * ⚠ THE ENTRY IS A LIABILITY, NOT AN EXEMPTION. `assessMatrix` is handed the set of
 * work-items that are still OPEN; a gap whose item has been CLOSED turns the square RED
 * with "WI-NNNN is closed but this square still fails". That is what stops this table
 * becoming a parking lot — the same rule P-003's METRIC_KNOWN_GAPS carries, for the same
 * reason.
 */
export const KNOWN_GAPS: Readonly<Record<string, string>> = {
  /** Answers `deployed:false` + `positionsUnknown:[]` for a path no commit ever touched. */
  'git.pipelinePosition|subject-degrades': 'WI-6484',
  /** Answers `judgingSha:null` + `verdictUnknown:[]` when no gate run is in flight. */
  'gate.greenCheckpoint.candidate|subject-with-value': 'WI-6485',
  /** The same null, reached from the degrading subject — one defect, two squares. */
  'gate.greenCheckpoint.candidate|subject-degrades': 'WI-6485',
};

export function gapKey(cell: string, condition: MatrixCondition): string {
  return `${cell}|${condition}`;
}

/* -------------------------------------------------------------------------- */
/* The per-square verdict                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Judge ONE square. Pure, total, and independent of every other square — an aggregate
 * is computed from these, never the other way round (see `assessMatrix`).
 */
export function judgeSquare(obs: CellObservation): SquareResult {
  const base = { cell: obs.cell, condition: obs.condition, ...(obs.port ? { port: obs.port } : {}) };

  if (obs.readError !== undefined) {
    return { ...base, verdict: 'unreadable', detail: `the read itself failed: ${obs.readError}` };
  }

  // ── (c) the non-oracle square. Handled first: it is the only condition whose
  // expectation is `absent`, and every other verdict below assumes the cell was
  // disclosed to the reader.
  if (obs.condition === 'out-of-audience') {
    if (obs.status !== 'absent') {
      return {
        ...base,
        verdict: 'oracle-leak',
        detail:
          `an out-of-audience/unregistered read answered "${obs.status}" instead of "absent" — the refusal is ` +
          'distinguishable, so it can be used as a probe oracle to enumerate cells you may not see (P-019).',
      };
    }
    return { ...base, verdict: 'ok', detail: 'absent, as an unregistered cell would be' };
  }

  // ── (d) a required subject was withheld. The ONLY honest answer is the enumerated
  // `insufficient-data` unknown: more INPUT is the lever, and the read must say so
  // rather than guessing a subject or collapsing to absent.
  if (obs.condition === 'subject-missing') {
    if (obs.status === 'unknown' && obs.unknownCode === 'insufficient-data') {
      return { ...base, verdict: 'ok', detail: 'insufficient-data, naming the missing parameter' };
    }
    return {
      ...base,
      verdict: 'wrong-status',
      detail:
        `a cell requiring a subject was read WITHOUT one and answered ` +
        `${obs.status}${obs.unknownCode ? `/${obs.unknownCode}` : ''} — it must be unknown/insufficient-data, ` +
        'so the caller is told to supply the subject rather than left with an answer to a question it never asked.',
    };
  }

  // ── (a) and (b) both require the cell to have been DISCLOSED. An `absent` here means
  // the audience gate refused a cell the driver believed it could read — a probe-design
  // fault or a real audience regression, and either way not something to score as ok.
  if (obs.status === 'absent') {
    return {
      ...base,
      verdict: 'wrong-status',
      detail:
        'the cell answered ABSENT for a reader that should be in its audience — either the probe named the wrong ' +
        'cell, or this cell\'s visibility narrowed. Absent is indistinguishable from unregistered by design, so ' +
        'this cannot be diagnosed from the answer alone.',
    };
  }

  // An enumerated unknown is a COMPLETE answer: it says the cell exists for you and why
  // it has no value, and the code carries the lever. That is the contract working.
  if (obs.status === 'unknown') {
    if (obs.unknownCode === undefined || obs.unknownCode === '') {
      return {
        ...base,
        verdict: 'wrong-status',
        detail: 'an unknown arrived with no branchable code — prose cannot be branched on (cell-contract.ts).',
      };
    }
    return { ...base, verdict: 'ok', detail: `explained: unknown/${obs.unknownCode}` };
  }

  // ── status === 'value'. The hoist rules apply.
  if (obs.declaresHoist) {
    if (obs.hoist === null || obs.hoist === undefined) {
      return {
        ...base,
        verdict: 'hoist-missing',
        detail:
          'the spec declares unknownHoist but the read emitted no unknownHoist field at all — a null from this ' +
          'cell reaches the caller with its reason stripped off (WI-6444\'s original symptom).',
      };
    }
    if (obs.hoist.drifted) {
      return {
        ...base,
        verdict: 'hoist-drifted',
        detail:
          `the declared hoist key "${obs.hoist.key}" was absent from the resolver's result — the channel is BROKEN, ` +
          'not silent. The registration and the resolver shape have moved apart.',
      };
    }
  }

  // D-001/D-003 — semantic meaning comes from the explicit assessment, never from
  // generic inference over the separate raw headline. Keep this after hoist checks:
  // assessment replaces semantic inference, not the independent read-health guard.
  if (obs.declaresAssessment) {
    const assessment = obs.assessment;
    if (assessment === null || assessment === undefined) {
      return {
        ...base,
        verdict: 'assessment-missing',
        detail:
          'the spec declares an assessment but the value read emitted no assessment field — the caller received ' +
          'a raw measurement without the decision-ready meaning or safe action the cell contract requires.',
      };
    }
    if (assessment.status === 'unavailable') {
      // Condition (b) deliberately supplies a subject with nothing behind it. An
      // explicit unavailable assessment is therefore the honest, branchable answer:
      // it carries the diagnosis and safe action that the old raw-null heuristic had
      // to infer. On condition (a), by contrast, the driver chose a known-good subject,
      // so unavailable is either a bad probe or a real resolver/registration defect.
      if (obs.condition === 'subject-degrades') {
        return {
          ...base,
          verdict: 'ok',
          detail: `degradation explained by assessment/${assessment.unknown.code}: ${assessment.unknown.detail}`,
        };
      }
      return {
        ...base,
        verdict: 'assessment-unavailable',
        detail:
          `the assessment is unavailable (${assessment.unknown.code}): ${assessment.unknown.detail} ` +
          `Safe action: ${assessment.safeAction}`,
      };
    }
    if (
      assessment.code.trim() === '' ||
      assessment.meaning.trim() === '' ||
      assessment.safeAction.trim() === '' ||
      !Array.isArray(assessment.evidence) ||
      assessment.evidence.some((e) => e.drifted || e.truncatedByDoor)
    ) {
      return {
        ...base,
        verdict: 'assessment-unavailable',
        detail:
          'the read labelled its assessment resolved but omitted a branchable code/meaning/safe action, or carried ' +
          'drifted/truncated evidence — a partial assessment is not decision-ready.',
      };
    }
    return {
      ...base,
      verdict: 'ok',
      detail: `assessment resolved: ${assessment.code} — ${assessment.meaning}`,
    };
  }

  const empty = obs.hoist ? isMeasuredEmpty(obs.hoist) : true;

  if (obs.condition === 'subject-with-value') {
    // A subject chosen BECAUSE it has a value must produce one. A null here is either a
    // real degradation (then the hoist must say why) or a defect.
    if (carriesNoMeasurement(obs.value) && empty) {
      return {
        ...base,
        verdict: 'unexplained-null',
        detail:
          'a subject known to HAVE a value produced a null headline while the declared unknown channel reported a ' +
          'MEASURED SILENCE — the cell is asserting it looked and found nothing unknown, which is a measurement it ' +
          'did not make. The reason is in the resolver\'s own result and was dropped.',
      };
    }
    return { ...base, verdict: 'ok', detail: 'a real subject produced a real measurement' };
  }

  // ── (b) the subject was chosen BECAUSE the headline must degrade. Whatever value comes
  // back, the degradation has to be EXPLAINED — and note this square does not care what
  // the value IS. That is what catches WI-6484, where the headline degrades to a
  // perfectly ordinary-looking `false` rather than to null.
  if (empty) {
    return {
      ...base,
      verdict: 'unexplained-null',
      detail:
        `a subject with no data behind it produced a plain value (${JSON.stringify(obs.value)}) while the declared ` +
        'unknown channel reported a MEASURED SILENCE. "Nothing to measure" is being served as "measured" — the two ' +
        'have OPPOSITE levers (fix the subject vs wait for the pipeline) and are indistinguishable in this answer.',
    };
  }
  return { ...base, verdict: 'ok', detail: 'the degradation is explained by a non-empty unknown channel' };
}

/* -------------------------------------------------------------------------- */
/* The whole-matrix assessment                                                 */
/* -------------------------------------------------------------------------- */

export interface MatrixAssessment {
  squares: SquareResult[];
  /** Squares that failed and have NO filed defect. These are what turn the gate red. */
  failing: SquareResult[];
  /** Squares that failed but are covered by an OPEN work-item. Reported, not fixed. */
  filedGaps: SquareResult[];
  /** Squares whose filed defect has been CLOSED while the square still fails. */
  staleGaps: SquareResult[];
  /** Squares whose read never happened. Never counted as a pass. */
  unreadable: SquareResult[];
  passed: number;
  /** Refusal reason when the run cannot be judged at all. */
  refusal?: string;
  ok: boolean;
  /** What the run actually established — never more than that. */
  headline: string;
}

export interface AssessOptions {
  /**
   * Work-item ids from KNOWN_GAPS that are STILL OPEN. A gap whose id is absent from
   * this set is treated as closed, and its square goes red rather than staying exempt.
   * Pass `null` to skip the liveness check entirely (the unit tests do; the live driver
   * never does).
   */
  openGapItems: ReadonlySet<string> | null;
}

/**
 * Judge a whole matrix run.
 *
 * ⚠ REFUSES AN EMPTY RUN. Zero observations is not a clean matrix — it is a matrix that
 * did not run, and reporting `ok: true` for it is the vacuity failure this plan has now
 * filed three times (WI-6476). A driver pointed at a dead port, a renamed cell, or the
 * wrong host produces exactly this, and it must be loud.
 */
export function assessMatrix(
  observations: readonly CellObservation[],
  opts: AssessOptions,
): MatrixAssessment {
  if (observations.length === 0) {
    return {
      squares: [],
      failing: [],
      filedGaps: [],
      staleGaps: [],
      unreadable: [],
      passed: 0,
      refusal:
        'the matrix observed ZERO squares. That is not a clean run — it is a run that did not happen (a dead ' +
        'operator, a wrong port, a renamed cell). Refusing rather than reporting a vacuous green.',
      ok: false,
      headline: 'REFUSED — no squares observed',
    };
  }

  const squares = observations.map(judgeSquare);
  const failing: SquareResult[] = [];
  const filedGaps: SquareResult[] = [];
  const staleGaps: SquareResult[] = [];
  const unreadable: SquareResult[] = [];
  let passed = 0;

  for (const sq of squares) {
    if (sq.verdict === 'ok') {
      passed += 1;
      continue;
    }
    if (sq.verdict === 'unreadable') {
      unreadable.push(sq);
      continue;
    }
    const gap = KNOWN_GAPS[gapKey(sq.cell, sq.condition)];
    if (gap === undefined) {
      failing.push(sq);
      continue;
    }
    sq.knownGap = gap;
    if (opts.openGapItems !== null && !opts.openGapItems.has(gap)) {
      staleGaps.push(sq);
      continue;
    }
    filedGaps.push(sq);
  }

  const ok = failing.length === 0 && staleGaps.length === 0 && unreadable.length === 0;

  /**
   * ⚠ THE HEADLINE MUST NOT OVERSTATE ITSELF ON THE HAPPY PATH. With a filed gap
   * present, "every cell answers honestly" is FALSE — three squares do not, they are
   * merely tracked. A gate that lies when green is the same defect as the fields it
   * polices, one level up.
   */
  const headline = ok
    ? filedGaps.length === 0
      ? `${passed}/${squares.length} squares honest — no unexplained answer in the live matrix`
      : `${passed}/${squares.length} squares honest, ${filedGaps.length} still failing under a FILED defect ` +
        `(${[...new Set(filedGaps.map((g) => g.knownGap))].join(', ')}) — reported, not fixed`
    : `${failing.length} unexplained, ${staleGaps.length} stale-gap, ${unreadable.length} unreadable ` +
      `of ${squares.length} squares`;

  return { squares, failing, filedGaps, staleGaps, unreadable, passed, ok, headline };
}

/* -------------------------------------------------------------------------- */
/* The A/B across the two operators                                            */
/* -------------------------------------------------------------------------- */

export interface AbDivergence {
  cell: string;
  condition: MatrixCondition;
  left: string;
  right: string;
  detail: string;
}

/**
 * Compare the SAME matrix taken against two operators.
 *
 * ⚠ AGREEMENT IS NOT CORRECTNESS, and this function's name is the only place that could
 * mislead. Both ports carrying the same defect agree perfectly — measured 2026-07-27,
 * they agree on every square INCLUDING the two filed ones. What divergence localises is
 * a change that has reached one side of the deploy boundary and not the other; what
 * agreement establishes is only that the boundary is not the explanation.
 */
export function compareAb(
  left: readonly CellObservation[],
  right: readonly CellObservation[],
): AbDivergence[] {
  const index = (obs: readonly CellObservation[]): Map<string, CellObservation> =>
    new Map(obs.map((o) => [gapKey(o.cell, o.condition), o]));
  const l = index(left);
  const r = index(right);
  const out: AbDivergence[] = [];

  for (const [key, lo] of l) {
    const ro = r.get(key);
    if (!ro) {
      out.push({
        cell: lo.cell,
        condition: lo.condition,
        left: lo.status,
        right: 'not-observed',
        detail: 'this square was observed on one operator and not the other',
      });
      continue;
    }
    const lv = judgeSquare(lo);
    const rv = judgeSquare(ro);
    if (lv.verdict !== rv.verdict) {
      out.push({
        cell: lo.cell,
        condition: lo.condition,
        left: lv.verdict,
        right: rv.verdict,
        detail:
          `the two operators disagree on this square (${lv.verdict} vs ${rv.verdict}) — a change has reached one ` +
          'side of the deploy boundary and not the other.',
      });
    }
  }
  for (const [key, ro] of r) {
    if (!l.has(key)) {
      out.push({
        cell: ro.cell,
        condition: ro.condition,
        left: 'not-observed',
        right: ro.status,
        detail: 'this square was observed on one operator and not the other',
      });
    }
  }
  return out;
}
