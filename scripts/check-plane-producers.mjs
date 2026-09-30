#!/usr/bin/env node
/**
 * check-plane-producers.mjs — THE PRODUCER CENSUS
 * (agent-state-plane-verification-2026-07-27 P-001).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The unified agent-state plane shipped 33 items with green unit tests and then
 * produced EIGHT defects that unit tests could not see. Every one was the same
 * shape: a field, column or channel that is DECLARED and VALIDATED at one end and
 * REACHED BY NOTHING at the other.
 *
 *   · WI-6444 — `unknownHoist` declared on 6 cells, enforced at registration,
 *     emitted by zero readers. Six declaration sites, one validator, no consumer.
 *   · WI-6465 — the mirror image: `kind='assumption'`, `depends_on` and `claim`
 *     have consumers (P-011's detector, P-009's stamp, P-024's read) and ZERO
 *     producers. 0 rows of 2,180, all time.
 *
 * A unit test cannot catch either, because both halves are individually correct.
 * The defect lives in the JOIN between them, and the join only exists in
 * production data. So this gate asks the one question the type system cannot:
 *
 *     For every field this plane added — is anything actually WRITING it?
 *
 * ── ⚠ THE VACUOUS PASS THIS GATE IS BUILT TO AVOID ──────────────────────────
 *
 * The obvious implementation reports `populated` per field and fails on zero.
 * That gate is WRONG in the most dangerous direction, because two completely
 * different situations both produce `populated = 0`:
 *
 *   (a) the table holds 170,000 rows and none carry the field  → NO PRODUCER.
 *       A real defect, and exactly WI-6465.
 *   (b) the table is EMPTY (fresh database, pruned window, new install)
 *                                                              → NO DATA.
 *       Says nothing at all about the producer.
 *
 * Reporting (b) as a failure trains everyone to ignore the gate on a fresh box;
 * reporting it as a PASS is the vacuous pass — a green tick that means "we looked
 * at nothing". Both are worse than useless. So `judgeProducerField` returns THREE
 * verdicts and `no-data` is neither pass nor fail: it is `unknown`, reported
 * separately and loudly, exactly as `cell-contract.ts` reserves an enumerated
 * unknown rather than collapsing it into a boolean.
 *
 * This mirrors what P-015's own measurement module already learned the hard way:
 * a metric with no input must report `interpretable: false`, never a clean zero.
 * The whole reason WI-6465 was FINDABLE is that P-015 refused to round its zero
 * up to a pass. This gate inherits that rule rather than re-deriving it.
 *
 * ── HOW TO ADD A FIELD ──────────────────────────────────────────────────────
 *
 * Append to {@link PLANE_PRODUCER_FIELDS}. Every entry MUST carry `why` (what
 * breaks if nothing writes it) and `producer` (the act that is supposed to write
 * it) — a field whose producer nobody can name is a field nobody owns, which is
 * the condition that produced WI-6465.
 */

import { resolveScriptPgUrl } from './lib/pg-url.mjs';

/**
 * THE CENSUS. One row per field this plane added.
 *
 * `sinceDays` is per-field on purpose. A stamp written on every dispatch is
 * expected within hours, so a 7-day window that finds nothing is damning. A fact
 * modality written a few times a week needs a longer window before silence means
 * anything — and using one global window would either make the slow fields
 * flap or let the fast ones stay dead for a week unnoticed.
 */
