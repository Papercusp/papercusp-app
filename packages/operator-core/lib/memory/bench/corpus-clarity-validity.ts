/**
 * corpus-clarity-validity.ts — the inferential core of P-019 / D-088 R5.
 *
 * Split from `corpus-clarity-validity-cli.ts` so the statistics that the RULING
 * rests on are testable without a live corpus. Everything here is PURE.
 *
 * ⚠ WHY THIS IS A MODULE AND NOT INLINE IN THE CLI. The CLI's output is a
 * decision document: it says whether a shipped predictor has any validity, and
 * a defect in `spearman` or `permutationNull` would not throw, would not look
 * wrong, and would produce a confidently-wrong ruling that other lanes then
 * build on. A bench that only ever runs against live data has no control on its
 * own arithmetic — the correlation it prints is unfalsifiable by construction.
 * The companion test carries PERMANENT controls (a known-ρ series, a
 * tie-saturated series, an independent-series null) so this file cannot drift
 * into producing a plausible number that is not the statistic it claims.
 */

/** Arithmetic mean, or `null` for an empty series (never 0 — an empty mean is
 *  not zero, and reporting it as zero reads as a measurement). */
export function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Ranks with TIES SHARING their average rank.
 *
 * ⚠ Tie handling is load-bearing here, not a refinement. The outcome series in
 * this study are tie-saturated by construction — admitted-line counts live in
 * `0..6`, so a 2,000-row sample has ~7 distinct values and enormous tie groups.
 * Assigning ties arbitrary distinct ranks makes ρ depend on input ORDER, which
 * is exactly the kind of defect that yields a stable-looking wrong number.
 */
export function averageRanks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation.
 *
 * `null` when either series is CONSTANT — ρ is undefined there, and returning 0
 * would read as "measured no association" when nothing was measurable at all.
 */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = averageRanks(a);
  const rb = averageRanks(b);
  const ma = mean(ra)!;
  const mb = mean(rb)!;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i]! - ma;
    const y = rb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * FIRST-ORDER PARTIAL Spearman: the association between `a` and `b` once the
 * variance they SHARE with `c` is removed.
 *
 * This exists because R5's two outcome columns are NOT independent. Retrieval
 * reach (admitted lines) and post-retrieval clarity are measured on the same
 * result set, and `postRetrievalClarity` is a PLUG-IN KL estimator over that
 * set's term distribution — a smaller set is sparser and therefore peakier, so
 * bits rise mechanically as admitted falls. A raw rho(SCS, postBits) is
 * consequently satisfied by a query that merely retrieves LESS, which is the
 * exact reading R5 must not accept as "clarity predicts retrieval quality".
 *
 * `null` when any input rho is undefined, or when |rho(a,c)| or |rho(b,c)| is 1
 * (the denominator vanishes: `c` fully determines a series, so nothing is left
 * to partial out). Never returns 0 for an unmeasurable case — 0 would read as
 * "measured no association" when nothing was measurable at all.
 *
 * ⚠ Removing shared variance is NOT the same as establishing a causal path, and
 * a partial rho near 0 is the strongest statement here: it says the raw
 * association is ACCOUNTED FOR by `c`, not that `a` and `b` are unrelated.
 */
export function partialSpearman(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): number | null {
  if (a.length !== b.length || a.length !== c.length) return null;
  const rab = spearman(a, b);
  const rac = spearman(a, c);
  const rbc = spearman(b, c);
  if (rab === null || rac === null || rbc === null) return null;
  const denom = Math.sqrt((1 - rac * rac) * (1 - rbc * rbc));
  if (!Number.isFinite(denom) || denom === 0) return null;
  return (rab - rac * rbc) / denom;
}

/**
 * Deterministic Fisher-Yates over a seeded LCG.
 *
 * ⚠ Deliberately a full shuffle rather than a rotation. A rotation preserves the
 * series' ordering structure, so if sample position carried ANY signal the
 * control would inherit it and could mask a manufactured association — the one
 * thing the control exists to detect.
 */
