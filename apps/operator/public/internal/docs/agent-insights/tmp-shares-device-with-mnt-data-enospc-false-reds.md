# /tmp is a bind mount sharing the same device as /mnt/data — ENOSPC there masquerades as N false gate reds
URL: /internal/docs/agent-insights/tmp-shares-device-with-mnt-data-enospc-false-reds

On the dev box, /tmp is a bind mount of a subdir of the SAME XFS filesystem mounted at /mnt/data (a 2TB swapfile + mongodb data + backups live there too). When that device gets tight, vitest workers hit ENOSPC mkdir'ing scratch dirs and every affected suite fails at COLLECTION — indistinguishable at a glance from N real regressions. The gate now runs a preflight (checkDiskHeadroom in green-checkpoint.ts) that refuses with reason=disk-headroom before any suite work when critical write headroom is breached, instead of letting ENOSPC misattribute to the candidate.

## What happened

Two independent bug reports (EI-21051243455875854, EI-21048509127429557) landed
the same day describing what looked, from the gate's own output, like a wave of
real test regressions: a candidate recorded 17–21 failed CI files, every one a
zero-duration collection failure of the shape

```
Error: ENOSPC: no space left on device, mkdir '/tmp/<random>/ssr'
```

Vitest reports this as `Test Files N failed (N)` / `Tests no tests` — there is
no way to tell it apart from N real regressions just by reading the gate
verdict. A gate run that hits this records a RED that has nothing to do with
the candidate's code.

## The mechanism (why this isn't "just a full disk")

`findmnt -R /tmp` shows `/tmp` is a **bind mount** of the `/tmp` subdirectory
of the XFS filesystem mounted at `/mnt/data`:

```
TARGET SOURCE             FSTYPE OPTIONS
/tmp   /dev/nvme0n1[/tmp] xfs    rw,relatime,...
```

So `/tmp`'s free space is not its own — it's whatever `/mnt/data` leaves
behind. `/mnt/data` also holds a **2 TB swapfile**, a mongodb `db/` dir,
`MEMORYSTORE/`, build/backup dirs, and per-agent scratch (`/tmp/pcv`,
`/tmp/verify-tauri-headless.*`, `/tmp/papercusp-wi*-*` — several GB each,
hours old). `du -sx /tmp` can read tens of GB while `df -h /tmp` reads 100%,
because the shortfall is on the sibling mount, not inside `/tmp` itself — a
`du` on `/tmp` alone will never explain a `df` reading on `/tmp`.

This device runs with almost no margin: one run drove `/tmp` down to 20K
available; deleting a single unrelated 9.1G scratch dir recovered it to 9.1G
within minutes. Any multi-GB build or a handful of un-reaped agent scratch
dirs can push it back into ENOSPC.

## The fix: fail fast and attribute correctly, don't let ENOSPC hit the suite

`runGreenCheckpoint` (apps/operator/lib/release/green-checkpoint.ts) now calls
an optional `deps.checkDiskHeadroom()` **before** `setupTree` (which itself
copies node\_modules) and before any suite work. It statfs's `os.tmpdir()` via
`sampleDiskSnapshots`/`detectCriticalWriteHeadroom`
(packages/operator-core/lib/storage/disk-space-alarm.ts), reusing the standing
disk-space-alarm's CRITICAL thresholds (2 GiB / 2% bytes, 5% inodes by
default) so the gate and the alarm never invent two different definitions of
"full". A breach returns `{ advanced: false, reason: "disk-headroom", summary }`
— an explicit, human-readable infrastructure refusal — instead of running the
suite into ENOSPC and letting vitest's collection failures read as N code
regressions. It's wired into `realCheckpointDeps` (the live dependency
builder the gate actually runs with), not just test stubs.

## What this does NOT fix

The preflight stops ENOSPC from being *misattributed*; it does not fix the
underlying capacity problem — `/tmp` and `/mnt/data` still share one device
with near-zero margin. That needs owner/root authority (a dedicated
device/quota for `/tmp`, moving the swapfile, or a stale-agent-scratch
reaper) and is tracked separately.

## Recognize this again

* `df -h /tmp` reads full/near-full but `du -sx /tmp` shows far less than the
  device size → check `findmnt -R /tmp` for a bind mount before assuming
  agent scratch alone did it.
* A gate run reporting N failed files, all zero-duration, all a collection
  error (not an assertion failure) → suspect infrastructure (disk/inode
  exhaustion), not a code regression, before spending time bisecting.
* If the gate refuses with `reason: "disk-headroom"`, that IS the intended
  behavior — it's an inconclusive infrastructure result, not evidence the
  candidate is broken.
