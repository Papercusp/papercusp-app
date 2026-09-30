/**
 * wi-6512-known-item-replay-cli.ts — THE P-018 ACCEPTANCE MEASUREMENT.
 *
 * Replays the seven reconstructed WI-6512 investigation batches against the LIVE
 * mid-turn-context endpoint and counts how many hand back the already-recorded
 * answer. This is the RELEVANCE instrument: the corpus-leg acceptance CLI
 * measures how MANY lines get admitted, and says nothing about whether they are
 * the RIGHT ones. A change that admits more noise scores identically there and
 * scores zero here.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/wi-6512-known-item-replay-cli.ts
 *
 * ⚠ TARGET :3170 (staging), not :3070. :3070 runs from the release checkout, so
 * it answers about code that shipped, not code you just wrote. :3170 runs from
 * this integration tree — but it does NOT hot-reload, so after a server-side edit
 * you must `dev:restart { target: 'staging', confirm: true, authorize: true, reason: '<why>' }` or you will
 * measure the previous build and believe you measured yours.
 *
 * ═══ THE TWO MODES ARE DIFFERENT QUESTIONS — DO NOT AVERAGE THEM ════════════
 *
 * This is the methodological trap in the measurement, and it is invisible if you
 * only ever run one mode:
 *
 *   SEQUENTIAL — one fresh session, seven batches in order, as a real agent
 *   experiences them. D-006's session-epoch dedup stamps a record the first time
 *   it surfaces and never re-pays it, so the count of batches carrying WI-6512 is
 *   CAPPED AT 1 BY DESIGN. Here "1 of 7" is a PERFECT score and 2 would be a
 *   dedup regression. Reading it as "1 hit, 6 misses" reports the dedup working
 *   as though it were retrieval failing.
 *
 *   INDEPENDENT — a fresh session per batch, so every batch's derived query is
 *   judged on its own with an empty ledger. Ceiling 7. This is the only mode in
 *   which "batches 2-7 cannot move at any budget" (the acceptance test header's
 *   claim about WI-7237/P-018) is a statement that can be true or false.
 *
 * Both are printed, always, labelled with their own ceiling. The headline
 * acceptance number is the INDEPENDENT one.
 *
 * ⚠ A green run of `mid-turn-context.p018-acceptance.test.ts` is NOT this
 * measurement and never was — that file mocks the store, and its own header says
 * so at length. It shares this replay's seven batches by import (see
 * `wi-6512-replay.ts`) precisely so the two cannot drift apart.
 */
import { ANSWER_RECORDS, KNOWN_ITEM, REPLAY, carriesAnswer, type ReplayBatch } from './wi-6512-replay';
import { deriveBatchQuery, splitLegQueries } from '../../endpoint-route/routes/agent-mcp/mid-turn-context';
import type { CorpusDropReason } from '../corpus-recall';

interface Args {
  base: string;
  passes: number;
  harness: string;
  workspace: string;
  verbose: boolean;
  /** 'none' runs the in-process probes only — no live endpoint, no staging restart needed. */
  mode: 'both' | 'independent' | 'sequential' | 'none';
  explainSelection: boolean;
  arms: boolean;
  oracle: boolean;
  oracleMaxTerms: number;
  oracleTurns: number[];
  gradedArms: boolean;
  anchorArms: boolean;
  rerankArms: boolean;
  ceiling: boolean;
  arity: boolean;
  /** Restrict --arity to these replay turns (empty = all). */
  arityTurns: number[];
  /** 0 = probe EVERY candidate term, which is what makes "unreachable" a ceiling. */
  arityMaxTerms: number;
}

/** Drop reasons that are purely a consequence of ORDER: the hit survived every
 *  filter and lost only because six better-ranked refs got there first. A
 *  reordering or slot-reservation policy could have admitted it. */
const ORDER_DROPS: ReadonlySet<CorpusDropReason> = new Set(['cap-exhausted', 'budget-exhausted']);

/** Drop reasons that EXCLUDED the hit before ordering ever happened. No
 *  reordering and no reserved slot can rescue these — they are a different fix
 *  in a different layer, and counting them as "selection could fix this" is the
 *  error this whole measurement exists to prevent. */
const FILTER_DROPS: ReadonlySet<CorpusDropReason> = new Set([
  'self-session',
  'out-of-scope',
  'no-term-overlap',
  'not-novel',
]);

type CeilingVerdict =
  /** Already in the injected block — selection needs no help here. */
  | 'admitted'
  /** Survived to ordering, lost on rank/cap. THE RESCUABLE CLASS. */
  | 'order-blocked'
  /** Filtered out before ordering. Selection policy cannot reach it. */
  | 'filter-blocked'
  /** Retrieval never returned it. Nothing downstream of retrieval can help. */
  | 'not-retrieved'
  /** Recorded only as a collapsed duplicate but never admitted — should be
   *  impossible; reported rather than silently bucketed. */
  | 'anomaly'
  /** The arm did not hold, or the leg did not run to completion. NOT a result. */
  | 'void';

/**
 * THE ORACLE — which 2-TERM PAIRS retrieve an answer-bearing record at all, and
 * would any selector have been able to pick one?
 *
 * This is a CEILING measurement, run BEFORE designing a replacement selector
 * (WI-9273), because that ordering is exactly what P-018 got wrong: a mechanism
 * was built on a plausible story about which terms are good, and the story was
 * false. Here nothing is designed — every candidate term is simply tried, and
 * the corpus says which ones work.
 *
 * It answers three questions no selector-vs-selector comparison can:
 *   1. Is 2/7 near the ceiling, or is 7/7 reachable? If a batch has NO winning
 *      pair AFTER AN EXHAUSTIVE search, no choice of two terms can save it and
 *      the fix is not selection at all (it is reach, or the 2-term cap, or the
 *      corpus). ⚠ "no winner found" earns that conclusion ONLY at COMPLETE
 *      coverage — see the coverage note on the candidate window below.
 *   2. What do the winners have in common? If nothing learnable — not rarity,
 *      not length, not position — then ranked single-term selection is a dead
 *      end and the honest answer is to stop trying to pick.
 *   3. Did either shipped selector actually have the winner in reach? A selector
 *      that never had the right term as a candidate is failing earlier than its
 *      ranking rule.
 */
