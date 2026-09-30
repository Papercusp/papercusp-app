/**
 * P-009 / AUTO-BAR-R-7-P-009: the published tool-delivery agent-insights doc must state
 * the MEASURED before/after bytes alongside the two corrections the plan encodes.
 *
 * WHY THIS IS PINNED RATHER THAN TRUSTED. The clause exists because the doc's whole job
 * is to stop the next reader re-deriving a number badly — and a doc that says "COMPACT
 * saves a lot" instead of "1,599,477 -> 649,761" fails that job while still reading like
 * it passed. Vagueness is the failure mode here, and vagueness does not throw. So the
 * guard checks for the SHAPE of a measurement (a before, an after, and a saving that
 * RECONCILES), not for the presence of prose.
 *
 * The arithmetic check is the load-bearing part. Anyone can paste three impressive
 * numbers; only a real measurement has before - after == saved. That single identity is
 * what makes this a claim about reality rather than about formatting, and it is exactly
 * what catches a doc updated by hand after the generator moved.
 */

export interface DocMeasurementVerdict {
  ok: boolean;
  violations: string[];
  /** Every `key=<integer>` pair found in the body, in document order. */
  pairs: Array<{ key: string; value: number }>;
}

/** `savedByCompact=949716` / `full=1599477` — the generator's own report syntax, which is
 *  what the doc quotes. Commas are tolerated so a prose restatement ("949,716 B") counts. */
const PAIR_RE = /([A-Za-z][A-Za-z0-9_]*)=(\d[\d,]*)/g;

function pairsOf(body: string): Array<{ key: string; value: number }> {
  const out: Array<{ key: string; value: number }> = [];
  for (const m of body.matchAll(PAIR_RE)) {
    out.push({ key: m[1], value: Number(m[2].replace(/,/g, '')) });
  }
  return out;
}

function pick(
  pairs: Array<{ key: string; value: number }>,
  key: string,
): number | null {
  const hit = pairs.find((p) => p.key === key);
  return hit ? hit.value : null;
}

/**
 * Pairs from the FIRST line carrying `marker`.
 *
 * ⚠ Scoping to the line is load-bearing, not tidiness: `full=` appears on BOTH the
 * WIRE_BYTES and GUIDANCE_BYTES lines. A document-wide lookup returns the wire's
 * `full` for the guidance check, so the guidance identity cannot reconcile and a
 * CORRECT doc is reported as arithmetically broken — a false positive that would
 * get this guard weakened or deleted by whoever next touched it.
 */
function lineScoped(body: string, marker: string): Array<{ key: string; value: number }> {
  const line = body.split('\n').find((l) => l.includes(marker));
  return line ? pairsOf(line) : [];
}

/**
 * Judge a doc body against the clause.
 *
 * A reconciling triple is required for BOTH halves the plan measured separately — the
 * whole wire (schema-dominated) and the guidance/prose half — because D-011's negative
 * result only makes sense when the two are stated apart. Collapsing them into one
 * "we saved N bytes" number is precisely the loss this clause guards against.
 */
