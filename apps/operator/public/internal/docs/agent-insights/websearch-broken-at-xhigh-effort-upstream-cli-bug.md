# Native WebSearch is 100% broken at --effort xhigh in the claude CLI — an upstream binary bug, not fixable from this repo
URL: /internal/docs/agent-insights/websearch-broken-at-xhigh-effort-upstream-cli-bug

In any psu Claude Code session launched with --effort xhigh, every WebSearch call 400s with \"output_config.effort 'xhigh' is not supported when thinking is disabled\". WebSearch dispatches to an internal summarizer sub-model that inherits the session's xhigh effort but not its thinking config — a bug inside the proprietary claude binary (confirmed: no --help flag, no settings.json key, and no papercusp source path touches WebSearch's internal dispatch). Cannot be patched here; route around it and report upstream.

## The symptom

In a psu Claude Code session running at `--effort xhigh` (the CLI's own top-level
session flag — `claude --model <m> --effort xhigh`), **every** call to the native
`WebSearch` tool fails immediately:

```
API Error: 400 output_config.effort 'xhigh' is not supported when thinking is
disabled on this model. Use effort 'high' or below, or enable thinking.
```

Reproduced deterministically (3/3, different queries — EI-18753696723750409).
`WebFetch` on the same turn works fine, so it's specific to whatever internal
model call `WebSearch` makes.

## Why this is NOT a papercusp bug

`WebSearch` is a **native** Claude Code tool — it is not an MCP tool papercusp
defines, wraps, or dispatches. The `claude` binary itself is a proprietary,
non-vendored executable (`~/.local/bin/claude`, installed via the
`@anthropic-ai/claude-code` package) — there is no source for it in this repo to
patch. `--effort` is passed straight through as a single top-level CLI flag
(`apps/operator/scripts/psu-launcher.mjs`: `if (agent === 'claude' && m) return ['--model', m[1], '--effort', m[2]]`); papercusp has no lever that reaches
`WebSearch`'s internal sub-model invocation specifically. `claude --help` has no
separate flag for it, and no `settings.json` key controls it either.

The apparent root cause (from the error text): `WebSearch` dispatches to a
small/fast internal summarizer model. The parent session's `output_config.effort`
(xhigh) is being propagated to that sub-invocation, but the sub-invocation has
thinking disabled — and `xhigh` is only a valid `effort` value when thinking is
enabled. This is a bug in the CLI's own internal call construction, not in
anything reachable from papercusp's launch code.

## What to do instead

**In this session:** if `WebSearch` 400s with this exact message, don't retry it —
switch tool:

* Prefer the **firecrawl** plugin's search verb when `FIRECRAWL_API_KEY` is
  configured (`plugins:runtime_status` to check) — a real open-web search,
  independent of this CLI-internal path.
* Otherwise, `WebFetch` against a structured query API directly, e.g. for academic
  literature: `http://export.arxiv.org/api/query?search_query=abs:%22...%22&sortBy=submittedDate&sortOrder=descending&max_results=40`
  or the Semantic Scholar Graph API. Strictly worse than a real web search (no
  open-web ranking), but functional.
* Or, if the session isn't pinned to `xhigh` for a specific reason, drop to
  `--effort high` for the turn(s) that need `WebSearch`.

**Durably:** report this to Anthropic (it's their CLI, their fix). Until then,
anyone whose saved default effort is `xhigh` should expect `WebSearch` to be
completely unavailable and should know the workaround above exists — don't
re-diagnose this from scratch, and don't file a duplicate bug for it.

## Recurrence

`EI-18753696723750409` is intentionally NOT closed `done` — there is no code
change in this repo that fixes it. It is being marked `needs_human`, because the
actionable next step (report upstream to Anthropic, and/or the owner deciding
whether `xhigh` should still be the saved default given this tradeoff) is outside
this fleet's authority. This doc is the durable pointer so the diagnosis survives
even after the work item closes.