export const PLANE_PRODUCER_FIELDS = [
  {
    id: 'tool_invocations.intent_event_id',
    table: 'harness_shared.tool_invocations',
    column: 'intent_event_id',
    tsColumn: 'invoked_at',
    sinceDays: 1,
    producer: "P-009 stamp writer ← coord:declare-intent / coord:orient { intent }",
    why: "P-010's divergence detector buckets calls by this id. With no stamp there are no buckets, and the detector reports a clean zero for the same reason a perfectly-disciplined fleet would.",
  },
  {
    id: 'tool_invocations.goal_ref',
    table: 'harness_shared.tool_invocations',
    column: 'goal_ref',
    tsColumn: 'invoked_at',
    sinceDays: 1,
    producer: 'P-009 stamp writer ← work_items:claim / release (noteGoalClaimed)',
    why: 'P-024\'s "what did this agent do while holding goal X" read filters on it. Unstamped calls are invisible to every postmortem.',
  },
  {
    id: 'tool_invocations.assumption_set_id',
    table: 'harness_shared.tool_invocations',
    column: 'assumption_set_id',
    tsColumn: 'invoked_at',
    sinceDays: 7,
    producer: 'P-009 stamp writer ← facts:assert { kind:"assumption" } (noteAssumptionAsserted)',
    why: 'ACCEPTED ZERO BY RULING (D-102 F3 + D-103), not a queued gap. Structurally always-NULL while no assumption facts exist — and D-102 F3 measured `kind` and REFUSED to force it, because agents honestly assert verified conclusions, so forcing would yield "conclusion" and leave this exactly as null at fleet-wide friction cost. P-024 therefore cannot resolve an assumption set behind any historical call, and that is the ruled outcome rather than pending work.',
    knownUnbuilt: 'D-103 (ruled)',
  },
  {
    id: 'agent_facts.kind',
    table: 'harness_shared.agent_facts',
    column: 'kind',
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { kind } — OPT-IN, no default',
    why: 'The modality split (conclusion | assumption | convention). Without it every fact is an undifferentiated blob and P-008\'s whole taxonomy is decorative.',
  },
  {
    id: "agent_facts.kind='assumption'",
    table: 'harness_shared.agent_facts',
    column: 'kind',
    predicate: "kind = 'assumption'",
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { kind:"assumption" }',
    why: "ACCEPTED ZERO BY RULING (D-102 F3 + D-103). The consumer this row used to name — P-011's conflicting-assumption detector — was RETIRED by WI-6545/D-103, so the old rationale is void. What still reads the modality is the P-009 assumption watermark (`isAssumptionFact` in agent-facts/store.ts), which simply never moves. D-102 F3 refused to force `kind`, so 0 here is the ruled outcome, not pending work.",
    knownUnbuilt: 'D-103 (ruled)',
  },
  {
    id: 'agent_facts.depends_on',
    table: 'harness_shared.agent_facts',
    column: 'depends_on',
    predicate: "depends_on IS NOT NULL AND depends_on::text <> '[]'",
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { dependsOn } → captureFactDependencies',
    why: "WI-6548. D-007 auto-invalidation is what makes an assumption more than a weak-badged conclusion. With no dependsOn nothing can ever go stale on its own terms, and `acted-on-stale-or-wrong-value` is permanently uninterpretable. ⚠ This is the ONE row here that is still GENUINELY OPEN work rather than a ruled zero — D-103 measured the fix: capture must be inline-and-required in a workflow the agent already performs (as `work_items:complete { assumptions }` is), never a voluntary extra field.",
    knownUnbuilt: 'WI-6548',
  },
  {
    id: 'agent_facts.claim',
    table: 'harness_shared.agent_facts',
    column: 'claim',
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { claim }',
    // ⚠ INVERTED BY WI-6545 / D-103, and left here deliberately rather than deleted.
    // This row used to be the mirror-image defect in the header: a field with a
    // consumer and no producer. Retiring P-011's detector removed the CONSUMER, so
    // `claim` is now the opposite — a field 3 rows of which exist and NOTHING reads.
    // It passes this lint (3 > 0) and that pass is uninformative; the lint asks only
    // about producers. Kept listed so the next audit sees the inversion stated rather
    // than re-deriving it, and so nobody re-attaches a consumer without re-measuring
    // adoption first: 3 of 2,217 rows, one identity, one author.
    why: "D-103. Was 'the typed assertion P-011's detector compares' — that detector is retired, so this field now has a producer and NO consumer. Not a producer gap.",
    knownUnbuilt: 'D-103 (ruled)',
  },
  {
    id: 'agent_facts.enforcement',
    table: 'harness_shared.agent_facts',
    column: 'enforcement',
    tsColumn: 'created_at',
    sinceDays: 30,
    producer: 'facts:assert { kind:"convention", enforcement }',
    why: "P-017/D-016: a convention with no declared tier is prose exhortation in a costume. Measured 5 of 30 conventions at audit time.",
  },
];

