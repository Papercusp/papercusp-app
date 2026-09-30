/**
 * check-plane-adoption.mjs — the THIRD agent-state-plane probe: is an agent-facing
 * surface this plan shipped actually being USED at runtime?
 *
 * Plan: unified-agent-state-plane-2026-07-27. Filed as EI-19300249267306129 /
 * EI-19300248249253151 by the 2026-08-02 audit (WI-6763), built under WI-6768.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY A THIRD PROBE, GIVEN TWO ALREADY PASS
 *
 * The plane ships two good reachability gates and neither can answer this question:
 *
 *   · check-plane-producers.mjs   — is the field WRITTEN?          (a DB fact)
 *   · check-declared-consumed.mjs — is the field READ IN SOURCE?   (a static fact)
 *
 * Both are blind to whether an AGENT ever calls the thing. Measured at audit time,
 * `tool_invocations.goal_ref` simultaneously reported:
 *
 *   ✓ producing 74.23%      (the census — the dispatcher writes it on every call)
 *   ✓ consumed 12R          (the sweep — timeline.ts really does select the column)
 *
 * ...while `sessions:timeline { goalRef }` — the filter that was the ENTIRE
 * justification for building that read path — had been passed exactly ZERO times by
 * anyone, ever. Two green ticks over a feature nobody uses. Same shape for
 * `state:subscribe` (registered at agent-tools/index.ts:1287, 0 calls all-time),
 * `coord:couple` (7 calls, none after the day it shipped) and `conventions:governing`
 * (2 calls, 1 caller).
 *
 * ⚠ THE PRECEDENT THIS EXISTS TO STOP REPEATING. cell-registry.ts's own header names
 * the failure: "`predicate_watches` is shipped, correct in principle, and has NEVER
 * been adopted (0 rows, all tenants) ... A registry nobody registers into is surface
 * #29 and strictly worse than today." `state:subscribe` RIDES predicate_watches and
 * has now reproduced it exactly — which is the proof that shipping an adoption GATE
 * (P-005) does not by itself produce adoption, and that nothing was watching.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * THE FLOORS ARE THE PLAN'S OWN, NOT INVENTED HERE
 *
 * D-016: "Every tier-2 and tier-3 behaviour ships with an adoption floor and a review
 * date. Below floor at review = the feature is failing; it either moves up a tier or
 * is cut. It does NOT sit half-adopted." D-047 then recorded the table for 16
 * behaviours. That table has lived in the plan as PROSE since 2026-07-27 and no code
 * has ever read it — so the review D-016 promised could not happen. This file is that
 * table's executable half, for the rows whose floor is a runtime CALL count.
 *
 * Floors that are SHARE-based rather than call-based (D-047 rows 5, 6, 8 — the
 * explicit-`'none'` share, the non-default `expects` share, convention adherence)
 * deliberately do NOT live here: they belong to the ratchet's metric set
 * (agent-plane-measurement.ts), which already owns share-shaped signals and their
 * interpretability rules. Splitting them across two probes would be the second
 * derivation axis 5 forbids.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠ WHY IT REPORTS AND (MOSTLY) DOES NOT FAIL — READ BEFORE ADDING TEETH
 *
 * Every surface below is BELOW FLOOR today. A probe that failed on that would red-pin
 * `main` for the whole fleet the moment it landed, for a condition no single commit
 * caused and no single commit can fix — the exact defect EI-18850142725126359 filed
 * against the first candidate-independent live-DB gate trap. So:
 *
 *   · below floor BEFORE its review date  → reported, exit 0. The clock is running.
 *   · below floor ON/AFTER its review date → FAILS. That is D-016's "below floor at
 *     review = the feature is failing", and the remedy is a DECISION (raise the tier,
 *     or cut the feature) — not a code change that makes the number go up.
 *   · a row carrying `ruling` → reported, never fails. A ruling is a permanent
 *     statement that the zero is intended; unlike a work-item it cannot close.
 *
 * The review dates therefore matter, and are recorded per row with their provenance:
 * a date D-047 stated explicitly, or — where D-047 said only "· P-015", meaning "at
 * the measurement" without naming a day — this file's own dated choice, marked
 * `reviewSource: 'derived'` so nobody mistakes it for a ruling of the plan's.
 */
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

/**
 * The agent-facing surfaces whose adoption floor is a runtime CALL count.
 *
 * `filterArg` rows measure something stricter than "was the tool called": they measure
 * whether the specific ARGUMENT that justified the feature was ever passed. That
 * distinction is the whole reason this file exists — `sessions:timeline` is a
 * well-used tool in principle, and its goalRef filter is the part P-024 staked the
 * P-009 writer on.
 */