async function runOracle(args: Args): Promise<void> {
  const [{ corpusQueryText, corpusTerms }, { corpusTermDfLookup }, { recallCorpusContext }, { getOrgPg }] =
    await Promise.all([
      import('../corpus-recall'),
      import('../corpus-term-df'),
      import('../corpus-recall-io'),
      import('@papercusp/db-org'),
    ]);
  const { sql } = getOrgPg();
  const df = await corpusTermDfLookup(sql, 'papercusp-workspace');

  console.log('\n## ORACLE — which 2-TERM PAIRS retrieve an answer-bearing record?');
  console.log(
    `   (ceiling for WI-9273: every pair over ${args.oracleMaxTerms > 0 ? `the first ${args.oracleMaxTerms}` : 'ALL'} candidates)`,
  );
  // ⚠ A turn-filtered run's tallies are over the SELECTED batches, never over
  // all 7. Say so in the header: an "N of 7" read off a filtered sweep is the
  // same false-ceiling shape as counting iterated-instead-of-returned probes —
  // a number that did not measure what its denominator claims.
  const oracleWanted = args.oracleTurns.length > 0 ? new Set(args.oracleTurns) : null;
  console.log(
    oracleWanted
      ? `   ⚠ TURN-FILTERED to ${[...oracleWanted].join(',')} — tallies below are over these ${oracleWanted.size} batch(es), NOT all ${REPLAY.length}.\n`
      : '',
  );

  let batchesWithAnyWinner = 0;
  let batchesWithLenientWinner = 0;
  let batchesProvenUnreachable = 0;
  let batchesUndetermined = 0;
  const winnerProfile: Array<{ term: string; df: number; len: number; pos: number; batch: number }> = [];

  for (const batch of REPLAY) {
    if (oracleWanted && !oracleWanted.has(batch.turn)) continue;
    const raw = deriveBatchQuery(batch.calls);
    const allTerms = corpusTerms(raw);
    const picks = {
      length: corpusQueryText(raw).split(' '),
      banded: df ? corpusQueryText(raw, undefined, { df }).split(' ') : [],
    };
    // ⚠ SECOND CORRECTION, same class as the first (see the PAIRS note below).
    // The candidate window used to be a bare `.slice(0, N)` while the SHIPPED
    // SELECTORS choose from ALL of `corpusTerms(raw)`. So a selector whose pick
    // fell outside the window could never match a probed pair, and the row
    // printed `LENGTH no` — an ABSENCE OF PROBE rendered as a NEGATIVE RESULT.
    // Measured: turn 69 has 29 candidates, of which 8 were probed (7% of its 406
    // pairs), and its `LENGTH no` was un-probed rather than false. Both shipped
    // selectors' picks are now unioned into the window unconditionally, so an
    // `[L]`/`[B]` verdict is always about a pair that was actually tried.
    const windowed = args.oracleMaxTerms > 0 ? allTerms.slice(0, args.oracleMaxTerms) : allTerms;
    const terms = [...new Set([...windowed, ...picks.length, ...picks.banded])].filter((t) => allTerms.includes(t));
    const fullPairs = (allTerms.length * (allTerms.length - 1)) / 2;

    // PAIRS, not single terms. ⚠ This is a CORRECTION of this probe's first
    // version, and the bug is worth stating because it is counter-intuitive:
    // single-term retrieval is NOT a lower bound for two-term retrieval. The leg
    // issues an AND (then P-017's graded cascade), so adding a term makes the
    // query MORE selective — two terms can surface a record that NEITHER term
    // surfaces alone. Measured here: turn 69 retrieves WI-6512 on
    // "sessions explain", while `sessions` alone and `explain` alone both miss.
    // A single-term sweep therefore reports batches as "unreachable" that are
    // perfectly reachable, which is a false ceiling in the expensive direction —
    // it argues for abandoning selection when selection is exactly what works.
    // ⚠ THIRD CORRECTION, same class as the first two. This probe used to score
    // ONE criterion — `carriesAnswer`, which is LENIENT (the work-item id OR any
    // of three mem0 records that would equally stop the investigation). The bar
    // it is measured against ("beat STRICT 2 of 7") is the STRICT criterion (the
    // literal work-item id). A lenient ceiling quoted against a strict bar is a
    // UNITS MISMATCH: it inflates the apparent headroom and cannot be acted on.
    // Caught by reconciling against a measurement already trusted — the endpoint
    // run scored BANDED 0/7, while a lenient-only oracle called BANDED's turn-63
    // pick a WINNER. Both are correct; they are not the same question. Score BOTH.
    const results: Array<{ term: string; strict: boolean; lenient: boolean }> = [];
    const queue: string[] = [];
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) queue.push(`${terms[i]} ${terms[j]}`);
    }
    const worker = async (): Promise<void> => {
      for (;;) {
        const term = queue.shift();
        if (term === undefined) return;
        const res = await recallCorpusContext({
          queryText: term,
          workspaceId: 'papercusp-workspace',
          harnessSlugs: ['papercusp'],
        });
        // ⚠⚠ FOURTH CORRECTION, and the most dangerous of the four: score record
        // IDENTITY, never a substring of the rendered block.
        //
        // `rendered.includes('WI-6512')` counts a hit for ANY record whose TEXT
        // merely mentions the id — and this investigation's OWN session turns and
        // work-items now sit in the very workspace corpus the leg queries, all of
        // them saying "WI-6512" repeatedly. The probe was scoring its own notes.
        //
        // Measured 2026-08-03: the pair "components agentsrunningpill" scored a
        // WINNER by retrieving a session turn of mine reading
        //   "`agentsrunningpill components` → **absent** (top 0.021)"
        // i.e. it matched my own written record that THIS PAIR FAILS. "explain
        // session" retrieved EI-19459220786674667, filed 40 minutes earlier.
        // "turn 3170" was a winner in one sweep and returned 0 lines in the next.
        //
        // Identity scoring is immune: a session turn ABOUT WI-6512 has
        // handle.ref = 'claude:<session>', not 'WI-6512'.
        const strict = res.lines.some((l) => l.handle.kind === 'work-item' && l.handle.ref === KNOWN_ITEM);
        results.push({
          term,
          strict,
          // The OLD substring measure, kept ONLY so the contamination gap is
          // visible in the output rather than silently absorbed. Never act on it.
          lenient: carriesAnswer(res.lines.map((l) => l.line).join('\n')) !== undefined,
        });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    // STRICT is the headline: it is the only criterion comparable to the shipped
    // bar (2 of 7). LENIENT is reported alongside so the gap between them is
    // visible rather than silently chosen.
    const winners = results.filter((r) => r.strict).map((r) => r.term);
    const lenientWinners = results.filter((r) => r.lenient).map((r) => r.term);
    if (winners.length > 0) batchesWithAnyWinner++;
    if (lenientWinners.length > 0) batchesWithLenientWinner++;
    for (const w of winners) {
      const [a, b] = w.split(' ') as [string, string];
      winnerProfile.push({
        term: w,
        df: df ? Math.min(df(a), df(b)) : -1,
        len: Math.max(a.length, b.length),
        pos: Math.max(terms.indexOf(a), terms.indexOf(b)),
        batch: batch.turn,
      });
    }

    // ── SEPARABILITY: could ANY monotone rule over a per-term scalar find these? ──
    //
    // This is the question P-018 answered with a story instead of a measurement.
    // Both shipped selectors score each term IN ISOLATION and take the top two:
    // LENGTH prefers the longest, BANDED the rarest attested (df >= 2). Knowing
    // that each picked a LOSER says only that its direction/cutoff was wrong.
    // The stronger question is whether the signal is in the scalar AT ALL.
    //
    // If the winning pairs and the losing pairs OVERLAP on a scalar, then no
    // monotone threshold over it separates them — so no top-2 rule, in EITHER
    // direction and at ANY cutoff, can be made to prefer winners. Retuning is
    // then not a smaller version of the fix; it is not a fix.
    //
    // Ranges are printed alongside the verdict so it is checkable, not asserted.
    const profileOf = (pair: string) => {
      const [a, b] = pair.split(' ') as [string, string];
      return {
        df: df ? Math.min(df(a), df(b)) : -1,
        len: Math.max(a.length, b.length),
        pos: Math.max(terms.indexOf(a), terms.indexOf(b)),
      };
    };
    const losers = results.filter((r) => !r.strict).map((r) => r.term);
    if (winners.length > 0 && losers.length > 0 && df) {
      const span = (xs: number[]): { lo: number; hi: number } => ({
        lo: Math.min(...xs),
        hi: Math.max(...xs),
      });
      const w = winners.map(profileOf);
      const l = losers.map(profileOf);
      console.log(`     separability — winners ${winners.length} vs losers ${losers.length}:`);
      for (const s of ['df', 'len', 'pos'] as const) {
        const ws = span(w.map((p) => p[s]));
        const ls = span(l.map((p) => p[s]));
        const disjoint = ws.hi < ls.lo || ls.hi < ws.lo;
        console.log(
          `       ${s.padEnd(3)} winners [${ws.lo}..${ws.hi}]  losers [${ls.lo}..${ls.hi}]  → ` +
            (disjoint
              ? 'DISJOINT — a threshold COULD separate'
              : 'OVERLAP — no monotone threshold on this scalar separates'),
        );
      }
    }

    const same = (pair: string, picked: string[]): boolean => {
      const p = pair.split(' ');
      return picked.length === 2 && p.every((t) => picked.includes(t));
    };
    const complete = results.length >= fullPairs;
    if (winners.length > 0) {
      /* counted above */
    } else if (complete) batchesProvenUnreachable++;
    else batchesUndetermined++;
    console.log(
      `   turn ${batch.turn}  (${results.length} of ${fullPairs} pairs probed over ${terms.length} of ${allTerms.length} candidates` +
        ` — ${complete ? 'COMPLETE' : `PARTIAL ${((results.length / fullPairs) * 100).toFixed(0)}%`})`,
    );
    if (winners.length === 0) {
      // The distinction this line exists to make: an exhausted search that found
      // nothing is EVIDENCE; a truncated one that found nothing is NOT.
      console.log(
        complete
          ? `     STRICT winners: (NONE — every pair tried; PROVEN unreachable by 2-term selection)`
          : `     STRICT winners: (none found — but ${fullPairs - results.length} pairs NOT tried: UNDETERMINED, not unreachable)`,
      );
      if (lenientWinners.length > 0) {
        console.log(
          `     …but ${lenientWinners.length} pair(s) DO return an answer-bearing record (lenient): ` +
            `${lenientWinners.slice(0, 4).map((w) => `"${w}"`).join('  ')}${lenientWinners.length > 4 ? '  …' : ''}`,
        );
      }
    } else {
      const shown = winners
        .slice(0, 8)
        .map((w) => `"${w}"${same(w, picks.length) ? '[L]' : ''}${same(w, picks.banded) ? '[B]' : ''}`);
      console.log(
        `     IDENTITY winners (${winners.length} of ${results.length} pairs; substring-measure ${lenientWinners.length}): ` +
          `${shown.join('  ')}${winners.length > 8 ? '  …' : ''}`,
      );
      console.log(
        `     did a shipped selector pick one?  LENGTH ${winners.some((w) => same(w, picks.length)) ? 'YES' : 'no'}` +
          `   BANDED ${winners.some((w) => same(w, picks.banded)) ? 'YES' : 'no'}`,
      );
    }
  }

  // The denominator is the number of batches actually PROBED, not REPLAY.length
  // — under --oracle-turns those differ, and quoting the full-corpus denominator
  // over a partial sweep would understate the ratio while looking authoritative.
  const probedBatches =
    batchesWithAnyWinner + batchesProvenUnreachable + batchesUndetermined;
  console.log(
    `\n   CEILING (STRICT — the ONLY figure comparable to the shipped bar):` +
      ` ${batchesWithAnyWinner}/${probedBatches} batches have >=1 winning 2-TERM PAIR` +
      ` (proven unreachable ${batchesProvenUnreachable}, undetermined ${batchesUndetermined})` +
      `${probedBatches === REPLAY.length ? '' : `  [PARTIAL SWEEP — ${probedBatches} of ${REPLAY.length} batches probed]`}`,
  );
  console.log(
    `   SUBSTRING measure (CONTAMINATED — retrieves this investigation's own notes):` +
      ` ${batchesWithLenientWinner}/${probedBatches}. Never act on it; shown only so the gap is visible.`,
  );
  console.log(
    `   Read it as a FLOOR when any batch is undetermined: the reachable count can only go UP with more probing.`,
  );
  console.log(`   [L] = the LENGTH proxy picked it   [B] = BANDED picked it`);
  if (winnerProfile.length > 0) {
    const dfs = winnerProfile.map((w) => w.df).filter((d) => d >= 0);
    const lens = winnerProfile.map((w) => w.len);
    console.log(`\n   Winner profile (what a selector would have to prefer):`);
    console.log(`     df   min ${Math.min(...dfs)}  max ${Math.max(...dfs)}  (banded prefers the MINIMUM)`);
    console.log(`     len  min ${Math.min(...lens)}  max ${Math.max(...lens)}  (length prefers the MAXIMUM)`);
    for (const w of winnerProfile) {
      console.log(`     turn ${w.batch}: "${w.term}" df=${w.df} len=${w.len} candidatePos=${w.pos}`);
    }
  }
  console.log(
    `\n   ⚠ Only a batch marked COMPLETE above licenses the conclusion "choosing different terms cannot` +
      ` fix this" (i.e. reach/cap, not selection). A PARTIAL batch with no winner licenses NOTHING.`,
  );
}

