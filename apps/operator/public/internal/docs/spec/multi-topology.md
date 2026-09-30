# Multi-topology install
URL: /internal/docs/spec/multi-topology

Templates that scaffold more than one harness in a single install — for orgs, harness-of-harnesses, and any case where a project is intrinsically multi-rooted.

Most published harnesses install as a single project: one slug, one
directory, one row in the registry. But some templates describe a
**topology** of related harnesses that have to be created together —
e.g. a multi-department organization with a parent coordinator and N
child departments sharing a cross-harness message bus.

Multi-topology install is the mechanism for those.

## §1. Manifest

A template opts into multi-topology by setting `topology: "multi"` in
its `papercusp.json` and providing a `subprojects` array.

```json
{
  "name": "papercup-org",
  "version": "0.1.0",
  "topology": "multi",
  "subprojects": [
    { "suffix": "",              "kind": "org",        "dir": "parent" },
    { "suffix": "-business",     "kind": "department", "department_slug": "business",     "dir": "departments/business" },
    { "suffix": "-rd",           "kind": "department", "department_slug": "rd",           "dir": "departments/rd" },
    { "suffix": "-technology",   "kind": "department", "department_slug": "technology",   "dir": "departments/technology" },
    { "suffix": "-management",   "kind": "department", "department_slug": "management",   "dir": "departments/management" },
    { "suffix": "-marketing",    "kind": "department", "department_slug": "marketing",    "dir": "departments/marketing" },
    { "suffix": "-coordination", "kind": "department", "department_slug": "coordination", "dir": "departments/coordination" }
  ]
}
```

Each subproject entry is:

| Field             | Meaning                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suffix`          | Appended to the install-time `<slug>` to derive the child slug. Empty string means "this entry IS the parent".                                                                                                                                                          |
| `kind`            | One of `org`, `department`, `coding`. Persisted in the registry as `harness_kind` for `org` and `department` only — for `coding` the registry entry omits `harness_kind`. (The per-project `.papercusp/config.json` always records `harness_kind`, including `coding`.) |
| `department_slug` | Optional — used when `kind === 'department'`. Persisted as `department_slug`.                                                                                                                                                                                           |
| `dir`             | Path inside the tarball to copy into the resulting project directory.                                                                                                                                                                                                   |

If the manifest has no `topology` field, behavior defaults to `single`
(today's flow).

## §2. Tarball layout

The tarball SHOULD bundle each subproject's seed under its `dir`:

```
papercup-org-0.1.0.tar.gz
├── papercusp.json                   ← manifest (consumed by install + init)
├── README.md
├── parent/                          ← copied to <projects-root>/<slug>/
│   ├── SPEC.md
│   └── .papercusp/config.json
└── departments/
    ├── business/                    ← copied to <projects-root>/<slug>-business/
    │   ├── SPEC.md
    │   ├── .papercusp/config.json
    │   └── .papercusp/director-config.json
    ├── rd/
    └── ...
