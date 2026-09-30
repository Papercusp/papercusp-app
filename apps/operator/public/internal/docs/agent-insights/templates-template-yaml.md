# template.yaml — the app-template manifest schema
URL: /internal/docs/agent-insights/templates-template-yaml

Field-by-field reference for a template's machine manifest: scope, category, requires vs composesWith, checks, musts and enforcedBy, and what validateTemplateManifest does and does not check.

`template.yaml` is a template's **machine** manifest — the twin of its human `GUIDE.md`. It sits at
`templates/<id>/template.yaml`; the schema is `TemplateManifest` in
`@papercusp/template-kit` (`src/template-manifest.ts`), which is the authority if this page ever
disagrees with it.

## Fields

| field            | required | notes                                                                                                                   |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`             | yes      | kebab-case; matches the directory name                                                                                  |
| `version`        | yes      | semver                                                                                                                  |
| `scope`          | yes      | `app` \| `aspect` — see the system-design page; exactly one `app` per composition                                       |
| `category`       | yes      | `app` `agentic` `shell` `data` `search` `ui` `release` `design`                                                         |
| `summary`        | yes      | one paragraph; what the template is for                                                                                 |
| `components`     | yes      | `[{ id, version }]` — catalog components this template contributes. **`[]` is normal for an app root** (roots are thin) |
| `contracts`      | yes      | typed-contract ids; may be `[]`                                                                                         |
| `decisionPoints` | yes      | `[{ id, prompt }]` — questions the builder must answer before composing                                                 |
| `composesWith`   | yes      | template ids this stacks with. Advisory, may be `[]`                                                                    |
| `requires`       | no       | `[{ id, version }]` — **HARD pinned** cross-template deps; pulls in the whole closure                                   |
| `docs`           | no       | `/internal/docs` page slugs the builder should consult when the GUIDE is not enough                                     |
| `checks`         | yes      | `[{ id, run, summary }]` — **non-empty**; the acceptance suite                                                          |
| `musts`          | no       | `[{ id, rule, enforcedBy }]` — structured invariants                                                                    |

## `requires` vs `composesWith`

The distinction decides resolution, so do not blur it:

* **`requires`** is a hard, version-pinned edge. Composing this template pulls the target in, and
  the checks union covers the whole transitive closure.
* **`composesWith`** says "designed to stack with" — it drives suggestions and decision points and
  resolves nothing.

## `musts` and `enforcedBy` — debt made visible

Each must links an invariant to the check that PROVES it:

```yaml
musts:
  - id: thin-app-template
    rule: "The app template adds glue guidance and decision points, never its own components"
    enforcedBy: composition-integrity      # the id of a check in `checks`
  - id: full-union-green
    rule: "The composed app passes the FULL union of the closure checks"
    enforcedBy: prose-only                 # MUST_PROSE_ONLY — declared, unenforced
```

`enforcedBy: prose-only` is the literal `MUST_PROSE_ONLY`. It is **not** a failure — it is how a
real-but-unautomated invariant stays countable instead of silently vanishing.
`unenforcedMusts(manifest)` returns exactly that set, which is the honest "how much of this
template is enforced by prose" measure. The GUIDE's numbered MUSTs should mirror these ids.

## Validation — and its two real limits

* `validateTemplateManifest(raw)` returns `{ ok, errors }` and reports **every** problem, not the
  first. `parseTemplateManifest(raw)` is the throwing form.
* `validateTemplateAgainstCatalog(manifest, catalog)` additionally checks that every
  `components[].id` resolves in `COMPONENT_CATALOG` at the pinned version — a stale pin fails the
  Cupboard install, the same rule the gym applies.

⚠ **Two things validation deliberately does NOT do — know them before trusting a green validate:**

1. **`docs` slugs are shape-checked, not existence-checked.** The `DOC_SLUG` regex only asserts
   kebab segments separated by `/`. A perfectly-formed slug pointing at a page that was never
   written passes validation — which is exactly how three dangling `agent-insights/templates-*`
   slugs ended up cited by all 11 official templates while resolving to nothing.
2. **`checks[].run` paths are not executed here.** No vitest config in this monorepo owns
   `templates/**/checks/*.test.ts` (by design — they run in a materialized app), so a manifest can
   name a check file that never runs in CI.

Both are why template correctness needs guards in ordinary operator-core suites, not just a
manifest validate.

## Worked example

`templates/papercusp-webapp/template.yaml` is the reference app-root manifest: `scope: app`,
`components: []`, three hard `requires`, decision points for domain/tenancy/optional-planes, one
`composition-integrity` check, and four `musts` of which three are `prose-only`. Its machine twin
is pinned in `src/reference-templates.ts`, so the kit's own suite fails if the file drifts.
