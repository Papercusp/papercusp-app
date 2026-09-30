/**
 * Grader for **GAIA** (General AI Assistants — Mialon, Fourrier, Swift, Wolf, LeCun, Scialom;
 * Meta FAIR + Hugging Face + AutoGPT; arXiv:2311.12983) — plan `benchmark-suite-gaia-2026-06-17`.
 *
 * GAIA ships NO agent harness: it is a Q&A dataset + a string scorer. So unlike the SWE-bench-family
 * graders (apply a diff → run tests) or TheAgentCompany (run an in-container evaluator), this grader is a
 * pure, in-process, deterministic **quasi-exact-match** comparator — no docker, no subprocess, no network.
 * It is the easy, well-specified half of the build; getting it byte-faithful to the official scorer is
 * what makes the reported accuracy comparable to the public leaderboard.
 *
 * FAITHFUL to the upstream `question_scorer` (the GAIA leaderboard Space's `scorer.py`). The model is
 * instructed (system prompt, see {@link GAIA_SYSTEM_PROMPT} in ../gaia/agent.ts) to finish with
 * `FINAL ANSWER: [answer]` in a normalized format; we extract that substring and compare it to the gold
 * `Final answer` with type-aware normalization:
 *   - **number** — gold parses as a float → strip `$ % ,` from the model answer, parse, compare numerically.
 *   - **list**   — gold contains `,` or `;` → split BOTH on `[,;]`, require equal length, then apply the
 *                  number-rule or the string-rule per element (string elements keep punctuation — the
 *                  upstream list path normalizes with `remove_punct=False`).
 *   - **string** — otherwise → lowercase, strip ALL whitespace, strip ALL ASCII punctuation, compare.
 *
 * The scorer is **arm-blind** (it sees only `model_answer` + `gold`, never which agent produced it) and
 * **deterministic** (same inputs → same verdict). Scoring is **binary per task** — there is no partial
 * credit (GAIA is exact-match). Aggregation reports **per-level (L1/L2/L3) + overall accuracy**.
 */

/* -------------------------------------------------------------------------- */
/* Python-faithful primitives                                                  */
/* -------------------------------------------------------------------------- */

/** The exact set of characters Python's `string.punctuation` removes (used by `normalize_str`). */
const PY_PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

/**
 * Parse a string the way Python's `float()` does, for the cases GAIA answers hit. Returns
 * `{ ok, value }`: `ok:false` ⇒ a `ValueError` (NOT a number). Accepts optional sign, decimal,
 * exponent, and the literals inf/infinity/nan (case-insensitive, like CPython). Rejects everything
 * `float()` would — embedded units (`"100000 dollars"`), thousands commas (`"1,000"`), hex, empty.
 *
 * NOTE: underscores-in-numerals (`float("1_000")`) ARE valid in CPython ≥3.6 but never occur in GAIA
 * gold answers; we deliberately reject them to keep the grammar tight (a model emitting `1_000` would
 * fail the number path, which is the safer direction — it cannot create a false MATCH).
 */
export function pyFloat(raw: string): { ok: boolean; value: number } {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, value: NaN };
  const lower = s.toLowerCase();
  const signless = lower.replace(/^[+-]/, '');
  if (signless === 'inf' || signless === 'infinity') {
    return { ok: true, value: lower.startsWith('-') ? -Infinity : Infinity };
  }
  if (signless === 'nan') return { ok: true, value: NaN };
  // Standard float grammar: 1, 1.5, .5, 1., 1e3, -2.5E-4 (no thousands separators, no embedded units).
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return { ok: false, value: NaN };
  const v = Number(s);
  return Number.isNaN(v) ? { ok: false, value: NaN } : { ok: true, value: v };
}

/** Does `s` parse as a Python float? (Mirrors the upstream `is_float`; "nan"/"inf" count as floats.) */
export function isFloatStr(s: string): boolean {
  return pyFloat(s).ok;
}

/**
 * `normalize_number_str` — strip `$ % ,`, then parse as a float. On a parse failure the upstream scorer
 * returns `float("inf")` (so a non-numeric model answer can never equal a finite gold number). We mirror
 * that exactly: failure → `Infinity`.
 */
export function normalizeNumberStr(raw: string): number {
  let s = raw;
  for (const ch of ['$', '%', ',']) s = s.split(ch).join('');
  const p = pyFloat(s);
  return p.ok ? p.value : Infinity;
}

/**
 * `normalize_str` — lowercase, remove ALL whitespace, and (when `removePunct`) remove ALL ASCII
 * punctuation. The string-equality path uses `removePunct:true`; the per-element list path uses
 * `removePunct:false` (keeps punctuation, mirroring the upstream `remove_punct=False`).
 */
