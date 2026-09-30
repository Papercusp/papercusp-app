# 15. Open questions for v1.0
URL: /internal/docs/spec/open-questions



These are the questions still genuinely undecided. The list shrank
between drafts as previously-open issues got resolved into spec
sections — see "Resolved since draft 2" at the bottom for
traceability.

Still open

UI plugin install flow when the host isn't running. If the host UI is offline, the CLI can still drive install (`papercusp install` doesn't require the GUI), but capability prompts are text-only. Is text-only consent acceptable for high-tier capabilities (§10.6.1), or should the spec require GUI confirmation for those? Affects headless deployments.

Versioning of the spec itself. Plugin manifests pin against a substrate service version (§8.4.1), but not against a spec version. How do we evolve the harness contract (add a 5th required role, change state schema) without breaking installed plugins? Likely needs a `papercusp` field in the manifest pinning a spec semver range, with the same evolution rules as services.

Goal-graph richness. Today goals are a tree (parent\_id). Real strategy involves multiple goals contributing to one outcome (DAG, not tree). Add multiple parents? Weighted contributions? Or punt to plugins?

Reputation and reviews. §11.6 establishes verified vs unverified trust tiers based on identity + signature, but no mechanism for community feedback. Does the marketplace need ratings, reviews, or a reporting flow for low-quality (not malicious) packages? At what scale does this become necessary, and who moderates?

Resolved since draft 2

These were open questions in earlier drafts; the linked sections
now answer them.

Was openNow answered in

Plugin-defined decision verbs — should plugins extend the verb vocabulary beyond a fixed built-in set, and how is it kept bounded/auditable?
§6 (orchestrator) — verb vocabulary is per-blueprint, not fixed: each blueprint declares its own verbs in spine.edges (a verb → action map), parsed by parseDecisionFor and interpreted by the data-lookup engine deriveNext (D-002, "pipeline-as-data"). Boundedness/auditability is enforced by spine validation (validateDeciderSpine: terminal reachability + declared-role checks). The built-in coding pipeline still ships a fixed set, classified by an exhaustive switch. Note the emitter is the per-feature director (in the coding-factory blueprint), not a single "orchestrator"; the Pot (coding) layer has no spine and emits no NEXT\_\* verbs.

LLM-agnosticism — the runtime hardcodes Claude; should the spec require pluggable LLM providers (adapter slot)?
Reference runtime already ships the adapter slot. Three pluggable agent backends (claude-code, omp, codex) each carry their own config-driven invocation command and stream parser; the backend and command are config fields, not hardcoded. claude-code is the default, not the only option.

Multi-tenancy in the runtime — how to scope user/install when many run side-by-side
§10.5 — shared-DB multi-tenancy: a single harness\_shared schema whose tables are tenant-keyed by install\_slug / workspace\_id and isolated by row-level-security policies (workspace\_id = current\_setting('app.workspace\_id')), not a per-install database.

Marketplace governance — moderation model for malicious entries; reviewer approval at publish time?
§11.6 (namespace policy + verified/unverified trust tiers via signing) + §11.9 (retraction levels: deprecated / yanked / withdrawn / quarantined, with operator-only quarantine for security incidents)

Permission fatigue — how to prevent users from blindly approving 30-cap manifests
§10.6 (impact-tiered budgets + grouped consent + default-deny new caps at update)

Cost containment for routines — how to prevent a buggy cron from draining LLM budget
§9.4 (per-routine rate limit + per-plugin daily budget + system-wide caps + auto-pause on 5 errors)

Plugin update flow — what happens when a new version requests new capabilities or migrates schema
§11.7 (CLI flow with capability diff and snapshot) + §10.8 (per-change-class semantics)

Hook ordering when multiple plugins fight for the same hook
§8.5.1 (named predicates as canonical, integer priorities as fallback)
