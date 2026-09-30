# The app-template system — scopes, the composition closure, and how a template becomes an app
URL: /internal/docs/agent-insights/templates-system-design

How Papercusp's official app templates are structured (app roots vs aspects), how the requires/composesWith closure and the checks union work, and what actually happens when a template is materialized into a new pot.

Every new Papercusp app starts from a template — never a hand-rolled scaffold. This page is the
map of that system: what a template *is*, how templates compose, and what materializing one
actually does.

> Canonical tree: `templates/<id>/` in this monorepo. The public mirror
> ([Papercusp/templates](https://github.com/Papercusp/templates)) is a copy, one subdir per
> template. The machine schema lives in `@papercusp/template-kit`.

## Two scopes: app ROOTS and aspects

`scope` in `template.yaml` is the load-bearing distinction.

* **`scope: app`** — a whole application. There are exactly **three app-scope roots**, and
  picking between them is the first decision in any "build me an app" request:

  | root                            | shape                                                |
  | ------------------------------- | ---------------------------------------------------- |
  | `papercusp-webapp`              | a web app (browser; `papercusp-web-host` chassis)    |
  | `papercusp-desktop-app`         | a standard Tauri desktop app, **no** embedded agents |
  | `papercusp-agentic-desktop-app` | a desktop app that embeds an agent/pot plane         |

* **`scope: aspect`** — a capability layer that composes *onto* a root: `papercusp-ui`,
  `papercusp-data-layer`, `papercusp-data-sync`, `papercusp-search`, `papercusp-ops-pots`,
  `papercusp-release-pipeline`, `papercusp-tauri-desktop-shell`, `papercusp-web-host`.

**App roots are THIN by design.** A root contributes glue, decision points and a composition —
`components: []` is the normal state for one. Capability belongs in aspects. `papercusp-webapp`
even encodes this as a `must` (`thin-app-template`, enforced by `composition-integrity`).

## The closure: `requires` vs `composesWith`

* **`requires`** — HARD, version-pinned dependencies. Composing the template pulls these in.
  `papercusp-webapp` requires `papercusp-web-host` + `papercusp-data-layer` + `papercusp-ui`.
* **`composesWith`** — templates this one is *designed* to sit beside. Advisory: it drives
  suggestions and decision points, not resolution.

The transitive `requires` set is the **closure**, and the closure is what the app is judged
against.

## The checks union is what CI runs

Each template declares `checks: [{ id, run, summary }]` pointing at `checks/*.test.ts` inside its
own dir. An app built from a composition must pass the **UNION of the closure's checks**, not just
its root's. `composition-integrity` is the one check all three app roots declare — it asserts the
composed set resolves (pins consistent, exactly one `scope: app`) and that the union is what CI
runs.

⚠ **Template checks do not run in this monorepo.** No vitest config owns
`templates/**/checks/*.test.ts`, and `testing:run` on one answers `TEST_FILE_ROUTE_ERROR`. That is
BY DESIGN — those checks are written to run inside a *materialized app* (or against the mirror's
own `package.json` + `vitest.config.ts`). In-repo coverage of template correctness therefore lives
in ordinary operator-core suites, not by invoking the template's own checks.

## GUIDE.md — the composition prompt

`GUIDE.md` is the human/agent build knowledge, written in **MUST / SHOULD / FREE** tiers. A
template's correctness guarantee is **by VERIFICATION, not construction**: the GUIDE says what to
build, the `checks/` prove it. `templates:get-guide` reads it without cloning; `templates:new-app`
hands it to a builder agent as the kickoff brief.

## What materializing actually does

`templates:new-app { template, slug }` →

1. **Resolve the source.** First-party templates ship BUNDLED, so the common path copies
   `templates/<ref>/` straight off local disk (works offline). The Cupboard marketplace clone is a
   dormant v2 seam behind `FLAGS.TEMPLATES_MARKETPLACE`.
2. **Create the pot.** `pot:create` — the app is its own pot (a Hive home), so it is *plan-capable
   from birth*; created idle + local-only. This is the first DURABLE step, so any later failure
   rolls it back (otherwise the slug is taken and the natural retry can never succeed).
3. **Overlay.** `overlayTemplateFiles` copies the **entire `<ref>/` dir** into the new app —
   `fs.cp(recursive, force)`, excluding only `.git` and the harness's own
   `.papercusp/blueprint.yaml`. It is a MERGE, not a replace.

**The overlay boundary is the single most important fact about this system:** nothing *outside*
`<ref>/` reaches the app. That constraint is what forces the supply-chain layout below.

## Supply chain — what a materialized app can actually depend on

The component packages are `private: true` and 404 on npm, so a materialized app gets them one of
two ways:

* **Vendored INTO the template dir** — `template-kit/` and `pot-app-seam/` are copied inside each
  app-root template, so they ride `sidecar/templates` to **every platform** and resolve as
  `"@papercusp/template-kit": "file:./template-kit"` after a plain `npm install`. This is why
  those two work everywhere.
* **`file:`-linked from the install's `libs/generic`** — everything else
  (`@papercusp/sync`, `ui-primitives`, …). That tree only exists where the build shipped
  `source.tar.zst`.

🚨 **Never hardcode a path for the second case.** The old documented example
`"file:../papercusp/libs/generic/sync"` is dev-checkout-relative and resolves to nothing on a real
install. The path is per-install and the product reports it: `templates:get-guide` and
`templates:new-app` both return a **`supplyChain`** block with the resolved absolute root, and
`templates:new-app` injects it into the builder kickoff. `supplyChain.root: null` is a real
answer — that install has no tree (the macOS GUI app and cross-built macOS bundles are the known
cases), and the honest response is to build with what the template vendors, not to invent a path.

## Where to look

| you want                 | go to                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| the manifest schema      | `agent-insights/templates-template-yaml`                           |
| what components exist    | `agent-insights/templates-component-catalog`                       |
| the supply chain in full | `templates/README.md` § Supply chain                               |
| the resolver             | `packages/operator-core/lib/cupboard/generic-libs-root.ts`         |
| materialize semantics    | `packages/operator-core/lib/cupboard/materialize-template-core.ts` |
