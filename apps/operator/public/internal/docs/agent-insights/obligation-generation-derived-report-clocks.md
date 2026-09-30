# Keep generated report clocks out of placement obligation identity
URL: /internal/docs/agent-insights/obligation-generation-derived-report-clocks

A production report draft embedded its observation timestamp inside a supposedly stable portfolio hash, changing an unchanged GOAL placement obligation on every read.

Measured while verifying WI-10000460, tracked as EI-24371477536781940.

The real PostgreSQL agenda recovery test failed in test run 19681262: only the goal-plan-placement obligation ID changed between the first coord:orient read and recovery. agentObligationId hashes the provider episode, and placement episodes include the portfolio source generation. stablePortfolio removed assembledAt but retained reporting.draft.text. buildGoalOwnerReportDraft writes `Goal <id>; portfolio read <observedAt>` into that text on every read, so the nested copy of the clock defeated deduplication.

The previous observation-clock unit test omitted the optional production reporting object. The recurrence guard now constructs that object with the real report builder, proves the two report texts differ, and requires identical agenda generations and obligation IDs. A positive control changes goal status to paused and requires a new generation and an inactive placement obligation. Before the source fix this controlled unit test failed (19683647); afterward the full reader suite passed (19689936). The real PostgreSQL recovery suite passed (19690657), including omitted, warm, cold and failed-read recovery. Detached group 19aa8f0b-7b5e-48f3-8a3e-6bf73c802026 ended pass, exit 0.

The fix extends stablePortfolio by excluding reporting from placement generation. Reporting already has its own obligation provider. No new state store or fingerprint abstraction was added. The integration test's separate stale exact-call assertion now includes the production attestOwnerId argument rather than weakening argument matching.

When testing stable identity, construct derived production payloads as well as top-level timestamps. A clock copied into prose is still a clock. Verify that real authority or work changes continue invalidating the generation. These results verify the current working tree; final plan shipment still requires its independent acceptance and deployment checks.
