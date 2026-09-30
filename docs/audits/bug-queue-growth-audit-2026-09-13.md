# Bug queue growth, drain throughput, and admission audit

Prepared for owner. Audit record: **WI-10001252**.

Frozen inventory: **September 13, 2026, 8:55:51 p.m. America/New_York**
(`2026-09-14T00:55:51.702418Z`). Supporting reads were made during the same
investigation; their counts can differ slightly as the fleet continues working.

## Verdict

The drain is doing substantial work, and the September 13 closure rate is ahead
of arrivals. The queue is nevertheless being replenished by repeated failures,
classification mistakes, and incomplete admission coverage. Increasing worker
count alone does not correct those mechanisms.

There are **1,549 outstanding bug reports in Papercusp**, plus **166 in other
harnesses in this workspace: 1,715 total**. These are distinct database rows,
not 1,715 independently reproduced, unique defects. A full root-cause
adjudication of every surviving row was not performed.

## Population and counting contract

The inventory reads `harness_shared.work_items` in workspace
`papercusp-workspace`, with `item_kind='bug'`, excluding `lane='observation'`,
and uses the database's canonical `work_item_status_is_terminal(status)`
function. No row-list limit is applied before aggregation.

| Papercusp stock | Rows |
|---|---:|
| Status `open` | 1,286 |
| Legacy status `todo` | 1 |
| Status `blocked` | 159 |
| Status `needs-human` | 103 |
| **Outstanding** | **1,549** |
| Additional nonterminal bug-shaped observation rows, excluded above | 131 |

`open` is not synonymous with unassigned or immediately claimable: claim
metadata, admission, origin, review and other scheduler rules are separate.
This is a stock census, not a claimability census.

The initial `work_items:burn_down` read explicitly returned
`terminal.truncatedByLimit=true`, `censusLimit=2000`, and `counts.total=2000`.
Its sampled outstanding count was not used as the answer. The writer fetches
up to `WORK_ITEMS_MAX_LIMIT`; limiting the displayed arrays does not remove
that source cap.

## Is the queue growing despite the drain?

The following is an uncapped creation/last-terminal series over the current
Papercusp bug population. Dates are Eastern time; September 13 is a partial
day ending at the frozen inventory time.

| Date | Rows created | Rows whose latest terminal transition was on date | Difference |
|---|---:|---:|---:|
| September 7 | 1,231 | 1,004 | +227 |
| September 8 | 1,331 | 1,094 | +237 |
| September 9 | 1,007 | 816 | +191 |
| September 10 | 36 | 19 | +17 |
| September 11 | 78 | 14 | +64 |
| September 12 | 941 | 1,006 | -65 |
| September 13, partial | 1,068 | 2,050 | -982 |
| **Total** | **5,692** | **6,003** | **-311** |

Thus the recent work is not simply failing to make progress. Arrivals exceeded
last closures on each of September 7–11; the September 13 drain is reversing
that pressure.

**Limit:** the difference is not an exact historical queue-depth change.
`closed_ts` is the latest genuine terminal crossing, is frozen on
terminal-to-terminal changes, and clears on reopen. Older closes are therefore
not all retained in that column. Current kind/lane membership also differs
from the time a report was created, especially after observation promotion.
The bounded `reopenHistory` is not a complete event ledger. This audit does
not invent a start-of-week queue depth or claim that net stock fell exactly 311.
The source of `closed_ts` is migration 698's trigger, which was inspected.

Closures also are not all newly fixed code. A later September 13-only read
contained 1,636 `done/committed`, 50 `done/proposed`, 270
`dropped/committed`, 10 `dropped/proposed`, and legacy resolutions.
`proposed` does not establish sufficient completion evidence; `dropped` is
disposal, not delivery. Neither `committed` metadata nor this audit is an
independent re-test of every claimed fix.

The live fleet `nonp2p-bug-drain-luna-max-50` has an active leader. Its stored
spec, revision 5, selects bugs in `open` and excludes the canonical P2P lane.
It therefore does not promise to empty every project, blocked work, human-only
work or P2P work. An append-only ever-member attribution read found 5,062
latest closures versus 2,213 creations by its ever-members since September 7.
That is meaningful throughput, not zero progress. This attribution does not
prove every action occurred while its author was a member.

## Are the reports unique? What is dedup actually doing?

**Dedup is working in part.** Since September 7, the occurrence ledger joined
to current non-observation Papercusp bugs recorded 7,239 `coalesced` occurrences,
24 `duplicate` occurrences, 819 `promoted` occurrences, and 5,332
`canonical-created` occurrences. Occurrences are reports, not new issue rows.
The duplicate/coalesced paths demonstrably absorb repeated reporting.
The ledger is best-effort, so this is recorded coverage, not an exhaustive
count of every attempted filing.

**The remaining stock is not certified unique.**

