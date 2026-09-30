# checks/ — the acceptance suite for an app built from this template

These are **portable** checks: they are written to run in this repo (against
the sibling template dirs) and, unchanged, inside a materialized app that
carries `@papercusp/template-kit`. They are parameterized by a JSON file whose
path arrives in `TEMPLATE_CHECKS_CONFIG`.

## `checks/composition-integrity.test.ts`

Validates the **composition plan**, not the built app — the template set
parses, component pins match the catalog, exactly one ROOT app-scope template
owns the composition, and the union-of-checks is the full additive set.

It also covers the `target` axis, which is what makes one root serve both
runtime targets:

- **selecting no chassis must FAIL to compose.** Before this root existed, a
  hard `requires` pin guaranteed a chassis was present. `target` replaced that
  pin with a choice, so this negative case is the guard that the guarantee
  survived the change. It stays here permanently, and deliberately: a guard
  only ever observed passing is not evidence that it can fail.
- **each answer pulls in its own chassis and NOT the other** — the whole point
  of the axis.
- **`both` carries the UNION of both chassis check suites**, which is the real,
  recurring cost of a dual-target app and the reason `both` is opt-in.
- **an unanswered or unknown answer is an error**, never a silent default.

Config section (all optional):

```json
{
  "composition": {
    "templateYamls": ["path/to/template.yaml", "..."]
  }
}
```

Omit `templateYamls` and the check walks every sibling template dir. Supply it
and the listed set is treated as a legitimate chosen SUBSET of the registry —
`composesWith` is descriptive affinity and may name templates outside it.
