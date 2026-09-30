# August 2026 non-Blender plan audit

Live reconciliation checked on 2026-08-26 at approximately 00:53 EDT.

## Scope and interpretation

This is the canonical 70-plan August closeout cohort. It excludes every canonical plan whose frontmatter contains `origin: scout`, the stored Blender/Scout provenance marker.

That proves these plans are outside the Blender/Scout cohort. It does **not** prove that owner personally authored every plan: all 70 currently have a null/blank structured `origin`, so positive personal authorship is not available from the plan metadata.

`Ready` is not terminal. It generally means implementation may be complete, but acceptance or lifecycle closeout remains unfinished.

The final reconciliation joined the immutable 70-row source manifest to the live workspace-wide plan index by harness and slug: all 70 rows matched, with zero missing rows and zero duplicate keys.

| Original audit bucket | Total | Shipped | Superseded | Unresolved |
|---|---:|---:|---:|---:|
| Acceptance residue | 13 | 2 | 0 | 11 |
| Missing closeout evidence | 51 | 8 | 2 | 41 |
| Stale audit | 5 | 4 | 1 | 0 |
| Status residue | 1 | 1 | 0 | 0 |
| **Total** | **70** | **15** | **3** | **52** |

The 52 unresolved plans are currently 20 active, 30 ready, and 2 draft.

## Terminal plans — 18

| Plan | Status | Description | Recommendation |
|---|---|---|---|
| Repeated abrupt Codex termination | Shipped | Investigated repeated unexplained termination of a Codex fleet-leader session. | Keep shipped; reopen only if the incident class recurs with contradictory evidence. |
| Agent launch verification and spawn environment | Shipped | Makes launches verifiable and spawned terminals self-sufficient across platforms. | Keep shipped. |
| Pipeline-state truthfulness | Shipped | Prevents release and gate surfaces from claiming more certainty than their evidence supports. | Keep shipped. |
| Fleet peers in the chat popup | Shipped | Adds a fleet-peers rail beside Activity in the conversation popup. | Keep shipped. |
| Consult-revival acceptance residue | Shipped | Closed the remaining acceptance gaps in consult revival. | Keep shipped. |
| Standalone Email app | Shipped | Provides an independent Gmail/triggers email application for web and desktop. | Keep shipped; subsequent email features should use a new plan. |
| SU policy-injection audit | Shipped | Audited whether SU operating policies reach fresh sessions correctly. | Keep shipped. |
| Verify 0.0.14-alpha on real platforms | Shipped | Tested published installers on real Windows, macOS, and Linux machines. It found platform defects that moved to remediation work. | Keep shipped; track the discovered defects separately. |
| Work-item completion-boundary integrity | Shipped | Repairs provenance and evidence gaps around terminal work-item completion. | Keep shipped; its corrected tests and acceptance lineage are healthy. |
| SideStage architecture documentation | Shipped | Documents SideStage’s complete architecture and system boundaries. | Keep shipped. |
| SideStage Copilot queue inspector | Shipped | Implements the chosen Queue-plus-inspector Copilot interface. | Keep shipped. |
| SideStage migration-history completeness | Shipped | Consolidates SideStage plans and provides complete historical visibility. | Keep shipped. |
| Acceptance rubrics on every plan | Shipped | Establishes standard and acceptance rubric kinds, per-plan linkage, a default-on completion gate, seeded class rubrics, and lifecycle retirement. | Keep shipped; completion audit #2, meta-vetting, independent six-of-six healthy grading, and author acceptance are current. |
| Token-composition attribution | Shipped | Breaks injected context into explicit token-composition components and closes the previously degraded evidence caveat. | Keep shipped; the fixed caveat, fresh corpus evidence, independent grading, and author acceptance are healthy. |
| TypeScript 7 upgrade | Shipped | Upgrades active Papercusp workspaces to TypeScript 7.0.2 with strengthened API and active-compiler gate evidence. | Keep shipped; the critic-repaired rubric, current compiler evidence, independent grading, and author acceptance are healthy. |
| Oddsmith recovery and hardening | Superseded | Described recovery after the August 15 wipe. | Keep superseded; confirm the replacement plan retains any still-relevant hardening requirements. |
| Event-system calibration audit | Superseded | Proposed a blind, held-out audit for calibrating event-system audit accuracy. | Keep superseded; retain its calibration method as reusable guidance. |
| Automations main-tab replacement | Superseded | Proposed replacing fragmented automation catalogs with one full-width main tab. | Keep superseded; ensure the active Automations plan incorporates the accepted UX intent. |

## Acceptance residue — 11