/** Verdicts. `no-data` is deliberately NEITHER pass nor fail — see the header. */
export const PRODUCER_VERDICTS = ['producing', 'no-producer', 'no-data'];

/**
 * Judge one census row. Pure ({ populated, total } -> verdict) so the
 * distinction this gate exists to make is unit-testable with no database.
 *
 * ⚠ `total === 0` MUST NOT be a pass and MUST NOT be a failure. It is the "we
 * looked at nothing" case, and conflating it with either direction is precisely
 * the vacuous pass documented in the header.
 */
export function judgeProducerField({ populated, total }) {
  if (!Number.isFinite(total) || total <= 0) return 'no-data';
  if (!Number.isFinite(populated) || populated <= 0) return 'no-producer';
  return 'producing';
}

/** Fill ratio, or null when there is no denominator to divide by. */
export function fillRate({ populated, total }) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return populated / total;
}

/**
 * Roll a judged census up into an exit decision.
 *
 * A field with a `knownUnbuilt` ref is reported but does NOT fail the gate: the
 * defect is already filed and owned, and re-failing the build for a known-open
 * bug turns the gate into noise the fleet routes around (which is how the
 * no-bespoke-state-read gate nearly died — WI-6464). It flips to a hard failure
 * the moment its ref closes; that transition is P-003's job.
 */
/**
 * Is this `knownUnbuilt` ref a WORK-ITEM (which can close) or a RULING (which cannot)?
 *
 * `D-103 (ruled)` and `WI-6548` are both legitimate explanations for a dead field,
 * but only one of them expires. A decision is a permanent statement that the zero is
 * the intended outcome; a work-item is a promise that someone will fix it, and that
 * promise goes stale the moment the item closes.
 */
export function isWorkItemRef(ref) {
  return /^(?:WI|EI|F)-\d+$/.test(String(ref ?? '').trim());
}

/**
 * ⚠ WHICH `knownUnbuilt` POINTERS HAVE GONE STALE (EI-18850142725126359, sibling finding).
 *
 * The two plane lints DISAGREED about what a closed gap means. P-003's ratchet
 * WITHDRAWS the exemption the moment the item closes — that is its whole point. This
 * census never checked at all: it carried four `knownUnbuilt: 'WI-6465'` entries for an
 * item that had been closed for 90 minutes and printed, for each of them, "KNOWN:
 * WI-6465 — reported, not failing the build" in a run that exited 0.
 *
 * A stale pointer that does not fail is worse than one that does: nothing will ever
 * tell you. Two of those four described as their consumer a detector that was being
 * RETIRED in the same change, and the census would have gone on citing it indefinitely.
 *
 * ⚠ WHY THIS REPORTS AND DOES NOT FAIL. Making it fail would add a SECOND
 * candidate-independent, live-DB fleet-gate trap — the exact defect
 * EI-18850142725126359 filed against the first one. One such transition is enough, it
 * already exists, and it belongs to P-003 (see rollupCensus's doc). This census owes
 * the fleet VISIBILITY, which is the thing that was actually missing; it does not owe
 * it a second way to red main from a work-item state change.
 *
 * PURE — the live status read is injected, so the stale/missing/ruling cases are
 * testable without a database.
 */
