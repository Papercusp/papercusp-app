# 13. How Papercusp compares to existing projects
URL: /internal/docs/spec/compared



Project
Stars
Core abstraction
What it solves

gstack84kSlash-commands inside Claude Code as a virtual eng teamMarkdown-defined "team members" accessed as Claude Code slash commands.
Open Interpreter63kCode-running LLM with full system access"Talk to your computer" — natural-language shell.
Paperclip59kCompanies (CEO → directors → specialists), agents, adapters"Deploy an AI workforce" — pre-built domain teams + control plane.
AutoGen57kConversation between configurable agentsGeneric multi-agent programming framework.
CrewAI50kCrew of role-playing agents on a taskSequential / hierarchical task delegation.
LangGraph30kAgents as a directed graph of state transitionsExplicit graph-of-agents.
Smolagents27kCode-as-action agentsAgents that emit Python code as their actions.

### 13.1 Paperclip deep-dive

Paperclip is the closest existing project to Papercusp — but the relationship is more competitive than complementary, despite some surface similarities. Critical context: they explicitly say they are NOT an agent framework. From their README: "We don't tell you how to build agents. We tell you how to run a company made of them."

Paperclip's twelve subsystems

Identity & Access — board users, agent API keys, run JWTs, company memberships
Org Chart & Agents — roles, titles, reporting lines; pluggable adapters (claude-local, codex-local, cursor-local, gemini-local, openclaw-gateway, opencode-local, pi-local)
Work & Tasks — issues with company/project/goal/parent links, atomic checkout, blocker dependencies, comments, attachments, work products
Heartbeat Execution — DB-backed wakeup queue, budget checks, workspace resolution, secret injection, skill loading
Workspaces & Runtime — git worktrees, operator branches, runtime services (dev servers, preview URLs)
Governance & Approvals — board approval workflows, decision tracking, budget hard-stops, agent pause/resume/terminate
Budget & Cost Control — token + cost tracking by company/agent/project/goal/issue/provider/model
Routines & Schedules — cron + webhook + API triggers
Plugins — out-of-process workers, capability-gated host services
Secrets & Storage — encrypted local + provider object storage; sensitive values stay out of prompts unless scoped
Activity & Events — durable activity log
Company Portability — export/import with secret scrubbing + collision handling

### 13.2 How Papercusp positions vs Paperclip

Both projects ship a full vertical stack (substrate + control plane + UI + marketplace). The difference is what gets opinionated:

Paperclip's bet: there's one right way to model an autonomous organization — companies, employees, org charts, goals, governance, budgets. Build that opinionated model well and become the standard for "how AI companies work."

Papercusp's bet: there's no one right way. Build the substrate (drift control, structured handoffs, named decisions) with a plugin architecture for everything above it — including the company model itself. Anyone can publish a "harness config" via the marketplace; the best ones win. Papercup-as-AI-company is just one demo; a marketing-agency or research-lab harness has equal standing.

Analogy: Paperclip is Wordpress — a complete CMS shipped opinionated; you customize via themes/plugins inside their model. Papercusp is React — a runtime + framework on which anyone can build CMSes (or non-CMSes); the model isn't fixed.

### 13.3 Ideas worth borrowing from Paperclip

IdeaWhere in our spec

Goal-ancestry on every task§5.1 — recursive task lineage. Adopted.
Atomic task checkout§5.2 — Postgres `FOR UPDATE SKIP LOCKED`. Adopted.
Hard-stop budget enforcement§5.3 — atomic transaction at proposal-accept. Adopted.
Capability-gated plugins§10 — Tauri-style declarative + Manifest-V3 user consent. Adopted.
Routines as first-class§9 — substrate concept feeding pending\_events. Adopted (mapped onto our orchestrator).
Secret scrubbing on export§11.1 — gitleaks regex set + harness-specific patterns. Adopted.
"What it is NOT" discipline§14 — explicit anti-scope (below). Adopted.
Embedded Postgres for zero-config devReference runtime detail — real embedded Postgres (`@papercusp/embedded-postgres-server`) discovered via `~/.papercusp/embedded-pg.json`; `DATABASE_URL` overrides it.