export const PLANE_ADOPTION_SURFACES = [
  {
    id: 'state:read',
    tool: 'state:read',
    item: 'P-004',
    windowDays: 7,
    floorCalls: 5,
    floorCallers: 2,
    reviewBy: '2026-10-25',
    reviewSource: 'D-047 row 1 horizon',
    why: 'The PULL half of the cell contract. If agents do not read cells at the moment of acting, the plane has not replaced transcription — it has only added a surface.',
  },
  {
    id: 'state:subscribe',
    tool: 'state:subscribe',
    item: 'P-004',
    windowDays: 7,
    floorCalls: 1,
    floorCallers: 1,
    reviewBy: '2026-10-25',
    reviewSource: 'D-047 row 1 horizon',
    why: 'The PUSH half. It rides `predicate_watches`, whose 0-row non-adoption cell-registry.ts cites as the failure this whole plane exists to avoid. A floor of ONE call in seven days is the weakest possible bar and it is not being met.',
  },
  {
    id: 'sessions:timeline{goalRef}',
    tool: 'sessions:timeline',
    filterArg: 'goalRef',
    item: 'P-024',
    windowDays: 7,
    floorCalls: 1,
    floorCallers: 1,
    reviewBy: '2026-10-25',
    reviewSource: 'D-047 row 11 (read-path floor, explicit)',
    why: "P-024's own FLOOR, verbatim: \"if the `goalRef` filter is never passed, P-009's STAMP is cut, not this read path.\" D-047 row 11 confirms the cut lands on the WRITER. So a breach here is not a request to improve the read — it is a standing instruction to stop writing ~38k stamped rows/day. That decision is the owner's; this probe only makes it visible, on time, instead of never.",
  },
  {
    id: 'coord:couple',
    tool: 'coord:couple',
    item: 'P-031',
    windowDays: 7,
    floorCalls: 2,
    floorCallers: 2,
    reviewBy: '2026-11-01',
    reviewSource: 'derived — D-047 predates P-031 (owner-added 2026-07-27) and set no date for it',
    why: "P-031's acceptance was behavioural: \"a fleet member reading its own prompt can discover the capability without being told by a human.\" Adoption is the only honest test of that sentence, and the tool is named in no prompt source (EI-19300253346703673).",
  },
  {
    id: 'conventions:governing',
    tool: 'conventions:governing',
    item: 'P-018',
    windowDays: 7,
    floorCalls: 3,
    floorCallers: 2,
    reviewBy: '2026-11-01',
    reviewSource: "derived — D-047 row 8 says \"· P-015\" without naming a day",
    why: 'D-047 row 8: "≥3 conventions with >50% adherence, else CUT". Adherence is the ratchet\'s to measure; whether anyone ever ASKS what governs them is this probe\'s, and it is the cheaper precondition — a convention nobody queries cannot be adhered to on purpose.',
  },
];

/** Verdicts. `no-data` is NEITHER pass nor fail — the same discipline as the census. */
export const ADOPTION_VERDICTS = ['adopted', 'below-floor', 'unused', 'no-data'];

/**
 * Judge one surface. PURE ({calls, distinctCallers, floors} -> verdict) so every
 * branch is testable with no database.
 *
 * `unused` is split out from `below-floor` deliberately: 0 is not merely a small
 * number. A surface with SOME traffic is a calibration question (is the floor right?);
 * a surface with none has never been reached by anybody, which is a different defect
 * with a different remedy — and it is the one that keeps recurring here.
 */
export function judgeAdoption({ calls, distinctCallers, floorCalls, floorCallers, windowHadTraffic }) {
  if (windowHadTraffic === false) return 'no-data';
  const c = Number.isFinite(calls) ? calls : 0;
  const k = Number.isFinite(distinctCallers) ? distinctCallers : 0;
  if (c <= 0) return 'unused';
  if (c < floorCalls || k < floorCallers) return 'below-floor';
  return 'adopted';
}

/** Has this row's review date arrived? PURE, so the transition is testable. */
export function isPastReview(reviewBy, now) {
  const d = Date.parse(`${reviewBy}T00:00:00Z`);
  if (!Number.isFinite(d)) return false;
  return now.getTime() >= d;
}

/**
 * Roll judged rows into an exit decision. See the header: a below-floor row fails ONLY
 * once its review date has arrived, and a `ruling` row never fails.
 */
