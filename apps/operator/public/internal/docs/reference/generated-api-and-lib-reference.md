# Generated API & lib reference (projection site)
URL: /internal/docs/reference/generated-api-and-lib-reference

The operator HTTP/tool API and the libs/generic TypeDoc API rendered as a browsable human site, projected directly from code. Built on demand via npm run docs:preview; additive to the hand-written docs, replacing none of them.

import { Aside } from '@astrojs/starlight/components';

Two parts of this reference are **projected directly from code**, not hand-written —
so they never drift. They are **additive**: they document surfaces that never
existed as hand-authored pages, and they replace none of the conceptual,
spec, design, or runbook docs in this site.

* **Operator API** — every HTTP-exposed `defineTool` projected into an OpenAPI 3.1
  spec (`npm run gen:openapi`) and rendered with [`starlight-openapi`](https://starlight-openapi.vercel.app/).
* **Lib API** — the borrowable `libs/generic/*` libraries' public TypeScript API,
  rendered with [`starlight-typedoc`](https://starlight-typedoc.vercel.app/) from
  the same entry points `npm run gen:lib-api` resolves.

This is the human half of the "two independent projections of one source" design
(`docs-and-memory-as-projections-2026-06-05` D-004): the agent form is served
directly from code over the `docs:*`/MCP surface, and this site is the parallel
human view of the **same** artifacts.

## Building & browsing it

The render is **generated on demand**, behind a `DOCS_PREVIEW` build, so it is not
baked into the default docs build (which stays fast and free of the
operator-core registry import + the multi-lib TypeDoc run). To build and browse it:

```bash
# from the repo root
npm run docs:preview          # gen:openapi + DOCS_PREVIEW=1 astro build -> dist-preview
npm run docs:preview:serve    # serve it; open the printed URL
```

Then browse:

* **`/internal/docs/preview/api`** — the Operator API reference (one page per operation).
* **`/internal/docs/preview/lib-api`** — the libs/generic TypeScript API.

Rendering the full reference runs a multi-lib TypeDoc pass (\~2.5 min) and imports
the live `defineTool` registry. Baking that into every docs rebuild would slow the
default build \~4x fleet-wide and couple it to the registry. Until that tradeoff is
accepted (it is one flag — enabling `DOCS_PREVIEW` on the default build path), the
reference is generated on demand. See plan
`starlight-projection-site-2026-06-18` (D-006).

## Don't hand-edit it

These pages are a **projection**. Edits go to the source — the code (for the API/lib
surface) or the plans/insights (for rationale) — never to the generated output, which
is overwritten on every build.
