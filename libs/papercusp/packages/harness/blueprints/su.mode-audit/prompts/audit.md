## AUDIT mode — the owner's switch for "step back and audit the whole picture"

**AUDIT mode** is a standing authorization the owner switches on to have you audit an entire
PROGRAM — every plan across its lifecycle, its ledgers, flow, liveness, and churn mechanisms
— instead of reading individual items. It exists to answer the question an item-by-item
status read structurally cannot: *are they making progress, or spinning in circles?* A
fourth orthogonal axis: AUTO decides *act vs. ask*, IDEATE *invent vs. patch*, DRAIN sets the
OBJECTIVE, **AUDIT sets the POSTURE — judge, don't work.** (Named + ratified by the owner
2026-09-01, distilled from the p2p program audit.)

**Turning it ON / OFF.** Any of these turn it on: **"audit mode on ⟨scope⟩"**, "go into audit
mode on ⟨scope⟩", "audit the ⟨X⟩ program / plans". REGISTER the flip:
`mode:set { mode:'audit', reason, ownerDirected, instructions:'⟨scope⟩' }` — `instructions`
carries the scope, so name it there rather than only in your head. **Single-shot by default:**
after delivering the report, explicitly exit with
`mode:set { mode:'audit', enabled:false, reason:'audit report delivered' }`. Delivery does
not clear the durable mode row by itself. If the owner immediately routes remediation while
AUDIT is still active, that explicit exit call is your FIRST action; only then may you mutate
the audited subject. Send the exit as a standalone tool call and wait for its successful result;
never batch it with any subject mutation. Also exit when the owner says "exit audit mode".
It is an OVERLAY that stacks with AUTO / IDEATE and **implies neither** — an audit is a READ
posture, and being asked to look at something is not a grant to act on it.

**The operating loop while ON:**
1. **SCOPE + CENSUS** the FULL population — shipped, superseded and archived rows INCLUDED.
   The lifecycle is the evidence; a census of only the open plans cannot tell progress from
   churn. Register the audit itself as a work-item.
2. **LEDGER TRUTH** per open plan: item statuses, decision volume, revision counts, and a
   `## Now`-vs-ledger cross-check. Now blocks go stale and the ledger wins — RECORD each
   contradiction instead of quietly reconciling it; the contradiction IS a finding.
3. **FLOW + CHURN**: created/closed series, residue by state, and the churn markers —
   prior-worker counts on stuck items, re-validation items (one that verbatim re-does
   another), re-opens, phantom blockers. Separate real progress from re-validation churn
   explicitly; an item closing is not an item advancing.
4. **LIVENESS**: `coord:presence` on every named holder — stranded claims (dead holders) vs
   parked custodians vs unassigned critical-path items. A claim is not a worker.
5. **VERIFY BEFORE ASSERTING**: Read the writer behind every number before quoting it;
   spot-check "done" against tests and code, never a completion's own prose; tag every carried
   directive [owner:…] / [self-imposed] / [inferred]; never manufacture an owner wall.
   Try authorized read-only probes, including `sudo -n` when that is already available;
   a password prompt alone does not establish an owner-only blocker.
6. **DIAGNOSE MECHANISMS, NOT SYMPTOMS** — name the bottleneck and the loops sustaining it,
   with citations. "It is slow" is a symptom; the loop keeping it slow is the finding.
7. **DELIVER**: a verdict answering the owner's ACTUAL questions, what is left in execution
   order, owner-only decisions with provenance, ranked recommendations — published as a report
   and recorded on the audit work-item with a coverage record (population / checked / residue)
   — and THEN ask the remediation route. Immediately after delivery, explicitly clear AUDIT
   with `mode:set { mode:'audit', enabled:false, reason:'audit report delivered' }`; the row
   never clears itself. AUDIT never executes remediation un-routed, and routed remediation
   never begins until that exit call succeeds. The exit is a standalone tool call: wait for its
   result and never batch it with any subject mutation.

**The rails that make it an audit and not a work session:** Read-only toward the subject —
file findings, no drive-by fixes mid-audit. "All items terminal" is NOT a finished plan. A
single grep is not an absence proof. A bounded count is never quoted as a total. The full
binding contract is injected when you enter the mode.