/**
 * The paired arm comparison: for each batch, run the REAL corpus leg twice —
 * once with the query the LENGTH proxy would have chosen, once with the query
 * P-018's BANDED selection actually chooses — and ask which one retrieves a
 * record that answers the question.
 *
 * WHY THIS IS THE PRODUCTION PATH AND NOT AN APPROXIMATION: `recallCorpusContext`
 * derives its own query via `corpusQueryText(rawText)`. Feed it a rawText that is
 * ALREADY the two selected terms and both selections re-select the same two (two
 * candidates, k=2, neither an id) — so the query reaching the engine is exactly
 * that arm's, whichever selection happens to be wired on. Same engine, same
 * sources, same floors, same collapse. No fork of production behaviour, and no
 * flag to flip.
 *
 * Both arms run back-to-back against the SAME live corpus, which is what closes
 * the drift confounder: a difference between them cannot be "the corpus changed
 * since the baseline".
 */
async function compareArms(): Promise<void> {
  const [{ corpusQueryText }, { corpusTermDfLookup }, { recallCorpusContext }, { getOrgPg }] =
    await Promise.all([
      import('../corpus-recall'),
      import('../corpus-term-df'),
      import('../corpus-recall-io'),
      import('@papercusp/db-org'),
    ]);
  const { sql } = getOrgPg();
  const df = await corpusTermDfLookup(sql, 'papercusp-workspace');
  console.log('\n## ARM COMPARISON — does the arm\'s query retrieve an ANSWER-BEARING record?');
  if (!df) {
    console.log('   ⚠ no DF snapshot; both arms would be identical. Nothing to compare.');
    return;
  }

  const probe = async (query: string): Promise<{ hit: string; lines: number; top: string }> => {
    const res = await recallCorpusContext({
      queryText: query,
      workspaceId: 'papercusp-workspace',
      harnessSlugs: ['papercusp'],
    });
    const rendered = res.lines.map((l) => l.line).join('\n');
    const found = carriesAnswer(rendered);
    return {
      hit: found ? found.marker.slice(0, 8) : '',
      lines: res.lines.length,
      top: (res.lines[0]?.line ?? '').slice(0, 90),
    };
  };

  let lengthHits = 0;
  let bandedHits = 0;
  for (const batch of REPLAY) {
    const raw = deriveBatchQuery(batch.calls);
    const qLength = corpusQueryText(raw);
    const qBanded = corpusQueryText(raw, undefined, { df });
    const [a, b] = await Promise.all([probe(qLength), probe(qBanded)]);
    if (a.hit) lengthHits++;
    if (b.hit) bandedHits++;
    console.log(`\n   turn ${batch.turn}`);
    console.log(`     LENGTH "${qLength}" -> ${a.lines} lines  ${a.hit ? `✓ ANSWER via ${a.hit}` : '·'}`);
    console.log(`       top: ${a.top}`);
    console.log(`     BANDED "${qBanded}" -> ${b.lines} lines  ${b.hit ? `✓ ANSWER via ${b.hit}` : '·'}`);
    console.log(`       top: ${b.top}`);
  }
  console.log(
    `\n   ANSWER-BEARING batches — LENGTH ${lengthHits}/${REPLAY.length}   BANDED ${bandedHits}/${REPLAY.length}`,
  );
  if (bandedHits < lengthHits) {
    console.log(`   → P-018 BANDED selection RETRIEVES THE ANSWER LESS OFTEN than the proxy it replaced.`);
  }
}

/**
 * P-018's term selection, side by side with the length proxy it replaced, on
 * THIS replay's own queries.
 *
 * Why it belongs in the acceptance instrument rather than a scratch script: a
 * number that moves between two runs of this CLI has two very different causes —
 * the corpus leg ASKED something different, or it asked the same thing and
 * retrieval answered differently. Those call for opposite next steps, and
 * nothing else here can tell them apart. Reads the live DF snapshot, so it
 * reports what the endpoint would actually do right now.
 */
async function explainSelection(): Promise<void> {
  const [{ getOrgPg }, { corpusQueryText, corpusTerms }, { corpusTermDfLookup }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../corpus-recall'),
    import('../corpus-term-df'),
  ]);
  const { sql } = getOrgPg();
  const df = await corpusTermDfLookup(sql, 'papercusp-workspace');
  console.log('\n## Corpus-leg term selection — LENGTH (pre-P-018) vs BANDED (P-018)');
  if (!df) {
    console.log('   ⚠ NO DF SNAPSHOT — banded selection is INACTIVE and the leg is falling back');
    console.log('     to length. Any "P-018 is live" claim is false until this populates.');
    return;
  }
  for (const batch of REPLAY) {
    const raw = deriveBatchQuery(batch.calls);
    const terms = corpusTerms(raw);
    const byLength = corpusQueryText(raw);
    const banded = corpusQueryText(raw, undefined, { df });
    console.log(`\n   turn ${batch.turn}`);
    console.log(`     candidates: ${terms.slice(0, 12).map((t) => `${t}(${df(t)})`).join(' ')}`);
    console.log(`     LENGTH -> "${byLength}"`);
    console.log(`     BANDED -> "${banded}"   ${byLength === banded ? '(same)' : '*** CHANGED ***'}`);
  }
}