export function auditKnownUnbuiltRefs(rows, statusByRef, isTerminal) {
  const out = [];
  for (const ref of [...new Set(rows.filter((r) => r.knownUnbuilt).map((r) => r.knownUnbuilt))]) {
    const fields = rows.filter((r) => r.knownUnbuilt === ref).map((r) => r.id);
    if (!isWorkItemRef(ref)) {
      out.push({ ref, fields, verdict: 'ruling' });
      continue;
    }
    const status = statusByRef.get(ref);
    if (status === undefined) out.push({ ref, fields, verdict: 'missing' });
    else if (isTerminal(status)) out.push({ ref, fields, verdict: 'closed', status });
    else out.push({ ref, fields, verdict: 'open', status });
  }
  return out;
}

/** Mirrors check-plane-ratchet.ts — a legacy row can still carry the pre-fold token. */
export const TERMINAL_STATUSES = new Set(['done', 'dropped', 'resolved', 'closed', 'passed', 'deprecated']);

export function rollupCensus(rows) {
  const noProducer = rows.filter((r) => r.verdict === 'no-producer');
  const producing = rows.filter((r) => r.verdict === 'producing');
  return {
    producing: producing.length,
    noData: rows.filter((r) => r.verdict === 'no-data').length,
    knownUnbuilt: noProducer.filter((r) => r.knownUnbuilt).length,
    /**
     * PRODUCING, but carrying a `knownUnbuilt` note anyway — i.e. the field is
     * WRITTEN and the note records something else about it (for `agent_facts.claim`:
     * D-103 retired its only consumer, so it has a producer and NO consumer).
     *
     * Counted separately because the census answers exactly one question — "is
     * anything writing this field" — and a bare `✓` was being read as "this field is
     * healthy". A write-only field passes that question truthfully and is still dead
     * weight, which is the MIRROR IMAGE of the defect this gate was built for. The
     * note existed on the row the whole time; it was simply never printed for a
     * producing row (WI-6768).
     */
    producingWithNote: producing.filter((r) => r.knownUnbuilt).length,
    // Only an UNEXPLAINED dead producer fails the build.
    failures: noProducer.filter((r) => !r.knownUnbuilt),
  };
}

