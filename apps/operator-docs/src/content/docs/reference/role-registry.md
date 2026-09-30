---
title: "Role & persona registry"
description: "The built-in agent roles (AGENT_ROLES) joined with their spawn personas. Generated from role-config.ts + the harness persona files."
sidebar:
  order: 2
---

> **Generated — do not edit by hand.** Run `npm run gen:doc-projections` (or `npm run gen:doc-role-registry`).
> Source: `scripts/gen-doc-role-registry.ts`. Part of `starlight-projection-generators-2026-06-05` (Brief 29).

# Role & persona registry

A **role** is what kind of agent a spawn is. `AGENT_ROLES` is the runtime source of truth for the built-in role ids (tool `roles:` allowlists, `byRole` guidance, quotas); a role's **persona** is its spawn prompt at `libs/papercusp/packages/harness/blueprints/<id>/prompts/<role>.md` (the `base` library is the universal one). Not every role has a persona (operator/oracle are chat surfaces), and many personas are blueprint deciders/helpers that are not themselves `AGENT_ROLES` entries.

Sources: `packages/agent-mcp/src/role-config.ts` (54 built-in roles) + `libs/papercusp/packages/harness/blueprints/*/prompts/*.md` (60 personas).

## Built-in roles (`AGENT_ROLES`)

These ids appear in tool `roles:` allowlists, `rolesQuota` keys, and `byRole` guidance overrides. The set is open — plugins contribute `<plugin>:<role>` ids at runtime.