/**
 * THE SELECTION CEILING — of the batches where the known item is reachable at
 * all, how many could ANY line-selection policy admit?
 *
 * WI-9592 proposes changing how `selectCorpusLines` ORDERS its candidates
 * (reserved work-item slots, a kind-aware tiebreak, restatement dedup). This
 * measures the most such a change could ever buy, BEFORE one is designed —
 * D-066, the ordering P-018 got wrong twice.
 *
 * ⚠ THIS IS A DIFFERENT CEILING FROM D-067's ORACLE, and conflating them is the
 * live trap. D-067 measured the ceiling over QUERY selection (which 2-term pair
 * to ask) and put it at 4/7 with 3 batches unreachable by any pair. This one
 * holds the query fixed at what production actually derives and measures the
 * ceiling over LINE selection — the layer WI-9592 would change. A batch can be
 * unreachable in D-067's sense and rescuable here, or the reverse.
 *
 * WHY NO SEARCH IS NEEDED, AND WHY THAT MATTERS: the ceiling here is EXACT, not
 * estimated. `selectCorpusLines` filters (stages 1-5), then orders, then cuts at
 * six. An oracle selector free to choose any ordering can admit any candidate
 * that REACHED the ordering stage — there are six slots and it needs one. So
 * "best achievable" is not a search over 6-of-N subsets; it is exactly the set
 * of batches whose known item survived the filters. Every drop therefore sorts
 * into two classes that call for OPPOSITE next steps:
 *
 *   ORDER-BLOCKED  → it survived and lost on rank. Selection can fix this.
 *   FILTER-BLOCKED → it was excluded before ordering. Selection CANNOT fix it;
 *                    the filter (or the query) is the subject.
 *   NOT-RETRIEVED  → retrieval never returned it. Nothing after retrieval can
 *                    fix it. This is the re-scope-to-reach outcome.
 *
 * A "best 6 of N" search would have produced the same headline number while
 * hiding that partition — and the partition IS the finding.
 *
 * Both arms run per batch, back-to-back against the same live corpus, because
 * D-068 established that the arm changes WHICH lines compete. Arm integrity is
 * ASSERTED per call (`embedderAvailable`), never assumed: the background warmup
 * this file's own cold-start fix introduced can flip a BM25 arm to hybrid
 * mid-run, and a silently-flipped arm is an instrument reporting someone else's
 * experiment.
 */
