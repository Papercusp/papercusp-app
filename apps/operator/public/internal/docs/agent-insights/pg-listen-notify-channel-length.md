# PG LISTEN/NOTIFY channel name length asymmetry
URL: /internal/docs/agent-insights/pg-listen-notify-channel-length

pg_notify() raises "channel name too long" for names >63 bytes while LISTEN silently truncates — any string derived from a file path can cross the limit; always hash before using as a channel name.

## What

PostgreSQL channel names are identifiers capped at **NAMEDATALEN − 1 = 63 bytes**,
but the two sides of a pub/sub pair behave differently when you exceed it:

| Call                                          | Behavior on >63-byte name                 |
| --------------------------------------------- | ----------------------------------------- |
| `LISTEN` (SQL identifier)                     | **Silently truncates** to 63 bytes        |
| `pg_notify(channel, payload)` (text function) | **Raises** `ERROR: channel name too long` |

This asymmetry is the trap: LISTEN registers a subscription on the truncated name,
pg\_notify aborts with an error, and nobody ever wakes.

## Why it matters here

The locks subsystem keyed its per-workspace NOTIFY channel as
`'ch_coord_' || coordinationDomain`.  The coordination domain is the realpath of
the repo checkout root, which is typically 40–80 chars on a real machine.
`'ch_coord_'` is 9 chars, so any path longer than **54 chars** produces a channel
name >63 bytes.

Live incident (2026-06-09): the GREEN release checkout
`/home/dev/papercupai-workspace/papercup-release` is 56 chars → channel
was 65 bytes.  Every `grant_cascade()` call that had a waiting waiter called
`pg_notify` on that name, which **aborted the entire release transaction** —
rolling back the DELETE from `agent_file_locks` too.  The lock stayed held; the
waiter eventually timed out (30 s poll ceiling) instead of being woken (bug EI-15).
The failing symptom was `locks:acquire { wait: { max_sec } }` returning
`ok: false` even though the holder called `locks:release`.

## The fix

Hash the domain into the channel name so the total length is always 41 bytes:

```ts
// libs/papercusp/packages/locks/src/workspace-listener.ts (TypeScript LISTEN side)
export function coordNotifyChannel(coordinationDomain: string): string {
  return `ch_coord_${createHash('md5').update(coordinationDomain).digest('hex')}`;
}
```

```sql
-- libs/papercusp/packages/locks/src/sql/013-bounded-notify-channel.sql (SQL pg_notify side)
CREATE OR REPLACE FUNCTION coord_notify_channel(p_coordination_domain text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'ch_coord_' || md5(p_coordination_domain)
$$;
```

Both sides must use **exactly the same transformation** — any dual-mode "only hash
when long" branch will eventually desync.  Apply the hash unconditionally.

The package migration also adds a `coord_notify_channel_legacy()` function that notifies
the old truncated name during the rolling upgrade window (so pre-fix listeners
already LISTEN-ing on the truncated name still wake).  Drop it once no pre-fix
process remains.  The operator-core `workspace-listener.ts` path is now a host-adapter
shim that imports lock host configuration and re-exports `@papercusp/locks`; the bounded
channel implementation lives in the shared locks package.

## How to avoid it in the future

Whenever you derive a PG channel name from a string that originates outside the
binary (file paths, workspace ids, slugs, user input), **hash it first**:

```sql
-- safe: always 41 bytes
'prefix_' || md5(input)

-- unsafe: variable length, will explode for long inputs
'prefix_' || input
```

Test with integration cases that use a coordination domain longer than 54 chars
and assert the waiter wakes promptly (not via the 30 s poll ceiling).  Keep both the
file-lock wait coverage in `su-locks-wait.integration.test.ts` and the resource-lock
coverage in `resource-locks.integration.test.ts`; they exercise the same bounded channel
contract through different lock paths.
