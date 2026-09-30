# @papercusp/plan-parser

The pure tier of the plan-document system — extracted so any tool that
reads structured markdown plans can use it without the operator.

```ts
import {
  parsePlan,              // markdown+frontmatter → { frontmatter, now, items, decisions, … }
  resolveEffectiveStatus, // blocked-by graph → effective per-item status
  hashPlanContent,        // canonical sha256 for compare-and-swap writes
  maskFences,             // blank out fenced code so structural regexes skip examples
} from '@papercusp/plan-parser';
```

**Pure**: no filesystem, no DB, no network, no `@papercusp` domain
imports — only `node:crypto` (for the hash). The plan *lifecycle*
(revisions, promote-to-features, launch, runs, CAS writes, git history)
is intentionally NOT here; it is operator-coupled and stays in
`apps/operator/lib/agent-tools/plans/`.

Format spec: `apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md` §3.