async function runCeiling(args: Args): Promise<void> {
  const { recallCorpusContext, resetCorpusEmbedderWarmup, warmCorpusEmbedder } = await import(
    '../corpus-recall-io'
  );

  console.log('\n## SELECTION CEILING — could ANY line-selection policy admit the known item?');
  console.log(`   known item: ${KNOWN_ITEM}   slots: ${'6 (CORPUS_MAX_ITEMS)'}`);
  console.log('   verdicts: ADMITTED · ORDER-blocked (rescuable) · FILTER-blocked · NOT-RETRIEVED');

  const probe = async (
    queryText: string,
    arm: 'bm25' | 'hybrid',
    gradedMaxTerms?: number,
    anchorDfBudget?: number,
    rerank?: boolean,
  ): Promise<{
    verdict: CeilingVerdict;
    detail: string;
    candidates: number;
    admitted: number;
    rerank: string;
    refs: string[];
    ms: number;
  }> => {
    // Re-establish the arm immediately before the call: after a reset the leg
    // kicks off a BACKGROUND warmup, so an arm set once at the top of the run
    // does not survive seven batches.
    if (arm === 'bm25') resetCorpusEmbedderWarmup();
    else await warmCorpusEmbedder();

    const t0 = Date.now();
    const res = await recallCorpusContext({
      queryText,
      workspaceId: args.workspace,
      harnessSlugs: [args.harness],
      skipFlagCheck: true,
      ...(gradedMaxTerms === undefined ? {} : { gradedMaxTerms }),
      ...(anchorDfBudget === undefined ? {} : { anchorDfBudget }),
      ...(rerank === undefined ? {} : { rerank }),
    });
    const ms = Date.now() - t0;
    // The ADMITTED ORDER, not just the set. A rerank is a REORDER: it cannot
    // change how many lines are admitted, so a set- or count-based comparison
    // is structurally incapable of seeing it (D-066's confident null, exactly).
    const refs = res.lines.map((l) => l.handle.ref);

    // How many of the 6 slots the leg actually filled. This is the ONLY
    // stage-2 tell available without changing the leg: `corpus-recall-io.ts`
    // returns EARLY when stage 1 already fills `maxItems`, so a run that
    // admitted FEWER than 6 lines provably ran the coverage-graded stage and
    // still finished short. `admitted === 6` stays ambiguous (stage 1 filled,
    // or stage 2 topped it up) — read the implication in one direction only.
    const admitted = res.lines.length;
    const mk = (verdict: CeilingVerdict, detail: string) => ({
      verdict,
      detail,
      candidates: res.candidateCount,
      admitted,
      rerank: res.rerank,
      refs,
      ms,
    });

    const armHeld = arm === 'bm25' ? !res.embedderAvailable : res.embedderAvailable;
    if (!armHeld || res.outcome !== 'ok') {
      return mk(
        'void',
        `arm=${arm} embedderAvailable=${res.embedderAvailable} outcome=${res.outcome}`,
      );
    }

    if (res.lines.some((l) => l.handle.ref === KNOWN_ITEM)) return mk('admitted', '');

    const reasons = res.dropped.filter((d) => d.ref === KNOWN_ITEM).map((d) => d.reason);
    if (reasons.length === 0) return mk('not-retrieved', '');
    // Precedence, not first-match: a ref can appear twice (a collapsed duplicate
    // PLUS the winner's own drop). `duplicate-ref` alone never means excluded.
    if (reasons.some((r) => ORDER_DROPS.has(r))) return mk('order-blocked', reasons.join(','));
    if (reasons.some((r) => FILTER_DROPS.has(r))) return mk('filter-blocked', reasons.join(','));
    return mk('anomaly', reasons.join(','));
  };

  /**
   * DEPTH PROBE — where does the known item actually sit in fused order?
   *
   * `NOT-RETRIEVED` above means "absent from the candidate pool", and the pool is
   * `Math.max(maxItems * 4, 8)` = 24 rows by construction — an ENGINE OVER-FETCH
   * CAP, not the corpus's natural answer. So that verdict silently spans two
   * states needing OPPOSITE fixes: the record is genuinely unreachable for this
   * query, or it is reachable at rank 25+ and the pool simply stops short.
   * Reading the first as the second sends the next agent to rebuild retrieval;
   * reading the second as the first sends them to widen a pool that would not
   * help. Raising maxItems raises the pool with it, so the rank the known item
   * lands at IS the discriminator — and `absent` here, at 200 slots and an
   * effectively unbounded char budget, is a real absence rather than a cut.
   */
  const depth = async (
    queryText: string,
    arm: 'bm25' | 'hybrid',
    anchorDfBudget?: number,
  ): Promise<string> => {
    if (arm === 'bm25') resetCorpusEmbedderWarmup();
    else await warmCorpusEmbedder();
    const res = await recallCorpusContext({
      queryText,
      workspaceId: args.workspace,
      harnessSlugs: [args.harness],
      skipFlagCheck: true,
      ...(anchorDfBudget === undefined ? {} : { anchorDfBudget }),
      maxItems: 200,
      budgetChars: 5_000_000,
    });
    const armHeld = arm === 'bm25' ? !res.embedderAvailable : res.embedderAvailable;
    if (!armHeld || res.outcome !== 'ok') return 'void';
    const at = res.lines.findIndex((l) => l.handle.ref === KNOWN_ITEM);
    if (at >= 0) return `rank ${at + 1}/${res.lines.length} (pool ${res.candidateCount})`;
    const why = res.dropped.filter((d) => d.ref === KNOWN_ITEM).map((d) => d.reason);
    return why.length > 0
      ? `filtered [${why.join(',')}] (pool ${res.candidateCount})`
      : `ABSENT at depth (pool ${res.candidateCount})`;
  };

  const tally: Record<'bm25' | 'hybrid', Record<CeilingVerdict, number>> = {
    bm25: { admitted: 0, 'order-blocked': 0, 'filter-blocked': 0, 'not-retrieved': 0, anomaly: 0, void: 0 },
    hybrid: { admitted: 0, 'order-blocked': 0, 'filter-blocked': 0, 'not-retrieved': 0, anomaly: 0, void: 0 },
  };

  // PAIRED graded-stage arms (WI-9273). Both run inside ONE process, back to
  // back on the SAME batch, so the only thing that differs is the term cap
  // handed to the coverage-graded stage. The corpus is written continuously by
  // the fleet, so two separate runs minutes apart are NOT a paired comparison —
  // that gap is exactly where P-018's real-but-unrelated gain hid.
  //   CONTROL   gradedMaxTerms 2  = today's shipped behaviour, bit for bit
  //   TREATMENT gradedMaxTerms 24 = CORPUS_GRADED_QUERY_MAX_TERMS
  const gradedArms = args.gradedArms;
  const tallyGraded: Record<'control' | 'treatment', number> = { control: 0, treatment: 0 };

  // PAIRED anchor arms (WI-9273). Same one-process discipline as the graded
  // arms above; the ONLY difference between the arms is the graded stage's
  // anchor budget.
  //   CONTROL   anchorDfBudget 0    = the single rarest lexeme (pre-WI-9273)
  //   TREATMENT anchorDfBudget 4000 = the budgeted anchor set
  //
  // ⚠ BOTH ARMS PASS AN EXPLICIT BUDGET, and the treatment's must NOT be
  // `undefined`. ANCHOR_DF_BUDGET ships at 0 (the widening measured neutral —
  // see its doc comment), so an `undefined` treatment would silently become a
  // second control and this arm would report a guaranteed delta of 0 while
  // looking like it measured something.
  //
  // ⚠ READ REACH, NOT ADMISSIONS. The anchor is a RETRIEVAL lever, and D-069
  // measured the LINE-SELECTION ceiling at 2/7 — downstream of it. So a real
  // reach gain can leave the admitted count flat, and scoring this arm on
  // admissions alone would manufacture a false null against a cap that has
  // nothing to do with the anchor. The headline is therefore the verdict
  // MIGRATION: NOT-RETRIEVED (retrieval never saw it — only the anchor can fix
  // this) → ORDER-blocked/ADMITTED (retrieval found it; the rest is WI-9592's
  // layer).
  const anchorArms = args.anchorArms;
  const ANCHOR_ARM_BUDGET = 4000;
  const tallyAnchor = {
    control: { admitted: 0, reachable: 0, notRetrieved: 0, cand: 0 },
    treatment: { admitted: 0, reachable: 0, notRetrieved: 0, cand: 0 },
  };

  // PAIRED RERANK ARMS (P-008 / D-091). Same one-process discipline as the two
  // arm sets above; the ONLY difference is whether stage 1 reranks.
  //   CONTROL   rerank false = the shipped RRF order, bit for bit
  //   TREATMENT rerank true  = cross-encoder reorder of the same 24 candidates
  //
  // ⚠⚠ READ ORDER, NEVER COUNTS. A rerank is a REORDER of a pool that is cut
  // downstream — it CANNOT change how many lines are admitted. So `admitted`,
  // line counts and candidate counts are all guaranteed-flat by construction,
  // and scoring this arm on any of them manufactures a confident null. That is
  // not hypothetical: it is exactly how P-018 was accepted on a metric that
  // could not see what it changed (D-066). The headline is the KNOWN-ITEM
  // verdict migration, and the diagnostic is whether the admitted REF ORDER
  // moved at all.
  //
  // ⚠ HYBRID IS THE HEADLINE, BM25 IS NOT. Under BM25-only there is a single
  // agreement tier by construction, so an upstream reorder decides the tiebreak
  // trivially and OVERSTATES the effect — D-091 §1 records that trap on the
  // permutation bench, where the BM25 arm's 100% is a control artifact rather
  // than a result. Hybrid is also what production runs.
  const rerankArms = args.rerankArms;
  const tallyRerank = {
    control: { admitted: 0, reachable: 0, ms: 0 },
    treatment: { admitted: 0, reachable: 0, ms: 0 },
  };
  // INSTRUMENT INTEGRITY (see CorpusRecallResult.rerank). The stage is fail-soft:
  // with no engine it returns the RRF order, which is byte-identical to the
  // control — so a treatment arm that silently lost its engine reports a clean
  // 0/7 delta that reads as "reranking does not help". Both counters must be
  // non-zero for the run to mean anything, and the summary VOIDS it otherwise.
  let treatmentActuallyReranked = 0;
  let orderMovedOn = 0;

  for (const batch of REPLAY) {
    const queryText = deriveBatchQuery(batch.calls);
    if (rerankArms) {
      const ctl = await probe(queryText, 'hybrid', undefined, undefined, false);
      const tr = await probe(queryText, 'hybrid', undefined, undefined, true);
      if (tr.rerank === 'reranked') treatmentActuallyReranked++;
      const moved = ctl.refs.join('|') !== tr.refs.join('|');
      if (moved) orderMovedOn++;
      for (const [side, r] of [['control', ctl], ['treatment', tr]] as const) {
        const t = tallyRerank[side];
        if (r.verdict === 'admitted') t.admitted++;
        if (r.verdict === 'admitted' || r.verdict === 'order-blocked') t.reachable++;
        t.ms += r.ms;
      }
      const mark =
        ctl.verdict !== 'admitted' && tr.verdict === 'admitted'
          ? '✅ RESCUED'
          : ctl.verdict === 'admitted' && tr.verdict !== 'admitted'
            ? '🔻 LOST'
            : moved
              ? '~ reordered'
              : '   flat';
      console.log(
        `\n   turn ${batch.turn} ${mark}` +
          `\n     CONTROL   (RRF order)     ${ctl.verdict.toUpperCase().padEnd(14)} (${ctl.candidates} cand, ${ctl.admitted}/6, ${ctl.ms}ms)` +
          `\n     TREATMENT (reranked)      ${tr.verdict.toUpperCase().padEnd(14)} (${tr.candidates} cand, ${tr.admitted}/6, ${tr.ms}ms) [stage=${tr.rerank}]`,
      );
      // The order IS the treatment. Print it when it moved, so a reviewer can
      // see WHAT the reranker preferred rather than trusting a verdict tally.
      if (moved) {
        console.log(`       control   order: ${ctl.refs.join(' , ') || '(none)'}`);
        console.log(`       treatment order: ${tr.refs.join(' , ') || '(none)'}`);
      }
      continue;
    }
    if (anchorArms) {
      // BM25 arm only, for the same reason the graded arms use it: it is
      // deterministic, so a verdict difference is attributable to the anchor
      // rather than to embedder warm-state.
      const ctl = await probe(queryText, 'bm25', undefined, 0);
      const tr = await probe(queryText, 'bm25', undefined, ANCHOR_ARM_BUDGET);
      for (const [side, r] of [['control', ctl], ['treatment', tr]] as const) {
        const t = tallyAnchor[side];
        if (r.verdict === 'admitted') t.admitted++;
        if (r.verdict === 'admitted' || r.verdict === 'order-blocked') t.reachable++;
        if (r.verdict === 'not-retrieved') t.notRetrieved++;
        t.cand += r.candidates;
      }
      const gained =
        ctl.verdict === 'not-retrieved' && tr.verdict !== 'not-retrieved'
          ? '✅ REACHED'
          : tr.verdict === 'not-retrieved' && ctl.verdict !== 'not-retrieved'
            ? '🔻 LOST'
            : ctl.verdict === tr.verdict
              ? '  '
              : '~ ';
      console.log(
        `\n   turn ${batch.turn} ${gained}` +
          `\n     CONTROL   (anchor = rarest lexeme) ${ctl.verdict.toUpperCase().padEnd(14)} (${ctl.candidates} cand, ${ctl.admitted}/6)` +
          `\n     TREATMENT (anchor = df budget)     ${tr.verdict.toUpperCase().padEnd(14)} (${tr.candidates} cand, ${tr.admitted}/6)`,
      );
      // NOT-RETRIEVED at 6 slots is CENSORED by the 24-row over-fetch cap, so
      // it cannot tell "the anchor never matched it" from "the anchor matched
      // it and it ranked below the cut". Those need OPPOSITE fixes, and only
      // the second is evidence the anchor moved the barrier — so re-probe both
      // arms at depth whenever either says NOT-RETRIEVED.
      if (ctl.verdict === 'not-retrieved' || tr.verdict === 'not-retrieved') {
        console.log(`       depth CONTROL   : ${await depth(queryText, 'bm25', 0)}`);
        console.log(`       depth TREATMENT : ${await depth(queryText, 'bm25', ANCHOR_ARM_BUDGET)}`);
      }
      continue;
    }
    if (gradedArms) {
      // BM25 arm only: it is deterministic, so a verdict difference is
      // attributable to the term cap rather than to embedder warm-state.
      const ctl = await probe(queryText, 'bm25', 2);
      const tr = await probe(queryText, 'bm25', 24);
      if (ctl.verdict === 'admitted') tallyGraded.control++;
      if (tr.verdict === 'admitted') tallyGraded.treatment++;
      const mark = ctl.verdict === tr.verdict ? '  ' : tr.verdict === 'admitted' ? '✅' : '🔻';
      console.log(
        `\n   turn ${batch.turn} ${mark}` +
          `\n     CONTROL   (graded 2 terms)  ${ctl.verdict.toUpperCase().padEnd(14)} (${ctl.candidates} cand, ${ctl.admitted}/6)` +
          `\n     TREATMENT (graded 24 terms) ${tr.verdict.toUpperCase().padEnd(14)} (${tr.candidates} cand, ${tr.admitted}/6)`,
      );
      continue;
    }
    // Sequential, not Promise.all: the arms share one process-wide embedder
    // warm flag, so running them concurrently would race each other's arm.
    const bm25 = await probe(queryText, 'bm25');
    const hybrid = await probe(queryText, 'hybrid');
    tally.bm25[bm25.verdict]++;
    tally.hybrid[hybrid.verdict]++;
    const fmt = (r: {
      verdict: CeilingVerdict;
      detail: string;
      candidates: number;
      admitted: number;
    }): string =>
      `${r.verdict.toUpperCase().padEnd(14)} (${r.candidates} cand, ${r.admitted}/6 slots${
        r.admitted < 6 ? ' → STAGE-2 RAN' : ''
      })${r.detail ? ` [${r.detail}]` : ''}`;
    console.log(`\n   turn ${batch.turn}`);
    console.log(`     BM25   ${fmt(bm25)}`);
    console.log(`     HYBRID ${fmt(hybrid)}`);
    // Only meaningful where the 6-slot run could not see it at all.
    if (bm25.verdict === 'not-retrieved' || hybrid.verdict === 'not-retrieved') {
      console.log(`       depth BM25   : ${await depth(queryText, 'bm25')}`);
      console.log(`       depth HYBRID : ${await depth(queryText, 'hybrid')}`);
    }
  }

  const n = REPLAY.length;
  if (rerankArms) {
    const c = tallyRerank.control;
    const t = tallyRerank.treatment;
    console.log('\n   ── STAGE-1 RERANK, PAIRED arms (HYBRID) ──');

    // INTEGRITY FIRST, RESULT SECOND. A null from an instrument that never
    // engaged is not a finding, and it is indistinguishable from a real null by
    // looking at the numbers — so refuse to print a verdict rather than let one
    // be quoted. This is the same rule the arm-integrity check upstream applies
    // to `embedderAvailable`.
    if (treatmentActuallyReranked === 0) {
      console.log(
        `   ⛔ VOID — the treatment arm NEVER reranked (0/${n} batches reported stage='reranked').\n` +
          `      No engine resolved, so both arms ran the identical RRF path and any delta below is\n` +
          `      structurally 0. This is NOT evidence about P-008. Fix the engine and re-run:\n` +
          `      check FLAGS.LOCAL_RERANK and the embed sidecar's /rerank endpoint.`,
      );
      return;
    }
    if (orderMovedOn === 0) {
      console.log(
        `   ⛔ VOID — the stage ran on ${treatmentActuallyReranked}/${n} batches but the admitted order\n` +
          `      NEVER moved on any of them. A cross-encoder reproducing RRF order exactly on every\n` +
          `      batch is far more likely a scorer returning a constant than a genuine agreement.\n` +
          `      Treat as an engine fault, not as "rerank has no effect".`,
      );
      return;
    }

    const dAdm = t.admitted - c.admitted;
    const dReach = t.reachable - c.reachable;
    console.log(
      `   instrument: stage ran on ${treatmentActuallyReranked}/${n} batches; admitted ORDER moved on ${orderMovedOn}/${n}.`,
    );
    console.log(
      `   CONTROL   (RRF order):  known-item admitted ${c.admitted}/${n}  reachable ${c.reachable}/${n}  ${Math.round(c.ms / n)}ms/batch`,
    );
    console.log(
      `   TREATMENT (reranked) :  known-item admitted ${t.admitted}/${n}  reachable ${t.reachable}/${n}  ${Math.round(t.ms / n)}ms/batch`,
    );
    console.log(
      `   ADMITTED delta ${dAdm > 0 ? `+${dAdm}` : dAdm}` +
        (dAdm > 0
          ? '  — the reranker RESCUED a known item the RRF order buried. This is the case FOR P-008.'
          : dAdm === 0
            ? '  — NO relevance effect on the acceptance set, despite the order moving. The reorder is real\n' +
              '     but it is not moving the ANSWER, so the latency below buys nothing measurable here.'
            : '  — WORSE. The reranker DEMOTED a known item the RRF order admitted. Do not ship it.'),
    );
    console.log(
      `   REACH delta ${dReach > 0 ? `+${dReach}` : dReach} — expected 0: a reorder cannot change what RETRIEVAL returned.` +
        ' A non-zero value here means the arms differed in something other than the rerank; treat the run as suspect.',
    );
    const costPerBatch = Math.round((t.ms - c.ms) / n);
    console.log(
      `   ⏱ COST ${costPerBatch > 0 ? '+' : ''}${costPerBatch}ms/batch on a leg whose whole bound is ${'2000ms'}.` +
        ' This rides the pre-turn prompt build on EVERY turn, so it is charged to every agent whether or not\n' +
        '     the reorder helped that turn. Weigh the admitted delta against it — a positive delta is not\n' +
        '     automatically worth paying for, and D-079 found the FILTERS, not the ranking cut, do the selecting.',
    );
    console.log(
      '   ⚠ 7 batches is a SMALL acceptance set: it can establish "this rescues a real buried answer",\n' +
        '     but a 0/7 delta bounds the effect loosely rather than proving absence.',
    );
    return;
  }
  if (anchorArms) {
    const c = tallyAnchor.control;
    const t = tallyAnchor.treatment;
    const dReach = t.reachable - c.reachable;
    const dNr = t.notRetrieved - c.notRetrieved;
    console.log('\n   ── graded-stage ANCHOR, PAIRED arms (BM25, IDENTITY) ──');
    console.log(
      `   CONTROL   (anchor = single rarest lexeme, = pre-WI-9273):` +
        ` reachable ${c.reachable}/${n}  not-retrieved ${c.notRetrieved}/${n}  admitted ${c.admitted}/${n}  ${c.cand} cand`,
    );
    console.log(
      `   TREATMENT (anchor = df budget)                          :` +
        ` reachable ${t.reachable}/${n}  not-retrieved ${t.notRetrieved}/${n}  admitted ${t.admitted}/${n}  ${t.cand} cand`,
    );
    console.log(
      `   REACH delta ${dReach > 0 ? `+${dReach}` : dReach}` +
        ` (not-retrieved ${dNr > 0 ? `+${dNr}` : dNr})` +
        (dReach > 0
          ? '  — the anchor WAS the barrier for at least one batch.'
          : dReach === 0
            ? '  — NO reach effect. The anchor is not the barrier for these batches; do not ship it on the theory alone.'
            : '  — WORSE. The budget costs reach; do not ship it.'),
    );
    console.log(
      `   admitted delta ${t.admitted - c.admitted} — EXPECTED to lag reach: D-069 caps line selection at 2/7,` +
        ` downstream of the anchor. Do NOT read a flat admitted count as "the anchor did nothing".`,
    );
    console.log(
      '   ⚠ The bar is the CONTROL measured in THIS process, not a figure carried from an earlier run.',
    );
    return;
  }
  if (gradedArms) {
    const d = tallyGraded.treatment - tallyGraded.control;
    console.log('\n   ── graded-stage term cap, PAIRED arms (BM25, IDENTITY) ──');
    console.log(`   CONTROL   (graded  2 terms, = shipped today): ${tallyGraded.control}/${REPLAY.length}`);
    console.log(`   TREATMENT (graded 24 terms)                 : ${tallyGraded.treatment}/${REPLAY.length}`);
    console.log(
      `   delta ${d > 0 ? `+${d}` : d}` +
        (d > 0
          ? '  — the cap was the barrier for at least one batch.'
          : d === 0
            ? '  — NO effect. Widening the graded stage is not the lever; do not ship it on a story.'
            : '  — WORSE. Widening the graded stage costs retrieval; do not ship it.'),
    );
    console.log(
      '   ⚠ The bar is the CONTROL measured in THIS process, not a figure carried from an earlier run.',
    );
    return;
  }

  console.log('\n   ── ceiling ──');
  for (const arm of ['bm25', 'hybrid'] as const) {
    const t = tally[arm];
    const reachable = t.admitted + t['order-blocked'];
    console.log(
      `   ${arm.toUpperCase().padEnd(6)} actual ${t.admitted}/${n}   CEILING ${reachable}/${n}` +
        `   (order-blocked ${t['order-blocked']}, filter-blocked ${t['filter-blocked']},` +
        ` not-retrieved ${t['not-retrieved']}, anomaly ${t.anomaly}, void ${t.void})`,
    );
    if (t.void > 0) {
      console.log(`     ⚠ ${t.void} batch(es) VOID — the arm did not hold. The ${arm} row is NOT a result.`);
    }
    if (t['order-blocked'] === 0 && t.void === 0) {
      console.log(
        `     → NO batch is order-blocked: a line-selection change buys ${arm.toUpperCase()} NOTHING.` +
          ` The constraint is upstream (filter/retrieval), not selection.`,
      );
    }
  }
}