export function rollupAdoption(rows, now) {
  const failing = rows.filter(
    (r) => (r.verdict === 'below-floor' || r.verdict === 'unused') && !r.ruling && isPastReview(r.reviewBy, now),
  );
  const pending = rows.filter(
    (r) => (r.verdict === 'below-floor' || r.verdict === 'unused') && !r.ruling && !isPastReview(r.reviewBy, now),
  );
  return {
    adopted: rows.filter((r) => r.verdict === 'adopted').length,
    unused: rows.filter((r) => r.verdict === 'unused').length,
    belowFloor: rows.filter((r) => r.verdict === 'below-floor').length,
    noData: rows.filter((r) => r.verdict === 'no-data').length,
    ruled: rows.filter((r) => r.ruling).length,
    failing,
    pending,
  };
}

const MARK = { adopted: '✓', 'below-floor': '⚠', unused: '✗', 'no-data': '?' };

export function formatReport(rows, roll, now) {
  const out = ['\nADOPTION PROBE — agent-state plane (D-016 / D-047 floors)\n'];
  for (const r of rows) {
    const bar = `${r.calls}/${r.floorCalls} calls · ${r.distinctCallers}/${r.floorCallers} callers`;
    out.push(`  ${MARK[r.verdict]} ${r.id.padEnd(30)} ${String(bar).padEnd(30)} ${r.windowDays}d`);
    if (r.verdict === 'adopted') continue;
    const due = isPastReview(r.reviewBy, now) ? 'REVIEW DUE' : `review ${r.reviewBy}`;
    out.push(`      floor:  ${r.item} — ${due} (${r.reviewSource})`);
    out.push(`      why:    ${r.why}`);
    if (r.ruling) out.push(`      RULED:  ${r.ruling} — reported, never fails`);
  }
  out.push(
    `\n  ${roll.adopted} adopted · ${roll.belowFloor} below-floor · ${roll.unused} UNUSED · ${roll.noData} no-data · ${roll.ruled} ruled\n`,
  );
  if (roll.failing.length > 0) {
    out.push(
      '✗ REVIEW DATE REACHED and still below floor. D-016: "below floor at review = the feature is failing;\n' +
        '  it either moves up a tier or is cut. It does NOT sit half-adopted." The remedy is a DECISION, not a\n' +
        '  patch that nudges the number — record it on the plan, then set `ruling` here or remove the row:\n' +
        roll.failing.map((r) => `    · ${r.id} (${r.item}) — ${r.why}`).join('\n'),
    );
  } else if (roll.pending.length > 0) {
    out.push(
      `⚠ ${roll.pending.length} surface(s) below floor, none past review yet — reported, not failing. The clock is running:\n` +
        roll.pending.map((r) => `    · ${r.id.padEnd(28)} review ${r.reviewBy}`).join('\n'),
    );
  } else {
    out.push('✓ every measured surface is at or above its declared adoption floor.');
  }
  return out.join('\n');
}

async function main() {
  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  const now = new Date();
  const rows = [];
  try {
    for (const s of PLANE_ADOPTION_SURFACES) {
      // Identifiers are literals in this file, never input. The window + tool name
      // are parameterised.
      const filter = s.filterArg ? `AND args_json ? '${s.filterArg.replace(/'/g, "''")}'` : '';
      const [r] = await sql.unsafe(
        `SELECT count(*)::int AS calls,
                count(DISTINCT coord_owner_id)::int AS callers
           FROM harness_shared.tool_invocations
          WHERE tool_name = $1
            AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
            AND invoked_at > now() - ($2 || ' days')::interval
            ${filter}`,
        [s.tool, String(s.windowDays)],
      );
      // ⚠ NON-VACUITY. An empty tool_invocations window (a fresh DB, a wiped table)
      // would otherwise render every surface as `unused` — a confident wrong answer
      // that looks exactly like real non-adoption. Establish that the table had ANY
      // traffic in the window before believing a zero means anything.
      const [t] = await sql.unsafe(
        `SELECT count(*)::int AS total FROM harness_shared.tool_invocations
          WHERE harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
            AND invoked_at > now() - ($1 || ' days')::interval`,
        [String(s.windowDays)],
      );
      rows.push({
        ...s,
        calls: r?.calls ?? 0,
        distinctCallers: r?.callers ?? 0,
        verdict: judgeAdoption({
          calls: r?.calls ?? 0,
          distinctCallers: r?.callers ?? 0,
          floorCalls: s.floorCalls,
          floorCallers: s.floorCallers,
          windowHadTraffic: (t?.total ?? 0) > 0,
        }),
      });
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const roll = rollupAdoption(rows, now);
  console.log(formatReport(rows, roll, now));
  if (roll.failing.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('\n✗ adoption probe could not run:', e?.message ?? e);
    // A probe that cannot reach PG reports UNKNOWN, never a green tick — but it also
    // must not red the fleet gate on a transient connection blip, which is why the
    // green-checkpoint leg treats a non-zero exit as a reported failure rather than a
    // halt. Same posture as the producer census.
    process.exitCode = 1;
  });
}
