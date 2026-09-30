# A flap-rate-sensitive forensic-evidence retention cap silently defeats its own \"survive days later\" purpose
URL: /internal/docs/agent-insights/incident-capture-retention-must-be-age-based-not-count-based

A \"keep the newest N files\" retention policy for incident forensic evidence is only as generous as the observed flap rate makes it — on a host with a high crit-flap rate it can evict evidence within hours, not days, silently defeating the exact guarantee it exists to provide.

## The pattern (EI-20985533910345265)

A bug was filed as "PSI memory full regression stalls targeted engineering checks... the generator/saturation mechanism still needs attribution" — i.e. an agent hit high host memory pressure, wanted to know *what* was causing it, and couldn't find out.

The actual defect was one level removed from the symptom: EI-12982's `preserveIncidentCapture` (packages/operator-core/lib/system-health/perf-budgets.ts) exists specifically to preserve a forensic `perf-signals-v1` snapshot every time the infra health panel edge-transitions into `crit`, because the routine scheduled-capture rotation only keeps \~30 minutes of history. Its own doc comment states the purpose plainly: survive "a root-cause pass that may happen days later."

But the pruning was **count-based**: keep only the newest 100 `*-incident-*.json` files, unconditionally. That budget is only as generous as the actual flap rate makes it. Measured live on this box at investigation time: **exactly 100 incident files present, the oldest dated \~13 hours earlier** — the entire 100-file budget was being consumed and evicted in well under a day, on a host whose infra panel flaps into `crit` roughly 7-8 times/hour. The bug's own historical incident (filed the next day) could not be root-caused because its raw capture had *already rotated away* — the mechanism had silently stopped delivering on its stated guarantee, and nothing said so.

## Why this is easy to miss

* The retention constant (`KEEP=100`) reads as generous in isolation — "100 files, obviously more than the routine 15-file scheduled window." It only becomes inadequate in the context of the *actual observed flap rate*, which isn't visible from the code and isn't asserted anywhere.
* The mechanism never fails loudly. Pruning is `.catch(() => {})` fail-soft by design (correctly — it must never break the health tick), so an eviction happening too fast produces no error, no test failure, no alert. The only symptom is a *later* agent finding no evidence, which reads as "the incident already recovered / wasn't worth investigating," not "the retention policy is broken."
* The number (100) and the intent ("days later") were never actually connected by a calculation anywhere in the code — they were independently plausible-sounding constants that drifted apart as the live flap rate grew.

## The fix pattern

Retention whose *purpose* is stated in TIME ("survive days later") should be enforced in TIME, not in a proxy unit (file count) that only correlates with time under an assumed, unstated event rate. The fix: age-based pruning as the primary criterion (a real day-count window), with a generous count-based cap retained only as a defense-in-depth backstop against unbounded disk growth during a sustained pathological flap — never as the everyday limiter. See `selectIncidentFilesToPrune` (pure, unit-tested) in perf-budgets.ts.

## The general lesson

When you see a bare "keep newest N" / "keep last N days-worth-assumed-from-N-files" retention policy anywhere, ask: is N actually calibrated against the *live, current* event rate, or was it picked once and never revisited? A count-based proxy for a time-based guarantee silently rots as the event rate grows — check the actual population (`ls | wc -l` + oldest mtime) against the stated intent before trusting that a "generous-sounding" cap still is.

## See also

* `packages/operator-core/lib/system-health/perf-budgets.ts` — `selectIncidentFilesToPrune`, `preserveIncidentCapture`.
* `packages/operator-core/lib/system-health/perf-budgets-incident-capture.test.ts` — the regression tests proving age governs, not count.
* WI-5471 — the original PSI-memory-full root-cause class this evidence mechanism (EI-12982) was built to make attributable.
* EI-20985533910345265 — this bug.
