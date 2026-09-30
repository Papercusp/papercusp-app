# PG migrations — bash heredocs collapse $body$ tokens
URL: /internal/docs/agent-insights/pg-migrations-dollar-quote

Migrations using $body$...$body$ for function bodies break when written through bash heredocs. Use a named dollar-quote tag (e.g. $func$) and verify on apply.

## What

When you write a PG migration that uses a dollar-quoted body
(`$body$ ... $body$`) and pipe it through a bash heredoc, **bash
collapses the `$body$` tokens silently** as if they were variable
expansions. The migration runs through as malformed SQL — usually
parses without error, sometimes appears to "succeed" — but the
function body is wrong or empty.

## Why it matters

Migrations 060 and 061 were broken for **days** in 2026-04. The CI
applied them, no error surfaced, the function bodies were silently
empty. Symptoms appeared only at runtime when the function was
called.

The bug also caught us a fourth time on a later migration that used
`$$ ... $$` (the unnamed-tag form) — same problem, bash sees `$$` as
the parent process PID.

## How to apply

* **Use a named dollar-quote tag** that's not a bash variable name:
  `$func$ ... $func$`, `$body0$ ... $body0$` (note the `0` —
  `$body$` is too easy a target). Names with digits are safest.
* **Or write migrations to standalone `.sql` files** and apply them
  via `psql -f`, not via heredocs.
* **Always verify migrations with `psql -v ON_ERROR_STOP=1`** in your
  apply harness. The flag makes silent malformed SQL fail loudly.
* After applying, **call the function** at least once in a smoke
  test. An empty body parses fine; calling it does not.

The migration apply script lives in `libs/papercusp/libs/db/scripts/`
— check there before adding a new heredoc-based applier.