export function normalizeStr(input: string, removePunct = true): string {
  const noSpaces = input.replace(/\s/g, '');
  const lowered = noSpaces.toLowerCase();
  if (!removePunct) return lowered;
  let out = '';
  for (const ch of lowered) if (!PY_PUNCTUATION.has(ch)) out += ch;
  return out;
}

/** Split a string on `,` or `;` (the upstream `split_string` default char list). */
export function splitGaiaList(s: string): string[] {
  return s.split(/[,;]/);
}

/* -------------------------------------------------------------------------- */
/* The scorer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The canonical GAIA `question_scorer` — a faithful port. Returns `true` iff `modelAnswer`
 * quasi-exact-matches `gold` under GAIA's type-aware rules. Pure + deterministic.
 *
 *   1. gold is a number          → numeric compare (strip `$%,`).
 *   2. gold contains `,` or `;`  → list: equal length, per-element number/string rule.
 *   3. otherwise                 → string: lowercase / strip whitespace / strip punctuation.
 */
export function gaiaQuestionScorer(modelAnswer: string, gold: string): boolean {
  // 1) number
  if (isFloatStr(gold)) {
    return normalizeNumberStr(modelAnswer) === pyFloat(gold).value;
  }
  // 2) list (gold has a separator)
  if (gold.includes(',') || gold.includes(';')) {
    const goldElems = splitGaiaList(gold);
    const maElems = splitGaiaList(modelAnswer);
    if (goldElems.length !== maElems.length) return false;
    for (let i = 0; i < goldElems.length; i++) {
      const g = goldElems[i];
      const m = maElems[i];
      if (isFloatStr(g.trim())) {
        if (normalizeNumberStr(m) !== pyFloat(g.trim()).value) return false;
      } else {
        // List elements: normalize WITHOUT punctuation removal (remove_punct=False upstream).
        if (normalizeStr(m, false) !== normalizeStr(g, false)) return false;
      }
    }
    return true;
  }
  // 3) string
  return normalizeStr(modelAnswer) === normalizeStr(gold);
}

/* -------------------------------------------------------------------------- */
/* FINAL ANSWER extraction                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract the model's answer from its raw output. The agent is instructed to finish with
 * `FINAL ANSWER: [answer]`. We take the text after the LAST case-insensitive `FINAL ANSWER:` marker
 * (the last one wins — a model may restate the template), trimmed of surrounding whitespace and a
 * single pair of wrapping brackets/quotes if the model literally echoed `[ ... ]`.
 *
 * Returns `null` when no marker is present — a FORMATTING failure, reported distinctly from a wrong
 * answer (the plan calls the formatting-vs-reasoning split out as a first-class metric).
 */
export function extractFinalAnswer(rawOutput: string): string | null {
  const marker = /final\s*answer\s*:/gi;
  let lastIdx = -1;
  let lastLen = 0;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(rawOutput)) !== null) {
    lastIdx = m.index;
    lastLen = m[0].length;
  }
  if (lastIdx < 0) return null;
  let answer = rawOutput.slice(lastIdx + lastLen);
  // Stop at a trailing newline-block if the model kept writing after the answer on later lines is rare;
  // GAIA answers are short, so we take the remainder of the SAME logical answer: up to the first
  // double-newline (a new paragraph) if present, else the whole remainder.
  const para = answer.split(/\n\s*\n/, 1)[0];
  answer = para.trim();
  // Unwrap a single literal [ ... ] the model echoed from the template.
  if (answer.startsWith('[') && answer.endsWith(']')) answer = answer.slice(1, -1).trim();
  return answer;
}

/* -------------------------------------------------------------------------- */
/* Grading one task + aggregating                                              */
/* -------------------------------------------------------------------------- */

/** GAIA difficulty level. Stored as a string in the dataset ("1"|"2"|"3"); normalized to 1|2|3. */
export type GaiaLevel = 1 | 2 | 3;

/** One prediction to grade: a task id, the agent's raw output (or pre-extracted answer), and the gold. */
export interface GaiaPrediction {
  taskId: string;
  /** The agent's RAW final message (the grader extracts `FINAL ANSWER:` from it). */
  rawOutput?: string;
  /** OR a pre-extracted model answer (skips extraction). Exactly one of rawOutput / modelAnswer. */
  modelAnswer?: string;
  /** The gold `Final answer` for this task. */
  gold: string;
  /** GAIA level (1|2|3) — used for per-level aggregation. */
  level: GaiaLevel;
  /**
   * Mark a task as a non-reproducible live-web-drift failure (the source the gold was annotated against
   * moved). Such tasks are EXCLUDED from the scored denominator (not counted as a capability fail), and
   * surfaced separately — mirrors the SWE-bench `error`/`timeout` infra-exclusion discipline. (Optional;
   * defaults to scored.)
   */
  excludeReason?: string;
}