```

Files outside any subproject `dir` (e.g. `README.md`, `papercusp.json`)
are NOT copied to the resulting projects — they live with the manifest
in `~/.papercusp/harnesses/<template>/`.

## §3. Install flow

```sh
papercusp install papercup-org              # extracts tarball to ~/.papercusp/harnesses/
papercusp init my-org --from papercup-org   # detects topology=multi → loops subprojects
```

The init command:

1. Reads `<harness-dir>/papercusp.json` to detect topology.
2. If `topology === 'multi'`:
   * Validates EVERY derived slug is well-formed (via `isValidSlug`).
   * Validates EVERY derived path (`<projects-root>/<slug><suffix>/`) is non-existent.
   * Only after all checks pass, scaffolds each subproject in sequence.
3. For each subproject, calls a `scaffoldSubproject` helper that:
   * Creates `<path>/.papercusp/`
   * Copies template files from `<harness-dir>/<dir>/` (excluding manifest + tarballs)
   * Writes a default `.papercusp/config.json` if the template didn't bundle one. It sets `phase` (`org` → `'org'`, `department` → `'department'`, otherwise `'staging'`), `harness_kind` keyed off the entry's `kind`, and `dept` when `kind === 'department'` and a `department_slug` is present.
   * Adds a registry entry with `department_slug` (for departments) and `harness_kind` — but `harness_kind` is written to the registry only for `org` and `department`; a `coding` entry omits it.
4. Emits a summary listing all created sub-harnesses + a per-subproject
   `scaffold-schema <slug><suffix>` next step for each (and `run <slug>`
   to start the parent loop). The `--recursive` form (§5) scaffolds them
   all in one call.

`--target` is rejected for multi-topology templates — multi-install
intrinsically owns multiple project paths.

## §4. Atomicity guarantee

Validation runs BEFORE any filesystem writes. If any derived slug is
invalid OR any target path already exists, init exits without creating
anything. **A partial topology can never be left on disk.**

Once validation passes, scaffolding is sequential. If a later
subproject fails to scaffold (e.g. permission error), prior siblings
remain — but the user's CLI exit code reflects the failure. A thrown
scaffold error propagates to the CLI's top-level `main().catch(…)`,
which logs `fatal: …` and exits the process with code `1`.

## §5. Schema scaffolding

After init, each registered slug needs its Postgres schema. For
multi-topology installs that's one parent + N children. The
`scaffold-schema` command takes a `--recursive` flag for this:

```sh
papercusp scaffold-schema my-org --recursive
```

`--recursive` walks the registry for any project whose slug starts
with `<parent>-` and applies framework DDL to each. Non-recursive use
(`papercusp scaffold-schema my-org-business`) is unchanged.

When run recursively, the command scaffolds every child in sequence
and exits with the first failing child's exit code (or `0` if all
succeed) — a later failure does not mask an earlier one.

## §6. Cross-topology shared schemas

Some multi-topology templates need a **shared** schema that's not
per-harness — e.g. a cross-dept message bus. The manifest's `schema`
field lists SQL files relative to the template root that should be
applied once for the whole topology:

```json
{
  "topology": "multi",
  "schema": ["sql/003-papercusp-shared.sql"],
  ...
}
```

`schema` is not multi-topology-specific: it is the generic
install-time DDL mechanism shared with plugins, and it runs for ANY
install. Besides the bare string-array form shown above, it also
accepts canonical `{ schemaName, ddlPath }` objects — a single object
or an array of them (a legacy bare string is normalized to
`{ ddlPath }`):

```json
{
  "schema": [
    { "schemaName": "msgbus", "ddlPath": "sql/003-papercusp-shared.sql" }
  ]
}
```

The install runtime applies these to the framework DB (`papercusp`)
during `papercusp install`, before any per-harness schema is
provisioned. Each file runs via `psql` with `ON_ERROR_STOP=1` in
declared order; missing files are skipped with a warning rather than
failing the install. Reapplication is idempotent (DDL files MUST use
`CREATE … IF NOT EXISTS`).

## §7. Open questions

* **Renaming subprojects** — today, child slugs are mechanically
  derived as `<parent><suffix>`. Some users may want to rename a
  specific dept (e.g., `legal` → `compliance`). v2.
* **Variable topology** — today, `subprojects` is a fixed array baked
  into the template manifest. A multi-topology template can't say
  "create N departments where N is user-supplied at install time".
  Workaround: publish multiple templates (e.g.
  `papercup-org-3dept`, `papercup-org-5dept`).
* **Mixed-kind templates** — current `kind` enum is `org` /
  `department` / `coding`. Future kinds (e.g. `service`, `pipeline`)
  would need shared-schema and dashboard recognition extensions.

## §8. Reference template

The reference multi-topology template is **papercup-org**, shipping in
the default marketplace at version 0.1.0. It declares 7 sub-harnesses
(1 parent + 6 departments) carrying the registry/config shape the
install path writes (`harness_kind`, `department_slug`).

The decider role for each harness is **not** a config key — it comes
from the harness's blueprint spine. `SpineSchema.decider` is a string
with a zod default of `'director'`, and the pipeline reads
`spine.decider` (falling back to that default) to pick the
orchestrator role; the coding-factory spine therefore deciders as
`'director'`. (`primaryRole` is a retired concept — no live code
references it.)
