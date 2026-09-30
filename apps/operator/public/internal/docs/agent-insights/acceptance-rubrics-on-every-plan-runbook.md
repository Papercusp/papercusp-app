# Plan completion — code-truth audit, acceptance grading, and ship verdict
URL: /internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook

Runbook for shipping a plan through code-truth audit, acceptance-drain lifecycle, rubric vetting, independent grading, the implementer's verdict, and the scoped force path.

## The completion contract

A plan is not ready to ship merely because its implementation tasks are terminal. The completion path has two independent evidence families, in this order:

1. the implementer audits every plan item against the actual source tree;
2. the implementer authors and vets a post-implementation acceptance rubric;
3. a non-implementer grades the finished work;
4. the rubric author reads that grading and records an explicit `accept` or `reject` verdict;
5. `plans:set-plan-status { status:'shipped' }` re-verifies the evidence and closes the plan.

The order is intentional. The audit finds code-truth gaps while implementation is still warm; the rubric describes as-built reality; independent grading supplies the honesty leg a self-audit cannot.

## Acceptance-drain lifecycle: terminal implementation is a handoff, not shipment

When the last plan item becomes terminal, the drain transition moves a `ready` or `active` plan to `awaiting-acceptance`. That state means implementation is complete but the acceptance ceremony and shipment are still owed. It is deliberately not a successful ship state.

The acceptance-drain sweep makes this lifecycle claimable work. For each in-scope plan in `awaiting-acceptance`, it reads the canonical acceptance gate and maintains one keyed work item whose `payload.acceptanceDrainPlan` is `<workspace>/<harness>/<plan>`. The key is tenant-qualified and idempotent: rerunning the sweep refreshes the same row instead of creating duplicates. Filing is bounded per run, while existing rows are always re-evaluated so a changed blocker or a newly ready gate cannot become a permanent dedupe sink.

The filing body quotes the gate's own refusal message. The first refusal is actionable, but it is a short-circuit: clearing it can reveal another refusal, so re-read `plans:get { slug, shipReadiness:true }` after every repair. The code-truth family (unfinished items, audit, citations, and requirements) is evaluated before the rubric family; authoring a rubric cannot clear an earlier code-truth refusal.

### Gate observations and work-item states

* **blocked** — the canonical gate returned a refusal code. Record that code and quoted repair text in the keyed work item, then perform the requested repair.
* **ready** — the gate is satisfied. This is acceptance-ready, not shipped. Keep the same accountability row open until the plan reaches a terminal shipment or explicit not-to-ship disposition.
* **unknown** — the gate could not be evaluated or returned no refusal code (for example a transient read failure). Do not fabricate a blocker code or claim the plan is blocked. Retry the scoped gate read and preserve the unknown observation.
* **pending** — a newly entered plan has a carry row before its first gate observation. The next sweep replaces that placeholder in place.

Readiness never closes the sole acceptance-drain item. Only a verified terminal plan disposition closes it: `shipped` resolves the row; `superseded`, archive, or another explicit not-to-ship terminal disposition drops it with evidence. A refusal does not automatically file a row at ship time; the scheduled/explicit acceptance-drain sweep is the filing mechanism.

## 1. Finish or deliberately drop every item

`todo`, `blocked`, and `needs-human` items refuse shipping. Finish the work, or record an intentional departure:

```text
plans:set-status {
  slug:'<plan-slug>',
  item:'P-012',
  status:'dropped',
  note:'<why the plan changed>'
}
```

A dropped item is terminal and does not need code evidence. Departing from the plan is allowed; doing it silently is not.

## 2. Run the per-item code-truth audit

Use `plans:audit` after implementation. Read the code itself—not a work item, doc, or memory of writing it—and submit only items that are new, reopened, text-changed, or whose evidence changed:

```text
plans:audit {
  slug:'<plan-slug>',
  items:[
    {
      itemId:'P-001',
      verdict:'implemented',
      citations:[
        { kind:'code', path:'packages/example/lib/feature.ts', symbol:'buildFeature' },
        { kind:'test', path:'packages/example/lib/feature.test.ts' }
      ]
    },
    {
      itemId:'P-002',
      verdict:'not-code',
      note:'Investigation conclusion is the durable deliverable.',
      citations:[{ kind:'doc', ref:'agent-insights/example', reason:'No code artifact exists.' }]
    }
  ],
  findings:[{ summary:'Out-of-scope defect', disposition:'filed', ref:'WI-12345' }]
}
```

Only resolving `code` and `test` citations verify implementation. Their repo-relative paths must resolve; optional line and symbol anchors must be valid. A PG-canonical doc citation needs `ref` and `reason`; `none` needs `reason`. An `implemented` verdict requires a resolving code or test citation. Each item stores its audited SHA, timestamp, and text hash. At ship time the gate rechecks only status, text, citation resolution, and cited bytes. If it reports `audit_coverage_stale`, re-audit only the named items.

## 3. Author and vet the acceptance rubric

After the audit is clean, author the as-built definition of done:

```text
rubrics:propose {
  rubricRef:'<acceptance-rubric-slug>',
  kind:'acceptance',
  subjectPlan:'<plan-slug>',
  classRef:'plan-class-feature-ship',
  characteristic:'<umbrella-domain>',
  title:'<acceptance title>',
  criteria:[<3-7 outcome criteria tracing to the plan goal and Decisions>]
}
```