/**
 * THE ARITY / LEXICAL-REACH CEILING — can the lexical leg reach the known item
 * at ANY number of terms, or is D-067's exhaustive 2-term miss final?
 *
 * D-067 enumerated all 845 PAIRS and proved turns 65, 66, 68 unreachable at k=2.
 * D-069 then found 65 and 68 sitting at rank 66/81 in a deep pool — so the record
 * IS in the index for them, and "no pair wins" cannot mean "not retrievable".
 * The open question is whether some OTHER arity reaches them, and enumerating
 * k>=3 is combinatorially out of reach (turn 68 alone has ~29 candidate terms:
 * 406 pairs, but 3654 triples).
 *
 * IT DOES NOT NEED ENUMERATING. The leg ANDs its terms, so for MATCHING:
 *
 *     matched({A,B,...}) is a SUBSET of matched({A})
 *
 * Therefore if NO SINGLE TERM matches the record, no conjunction containing that
 * term can either — and since every conjunction is built from these candidates,
 * no query at ANY arity can. n probes settle a question that would otherwise
 * take C(n,k) summed over k.
 *
 * ⚠⚠ THIS IS THE EXACT INVERSE OF A TRAP THIS FILE ALREADY FELL INTO, and the
 * distinction is the whole reason the argument is sound. An earlier version of
 * the oracle probed single terms and reported "6 of 7 unreachable"; that was
 * WITHDRAWN because turn 69 retrieves WI-6512 on `sessions explain` while
 * `sessions` and `explain` each miss ALONE. Both facts are true at once:
 *
 *   ADMISSION (does it reach the top 6?) — single terms are NOT a ceiling.
 *     Adding a term SHRINKS the match set, which LIFTS a buried record's rank.
 *     That is precisely how turn 69's pair wins where its singles lose.
 *   MATCHING (is it in the pool at all?) — single terms ARE an exact ceiling,
 *     by the subset relation above. Narrowing can never ADD a document.
 *
 * So this probe asks only the matching question, at depth (maxItems 200), and
 * says nothing about admission. Reporting a rank here as if it were an
 * admission result would re-create the withdrawn finding with better manners.
 *
 * BM25 arm only: the subset argument is a property of the LEXICAL conjunction.
 * A warm embedder would fold in vector hits that obey no such relation and the
 * ceiling would no longer be a ceiling.
 */
