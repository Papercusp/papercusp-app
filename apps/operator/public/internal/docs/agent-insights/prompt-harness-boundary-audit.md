# The prompt–harness boundary audit — we enforce what touches FILES and exhort what touches PROCESS
URL: /internal/docs/agent-insights/prompt-harness-boundary-audit

An audit of every behavioural imperative in the su persona and the three CLAUDE.md layers, classified by whether the harness ENFORCES it (a blocking hook, a lint, a schema constraint, a CI gate) or merely asserts it in prose. The finding is a clean split along one axis: rules protecting FILES are enforced almost without exception (22 hooks, 54 lint scripts); rules governing PROCESS — hold a work-item before editing, declare intent, plan first, capture the workaround, evidence on completion — are almost entirely prose-only. Prose-only rules measurably drift: completion-evidence compliance ran 47.1% then 59.1% then 34.9% bare across three consecutive weeks, the non-monotonic signature of a rule carried by exhortation rather than structure.

Produced for P-001 of the plan `agent-protocol-authority-semantics-2026-07-26`.

## Why this audit exists

XFlow (arXiv:2606.14790) frames the "prompt–harness boundary" as a design object: *which workflow commitments should stay as actor-interpreted instructions, and which should become harness structure that can be checked, preserved, and enforced?* Their empirical result is that moving commitments into structure buys **process compliance** rather than task success — on τ³-bench task success barely moved (sometimes dropped) while constraint compliance rose 96.5%→100%, 91.8%→100%, and in one case 63.7%→100%.

We already had in-house evidence for that claim. We had simply never looked at it deliberately.

## Method

Sources walked: the su persona blueprint (base + overlay), `~/CLAUDE.md`, `~/.claude/CLAUDE.md`, `papercusp/CLAUDE.md`, and the tool `guidance` catalog.

For each imperative (MUST / NEVER / ALWAYS / required / forbidden), the enforcement mechanism was located **and read** — not assumed. That mattered: several rules that look enforced because a hook exists turned out to be advisory once the hook was opened.

* **ENFORCED** — a mechanism refuses the violating action (`permissionDecision: "deny"`, a failing lint, a schema rejection, a red CI gate).
* **NUDGE** — a mechanism observes and emits a message; the action proceeds.
* **PROSE** — no mechanism; compliance depends on the agent having read and remembered.

## The enforcement surface is larger than most agents assume

**22 configured hooks** (`~/.claude/settings.json`): 9 PreToolUse, 4 PostToolUse, 1 SessionStart, 2 SessionEnd, 3 Stop, 2 UserPromptSubmit, 1 Notification.

**54 `lint:*` scripts** in the root `package.json` — `no-raw-setinterval`, `no-retired`, `env-feature-gates`, `generic-first`, `migrations`, `no-sql-json`, `no-workspace-default`, `scope-defaults`, `no-identity-literals`, `assert-integrity`, `insight-citations`, `tsc`, and more.

The instinct that "papercusp runs on prose" is wrong. It runs on a large enforcement surface with a specific, systematic hole.

## ENFORCED — file and code safety

| Imperative                                           | Mechanism                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Claim a file lock before editing                     | `pretooluse-locks-acquire.sh` — verified `permissionDecision: "deny"`                                  |
| Release the lock after editing                       | `posttooluse-locks-release.sh`                                                                         |
| Edit only the canonical staging tree                 | worktree guard (PreToolUse)                                                                            |
| Never open `:3055`/`:3070` in a browser              | `guard-operator-desktop.mjs`                                                                           |
| No secrets into tree files                           | `pretooluse-secrets-guard.mjs`                                                                         |
| No identity leaks in content                         | `pretooluse-content-lint.mjs` + `lint:no-identity-literals` / `no-owner-name-tags` / `no-box-identity` |
| Bash resource ceilings                               | `pretooluse-bash-resource-gate.sh`                                                                     |
| Prefer tools over bash for known reads               | PreToolUse routing gate, registry-generated                                                            |
| No bare `setInterval`                                | `lint:no-raw-setinterval` (empty baseline) + `lint:timer-classification`                               |
| No imports from retired surfaces                     | `lint:no-retired`, `lint:no-retired-style`                                                             |
| Feature toggles are FLAGS entries, not `process.env` | `lint:env-feature-gates`                                                                               |
| New flags default ON; dark flags rationed            | `production-defaults.test.ts` + `DARK_FLAGS_HIGH_WATERMARK` / `DARK_FLAGS_PARKING_COUNT`               |
| Migration hygiene                                    | `lint:migrations`, `lint:drizzle-drift`, `lint:no-sql-json`                                            |
| Tenant scoping on raw SQL                            | `lint:no-workspace-default`, `lint:scope-defaults`, runtime advisory on `dev:pg_query`                 |
| npm only, never pnpm/yarn                            | `only-allow npm` in root `preinstall`                                                                  |
| Tool guidance within prompt-weight budget            | `tools-md-sync` + registration-time re-check                                                           |
| New tests in one of four frameworks                  | `lint:tests` + CI lint P-038                                                                           |
| Content/dialog delivery separation                   | `ask-gate-mirror.sh`                                                                                   |
| Turn provenance stamping                             | `userpromptsubmit-provenance.sh`                                                                       |
| No desktop notifications                             | no-op shim at `~/.papercusp/bin/notify-send`                                                           |
| No tree-wide destructive git ops                     | Bash guard                                                                                             |

## NUDGE — observed but not prevented

