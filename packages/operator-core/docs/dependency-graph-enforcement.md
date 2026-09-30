# Dependency graph enforcement

Dependency admission is enabled by default. Every supported work-item writer enters
`mutateWorkItemDependencies`, which reads the complete typed candidate graph inside a
serializable transaction and rejects new cycles, endpoint defects, stranded nonterminal
work, or active-dependant lifecycle contradictions. Plan writers use the corresponding
candidate-plan admission seam. There is no runtime dark flag or advisory bypass.

Rejections expose `WorkItemDependencyAdmissionError.telemetry` with the stable event name,
policy codes, duration, graph size, and budget verdict; the error also carries the complete
before/after analyses and exact paths. Successful mutations return the same telemetry shape
with inserted/removed counts. Operator monitoring emits the census telemetry on every clean
or finding-bearing tick.

The P-016 current-scale baseline is 130,000 nodes and 1,500 edges. Three live clean-census
runs at 126,532 nodes and 1,205 edges measured 2,843.1–3,211.2 ms, so the census budget is
5,000 ms. The serializable mutation budget is 2,000 ms. A budget overrun is structured
telemetry, not permission to weaken correctness or skip admission.

Operational verification:

1. Run the dependency analyzer unit/property tests, real-Postgres admission/concurrency/
   lifecycle tests, writer-census guard, plan admission tests, claim-door soak, monitor tests,
   and UI-model tests.
2. Run `reconcileDependencyGraphPolicy` against the live database. Strict rollout requires
   zero hard findings; the census must also report its duration and budget verdict.
3. If a mutation is rejected, use its policy codes and exact path/edge evidence. Repair the
   writer or legacy edge through the canonical mutation seam; never edit `work_item_deps`
   directly or disable admission.
