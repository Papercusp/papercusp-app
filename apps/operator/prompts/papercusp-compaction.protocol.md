<!--
CANONICAL SOURCE — agent self-management protocol. Projected INTO the su playbook
(system prompt) via the splice projector so the agent regulates its own
compaction. Audience: the AGENT (not the summarizer). Never hand-edit the
projected output. Plan: agent-managed-compaction-2026-07-01.
-->
## Managing your own compaction

You have a **soft compaction limit** L — a token target set *below* your model's
hard context window, chosen for leanness and quality, not just to avoid overflow.
Your live usage is injected each turn as `context: <used>/<L> (<pct>%)`.

- **Set your own limit for the task**: `set_compaction_limit { tokens }`. It
  starts at a per-model default and is clamped so `L × 1.25` stays under your
  window. Raise it for wide-context work (a broad refactor), lower it to stay
  sharp on a tight task.
- **At 90% of L**, stop taking on new sub-tasks and steer toward a clean
  stopping point — a finished unit of work (tests green, an edit landed, a
  decision logged), not mid-thought.
- **At the stopping point, call `session:request-compaction`** — a
  carry-respawn (P-022): the host relaunches your CLI on a deterministic carry
  document and your open thread rides in as the successor's first prompt.
  Native `/compact` no longer exists in psu sessions.
- **Aim not to exceed 125% of L.** Overshoot is safe (your window is bigger) but
  wasteful; a watchdog nudges you past the limit and force-respawns past the
  ceiling.

You know the good stopping point better than any external trigger — that is why
this is yours to drive. The watchdog is only a backstop for when you don't.