| Plan | Status | Description | Recommendation |
|---|---|---|---|
| Cupboard sharing for plans, rubrics, and recipes | Ready | Adds reusable Cupboard listing types and plan-to-rubric dependency gating. | Complete final verification against a stable published tree, refresh the audit, independently grade, then ship. |
| Drain control-plane resilience | Ready | Intended to make drain recovery lossless, verifiable, and grounded in canonical work. The audit snapshot suggested execution may not match the apparently closeable status. | Re-audit code truth first. If major implementation remains, mark active; do not acceptance-close from the `ready` label alone. |
| Fundraise automation | Ready | Implements an agent-run fundraising pipeline with research, tiering, outreach drafts, approval gates, follow-ups, and reviews. It intentionally cannot send email directly. | Keep open until real targets/network data and live Gmail/Slack acceptance exist; then grade and ship. |
| iPhone public-release readiness | Active | Drives the iPhone application through real public-release readiness and delivery. | Continue implementation and platform verification; acceptance-close only after the release evidence is current. |
| Learning-loop identity and consumption | Ready | Gives observations and ideas stable identities and makes their downstream consumption visible. | Run a current code-truth audit and independent acceptance grade; ship if healthy. |
| Official Android and iPhone templates | Ready | Establishes supported mobile-app templates rather than bespoke mobile scaffolds. | Verify both templates through real materialization/build tests, then independently grade and ship. |
| Serialize and slow Kopia backups | Ready | Prevents backup overlap and lowers excessively aggressive hot-backup cadence. | Verify current production scheduling and mutual exclusion, then acceptance-close. |
| Unified app template | Draft | Proposes collapsing web and desktop application templates into one target-parameterized root. | Decide through evidence whether consolidation still fits. Promote and build if it does; otherwise supersede explicitly. |
| Live reconciliation audit of unshipped plans | Ready | Audits plans whose implementation or lifecycle state disagrees with current reality. | Finish its own evidence and acceptance closure after WI-41605’s census is settled, avoiding circular claims. |
| SideStage seller-Copilot mission | Ready | Makes Copilot perform the actual operational mission of a live-selling seller. | Validate the end-to-end seller workflow, independently grade it, then ship or reopen concrete gaps. |
| SideStage standout features | Ready | Covers the engagement meter and the owner-selected standout feature slate. | Verify each selected feature against the current product, close omissions, then independently grade and ship. |

## Missing closeout evidence — 41

