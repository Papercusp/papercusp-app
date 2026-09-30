<!--
Claude Code overlay for the compaction instructions. Spliced into
papercusp-compaction.base.md at PAPERCUSP-COMPACTION:CLIENT-OVERLAY. The rendered
result is projected under `# Compact Instructions` in root/user CLAUDE.md (via
@import). Canonical — do not hand-edit the projected output.
Plans: agent-managed-compaction-2026-07-01; P-022 (deterministic-context-carry)
retired native compaction in psu sessions 2026-07-18.
-->

## Claude Code specifics (P-022: native compaction is retired in psu sessions)

In a **psu session**, `/compact` does not exist (`DISABLE_COMPACT`) and native
auto-compact never fires (`DISABLE_AUTO_COMPACT`). The deliberate cut is
**`session:request-compaction`** — a carry-respawn: the host relaunches your CLI
on a deterministic carry document, and your open thread rides in as the first
prompt. The native summarizer never runs, so for these sessions the
instructions above govern what you FLUSH before requesting the cut, not a
summary.

In a **non-psu terminal** (a plain `claude` the owner runs directly), native
compaction still exists and these instructions are the summarizer's guidance.
When deliberately compacting there, name the current unit of work in the
focus, e.g.:

`/compact keep the identity block, active plan <slug> and its open items, unverified claims, and owner-walls; drop resolved tool output.`

Auto-compactions you did not trigger fall back to these `# Compact Instructions`
alone — which is why they live in root/user CLAUDE.md (nested CLAUDE.md is not
re-injected after compaction).