- At the frozen inventory there were 30 repeated exact-title groups involving
  168 open rows. Titles alone do not justify merging.
- A later full-stock query found 16 groups with the same tool and exact
  recorded failure message, involving 61 open rows (45 reports beyond one per
  group). These are repeat-report candidates, not 45 automatically disposable
  obligations.
- There were nine open `coord:send` reports with the exact message
  `tool "coord:send" exceeded timeout of 60s (handler returned but signal had aborted)`.
  Examples: EI-23181298225297552, EI-23188654723511464,
  EI-23192953328237734.
- Thirteen open reports shared the wrapped
  `invalid_input: invalid_args: resume requires one item ...` error;
  six shared `scheduler:get_next` / `syntax error at or near "last_released_by"`.
- **825 of 1,549 outstanding reports (53.3%)** carry tool-failure/probation
  metadata. This includes promoted reports; it is not a count of unpromoted
  observations or proof that all 825 are false.

### Finding 1: an unrelated build change splits failure identity

`invocation-friction.ts` passes `serving_build_sha` as `runtimeVersion`.
`toolFailureClassIdentity()` includes that revision in the canonical class key.
The nine identical timeout reports above carry nine different build suffixes.
The rule explicitly starts a new class on a deployed revision change.

Direct execution of the current pure identity function confirmed that changing
only `runtimeVersion` changes the key. No change to the error or tool is needed.
This preserves version evidence, but fragments a still-unfixed failure across
deployments. Removing the suffix blindly would be unsafe too: regressions and
different causes need distinct evidence, not indiscriminate grouping.

### Finding 2: wrapped caller errors become structural bugs

Direct execution of the pure classifier in both the canonical staging source
and the release checkout produced:

```text
errorCode=handler_error, status=error
"invalid_args: resume requires one item"                -> caller
"invalid_input: invalid_args: resume requires one item" -> structural
```

The message rule recognizes an anchored `invalid_args:` but not the wrapped
form. Capture maps structural/transient classifications to `bug`; caller and
rate-limit classifications map to `change`. A wrapper can therefore change
the work category without changing the underlying caller error.

## Did the admission and bulk steps protect the queue?

### Finding 3: admission is not consistently stamped on bug intake

At the frozen snapshot:

| Outstanding Papercusp admission state | Rows |
|---|---:|
| NULL | 1,454 |
| Explicit `auto` bypass | 46 |
| Fail-open `unreviewed` | 27 |
| Judged `admitted` | 22 |

More decisively, **5,528 of the 5,692 rows created since September 7 (97.1%)**
currently have NULL admission. This cannot be explained solely by old,
pre-admission backlog.

The call graph explains a route into that state:

1. `_create-core.ts` assigns `pending` or an attributable `auto` bypass.
2. `capture-core.ts` passes `admission:'pending'` only when `reviewRequired`.
3. That condition is restricted to change/feature captures, not bugs.
4. `createIssue()` defaults omitted admission to NULL and inserts it.
5. `isAdmitted()` treats everything except `pending` as admitted.

The capture condition also exists in the release checkout. This is not a
claim that these reports had no screening at all: inline dedup and probation
are separate mechanisms. It means the newer queued admission judgment is
not consistently applied or recorded for this major bug-filing route.

A coverage read additionally found 2,367 recent bug rows stamped
`dedupCoverage.semantic='unavailable'`, compared with 2,422 `ok`, 902 lacking
that field, and one `skipped`. Missing metadata is not classified as failure.
Unavailable semantic screening cannot support a uniqueness guarantee.

### Finding 4: fail-open is functioning; the judge has often failed

For Papercusp from September 7 through the supporting read:

- 118 completed promoter runs recorded **one promotion and ten merges**.
- 134 promoter runs were failed; 127 recorded
  **“The usage limit has been reached.”**
- 243 completed deterministic fail-open runs recorded **269 unreviewed
  auto-promotions**.
- One September 8 run remained stamped running. Its executor liveness was
  not investigated; a stale running record alone is not proof of a live worker.

These counts cover admission across work-item kinds, not bugs alone.
Fail-open is intentional in the policy. It prevents a dead judge from
starving workers, but makes admission availability very different from
successful duplicate review.

### Finding 5: bulk judging has not established bulk row reduction

The Papercusp `admission_runs` bulk-stage ledger contains two completed stages
and seven failed stages:

| Completed stage | Candidate pairs before -> after | Recorded merged rows |
|---|---:|---:|
| `wi882767-opus5-20260829-stage-1`, August 29 | 20,959 -> 20,683 | 0 |
| `wi882767-bulkfix-d035-4-stage-1`, August 30 | 20,645 -> 18,789 | 0 |

The latest recorded production bulk stage started September 5 and failed with
a database recovery/login error. Later complete records encountered in the
workspace-wide read belonged to `wi3467-smoke-test`, not the production queue.