| Imperative                                                | Mechanism                                               | Why it is only a nudge                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Hold a work-item before editing; verify before completing | `workitem-verify-nudge.sh`                              | **`exit 0` only — no `permissionDecision`, no deny path.** Fires PostToolUse / Stop / SessionEnd, i.e. *after* the edit.             |
| Completion carries verification evidence                  | completion gate in `setWorkItemState` / `setIssueState` | Binds on `terminal_completion_ref`, which `work_items:complete` **auto-fills from `completion.summary`** — non-null by construction. |

## PROSE — no mechanism at all

Declare intent and claim your lane · Plan before non-trivial work; confirm the route · Register mode changes (`mode:set`) · Reuse-first, extend don't fork · Start a new app from a template · The papercusp-way routing gate · File what you discover the moment you work around it · A mitigation is not a fix · Never blame "high load" without a mechanism · A red gate is yours to green · A cross-lane ruling is a plan Decision · Read design docs before design work · Read `/internal/docs/performance` first · Use Context7 for library APIs · Apply migrations via the runner not `psql -f` · Use `npm run install:safe` · **Edit sources, never rendered outputs** · State goes in nuqs · Sync goes through `@papercusp/sync`

## The finding

**The split is an axis, not noise.**

> Rules that protect a **file** are enforced. Rules that govern a **process** are exhorted.

Every ENFORCED row is ultimately about tree contents: don't clobber a peer's file, don't leak a secret, don't import a retired module, don't write a bare timer. Violations are detectable *at the moment of the write*, so a `PreToolUse` hook or a lint can sit exactly there.

Every PROSE row is about the *shape of the work*: whether it was planned, claimed, verified, captured. Those violations are not detectable at any single tool call — only in the relationship *between* calls, or between a claim and its evidence. No hook sits there, so nothing enforces them.

### The proof that prose does not hold

Completion-evidence compliance, measured live 2026-07-26 (issue family, weekly):

| week       | terminal rows | % with **no** structured evidence |
| ---------- | ------------- | --------------------------------- |
| 2026-06-22 | 696           | 100.0%                            |
| 2026-06-29 | 3,511         | 91.8%                             |
| 2026-07-06 | 1,225         | 47.1%                             |
| 2026-07-13 | 5,268         | 59.1%                             |
| 2026-07-20 | 1,428         | 34.9%                             |

All-time, both families: **65.6% of 14,663 terminal rows carry no structured verification evidence.**

The trend is **non-monotonic**: 47.1 → 59.1 → 34.9. A structurally-enforced rule does not regress like that; it steps to \~0 and stays. A prose rule drifts with whatever else competes for attention that week. That shape *is* the diagnosis.

### Why the completion gate does not count as enforcement

The most instructive row, because it looks enforced and is not.

`setWorkItemState` / `setIssueState` genuinely reject a terminal transition without a completion ref. But every field on `CompletionVerificationEvidenceSchema` is `.optional()`, and `completionEvidenceFromRecord` returns `undefined` when none are supplied — while `terminal_completion_ref` is auto-filled from `completion.summary`.

The gate binds on a column that is **non-null by construction**. The in-repo comment states it exactly: it was *"auditing 'did a completion record exist', not 'was this actually verified'."*

> **Generalizable lesson: a gate that binds on a field the system auto-fills is not a gate.** It is a ritual producing the appearance of compliance. When adding an enforcement point, check what happens when the agent supplies *nothing* — if the write still succeeds, the constraint is decorative.

### A live demonstration, collected while writing this audit

Writing this document, the author wrote it first to `apps/operator/public/internal/docs/agent-insights/*.md` — the **generated output** — rather than `apps/operator-docs/src/content/docs/agent-insights/*.mdx`, the source. That is prose rule "edit sources, never rendered outputs", violated by the very agent enumerating it, within minutes of enumerating it.

The trap is structural: the generated directory is **git-tracked** (not ignored), holds 1,221 files, and is a plausible-looking home for the doc. Nothing blocks the write. It was caught only because `lint:insight-citations` happens to scan the source tree, so the new file's absence from the lint's view was a tell — an accident, not a guard.

This is the audit's thesis reproducing itself in real time, and it belongs in the promotion shortlist below.

## What follows

1. **Promoting a prose rule into the harness is the highest-leverage reliability work available.**
2. **Do not add a rule to the persona and consider it done.** The persona is where a rule goes to be *understood*; the harness is where it goes to be *kept*. A rule that matters needs both.
3. **Do not layer an audit over a prose rule either.** An after-the-fact audit is the bandaid form of enforcement — it detects the violation once the wrong state already exists. Restructure so the wrong state is unrepresentable.

## Ranked promotion shortlist

By blast radius when violated:

1. **Completion carries verification evidence** — defeated by auto-fill; 65.6% non-compliant. Make evidence required for the committed state.
2. **Hold a work-item before editing** — nudge only, and it fires *after* the edit. A PreToolUse gate matching the lock hook's shape.
3. **Writes to generated//`dist`/`public` doc + prompt trees** — no guard, git-tracked, actively trapped an agent (above). A PreToolUse deny mirroring the worktree guard.
4. **File what you discover at the moment you work around it** — the friction evaporates into transcript prose within the same turn. A Stop-hook detecting retry-with-changed-args / tool-fallback.
5. **Register mode changes** — an unregistered mode is invisible to peers and dies at compaction. Gate the behaviours on the registry rather than on transcript memory.

Items 1–2 are in flight under `agent-protocol-authority-semantics-2026-07-26`. Items 3–5 are candidates, not commitments.
