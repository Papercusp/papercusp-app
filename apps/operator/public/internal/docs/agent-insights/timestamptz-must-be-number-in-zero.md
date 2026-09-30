# TIMESTAMPTZ columns MUST be number() in Zero schemas
URL: /internal/docs/agent-insights/timestamptz-must-be-number-in-zero

Postgres TIMESTAMPTZ columns serialize as epoch-ms numbers in Zero. Declaring them as string() kills the WebSocket for the entire schema; every panel using it goes blank.

import { Aside } from '@astrojs/starlight/components';

This pitfall only bites a **Zero (ZQL) schema** consumed by `zero-cache`.
The shipping desktop app no longer runs zero-cache — it uses **SSE-primary**
sync (the operator sidecar pushes invalidate/update over Postgres
`LISTEN/NOTIFY`), and `libs/zero-harness` has 0 live ZQL importers. So this
rule is still correct *if you touch a Zero schema*, but that surface is being
retired; for current sync work see the Zero-free resolver path, not this. The
`libs/zero-harness` submodule (and its `src/schema.ts`) has since been **removed
from the tree entirely** — this page is retained only as a historical record.

## What

Postgres `TIMESTAMPTZ` columns deserialize as **epoch-ms `number`** in
Zero's wire format. If a Zero schema declares a `TIMESTAMPTZ` column
as `string()` instead of `number()`, **schema validation fails for
every row** of that table, `zero-cache` logs `SchemaVersionNotSupported`,
and the WebSocket connection drops for the **entire schema** — not
just the bad column.

Reload doesn't help. Every harness UI panel that touches that schema
goes blank simultaneously.

## Why it matters

This has bitten us **at least three times**, including once during a
release window. The symptom looks catastrophic ("the whole UI is
broken!") but the root cause is one line in a schema file.

Recent example: a new column on `harness_features` added as
`string()` because the type signature in the migration was unclear.
Took \~45 minutes to root-cause because the surface was so loud.

## How to apply

* **Before declaring any Zero column for a Postgres source**, check
  the column type:
  ```bash
  psql -c "\\d harness_<slug>.<table>" | grep <column>
  ```
* **For `TIMESTAMPTZ`, `TIMESTAMP`, and `DATE`**: declare `number()`.
* **For `JSONB` / `JSON`**: declare `json()`.
* **For `BOOLEAN`**: declare `boolean()`.
* **For `BIGINT`**: declare `number()` (postgres-js returns string,
  but Zero's coercion handles it; verify in dev).

The Zero schema file lives at `libs/zero-harness/src/schema.ts`. The
authoritative pitfall list is at [Data Sync → pitfalls](/internal/docs/data-sync/pitfalls)
item #2 — this insight is a short pointer.
