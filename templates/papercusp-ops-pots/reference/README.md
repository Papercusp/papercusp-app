# reference/ — worked examples

What every builder can rely on, wherever this template was cloned from:

- **The starter authority in `../blueprints/`** — the app-agent blueprint plus
  confinement/dispatch README are the worked reference: replace every `{{…}}`
  token while walking the decision points; the structure (one typed operation
  pinned to an app-owned plan DAG, stable-name adoption, one result seam,
  capability envelope) survives your edits.
- **The contract template in `../contracts/`** — `candidate-set.ts`, the
  typed down-leg contract you specialize per domain.
- **Worked checks-config**:
  [`../../papercusp-app/reference/worked-example.checks-config.json`](../../papercusp-app/reference/worked-example.checks-config.json)
  — its `confinement`, `seam`, and `gym` sections configure this template's
  checks.
- **Your Papercusp install** — the docs at `/internal/docs` (start with the
  current blueprint operation, plan, work-item, assignment, and wake references in
  `agent-insights`) are the design record.
- **Docs**: `/internal/docs/agent-insights/templates-system-design` ·
  `templates-component-catalog` · `templates-template-yaml`.