| Plan | Status | Description | Recommendation |
|---|---|---|---|
| Panda Gallery v1 | Ready | A website presenting panda imagery over an animated background. | Run current product verification and acceptance; ship if the deployed experience still satisfies the plan. |
| Remove runtime CDN dependencies | Active | Eliminates remaining runtime dependencies on public CDNs, especially the Vditor asset class. | Finish the remaining dependency removals and network regression tests; do not close early. |
| 88-constellation reference site | Active | Builds a browsable visual reference for all 88 IAU constellations. | Complete the deployed product and content validation, then run acceptance. |
| Decouple generic libraries | Active | Removes private workspace-package dependencies from public `libs/generic` libraries. | Finish dependency isolation and package-level tests before closeout. |
| Default deploy account | Ready | Retires old key/OAuth cards and permits a provider-agnostic default deployment account. | Verify UI, persistence, and actual routing behavior, then independently grade and ship. |
| Dependency-graph design pass | Active | Corrects visible graph defects and improves selection behavior. | Finish the selected UX corrections and validate them through the Tauri application. |
| Desktop 0.0.17-alpha release | Ready | Cuts, publishes, and validates a desktop alpha release from current green `main`. | Confirm publication and real-platform installer evidence, then close. |
| Durable federation peer lifecycle | Ready | Makes federation cursors and absence alerts survive peer lifecycle transitions. | Audit the live reader/writer behavior and recurrence tests, then independently grade. |
| False premises in prescriptive artifacts | Ready | Addresses instructions or artifacts that prescribe actions based on incorrect assumptions. | Verify the producer-side guard and a mutation/control test, then ship if the detector is adequate. |
| File-level test selection | Ready | Uses the import graph to run only tests a change can actually affect. | Validate selection completeness, exemptions, and false-negative controls before shipping. |
| Fleet-lead instrumentation audit | Ready | Audits misleading zeros, incorrect field interpretations, and inverted fleet signals. | Re-run against current metric writers and units, then close with corrected evidence. |
| Focus Kit | Active | Builds three local-first applications over a shared UI and data store. | Keep active until all three applications and their shared substrate are complete and tested. |
| Gate ownership singleton | Active | Makes a gate condition map to one accountable work item and owner. | Finish singleton/transition semantics and concurrency tests; then acceptance-close. |
| Gate ownership follow-up | Active | Stops condition-bridge work-item mint loops and makes red gates reliably ownable. | Complete the remaining red-gate ownership and deduplication work. |
| Stop chasing the checkpoint tip | Ready | Makes the green checkpoint evaluate a stable target instead of a continuously moving branch tip. | Verify stable-target behavior under concurrent commits, independently grade, then ship. |
| GOAL-mode hardening | Active | Hardens goal naming, provenance, launch settings, contracts, and test behavior. | Continue implementation; split or supersede stale scope if the plan has grown beyond one coherent closeout. |
| HLC contention-free clock | Ready | Removes transaction-wide HLC clock contention while preserving federation ordering. | Persist real external rubric-vetting provenance, emit a superseding vetted meta-card, then author-accept and normal-ship. |
| Hotel reservation app bootstrap | Active | Materializes and begins construction of a hotel-reservation application from a Papercusp template. | Keep active until the actual application—not merely the bootstrap—is implemented and verified. |
| HUD pot scope and dropdown | Ready | Corrects HUD pot scoping and keeps selection controls inside the viewport. | Validate in the Tauri shell, independently grade, and ship. |
| HUD unified search and filtering | Ready | Provides one identity-aware search/filter surface across all four HUD tabs. | Verify cross-tab semantics, keyboard behavior, and empty-state behavior before shipping. |
| Inference/account rename | Active | Renames Deploy Accounts to Inference, introduces provider-neutral defaults, and retires the Anthropic-specific field. | Finish data migration, routing behavior, and UI cleanup; then acceptance-close. |
| Local ModernBERT reranker | Ready | Replaces the dark external reranking seam with a local ONNX cross-encoder. | Verify quality, latency, fallback behavior, and packaging before shipping. |
| Orchestration-surface residue drain | Active | Addresses a large group of defects across command execution, recipes, result doors, and shell capabilities. | Continue draining with evidence; avoid declaring the umbrella complete while scoped defects remain open. |
| Outages must not be silent | Active | Ensures outages surface visibly and diagnoses are evidence-based rather than guessed. | Finish all notification/detection paths and run failure-injection tests. |
| Agentic web-app template | Active | Creates the web counterpart to the agentic desktop-app template. | Finish materialization and real example-app verification before shipping. |
| Plan visibility revamp | Active | Redesigns sidebar timestamps, plan-detail dashboards, and weighted HUD presentation. | Complete the Tauri implementation and visual/interaction validation. |
| Prose embedding MRL-384 fix | Draft | Corrects use of an untrained 384-dimensional truncation on prose embeddings. | Promote and implement if the defect remains current; otherwise supersede with measurements explaining why. |
| Chat popup timestamps and modes | Ready | Adds timestamps, visible sends, live mode state, and drain instructions to session chat. | Validate live updates and interaction behavior in Tauri, then independently grade and ship. |
| Task Manager release readiness | Ready | Prepares Task Manager for a public release. | Run the complete release rubric, platform verification, and packaging checks before shipping. |
| Cross-client thinking gauge | Active | Makes the Codex/OMP thinking gauge accurate and live-refreshing. | Finish writer/scale correctness and cross-client validation before closeout. |
| Trap-guard follow-ups | Active | Repairs ambiguous signals and enforcement gaps uncovered by the trap-guard fleet run. | Finish the identified guard classes and verify each with a recurrence test. |
| Vditor local assets and popup latency | Active | Removes Vditor’s cold-load dependency on 4.9 MB from `unpkg.com` and makes the plan popup open promptly. | Finish local asset packaging and measure cold-open performance in Tauri. |
| Wake-deaf PTY-host guard | Active | Detects and durably recovers the class where a parked terminal host stops receiving wakes. | Finish the external detector and prove recovery across process/session vintage boundaries. |
| Retire dead federation-probe hops | Active | Removes probe-hop states that were promised but never emitted. | Keep active until a rollback-safe captured-only release is deployed and migration 917 can be applied safely; do not arm the migration early. |
| SideStage Android app | Ready | Implements SideStage Android using the Rust core, UniFFI, and Compose framework. | Verify a real Android build and critical user journeys, then independently grade and ship. |
| SideStage blocked-items audit | Ready | Reconciles every blocked SideStage plan and work item against current reality. | Re-read all current blockers, correct stale states, and close with an exact residue report. |
| SideStage checkout and shipping | Ready | Ports the Restart checkout and shipping calculator into SideStage. | Validate pricing, shipping calculations, checkout integration, and failure paths before shipping. |
| SideStage page-design audit | Ready | Audits every SideStage page and produces responsive design corrections/mockups. | Confirm all approved designs are implemented or explicitly handed to implementation plans, then close. |
| SideStage public-release testing | Ready | Runs the release-readiness campaign against the SideStage acceptance rubric. | Refresh the complete release evidence and ship only if the current product passes. |
| SideStage Studio scheduling | Ready | Designs event activation and scheduling UX for SideStage Studio. | Confirm the selected mockup and implementation disposition; ship the plan only when the deliverable is accepted. |
| SideStage “Coming up next” | Ready | Designs the Watch-page “Coming up next” mockup gallery. | Record the selected design and its implementation handoff or supersession before closing. |

## Recommended sequence

1. Preserve the 18 terminal plans.
2. Process the remaining 30 ready plans through a current code-truth audit and independent acceptance grade.
3. Keep the 20 genuinely active plans active; do not paper-close incomplete implementation.
4. Give each of the 2 drafts an explicit build-or-supersede disposition.