/** Per-task grade. `formatFail` distinguishes a missing `FINAL ANSWER:` (formatting) from a wrong answer. */
export interface GaiaTaskGrade {
  taskId: string;
  level: GaiaLevel;
  /** Quasi-exact-match verdict. `false` for both a wrong answer AND a formatting failure. */
  resolved: boolean;
  /** The answer the scorer actually compared (post-extraction); null when extraction failed. */
  extractedAnswer: string | null;
  gold: string;
  /** True iff there was no `FINAL ANSWER:` marker to extract — a formatting (not reasoning) failure. */
  formatFail: boolean;
  /** Set when the task was excluded from scoring (live-web-drift etc.); the row is surfaced, not scored. */
  excludeReason?: string;
}

/** Per-level accuracy breakdown. */
export interface GaiaLevelReport {
  level: GaiaLevel;
  /** Scored tasks (excludes `excludeReason` rows). */
  scored: number;
  resolved: number;
  /** resolved / scored (0 when scored === 0). */
  accuracy: number;
  /** How many of the unresolved were formatting failures (no FINAL ANSWER). */
  formatFails: number;
  /** Excluded (live-web-drift etc.) rows at this level. */
  excluded: number;
}

/** The full GAIA report: per-level + overall, plus the per-task grades. */
export interface GaiaReport {
  /** Overall accuracy over all SCORED tasks (excludes drift-excluded rows). */
  overallAccuracy: number;
  scored: number;
  resolved: number;
  excluded: number;
  /** Of all unresolved scored tasks, how many failed purely on formatting (no FINAL ANSWER line). */
  formatFails: number;
  /** Formatting-failure rate among scored tasks — the "invest in FINAL ANSWER discipline" signal. */
  formatFailRate: number;
  byLevel: GaiaLevelReport[];
  grades: GaiaTaskGrade[];
}

/** Coerce a raw level value ("1" | 1 | "Level 1" | …) to a {@link GaiaLevel}; throws on an unparseable one. */
export function coerceLevel(raw: unknown): GaiaLevel {
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9]/g, ''));
  if (n === 1 || n === 2 || n === 3) return n;
  throw new Error(`GAIA: unparseable level ${JSON.stringify(raw)} (expected 1|2|3)`);
}

/** Grade ONE prediction. Extracts the FINAL ANSWER (unless `modelAnswer` is given) and scores it. */
export function gradeGaiaTask(pred: GaiaPrediction): GaiaTaskGrade {
  if (pred.excludeReason) {
    return {
      taskId: pred.taskId,
      level: pred.level,
      resolved: false,
      extractedAnswer: pred.modelAnswer ?? (pred.rawOutput ? extractFinalAnswer(pred.rawOutput) : null),
      gold: pred.gold,
      formatFail: false,
      excludeReason: pred.excludeReason,
    };
  }
  const extracted =
    pred.modelAnswer !== undefined ? pred.modelAnswer : pred.rawOutput !== undefined ? extractFinalAnswer(pred.rawOutput) : null;
  if (extracted === null) {
    return {
      taskId: pred.taskId,
      level: pred.level,
      resolved: false,
      extractedAnswer: null,
      gold: pred.gold,
      formatFail: true,
    };
  }
  return {
    taskId: pred.taskId,
    level: pred.level,
    resolved: gaiaQuestionScorer(extracted, pred.gold),
    extractedAnswer: extracted,
    gold: pred.gold,
    formatFail: false,
  };
}

/** Grade a batch of predictions → a per-level + overall {@link GaiaReport}. Deterministic + arm-blind. */
export function gradeGaia(predictions: GaiaPrediction[]): GaiaReport {
  const grades = predictions.map(gradeGaiaTask);

  const byLevel: GaiaLevelReport[] = ([1, 2, 3] as GaiaLevel[]).map((level) => {
    const atLevel = grades.filter((g) => g.level === level);
    const excludedRows = atLevel.filter((g) => g.excludeReason);
    const scoredRows = atLevel.filter((g) => !g.excludeReason);
    const resolved = scoredRows.filter((g) => g.resolved).length;
    const formatFails = scoredRows.filter((g) => g.formatFail).length;
    return {
      level,
      scored: scoredRows.length,
      resolved,
      accuracy: scoredRows.length > 0 ? resolved / scoredRows.length : 0,
      formatFails,
      excluded: excludedRows.length,
    };
  });

  const scoredGrades = grades.filter((g) => !g.excludeReason);
  const resolved = scoredGrades.filter((g) => g.resolved).length;
  const formatFails = scoredGrades.filter((g) => g.formatFail).length;
  const scored = scoredGrades.length;
  return {
    overallAccuracy: scored > 0 ? resolved / scored : 0,
    scored,
    resolved,
    excluded: grades.length - scored,
    formatFails,
    formatFailRate: scored > 0 ? formatFails / scored : 0,
    byLevel,
    grades,
  };
}