export function permute<T>(xs: readonly T[], seed = 1): T[] {
  const out = [...xs];
  let s = (Math.imul(seed, 0x9e3779b9) ^ 0x85ebca6b) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface PermutationNull {
  /** Mean ρ under random pairings. Must be ≈0 or the harness is manufacturing
   *  the association. */
  mean: number;
  /** 2.5th percentile of the null ρ distribution. */
  lo: number;
  /** 97.5th percentile of the null ρ distribution. */
  hi: number;
  /** Two-sided permutation p-value for `observed`. */
  p: number;
  /** Draws that produced a defined ρ. */
  draws: number;
}

/**
 * The null distribution of ρ under random pairings — an ENSEMBLE, never a
 * single control draw.
 *
 * ⚠ A SINGLE permutation is a sample of size one from this distribution, and
 * its standard error is ≈1/√(n−1) — about 0.17 at n=36. Measured on this
 * study's own N=40 smoke run, one draw returned a control ρ of −0.204 against a
 * real ρ of −0.107: the "control" was LARGER than the effect it was meant to
 * bound. Read as a pass/fail it condemns a sound measurement; read as a
 * threshold it licences whatever the real column happens to say. Only the
 * ensemble makes "≈0" a testable claim.
 */
export function permutationNull(
  x: readonly number[],
  y: readonly number[],
  observed: number,
  draws = 999,
): PermutationNull | null {
  if (x.length < 3) return null;
  const rhos: number[] = [];
  let atLeastAsExtreme = 0;
  for (let b = 0; b < draws; b++) {
    const r = spearman(x, permute(y, b + 1));
    if (r === null) continue;
    rhos.push(r);
    if (Math.abs(r) >= Math.abs(observed)) atLeastAsExtreme++;
  }
  if (rhos.length === 0) return null;
  rhos.sort((a, b) => a - b);
  const at = (q: number): number => rhos[Math.min(rhos.length - 1, Math.floor(q * rhos.length))]!;
  return {
    mean: mean(rhos)!,
    lo: at(0.025),
    hi: at(0.975),
    // +1 in BOTH terms: the observed pairing is itself one of the arrangements
    // the null contains, so p = 0 is not attainable and must never be printed.
    p: (atLeastAsExtreme + 1) / (rhos.length + 1),
    draws: rhos.length,
  };
}

export interface PostRetrievalClarity {
  /** KL(P(·|R) ‖ P(·|C)) in bits, or `null` when nothing attested was retrieved. */
  bits: number | null;
  /** Attested tokens / all tokens in the retrieved text, 0..1. */
  attestedRatio: number | null;
}

/**
 * Post-retrieval clarity: KL divergence of the RETRIEVED set's language model
 * from the collection's, in bits.
 *
 * This is the Cronen-Townsend et al. (2002) clarity that the shipped
 * pre-retrieval SCS is an approximation OF, computed with the SAME estimator and
 * the SAME attestation rule so the two are commensurable:
 * `Σ_w P(w|·)·log2(P(w|·) / P(w|C))` with `P(w|C) = df(w)/ndocs`. Substituting a
 * uniform `P(w|Q)` over n query terms reduces that to `avgIdf − log2(n)`, which
 * is exactly what `scoreCorpusQueryClarity` computes — so this function and the
 * predictor differ ONLY in which language model supplies `P(w|·)`.
 *
 * ⚠ UNATTESTED TERMS ARE EXCLUDED, for the same reason the predictor excludes
 * them: `P(w|C) = 0` makes the KL contribution infinite, so a retrieved set full
 * of hex digests and session nonces would score as MAXIMALLY concentrated — the
 * precise inversion D-064 measured and reverted. They are counted in
 * `attestedRatio` instead, so the exclusion is visible rather than silent.
 *
 * ⚠ NOT A RELEVANCE MEASURE. It says the retrieved set is unlike the corpus at
 * large; it says nothing about whether it answers the query. Never report it as
 * retrieval quality.
 */
export function postRetrievalClarity(
  texts: readonly string[],
  tokenize: (text: string) => string[],
  df: (term: string) => number,
  ndocs: number,
  minDf: number,
): PostRetrievalClarity {
  if (ndocs <= 0) return { bits: null, attestedRatio: null };
  const tf = new Map<string, number>();
  let total = 0;
  let attestedTotal = 0;
  for (const t of texts) {
    for (const term of tokenize(t)) {
      total++;
      if (df(term) >= minDf) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
        attestedTotal++;
      }
    }
  }
  if (attestedTotal === 0) return { bits: null, attestedRatio: total > 0 ? 0 : null };
  let bits = 0;
  for (const [term, count] of tf) {
    const pr = count / attestedTotal;
    const pc = df(term) / ndocs;
    bits += pr * (Math.log(pr / pc) / Math.LN2);
  }
  return { bits, attestedRatio: attestedTotal / total };
}

/**
 * The teaser text of a rendered corpus line — the span between the `] ` label
 * and the ` → ` resolve call.
 *
 * Scoring the WHOLE rendered line would fold the handle boilerplate — the
 * `work_items:get { id: … }` call present in EVERY line — into the retrieved
 * language model, damping every divergence toward one shared constant and
 * shrinking the very signal being measured.
 */
export function teaserOf(line: string): string {
  const start = line.indexOf('] ');
  if (start < 0) return line;
  const end = line.lastIndexOf(' → ');
  return end > start ? line.slice(start + 2, end) : line.slice(start + 2);
}