async function main() {
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });

  const rows = [];
  const statusByRef = new Map();
  try {
    for (const f of PLANE_PRODUCER_FIELDS) {
      const predicate = f.predicate ?? `${f.column} IS NOT NULL`;
      // Identifiers cannot be parameterised; they are all literals in this file,
      // never user input. The WINDOW is parameterised.
      const [r] = await sql.unsafe(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ${predicate})::int AS populated
           FROM ${f.table}
          WHERE ${f.tsColumn} > now() - ($1 || ' days')::interval`,
        [String(f.sinceDays)],
      );
      const populated = r?.populated ?? 0;
      const total = r?.total ?? 0;
      rows.push({ ...f, populated, total, rate: fillRate({ populated, total }), verdict: judgeProducerField({ populated, total }) });
    }

    // Sibling finding: verify the `knownUnbuilt` pointers still point at something
    // OPEN. See auditKnownUnbuiltRefs — this is a visibility fix, not new teeth.
    const refs = [...new Set(rows.map((r) => r.knownUnbuilt).filter(isWorkItemRef))];
    if (refs.length > 0) {
      // ⚠ Multi-tenant table: scope on workspace_id, and the columns are
      // feature_id/status (the work_items TOOL renames both in its result shape).
      const items = await sql`
        SELECT feature_id, status
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${refs})
      `;
      for (const i of items) statusByRef.set(i.feature_id, i.status);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const roll = rollupCensus(rows);
  const pct = (r) => (r.rate === null ? '   —  ' : `${(r.rate * 100).toFixed(2).padStart(6)}%`);
  const mark = { producing: '✓', 'no-producer': '✗', 'no-data': '?' };

  console.log('\nPRODUCER CENSUS — agent-state plane (P-001)\n');
  for (const r of rows) {
    // A producing row that still carries a note is NOT a plain ✓ — see
    // `producingWithNote` in rollupCensus for why a bare tick was actively misleading.
    const glyph = r.verdict === 'producing' && r.knownUnbuilt ? '✓*' : mark[r.verdict];
    console.log(`  ${glyph.padEnd(2)}${r.id.padEnd(38)} ${String(r.populated).padStart(8)}/${String(r.total).padEnd(9)} ${pct(r)}  ${r.sinceDays}d`);
    if (r.verdict === 'no-producer') {
      console.log(`      producer: ${r.producer}`);
      console.log(`      breaks:   ${r.why}`);
      if (r.knownUnbuilt) console.log(`      KNOWN:    ${r.knownUnbuilt} — reported, not failing the build`);
    }
    // The row is WRITTEN, so it passes this gate's question — but the note says
    // something the tick does not, and printing it only for dead rows is how a
    // write-only field read as healthy for as long as it did.
    if (r.verdict === 'producing' && r.knownUnbuilt) {
      console.log(`      NOTE:     ${r.knownUnbuilt} — has a producer, but see below; ✓ means "written", not "healthy"`);
      console.log(`      status:   ${r.why}`);
    }
    if (r.verdict === 'no-data') {
      console.log(`      no rows in the ${r.sinceDays}d window — this says NOTHING about the producer, and is deliberately not a pass.`);
    }
  }
  console.log(
    `\n  ${roll.producing} producing · ${roll.failures.length} DEAD · ${roll.knownUnbuilt} known-unbuilt · ${roll.noData} no-data` +
      (roll.producingWithNote
        ? `\n  ⚠ ${roll.producingWithNote} of the producing rows carry a note (✓*) — written, but not therefore healthy.`
        : '') +
      '\n',
  );

  // Stale-pointer disclosure. Printed BEFORE both terminal branches below, because
  // the success branch returns and would otherwise swallow it — the failure mode
  // being fixed is precisely a stale pointer riding along inside a green run.
  const refAudit = auditKnownUnbuiltRefs(rows, statusByRef, (s) => TERMINAL_STATUSES.has(s));
  for (const a of refAudit) {
    if (a.verdict === 'closed') {
      console.log(
        `⚠ STALE EXPLANATION: ${a.ref} is ${a.status.toUpperCase()}, but ${a.fields.length} field${a.fields.length === 1 ? '' : 's'} still cite${a.fields.length === 1 ? 's' : ''} it as the open gap:`,
      );
      for (const f of a.fields) console.log(`      ${f}`);
      console.log(
        '  Either the producer landed (retire the row) or it did not (reopen the item, or\n' +
          '  repoint `knownUnbuilt` at the item that now owns the gap). Do NOT leave it: the\n' +
          "  census will keep printing this ref as a live promise nobody is holding.\n",
      );
    }
    if (a.verdict === 'missing') {
      console.log(
        `⚠ UNVERIFIABLE EXPLANATION: ${a.ref} matches no work-item in this workspace, so the\n` +
          `  exemption it grants ${a.fields.join(', ')} cannot be checked. Fix the ref or use a ruling id.\n`,
      );
    }
  }

  if (roll.failures.length > 0) {
    console.error('✗ producer census: a field this plane added is written by NOTHING, and no open item explains it.\n');
    for (const f of roll.failures) console.error(`    ${f.id} — expected producer: ${f.producer}`);
    console.error(
      '\n  This is the WI-6444/WI-6465 defect class: a declared field with no live writer.\n' +
        '  Either wire the producer, or file the gap and add its ref as `knownUnbuilt` so the\n' +
        '  census reports it instead of failing — but do NOT delete the row to green the gate.\n',
    );
    process.exitCode = 1;
    return;
  }
  console.log('✓ every field this plane added has a live producer (or a filed, owned gap).\n');
}

// Only run when invoked directly — the predicates above are imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('producer census failed to run:', err?.message ?? err);
    process.exitCode = 1;
  });
}