### 13.4 Ideas explicitly NOT borrowed

Heartbeats as the wakeup primitive. Pure heartbeats wake every agent on a schedule even when there's no work. Our orchestrator + `pending_events` + event-triggered ticks (§6) is strictly better for our shape: zero idle wakeups, centralized auditing, sequential drift control. Heartbeats win for multi-tenant scale (many companies in one deployment) — not our concern. They win for stateless decentralized agents — out of scope.

Their company-as-org-chart abstraction. CEO → CTO → engineers is opinionated about what an autonomous org looks like. Papercusp leaves that to plugins.

Their goal hierarchy at the company level (CEO breakdown → CTO breakdown → …). Adopt parent-link on tasks (yes), but not the org structure.

Mobile UX as a first-class concern. Useful for them (operators monitoring 20 companies). Papercusp's reference runtime is ops-shaped, not mobile-shaped. May change.

### 13.5 The original Claude-Code framework survey (2026-04, historical)

Before the first harness generation was written, 11+ Claude-Code agent
frameworks were surveyed. This is the survey that shaped the original design;
it's preserved here because the borrowed patterns still run in today's engine
(each mapped below). Star counts, project status, and authorship are as of the
survey date.

| Framework                     | Core idea                                     | Pattern adopted                                                   |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| gstack                        | 23 role-based slash commands, "boil the lake" | "Boil the lake" (do fewer things perfectly) in role prompts       |
| Superpowers                   | 7-phase TDD iron law                          | TDD iron law in the validator                                     |
| GSD                           | Per-phase orchestrators, state-to-disk        | Fresh contexts + cache-stable prompts                             |
| Agentwise                     | 8 specialist agents in parallel + dashboard   | Real-time dashboard                                               |
| Hermes                        | Autonomous orchestration with checkpoints     | Named checkpoints *(since deprecated → `needs-human` plan items)* |
| Multi-Agent Ralph Loop        | MemPalace 4-layer memory                      | Layered memory (raw → summary → MEMORY → identity)                |
| ComposioHQ Agent Orchestrator | Git worktrees per parallel agent              | Worktrees per lane *(now transient scratch worktrees)*            |
| OpenSwarm                     | Linear-driven Worker/Reviewer pair            | rejected — no external task source                                |
| Conductor                     | Two-mode parallelism                          | Competition mode *(since removed → work-item redundancy)*         |
| claudecode-orchestrator       | "Quality through truth" + service smoke-test  | Evidence rule + smoke-test gate                                   |
| MOLTRON                       | Self-evolving Skills.md                       | `TRICK:` observation-promotion convention                         |

The ecosystem clustered into **skill packs** (gstack, Superpowers, GSD —
human as orchestrator, one task at a time) and **multi-agent runtimes**
(Agentwise, Hermes, Conductor, ComposioHQ — parallel agents, but each tied to
*their* opinion of how the org should work). The harness took a third
position: a small supervised loop with no opinion about the company, only the
agent runtime — a bet the current blueprint-driven engine still embodies.

Patterns rejected then that stayed rejected: external task sources
(Linear/Notion), vector-DB memory for the inner loop, tmux/Discord/Slack as
control surfaces, agents rewriting their own prompts (audit + determinism
won), and AutoGPT-style infinite loops without decision verbs.

Where the surviving inventions live now:
[decision telemetry + ghost rate](/internal/docs/harness/decisions-timeline),
the [validator's evidence rule](/internal/docs/harness/roles),
[fresh contexts](/internal/docs/harness/decisions/fresh-contexts) +
[prompt-cache discipline](/internal/docs/harness/decisions/prompt-cache),
the [curator](/internal/docs/harness/decisions/curator), and the
[full decision log](/internal/docs/harness/decisions/log).