export function judgeToolDeliveryDoc(body: string): DocMeasurementVerdict {
  const violations: string[] = [];
  const pairs = pairsOf(body);

  // ── Correction 1: rank by distinct CALLERS, not by CALLS ─────────────────────────
  const saysCallers = /distinct\s+callers/i.test(body);
  const contrastsCalls =
    /not\s+(by\s+|the\s+)?(raw\s+)?(invocation\s+|call)/i.test(body) ||
    /callers\s*(-|\s)?not(-|\s)?calls/i.test(body);
  if (!saysCallers || !contrastsCalls) {
    violations.push('missing-callers-not-calls-correction');
  }

  // ── Correction 2: three tiers, not two ───────────────────────────────────────────
  const saysThree = /three\s+tiers/i.test(body);
  const namesAllTiers = ['full', 'compact', 'deferred'].every((t) =>
    new RegExp(`\\b${t}\\b`, 'i').test(body),
  );
  if (!saysThree || !namesAllTiers) {
    violations.push('missing-three-tiers-correction');
  }

  // ── The measured before/after, both halves, each reconciling ─────────────────────
  const wire = lineScoped(body, 'WIRE_BYTES');
  const wireFull = pick(wire, 'full');
  const wireCompact = pick(wire, 'compact');
  const savedByCompact = pick(wire, 'savedByCompact');
  if (wireFull === null || wireCompact === null || savedByCompact === null) {
    violations.push('missing-wire-bytes-measurement');
  } else if (wireFull - wireCompact !== savedByCompact) {
    violations.push('wire-bytes-do-not-reconcile');
  }

  const guidance = lineScoped(body, 'GUIDANCE_BYTES');
  const guidanceFull = pick(guidance, 'full');
  const guidanceSummary = pick(guidance, 'summary');
  const savedBySummary = pick(guidance, 'savedBySummary');
  if (guidanceFull === null || guidanceSummary === null || savedBySummary === null) {
    violations.push('missing-guidance-bytes-measurement');
  } else if (guidanceFull - guidanceSummary !== savedBySummary) {
    violations.push('guidance-bytes-do-not-reconcile');
  }

  // ── The honesty half: a BYTE saving is an UPPER BOUND, never the realised saving ───
  //
  // WHY THIS IS A SEPARATE CLAUSE. Everything above checks that the doc states a real
  // measurement. This checks that it states the right KIND of claim about it. The
  // provider bills TOKENS, and the tokenizer does not compress prose and JSON
  // punctuation at the same rate — so the byte percentage is systematically the more
  // flattering number. A doc that publishes 72.8% as "the context we save" is
  // arithmetically impeccable and still wrong, which is exactly the failure a checker
  // over byte triples alone cannot see.
  //
  // The label is not taken on trust either. The doc must carry a token measurement on
  // the SAME subject as its byte measurement, and the two percentages are recomputed
  // here: if the token saving ever stops being the smaller of the two, the upper-bound
  // framing is no longer supported by the doc's own numbers and this fails — rather
  // than leaving a stale claim that once was true.
  const defBytes = lineScoped(body, 'DEFINITION_BYTES');
  const defBytesFull = pick(defBytes, 'full');
  const defBytesCompact = pick(defBytes, 'compact');
  const defBytesSaved = pick(defBytes, 'savedByCompact');
  if (defBytesFull === null || defBytesCompact === null || defBytesSaved === null) {
    violations.push('missing-definition-bytes-measurement');
  } else if (defBytesFull - defBytesCompact !== defBytesSaved) {
    violations.push('definition-bytes-do-not-reconcile');
  }

  const defTokens = lineScoped(body, 'DEFINITION_TOKENS');
  const defTokensFull = pick(defTokens, 'full');
  const defTokensCompact = pick(defTokens, 'compact');
  const defTokensSaved = pick(defTokens, 'savedByCompact');
  if (defTokensFull === null || defTokensCompact === null || defTokensSaved === null) {
    violations.push('missing-definition-token-measurement');
  } else if (defTokensFull - defTokensCompact !== defTokensSaved) {
    violations.push('definition-tokens-do-not-reconcile');
  }

  if (!/upper\s+bound/i.test(body)) {
    violations.push('missing-upper-bound-label');
  }

  // Both measurements present and internally sound — now check they still SUPPORT the
  // label. A byte saving that is no longer the larger number means the doc is calling
  // the wrong figure an upper bound.
  if (
    defBytesFull !== null &&
    defBytesCompact !== null &&
    defTokensFull !== null &&
    defTokensCompact !== null &&
    defBytesFull > 0 &&
    defTokensFull > 0
  ) {
    const byteSaving = (defBytesFull - defBytesCompact) / defBytesFull;
    const tokenSaving = (defTokensFull - defTokensCompact) / defTokensFull;
    if (tokenSaving >= byteSaving) {
      violations.push('byte-saving-not-an-upper-bound');
    }
  }

  // ── The token figure must declare itself MEASURED ─────────────────────────────────
  //
  // R-7 also requires that any published token figure be MEASURED and never inferred
  // from the byte ratio, and nothing here used to check it at all. This is the half that
  // CAN be checked: the line must carry its own provenance label, so a refresh that
  // pastes a fresh number without re-measuring has to delete a token to stay green
  // rather than silently inheriting the old claim.
  //
  // Stated plainly, because a guard that overclaims gets trusted past its reach: the
  // label cannot detect a LIE. What it does detect is the common accident — an
  // unlabelled number appearing where a labelled one used to be. The arithmetic half of
  // "not inferred" is already carried by `byte-saving-not-an-upper-bound` above: a token
  // figure derived by applying the byte ratio reproduces that ratio exactly, so the two
  // percentages come out EQUAL and that check rejects it.
  const tokenLine = body.split('\n').find((l) => l.includes('DEFINITION_TOKENS')) ?? '';
  if (!/provenance\s*=\s*measured/.test(tokenLine)) {
    violations.push('missing-token-provenance');
  }

  // ── The $defs/$ref N=1 net loss — the saving's own boundary condition ─────────────
  //
  // WHY THIS RULE EXISTS, AND WHY IT IS ARITHMETIC. R-7 requires the `$defs` N=1 net loss
  // to be stated "wherever the saving is claimed". Before this rule the doc published
  // -72.8% and 65.1% with zero mentions of `$defs`, `$ref`, `N=1` or a net loss: the bar
  // was VIOLATED while every check in this file was green, which is the worst reading a
  // guard can produce — a grader reads "healthy" off a check that cannot see the breach.
  //
  // A prose match would close that in the weakest available way. The thing a reader
  // actually needs is a DIRECTION — at one reference, factoring must COST; from two, it
  // must PAY — and a direction is checkable. So the doc has to publish both endpoints of
  // the flip, each reconciling, and the sign of each is asserted. That also fails a doc
  // whose prose still recites the caveat while its numbers have stopped supporting it,
  // the same failure mode `byte-saving-not-an-upper-bound` exists for.
  const defsN1 = lineScoped(body, 'DEFS_N1_BYTES');
  const n1Inlined = pick(defsN1, 'inlined');
  const n1Referenced = pick(defsN1, 'referenced');
  const n1Added = pick(defsN1, 'addedByFactoring');
  if (n1Inlined === null || n1Referenced === null || n1Added === null) {
    violations.push('missing-defs-n1-limit');
  } else if (n1Referenced - n1Inlined !== n1Added) {
    violations.push('defs-n1-bytes-do-not-reconcile');
  } else if (n1Added <= 0) {
    violations.push('defs-n1-not-a-net-loss');
  }

  const defsN2 = lineScoped(body, 'DEFS_N2_BYTES');
  const n2Inlined = pick(defsN2, 'inlined');
  const n2Referenced = pick(defsN2, 'referenced');
  const n2Saved = pick(defsN2, 'savedByFactoring');
  if (n2Inlined === null || n2Referenced === null || n2Saved === null) {
    violations.push('missing-defs-payoff-threshold');
  } else if (n2Inlined - n2Referenced !== n2Saved) {
    violations.push('defs-n2-bytes-do-not-reconcile');
  } else if (n2Saved <= 0) {
    violations.push('defs-n2-does-not-pay');
  }

  return { ok: violations.length === 0, violations, pairs };
}
