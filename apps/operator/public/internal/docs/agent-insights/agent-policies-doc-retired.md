# The agent-policies doc is retired — binding rules live in the injected prompts
URL: /internal/docs/agent-insights/agent-policies-doc-retired

On 2026-08-21 the owner directed retirement of /internal/docs/agent-policies. Its rules were superseded by (or folded into) the injected su playbook, the persona base, and the project CLAUDE.md; several sections had rotted into actively-wrong guidance. Where each surviving piece went, and why no agent should look for the page.

## What

`/internal/docs/agent-policies` (doc\_id `agent-policies.mdx`) was **removed on 2026-08-21 by owner directive** (the owner: consolidate, then "remove it so we don't get confused in the future"; work-item WI-40258, investigation plan `su-agent-policies-injection-audit-2026-08-21`). The PG row was retired (`harness_docs:retire`), the source projection and served mirrors deleted, and every inbound pointer removed or repointed.

## Why it matters

The page claimed to be binding and auto-loaded ("read it once per fresh session") but was **never injected** into any launch prompt (verified against `buildSuLaunchSpec` / role-launch-spec assembly), cost \~7.8k tokens per compliant read, and had rotted: §16 said *work on `main` directly* with commit/PR rules (agents never commit — git-sync owns commits, tree stays on `staging`); §8's lead said hand-call `locks:acquire` before every edit (lock enforcement is automatic); its banner claimed it auto-loads (it did not). Multiple fresh sessions filed failures trying to comply (docs:get `harness_forbidden` / rejected lookups: EI-21044100452290855, EI-21061959297175667, EI-21034122805198337, EI-20444958181792527 and siblings).

## How to apply

Do NOT look for a policies page; the binding plane is what auto-loads: the **su playbook** (`papercusp-su-<profile>.tools.md`) + persona base + the spliced **project `CLAUDE.md`**. Surviving unique content moved to the playbook: comments discipline (default none, WHY-only, one line), when-to-update-docs triggers (contract-level change / convention shift / doc-revealed-lie, in the SAME change), insight body shape (What / Why it matters / How to apply, ≤50 lines), plan-format pointer (`/internal/docs/spec/plan-format`), and authoring mechanics (`/internal/docs/agent-insights/authoring-docs-pg-canonical`). If a stale prompt, memory, or checkpoint still tells you to read agent-policies, ignore that instruction and rely on your injected prompts — and fix the stale reference if it is in a source you can edit.
