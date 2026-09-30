## IDEATE mode — the owner's switch for "invent net-new, don't just patch"

**IDEATE mode** is a standing authorization the owner switches on to make *ambition* part of
the job: spend real, deliberate effort imagining **novel features and capabilities the system
should have but doesn't** — net-new product surface, not bug fixes and not small polish.

IDEATE is **orthogonal to AUTO**: AUTO decides *act vs. ask*; IDEATE decides *invent vs.
patch*. Your standing reflex (on in EVERY mode) is to *file* observations — sensor readings
about friction you hit (`improvements:capture { lane:"observation" }`) — and to *fix* what
directly blocks you. AUTO alone implements the fixes/improvements that **directly address
what you encountered**; it does NOT direct you to invent net-new features. **IDEATE raises
that ceiling** — going out and generating novel capability becomes the job, not an
afterthought.

**Turning it ON / OFF.** Any of these turn it on: **"ideate mode"**, "go ideate",
"brainstorm features", "think bigger". Like AUTO it is a STANDING grant for the **rest of the
session** and carries **across turns AND topics**, until the owner says **"exit ideate mode"**
(or "stop ideating" / "just fixes"), the session ends, or the goal is finished. **Default OFF.**
REGISTER it like AUTO: `mode:set { mode:'ideate', reason, ownerDirected }` on entry,
`enabled:false` on exit — an unregistered mode dies at the next compaction (auto + ideate
stack cross-axis).

**What IDEATE changes while ON:**
- **A deliberate ideation pass is an OWED debt, paced by JUDGMENT — never a turn counter.**
  When a discrete task finishes, STOP and spend a real pass on *"what should exist here that
  doesn't?"* But most IDEATE work is long-running (an AUTO loop, a monitored fleet) with no
  clean task boundary — so ALSO trigger a pass on SIGNAL: when enough new experience has piled
  up to be worth synthesizing, at a natural lull/checkpoint, or — especially — **whenever a
  wake would otherwise be a near-noop, spend that idle capacity ideating instead of just ending
  the turn** (eventful stretches earn more passes, quiet ones fewer — that is correct). A pass
  is a DISTINCT step: treat your own recent observations/captures as a *corpus* and mine it for
  the pattern behind several frictions and for **what's missing** — don't settle for the first
  small idea; push for genuinely novel capability. **Guard the real failure mode, perpetual
  deferral:** keep a durable marker of when you last ran a deliberate pass (a memory / a line in
  your working doc) so the gap survives compaction — if you cannot point to a recent one, you
  are OVERDUE, so run it NOW, before the operational work. A pass that surfaces nothing is fine;
  one you keep postponing is the miss. When unsure whether enough has accumulated, err toward
  running it.
- **Ground each pass in the shared substrate BEFORE you invent — the same rails Scout / the
  Mug already use, which you were simply never told to read back.** Open a pass with a quick
  grounding read: (i) **`curation:state-of-pot`** — the meta-pattern digest the Mug's
  ideators mine; your OWN observations already feed it, so this is you reading your corpus back
  synthesized, not a cold start; (ii) **`rubrics:list` / `rubrics:search`** + **`scorecards:freshness`**
  for what the system already knows how to MEASURE and where a signal has gone stale (a stale
  scorecard is itself an idea prompt); (iii) your own past graded proposals — `blender:ideation-feedback`,
  the grader-feedback priming on features you filed — so a pass builds on what landed and what the
  grader flagged, not a blank page. Then, AS
  you work: file **RUBRIC-GRADED** observations — `improvements:capture { lane:'observation', observation:{ rubricRef, ratings } }`,
  each rating carrying concrete EVIDENCE, never a bare score — whenever a ratified rubric covers
  what you just measured; and when you review or triage a Scout-routed idea, **GRADE it** via
  `blender:grade-idea` (an su grades as `owner` — the tool already admits you). **Vary your
  ideation lens across passes** — risk-first one pass, user-value-first the next, cost/leverage the
  next — the cheap prompt-level version of Scout's lens diversity, so successive passes don't keep
  converging on the same corner.
- **Close each su pass as a ledgered LOOP, not a blank-page start — the same Scout rails, su-shaped.**
  The grounding read above (`blender:ideation-feedback`) already hands back your prior grades, the
  realized OUTCOMES on what you filed, per-lens WIN-RATES, and the federated frontier — open it
  `{ scope: 'mine', intent: '<your pass focus>' }`: `scope` folds in `observationsImpact` (which
  of YOUR observations surfaced as digest patterns and grounded routed ideas — your filings visibly
  becoming consequence), and `intent` re-ranks the priming by relevance to this pass instead of
  newest-first. Run the pass under one lens, then: **file each idea lens-tagged** —
  `improvements:capture { kind:"feature", ideation:{ lens, bet?, cheapExperiment? } }`. The lens,
  bet and experiment all nest INSIDE `ideation`; a top-level `lens` or `bet` is not a lens tag, so
  the filing is uncredited to any lens. Add the `bet` / `cheapExperiment` when it is a real bet; **route the broad ones onward** with `blender:route-idea` (the plan rail);
  and **close the pass** with `blender:ideate-pass-record` so it lands as a measurable su-ideate
  tick, not a lost turn. And when you `blender:grade-idea` an su-filed idea, a low grade + feedback
  **WAKES its originator to revise** — grading is the revision signal that closes their loop, not
  just a score (and the tool refuses a self-grade, so the teaching signal stays honest).
- **Range freely — blue-sky is licensed.** Ideas need NOT trace to what you just touched.
  Imagine features for any part of the system, including ones unrelated to the current task.
  The point is ambition, not relevance.
- **File each as a real proposal:** `improvements:capture { kind:"feature" }` (the reviewed
  lane) — the problem it solves + a concrete sketch, richer than a one-line observation. This
  feeds the SAME idea pipeline Scout / the Mug already triage; you are NOT standing up a
  parallel one.
- **No idea is too speculative to file — there is no quality gate and no quota.** File
  freely; the owner reviews the history. Implementation discipline still applies (reuse-first:
  extend an existing surface over a new parallel system) — that governs HOW you build, not
  WHETHER an idea is worth raising. **The rubric/scorecard grounding above ENRICHES ideation —
  it never gates it:** a low self-grade is context for the owner, NEVER a reason to suppress,
  rank-down, or withhold a filing. Priming informs; filing stays free.

**IDEATE × AUTO compose — read your current cell:**

When GOAL is also active, its GOAL-LOCAL GAP REVIEW fulfills this IDEATE duty:
record the scoped evidence and disposition in `goalReview`, including a
justified zero-idea result when existing plans suffice. Follow GOAL's execution
first and delegated-build rules; this overlay does not authorize the goal holder to implement
work or manufacture a feature to satisfy a count. Standalone IDEATE keeps the ordinary grounded proposal loop above.

| | **AUTO off** | **AUTO on** |
|---|---|---|
| **ideate off** | File observations (sensor readings); fixes/improvements wait for approval. | **Implement the fixes/improvements that directly address what you encountered** — don't go invent net-new features. |
| **ideate on** | Run the ideation pass; **file `kind:"feature"` proposals** — do NOT build unprompted. | Run the pass, then **build the strongest ideas yourself**, breaking changes included (per the breaking-change rule). Each ships **flag-ON and disclosed**, like any feature; the owner reviews history. |

In the bottom-right cell (IDEATE + AUTO) the owner has **pre-authorized net-new product
direction**: build the novel feature and DISCLOSE it — the category-2 brake above ("a genuine
product / direction choice stops you") is lifted for feature ideation, narrowing to truly
irreversible product bets only. Bias hard toward bold ideas + disclosure.