| Role | Persona | Summary |
|---|---|---|
| `scoper` | ✓ | . Aim for 0–4 tags per feature. |
| `architect` | ✓ | You are the **ARCHITECT** in an autonomous coding harness. |
| `worker` | ✓ | You are the **WORKER** in the **staging** phase of a 3-phase autonomous coding harness. |
| `validator` | ✓ | You are the **VALIDATOR** in a 3-agent autonomous coding harness. |
| `reviewer` | ✓ | You are the **REVIEWER** in a multi-agent harness. You are an autonomous gate |
| `debugger` | ✓ | You are the **DEBUGGER**. You fire when a feature has attempts ≥ threshold (default 3) and keeps failing. |
| `documenter` | ✓ | You are the **DOCUMENTER** in an autonomous coding harness. |
| `curator` | ✓ | You are the **CURATOR** in an autonomous coding harness. |
| `operator` | ✓ | The Mug — the Pot operator (the judgment layer over the fleet) — You are **the Mug of this Pot** — the single operator in charge. You were |
| `oracle` | — | chat/runtime surface — no spawn persona |
| `cup` | ✓ | Cup — coding pot (domain delta) — The shared cup persona (above) is your operating model — placement, propose/dispose, |
| `mug` | ✓ | Mug — global fallback (no domain delta) — The shared Mug persona (above, `mug.base.md`) is your complete operating |
| `planner` | ✓ | Planner (interactive plan author) — You are a **planner** — an interactive, owner-driven session for authoring and |
| `orchestrator` | ✓ | You are the **ORCHESTRATOR** in the **staging** phase of a 3-phase autonomous coding harness. |
| `promote` | ✓ | Promote agent — You promote a plan's `## Promote` policy into the harness as features — **all |
| `security-reviewer` | ✓ | You are the **SECURITY-REVIEW EXPERT** for this harness. |
| `infra-reviewer` | ✓ | You are the **INFRASTRUCTURE-REVIEW EXPERT** for this harness. |
| `crosscheck` | ✓ | You are the **CROSSCHECK** validator. You run **after** the primary validator has passed a feature, with a **different model**. Your job is to catch validator bias: cases where the primary validator… |
| `ui-qa` | ✓ | You are the **UI QA** agent. You fire **after** a worker has completed a UI-facing feature and the text-only validator has signed off. Your job: actually open the app in a headless browser (via `verd… |
| `auditor` | ✓ | You are the **Auditor** — Papercusp's read-only adversarial gate. |
| `merge-resolver` | ✓ | You are the **Merge-Resolver** — Papercusp's automated git-sync conflict fixer. |
| `content-fixer` | ✓ | You are the **Content-Fixer** — Papercusp's automated git-sync content-guard repairer. |
| `release-manager` | ✓ | You are the **Release Manager** — Papercusp's deploy decision-maker. |
| `release-fixer` | ✓ | You are the **Release-Fixer** — Papercusp's automated green-checkpoint gate fixer. |
| `doc-steward` | ✓ | You are the **Doc-Steward** — Papercusp's automated documentation-freshness fixer. |
| `papercup` | ✓ | Papercup (canonical persona re-homed) — You are the **Papercup** — one role, |
| `papercup-deep` | ✓ | Papercup deep brain (canonical persona re-homed) — You are the **hidden deep-brain half** of the ONE user-facing assistant named |
| `kettle` | ✓ | Kettle (system-health supervisor — base-library fallback STUB) — You are **the Kettle** — the autonomous system-health supervisor, a sibling |
| `researcher` | ✓ | Researcher — You research **one task** — the one named in `FEATURE_ID` — and produce written |
| `research-director` | ✓ | Research Director (per-task durable pipeline) — You are the **research-director** for a SINGLE research-task inside a durable |
| `searcher` | ✓ | Searcher (reactive) — You are a **reactive helper** in a `research` harness: gather and organize the raw |
| `discoverer` | ✓ | Discoverer — You build the **work-list** for a migration task — the one named in `FEATURE_ID`. |
| `finding-verifier` | ✓ | Finding Verifier (reactive · adversarial) — You are a **reactive helper** in a `review` harness, and you are the trustworthiness |
| `findings-synthesizer` | ✓ | Findings Synthesizer — You produce the **final review report** for `FEATURE_ID`: take the confirmed |
| `synthesizer` | ✓ | You are the **SYNTHESIZER** in a multi-agent autonomous coding harness. |
| `review-director` | ✓ | Review Director (per-review-task durable pipeline) — You are the **review-director** for a SINGLE review-task inside a durable pipeline |
| `dimension-reviewer` | ✓ | Dimension Reviewer — You review **one task** — the one named in `FEATURE_ID` — along **one dimension**, |
| `verifier` | ✓ | Verifier (reactive) — You are a **reactive helper** in a `research` harness: independently check the |
| `migration-director` | ✓ | Migration Director (per-migration-task durable pipeline) — You are the **migration-director** for a SINGLE migration-task inside a durable |
| `migration-verifier` | ✓ | Migration Verifier — You verify that a migration task — the one named in `FEATURE_ID` — is **green**: |
| `transformer` | ✓ | Transformer (worktree-isolated) — You transform **ONE site** of a migration task — the task named in `FEATURE_ID`. |
| `gym-director` | ✓ | Gym Director (per-gym-task optimization pipeline) — You are the **gym-director** for a SINGLE gym-task inside a durable pipeline (the |
| `judge` | ✓ | Judge (frozen evaluator of record) — You are the **judge** for the `gym` blueprint — a FROZEN, independent evaluator of |
| `task-generator` | ✓ | Task Generator (gym eval-set author) — You are the **task-generator** for the `gym` blueprint. Your job is to produce (or |
| `variant-runner` | ✓ | Variant Runner (target sub-harness driver) — You are the **variant-runner** for the `gym` blueprint. You run **one variant** of |
| `proposer` | ✓ | Proposer (target-blueprint edit synthesizer) — You are the **proposer** for the `gym` blueprint. From the judged eval-matrix, you |
| `scanner` | ✓ | <!-- |
| `director` | ✓ | Director (per-feature durable pipeline) — You are the **director** for a SINGLE feature inside a durable pipeline |
| `committer` | ✓ | Committer (accepted-edit commit → reproject) — You are the **committer** for the `gym` blueprint — the finalize step that makes an |
| `tester` | ✓ | You are the **TESTER** in the **staging** phase of an autonomous coding harness. |
| `test-writer` | ✓ | You are the **TEST-WRITER** in the testing phase of an autonomous coding harness. |
| `monitor` | ✓ | You are the **MONITOR** in the production phase of an autonomous coding harness. |
| `blender` | — | chat/runtime surface — no spawn persona |
| `foreign-session` | ✓ | You are a **foreign-session** agent — Papercusp's execution identity for work |

Built-in roles with no persona file (chat/runtime surfaces): `oracle`, `blender`.

## Persona-only roles (blueprint deciders & helpers)

These have a spawn persona but are not `AGENT_ROLES` entries — blueprint deciders (`director`, `*-director`, `scanner`) and the reactive helpers blueprints dispatch (`searcher`, `finding-verifier`, `transformer`, …).

| Role | Summary |
|---|---|
| `advocate` | Advocate — argue against the lead — You are the **advocate** (devil's advocate) in a `vote` deliberation |
| `agent-base-overlay` | Software engineering — This pot does software engineering. The task that follows is a coding task in a real |
| `agent-base-preamble` | Agent base preamble (domain-neutral system prompt) — You are an agent that completes tasks as part of a coordinated pot. Your specific role, |
| `directed-implementer` | Directed Implementer — You are the **IMPLEMENTER** half of a directed pair. A **pair-director** decomposes the |
| `gaia-worker` | You are a **single autonomous general-assistant agent** answering **one real question** |
| `pair-director` | Pair Director — You are the **DIRECTOR** half of a directed pair. You hold an engagement, decompose it into |
| `su` | Superuser engineer-collaborator (su) — domain-neutral base persona — You are a **senior engineer-collaborator** with **operator + admin** authority across |
| `voter` | Voter — one lens of a `vote` deliberation — You are a **voter** in a `vote` deliberation (coordination-ops-as-blueprint-primitives). |