Use the matching plan class (`plan-class-feature-ship`, `plan-class-bugfix`, `plan-class-migration`, or `plan-class-investigation`). Vet the current revision with a `consult:get_feedback` critique and emit the meta-scorecard. Any later rubric edit invalidates both the attestation and independent grading because the gate pins scorecards to the plan revision; batch intended edits before requesting grading.

For a started BAR meaning change, use `rubrics:amend { dryRun:true, ... }` and follow the authenticated outside-lineage approval path. The reviewer posts the exact approval JSON as a `work_items:comment` on any existing thread they can write to, preferably an item they already hold. The `thread-post:<id>` lookup is workspace-wide by local post id, not tied to the requester's thread, so no separate counter-sign work-item is needed. See `agent-insights/unified-requirement-contract` for the full amendment contract.

### The order: amend → vet → attest → bind → cards → grade

Do these steps in exactly this order. A vetting critique should cost a text edit, not a proof cycle:

1. **amend** — get the BAR text complete first: METHOD, falsifier, structured check, `requiredTestLayers`. Every one of these is a `rubrics:amend`.
2. **vet** — `consult:get_feedback { policy:'rubric-vetting' }` on the current revision. Fold every critique into ONE further amendment.
3. **attest** — `scorecards:emit` against `meta-acceptance-rubric` for that final revision.
4. **bind** — only now bind proof with `plans:bind-spec-evidence`.
5. **cards** — run `plans:evaluate-spec-test-adequacy` and emit the adequacy cards.
6. **grade** — independent grading, then the author's verdict (section 4).

Why this order: an amendment re-revisions the clauses it touches. Proof, adequacy cards and grading bound to the old revision then no longer cover those clauses, and must be redone. Vetting is where amendments come from. So vetting after proof reliably pays for proof twice. The audit behind `review-system-rework-reduction-2026-09-23` measured a whole "vetting after proof" re-proof cycle on one plan.

The gate follows this order. The acceptance gate's `NEXT REPAIR` line ranks contract-text codes first, then `bar_snapshot_vetting_missing` / `bar_snapshot_vetting_stale`, then proof, adequacy and grading codes (`ACCEPTANCE_BAR_REPAIR_ORDER`). `plans:bind-spec-evidence` still writes BAR proof bound to an unvetted revision, but its result carries an `acceptance_rubric_unvetted_before_proof` advisory. Treat that advisory as the cue to stop binding and vet first. Binding early stays legal; it is just the expensive order.

## 4. Independent grading, then the implementer's verdict

A non-implementer grades every criterion with concrete evidence:

```text
scorecards:emit {
  rubricRef:'<acceptance-rubric-slug>',
  ratings:{ <every criterion key>: { rating, evidence } }
}
```

After the independent card exists, the rubric author re-emits complete ratings with an explicit plan-level decision:

```text
scorecards:emit {
  rubricRef:'<acceptance-rubric-slug>',
  ratings:{ <every criterion key>: { rating, evidence } },
  acceptance:{ verdict:'accept', reasoning:'<why the independent evidence meets this plan-specific bar>' }
}
```

Do not pass `supersedes` on the author verdict. The independent card must remain visible. `reject` is a real terminal judgment for that scorecard and blocks shipping until the work or grading is addressed and a newer author verdict is recorded.

## 5. Ship and reconcile the drain row

```text
plans:set-plan-status { slug:'<plan-slug>', status:'shipped' }
```

A successful ship auto-retires the acceptance rubric. The acceptance-drain sweep then observes the terminal plan disposition and resolves the keyed work item. If the plan is superseded or archived instead, the sweep drops the row with that explicit not-to-ship evidence. Do not close the row merely because the gate is ready or because a ship call was attempted.

## Refusal codes and the repair they demand

Code-truth family, controlled by `PLAN_ITEM_COMPLETION_GATE` and `PLAN_CODE_AUDIT_GATE` (both default ON):

* `plan_items_unfinished` — finish or drop the named items.
* `acceptance_unaudited` — run the first code-truth audit.
* `audit_coverage_stale` — re-audit only named missing, reopened, text-changed, or blob-changed items.
* `audit_citations_unresolved` — repair and re-audit only named broken citations.

Rubric family:

* `acceptance_rubric_missing` — author the post-implementation rubric.
* `acceptance_rubric_unvetted` — critique and attest the current rubric revision.
* `acceptance_ungraded` — obtain a complete non-synthesized grading.
* `self_graded_only` — obtain a grading from someone other than the rubric author.
* `acceptance_not_recorded` — record the post-grading author verdict.
* `acceptance_rejected` — address the rejection, then record a newer verdict.

An unknown/read failure is not one of these refusal codes. Preserve it as unknown and retry; never turn an unavailable gate read into a fabricated blocker.

## Forced shipping is scoped and loud

`plans:set-plan-status { status:'shipped', force:{ reason:'...' } }` may waive only the four code-truth checks. It does not waive rubric existence, vetting, independent grading, or the author's acceptance verdict. Every waived check, reason, actor, and time is appended to the plan's permanent `forcedPast` marker. Use force to record a deliberate exception, never to disguise one.

## What the mechanics prove—and what they do not

The citation resolver proves that cited paths exist at audit and ship time, anchors resolve, and cited bytes did not move unnoticed. It does not prove semantic correctness; that is why an independent grader spot-checks citations and the author explicitly accepts or rejects the grading. Audit findings do not independently block shipping; item lifecycle is the blocking truth. Out-of-scope findings never make a plan uncloseable, but a filed finding must name the work item that owns it.
