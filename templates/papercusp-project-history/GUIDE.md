# papercusp-project-history — composition GUIDE

**Papercusp Official: Project History.** This aspect gives any Papercusp-managed
project the same generated History plane. The installed CLI owns ledger and Git
I/O; `@papercusp/plan-parser` owns the product-neutral schema and assembler; the
app owns only configuration, artifact transport, and presentation.

Generate JSON for a static host:

```bash
papercusp project-history generate \
  --harness my-project \
  --prefix= \
  --project-id my-project \
  --project-name "My Project" \
  --repo . \
  --output .papercusp/project-history.v2.json
```

Use `--format typescript --export-name PROJECT_HISTORY` when a server package
imports committed generated data. Add the identical command with `--check` to a
focused test or build gate so stale output fails instead of shipping.

## MUST

- Treat the artifact as disposable derived output. Papercusp plan/work-item
  ledgers and Git remain authoritative.
- Invoke the installed `papercusp` command. A consumer must never require a
  `PAPERCUSP_REPO_ROOT` or import files from a Papercusp source checkout.
- Reject unknown `schemaVersion` values. Upgrade the adapter deliberately.
- Keep the consumer thin: choose scope and project identity, serve/import the
  artifact, and compose the UI. Extend the shared assembler for new fields.

## Scope and transport

The default plan filter is `<harness>-`. Pass `--prefix=` when the whole harness
is canonical even if its plan slugs use several prefixes. JSON is the portable
default; TypeScript is a convenience transport for server builds, not a second
schema.

See the installed docs at `/internal/docs/build-system/project-history` for the
contract, command reference, provenance rules, and consumer checklist.

## Checks

`checks/project-history-artifact.test.ts` is portable and config-driven. Copy it
into the composed app and point `TEMPLATE_CHECKS_CONFIG` at:

```json
{
  "app": { "root": "." },
  "projectHistory": {
    "artifact": ".papercusp/project-history.v2.json",
    "projectId": "my-project",
    "harness": "my-project"
  }
}
```
