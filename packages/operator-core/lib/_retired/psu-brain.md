# Retired: psu --brain

Retired on 2026-06-21.

`psu --brain` no longer launches or resumes a pinned brain session. The CLI
keeps `--brain` as a hard tombstone that exits with code 2, and the
`bootstrap-su` `brain` launch paths return `410 Gone`.

Use `operator:converse` / `papercup:converse` for the human-facing operator
brain, or launch a normal `psu` session for interactive shell work.

Historical helpers around the old brain pin and `wake-brain` routine may remain
only to read old state or keep old routine rows from failing with
`unknown action`. They must not be used to start new brain sessions.