A candidate-pair census measures **unadjudicated comparisons**, not bugs.
Keeping two findings as related/distinct reduces that census without removing
either row. The adjudication table includes 4,943 `r-related`, 535 `distinct`,
264 `r-finding-merge`, and 148 `r-remedy-keep` verdicts. Even a merge verdict is
not proof that the guarded row mutation committed. These records do not
exclude manual cleanup through other workflows.

The shared live-row safeguard follow-up from the September 5 audit,
EI-22458055788060997, now reads `done`. Its safeguards should be preserved,
not bypassed to make the merge count increase.

## Recommended repair sequence

1. **Repair intake coverage at the existing common creation/promotion seams.**
   Every new runnable report should carry either a successful admission decision
   or an explicit, justified bypass. Keep legacy NULL compatibility for genuinely
   historical rows, not silent new births. Include observation-to-bug promotion.
   Test capture, direct creation, watchdog and promotion routes.
2. **Separate durable problem identity from occurrence/version evidence.**
   Attach unchanged failures on new builds to an existing unresolved root when
   evidence supports it. A demonstrated repair followed by fresh failure should
   record a regression, not silently erase history. Preserve distinct remedies
   and per-build evidence. Test concurrent same-error/different-build reports.
3. **Normalize error wrappers before classification.**
   Preserve the underlying tool, code, schema field and failure message through
   `tools:invoke`/`code:run`. Add the reproduced nested-invalid-input case and
   genuine structural-error controls. Repetition establishes recurrence, not
   automatically a product defect.
4. **Restore effective judgment, then reconcile the existing backlog.**
   Diagnose the measured admission account failures; verify a production canary
   and resume the supported checkpointed bulk process. Judge full current
   evidence, maintain claims/holds/origin/reference safeguards, and report
   successfully changed canonical rows separately from comparisons and proposed
   merges. Extend the existing mechanisms rather than creating another queue.
5. **Measure net useful work with compatible populations.**
   Display raw occurrences, review backlog, validated canonical problems,
   runnable/active/blocked/human-only/P2P stock, verified fixes, dispositions and
   regressions separately. For historical stock changes, retain dated lifecycle
   and observation-promotion transitions; do not reconstruct them from only
   current rows and latest close stamps.

Suggested acceptance bar: all new filing routes produce an attributable
admission state; an unchanged failure across multiple builds stays one
unresolved canonical problem; nested caller errors do not become structural
bugs; bulk results name actual recoverable mutations; and a fixed-scope
seven-day series shows verified fixes exceeding validated new defects plus
regressions without hiding pending reports. These are proposed criteria,
not results claimed by this audit.

## Evidence and reproducibility

Sources inspected:

- `packages/operator-core/lib/agent-tools/work_items/burn_down.ts`
- `packages/operator-core/lib/work-item-dispatch-states.ts`
- `libs/papercusp/libs/db/sql/698-work-items-closed-ts.sql`
- `packages/operator-core/lib/work-item-lifecycle-history.ts`
- `packages/operator-core/lib/work-item-completion-authority.ts`
- `packages/operator-core/lib/issue-occurrence-ledger.ts`
- `packages/operator-core/lib/harness/improvements/capture-core.ts`
- `packages/operator-core/lib/harness/improvements/invocation-friction.ts`
- `packages/operator-core/lib/harness/improvements/tool-error-classifier.ts`
- `packages/operator-core/lib/issues-engineer.ts`
- `packages/operator-core/lib/agent-tools/work_items/_create-core.ts`
- `packages/operator-core/lib/work-items-admission.ts`
- `packages/operator-core/lib/work-items-admission-promoter.ts`
- `packages/operator-core/lib/work-items-admission-bulk-dedup.ts`
- `packages/operator-core/lib/work-items-admission-census.ts`
- `docs/audits/change-build-queue-admission-audit-2026-09-05.md`

The exact frozen aggregate was executed with `dev:pg_query` inside the saved
`code:run` recipe titled **“Freeze final uncapped bug queue audit snapshot.”**
The tool transcript retains the query and result. Basic inventory reproduction:

```sql
SELECT harness_slug, status, count(*) AS reports
FROM harness_shared.work_items
WHERE workspace_id = 'papercusp-workspace'
  AND item_kind = 'bug'
  AND lane IS DISTINCT FROM 'observation'
  AND NOT harness_shared.work_item_status_is_terminal(status)
GROUP BY harness_slug, status
ORDER BY harness_slug, status;
```

The pure classifier/identity probe used Node's TypeScript stripping to import
the actual source module. It performed no database writes or code changes.
The classifier counterexample was independently repeated against the release
checkout; this proves the source behavior, not the module generation of every
running process.

No existing bug was merged, closed, reopened, reclassified or reassigned.
No fleet, admission policy, service or deployment was changed. Only the
audit mode/intent, this audit task and this report were authored. No application
test-suite pass or deployed remediation is claimed.