async function runArity(args: Args): Promise<void> {
  const { recallCorpusContext, resetCorpusEmbedderWarmup } = await import('../corpus-recall-io');
  const { corpusTerms } = await import('../corpus-recall');

  // The 2s default bound protects a LIVE TURN; it is not a property of the
  // corpus. At maxItems 200 (pool 800) it expires routinely, and a timed-out
  // probe that is merely skipped silently converts "we did not look" into
  // "nothing is there" — see the VOID accounting below, which caught exactly
  // that. `<= 0` disables the bound (corpusRecallTimeoutMs).
  const priorTimeout = process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS;
  process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = '0';

  console.log('\n## LEXICAL REACH CEILING — can ANY arity reach the known item?');
  console.log('   Single-term probes bound EVERY arity for MATCHING (the leg ANDs: narrowing');
  console.log('   never adds a document). This says NOTHING about admission/rank — see header.');
  console.log('   Leg timeout DISABLED for these probes (depth 200 routinely exceeds the 2s turn bound).');

  const wanted = args.arityTurns.length > 0 ? new Set(args.arityTurns) : null;

  try {
  for (const batch of REPLAY) {
    if (wanted && !wanted.has(batch.turn)) continue;
    const terms = corpusTerms(deriveBatchQuery(batch.calls));
    const probed = args.arityMaxTerms > 0 ? terms.slice(0, args.arityMaxTerms) : terms;

    const reaching: { term: string; rank: number; of: number; admitted: boolean }[] = [];
    const voided: string[] = [];
    for (const term of probed) {
      resetCorpusEmbedderWarmup();
      const res = await recallCorpusContext({
        queryText: term,
        workspaceId: args.workspace,
        harnessSlugs: [args.harness],
        skipFlagCheck: true,
        maxItems: 200,
        budgetChars: 5_000_000,
      });
      // A hybrid result here would break the subset argument outright.
      if (res.embedderAvailable || res.outcome !== 'ok') {
        voided.push(`${term}(${res.embedderAvailable ? 'hybrid' : res.outcome})`);
        continue;
      }
      // ⚠ MATCHED means IN THE POOL — `lines` alone is an ADMISSION test, and
      // using it here silently re-asks the very question this probe is not
      // entitled to answer. A record can match a broad single term and still
      // rank past the 200-line cut; it is then recorded as `cap-exhausted` in
      // `dropped`, NOT absent. Reading that as "no match" produces a false
      // ceiling — caught by contradiction against the --ceiling depth probe,
      // which had turn 68's item at rank 66 under the 2-term production query
      // while this probe claimed no single term matched it at all. Both cannot
      // hold: matched({A,B}) is a SUBSET of matched({A}).
      const at = res.lines.findIndex((l) => l.handle.ref === KNOWN_ITEM);
      if (at >= 0) {
        reaching.push({ term, rank: at + 1, of: res.lines.length, admitted: true });
      } else if (res.dropped.some((d) => d.ref === KNOWN_ITEM)) {
        reaching.push({ term, rank: Number.POSITIVE_INFINITY, of: res.candidateCount, admitted: false });
      }
    }

    // ⚠ COVERAGE MUST COUNT VOIDS. Comparing probed.length to terms.length only
    // asks whether we ITERATED every term, not whether every probe RETURNED —
    // and a skipped timeout is indistinguishable from a genuine miss in the
    // `reaching` list. An earlier version got this wrong and printed a hard
    // "no query at any arity can reach it" for a batch where 4 of 7 probes had
    // timed out, two of which are terms independently PROVEN to reach the item.
    // A ceiling is only a ceiling at complete, non-void coverage.
    const complete = probed.length === terms.length && voided.length === 0;
    console.log(`\n   turn ${batch.turn} — ${probed.length}/${terms.length} terms probed,` +
      ` ${voided.length} VOID [${complete ? 'COMPLETE' : 'INCOMPLETE'}]`);
    if (voided.length > 0) console.log(`       VOID: ${voided.join(' ')}`);
    if (reaching.length === 0) {
      console.log(
        complete
          ? `     ✗ NO single term matches ${KNOWN_ITEM} ⇒ NO QUERY AT ANY ARITY CAN.` +
            `   The lexical leg cannot reach it — this is a real ceiling, not a ranking problem.`
          : `     · no reaching term AMONG THOSE THAT RETURNED — coverage INCOMPLETE, so this is` +
            ` NOT a ceiling claim and must not be reported as one. Re-run the VOID terms.`,
      );
    } else {
      const best = reaching.reduce((a, b) => (a.rank <= b.rank ? a : b));
      const bestRank = Number.isFinite(best.rank) ? `rank ${best.rank}/${best.of}` : 'pool-only (past the cut)';
      console.log(`     ✓ MATCHED by ${reaching.length}/${probed.length} term(s).   best: "${best.term}" ${bestRank}`);
      console.log(
        `       matching terms: ${reaching
          .map((r) => `${r.term}(${Number.isFinite(r.rank) ? r.rank : 'pool'})`)
          .join(' ')}`,
      );
      console.log(`       ⇒ matching is NOT the barrier here; admission/rank is.`);
    }
  }
  } finally {
    if (priorTimeout === undefined) delete process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS;
    else process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = priorTimeout;
  }
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const modeRaw = get('--mode') ?? 'both';
  if (modeRaw !== 'both' && modeRaw !== 'independent' && modeRaw !== 'sequential' && modeRaw !== 'none') {
    throw new Error(`--mode must be both|independent|sequential|none, got ${modeRaw}`);
  }
  return {
    base: (get('--base') ?? 'http://127.0.0.1:3170').replace(/\/$/, ''),
    passes: Number(get('--passes') ?? 3),
    harness: get('--harness') ?? 'papercusp',
    workspace: get('--workspace') ?? 'papercusp-workspace',
    verbose: argv.includes('--verbose'),
    mode: modeRaw,
    explainSelection: argv.includes('--explain-selection'),
    arms: argv.includes('--arms'),
    oracle: argv.includes('--oracle'),
    // 0 (the default) = NO cap: probe every pair, so the result is a real
    // ceiling rather than a floor. A positive cap trades completeness for time
    // and the run labels every batch it truncated as UNDETERMINED.
    oracleMaxTerms: Number(get('--oracle-max-terms') ?? 0),
    // Restrict the pair sweep to specific turns. The full sweep is ~C(n,2) per
    // batch across all 7; when the question is about a NAMED batch (t64/t67 are
    // the only ones term selection can address at all), probing the other five
    // costs a lot of DB work to re-derive what is already recorded.
    oracleTurns: (get('--oracle-turns') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    ceiling: argv.includes('--ceiling'),
    arity: argv.includes('--arity'),
    // Paired control/treatment over the coverage-graded stage's term cap.
    // Implies --ceiling's machinery; run it as: --mode none --ceiling --graded-arms
    gradedArms: argv.includes('--graded-arms'),
    anchorArms: argv.includes('--anchor-arms'),
    // P-008: --mode none --ceiling --rerank-arms
    rerankArms: argv.includes('--rerank-arms'),
    arityTurns: (get('--arity-turns') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    // 0 = every candidate term. A cap makes coverage PARTIAL and the run then
    // refuses to state a ceiling — same discipline as --oracle.
    arityMaxTerms: Number(get('--arity-max-terms') ?? 0),
  };
}

/** One POST to the live endpoint. Returns the injected block ('' = nothing pushed). */
async function post(args: Args, owner: string, batch: ReplayBatch): Promise<string> {
  const res = await fetch(`${args.base}/api/agent-mcp/mid-turn-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner,
      toolCalls: batch.calls,
      harness: args.harness,
      workspace: args.workspace,
      cwd: process.cwd(),
    }),
  });
  if (!res.ok) throw new Error(`endpoint ${res.status} ${res.statusText} — is :3170 up?`);
  const payload = (await res.json()) as { ok?: boolean; text?: string };
  return typeof payload.text === 'string' ? payload.text : '';
}

interface BatchResult {
  turn: number;
  /** STRICT: the literal work-item id — comparable to the 1-of-7 baseline. */
  strict: boolean;
  /** ANSWER: any enumerated answer-bearing record — matches the acceptance claim. */
  answer: boolean;
  /** Which answer-bearing record arrived, when one did. */
  via: string;
  chars: number;
  /** Pointer lines that came back INSTEAD, when no answer record did. */
  instead: string[];
}

function score(turn: number, block: string): BatchResult {
  const found = carriesAnswer(block);
  return {
    turn,
    strict: block.includes(KNOWN_ITEM),
    answer: found !== undefined,
    via: found ? found.marker.slice(0, 8) : '',
    chars: block.length,
    instead: found ? [] : pointerLines(block).slice(0, 3),
  };
}

const nonce = (): string => Math.random().toString(36).slice(2, 8);

/** Extract the bullet lines a block carries, for the "what came back instead" column. */
function pointerLines(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('• '))
    .map((l) => l.replace(/^[-•]\s*/, ''));
}

async function runIndependent(args: Args, pass: number): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const batch of REPLAY) {
    // Fresh owner PER BATCH — an empty epoch ledger, so nothing this replay
    // already surfaced can suppress this batch's own retrieval.
    out.push(score(batch.turn, await post(args, `p018-live-i${pass}-t${batch.turn}-${nonce()}`, batch)));
  }
  return out;
}

async function runSequential(args: Args, pass: number): Promise<BatchResult[]> {
  const owner = `p018-live-s${pass}-${nonce()}`;
  const out: BatchResult[] = [];
  for (const batch of REPLAY) out.push(score(batch.turn, await post(args, owner, batch)));
  return out;
}

interface ModeSummary {
  strict: number[];
  answer: number[];
}

function summarise(label: string, ceiling: number, passes: BatchResult[][], verbose: boolean): ModeSummary {
  console.log(`\n## ${label}`);
  console.log(`   ceiling ${ceiling} of ${REPLAY.length}`);
  console.log(`   S = STRICT (literal ${KNOWN_ITEM}) · A = ANSWER (any answer-bearing record)\n`);
  const cols = passes.map((_, i) => `p${i + 1}`).join('   ');
  console.log(`   turn  ${cols}   chars(p1)  via`);
  for (let b = 0; b < REPLAY.length; b++) {
    const cells = passes
      .map((p) => `${p[b]!.strict ? 'S' : '·'}${p[b]!.answer ? 'A' : '·'}`.padEnd(5))
      .join('');
    console.log(
      `   ${String(REPLAY[b]!.turn).padEnd(6)}${cells}${String(passes[0]![b]!.chars).padEnd(11)}${passes[0]![b]!.via}`,
    );
  }
  const strict = passes.map((p) => p.filter((r) => r.strict).length);
  const answer = passes.map((p) => p.filter((r) => r.answer).length);
  console.log(`\n   STRICT per pass: ${strict.map((h) => `${h}/${REPLAY.length}`).join('  ')}`);
  console.log(`   ANSWER per pass: ${answer.map((h) => `${h}/${REPLAY.length}`).join('  ')}`);

  if (verbose) {
    console.log('\n   what came back INSTEAD (pass 1, batches carrying NO answer record):');
    for (const r of passes[0]!) {
      if (r.answer || r.instead.length === 0) continue;
      console.log(`     turn ${r.turn}:`);
      for (const line of r.instead) console.log(`       ${line.slice(0, 150)}`);
    }
  }
  return { strict, answer };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`# WI-6512 known-item replay — P-018 ACCEPTANCE (relevance)`);
  console.log(`  endpoint ${args.base}/api/agent-mcp/mid-turn-context`);
  console.log(`  harness=${args.harness} workspace=${args.workspace} passes=${args.passes}`);
  console.log(`  looking for: ${KNOWN_ITEM} in the injected block`);

  // The derived queries are part of the record — a measurement that moved
  // because the QUERY changed is a different finding from one that moved
  // because retrieval improved, and only this makes them distinguishable.
  console.log('\n## Derived queries (what each batch actually asks)');
  for (const batch of REPLAY) {
    const derived = deriveBatchQuery(batch.calls);
    const { cosine, lexical } = splitLegQueries(derived);
    console.log(`   turn ${batch.turn}`);
    console.log(`     lexical: ${lexical.slice(0, 160)}`);
    if (cosine !== lexical) console.log(`     cosine : ${cosine.slice(0, 160)}`);
  }

  if (args.explainSelection) await explainSelection();
  if (args.arms) await compareArms();
  if (args.oracle) await runOracle(args);
  if (args.ceiling) await runCeiling(args);
  if (args.arity) await runArity(args);

  let independent: ModeSummary | undefined;
  let sequential: ModeSummary | undefined;

  if (args.mode === 'both' || args.mode === 'independent') {
    const passes: BatchResult[][] = [];
    for (let p = 1; p <= args.passes; p++) passes.push(await runIndependent(args, p));
    independent = summarise(
      'INDEPENDENT — fresh session per batch (THE ACCEPTANCE NUMBER)',
      REPLAY.length,
      passes,
      args.verbose,
    );
  }

  if (args.mode === 'both' || args.mode === 'sequential') {
    const passes: BatchResult[][] = [];
    for (let p = 1; p <= args.passes; p++) passes.push(await runSequential(args, p));
    sequential = summarise(
      'SEQUENTIAL — one session, seven batches in order (dedup-capped)',
      1,
      passes,
      args.verbose,
    );
  }

  const range = (xs: number[]): string => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? `${lo}` : `${lo}-${hi}`;
  };

  console.log('\n## Verdict');
  if (independent) {
    const s = independent.strict;
    const a = independent.answer;
    console.log(`   STRICT (literal ${KNOWN_ITEM}): ${range(s)} of ${REPLAY.length}.`);
    console.log(`     Baseline 2026-08-03, same criterion, was 1 of 7 (batch ONE only).`);
    const hi = Math.max(...s);
    if (hi > 1) console.log(`     → MOVED UP. Batches beyond the first now reach the work-item itself.`);
    else if (hi === 1) console.log(`     → UNCHANGED at the baseline.`);
    else console.log(`     → REGRESSED. Even batch one no longer names the work-item.`);
    console.log(`   ANSWER (any of ${ANSWER_RECORDS.length} answer-bearing records): ${range(a)} of ${REPLAY.length}.`);
    console.log(`     ⚠ NOT comparable to the 1-of-7 baseline — that number was never scored this way.`);
    console.log(`     This is the criterion that matches the claim "saves the other twelve calls".`);
  }
  if (sequential) {
    const bad = sequential.answer.filter((h) => h > 1);
    console.log(
      `   DEDUP (sequential ANSWER): ${sequential.answer.map((h) => `${h}/7`).join(' ')} — ` +
        (bad.length === 0 ? 'capped at 1 as designed ✓' : '⚠ >1 means the epoch dedup re-paid a record'),
    );
  }
}

main()
  .then(() => {
    // EXIT EXPLICITLY. `getOrgPg()` hands back a shared pool this CLI must not
    // close (other callers in-process own it too), and its open handles keep the
    // event loop alive indefinitely — so without this the process COMPLETES ALL
    // ITS WORK AND THEN HANGS. That failure is expensive precisely because it is
    // invisible: `ps` shows a live process, so a caller waits on a job that
    // already finished, and any buffering stage in the pipeline (`sed`, a block-
    // buffered `grep`) never sees EOF and never flushes — the run reports an
    // EMPTY log, which reads as "still working" rather than "done, output stuck".
    // Measured 2026-08-03: one such run sat idle 24 min at 40s CPU, holding pool
    // connections, while two agents' worth of runs queued behind the same pool
    // (a `connect-phase-deadline` on an unrelated call was the first symptom).
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
