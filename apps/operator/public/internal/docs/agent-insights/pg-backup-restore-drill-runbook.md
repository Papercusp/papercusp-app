# Proving a Postgres backup is RESTORABLE, not merely valid: the DR drill runbook
URL: /internal/docs/agent-insights/pg-backup-restore-drill-runbook

Runbook for actually restoring a papercusp pg_dump into a scratch database and proving the prose survived byte-for-byte — plus the two independent failures a green backup health check cannot see (archive SHAPE and reader USER), and why a row count is not evidence.

Since the doc corpus became PG-canonical, **Postgres holds prose that git no longer inherently
carries** — a `.mdx` on disk is a projection, so "the repo has it" is no longer a backup story for
the 869 authored docs. That is what made this drill worth running (WI-37835), and the drill
**failed twice before it passed**. Both failures were real, and neither was visible to any cheaper
check.

## The one-sentence lesson

A backup that is produced on schedule, self-validated, monitored, and reported healthy can still
be **impossible to restore** — and only an actual restore attempt finds it.

## Why every existing check missed it

The producer (`~/.config/kopia/db-backup.sh`, `pg_dump -Fd`, \~8.5 GB, hourly) validates its own
output with `pg_restore -l` and passes. The health check asserts dump freshness and passes. The
artifact was genuinely fresh, complete and valid. It was still unrestorable, for two independent
reasons:

1. **The documented tool could not open that SHAPE of archive.**
2. **It could not open it as that USER** — the producer `chown`s the dump so kopia can read it,
   which locked out `postgres`, the role that must *restore* it. Directory-format dumps need the
   restoring role to be able to **traverse** the directory: `drwxr-x--- <user>:postgres`.

You cannot infer either from the artifact. You can only find them by attempting the restore.

> **The pattern worth carrying:** every check in that chain validated the ARTIFACT, and none
> validated the PATH. A backup is not a file, it is a **round trip** — produce → store → retrieve →
> restore — and only the first two hops were instrumented. The health check could have run green
> every hour for another year while the restore was impossible.

## The drill

**1. Measure BOTH volumes before declaring a space blocker.**

```bash
df -h -x tmpfs -x devtmpfs -x squashfs    # never a bare `df -h /`
```

Root here sits at 98–99% while `/mnt/data` is a **separate 7.3 T volume with \~1.7 T free** — where
the dump already lives. A previous wake ran only `df -h /`, correctly refused to launch a 24 GB
restore, and recorded a hard blocker that did not exist. Put the scratch database on `/mnt/data`
via a tablespace; the 24 GB restore is then unremarkable.

**2. Restore into a SCRATCH database** — never over the live one — using the documented script
(`packages/backup/scripts/restore-pg-dump.sh`).

**3. Judge the result by QUERYING IT, never by the exit code.** `pg_restore` continues past errors:
a run that restored **zero tables** exits non-zero with a single error line, which is
indistinguishable from a healthy run's ordinary ordering noise. The first drill run restored
nothing and looked like one stray permission error.

**4. A row count is not evidence the payload survived.** `count(*)` returns 983 whether or not
every `content` is NULL — which is the failure mode that matters most for a PG-canonical doc
corpus. Compare the PROSE:

```sql
-- run against BOTH the restored scratch DB and the live one; the digests must match
select count(*)                                                  as docs,
       count(*) filter (where coalesce(content,'') <> '')         as with_content,
       sum(length(content))                                       as bytes,
       md5(string_agg(doc_id || coalesce(content,''), E'\n' order by doc_id)) as digest
  from harness_shared.harness_docs;
```

Comparable only if `harness_docs` has not moved since the dump was taken.

**5. Drop the scratch database** when the comparison is done.

## What a PASS looks like

Measured 2026-08-11, 2m08s, 0 `ERROR` lines: docs 983/983, content 983/983, insights 733/733,
parts 289/289, bytes 8,933,321, and `md5 = 365dede89baed9d81b328a2fe931df9a` on **both** sides.
Byte-identical prose, not merely non-NULL rows.

## The generalisable near-miss

The blocker that never existed is the part to remember. **A partial measurement that produces a
CAUTIOUS conclusion feels responsible, which is exactly why it never gets re-checked.** `df -h /`
returns 99% whether or not a second volume has 1.7 T free; `pg_restore -l` returns OK whether or
not postgres can traverse the directory; `count(*)` returns 983 whether or not every content is
NULL.

The cheap test, worth running before you believe any check: **say out loud what would have to be
true for this instrument to return this same answer while the thing you care about is broken.** If
you can describe that world in one sentence, you are holding the wrong instrument.
