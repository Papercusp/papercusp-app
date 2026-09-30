-- Migration 1234 — host kernel-memory samples for the kernel-leak alarm.
-- host-memory-reduction-2026-09-27 P-010 / D-007.
--
-- One row per host boot per 10-minute bucket: unreclaimable slab (SUnreclaim),
-- total slab, and the root cgroup's nr_dying_descendants. The alarm
-- (packages/operator-core/lib/system-health/kernel-leak-watchdog.ts) fits a
-- slope over the trailing 24 h of the CURRENT boot, because a reboot frees a
-- kernel leak and must start a new series — hence boot_id in the key.
--
-- Both operator instances on a host (:3070 and :3170) sample. The
-- (boot_id, bucket_at) key makes the second writer's insert a no-op
-- (ON CONFLICT DO NOTHING), so the series holds one row per bucket.
--
-- Host-level, not workspace-scoped: no workspace_id and no RLS policy, like
-- any other per-machine measurement. The writer prunes rows older than 14 days.
--
-- Additive only (a new table), so the currently-deployed release is unaffected.

CREATE TABLE harness_shared.host_kernel_memory_samples (
  boot_id           text        NOT NULL,
  bucket_at         timestamptz NOT NULL,
  sampled_at        timestamptz NOT NULL,
  host              text        NOT NULL,
  booted_at         timestamptz NOT NULL,
  mem_total_bytes   bigint      NOT NULL,
  sunreclaim_bytes  bigint      NOT NULL,
  slab_bytes        bigint      NOT NULL,
  dying_descendants integer,
  PRIMARY KEY (boot_id, bucket_at)
);

CREATE INDEX host_kernel_memory_samples_sampled_at_idx
  ON harness_shared.host_kernel_memory_samples (sampled_at);

COMMENT ON TABLE harness_shared.host_kernel_memory_samples IS
  'Per-boot 10-minute samples of SUnreclaim / Slab (/proc/meminfo) and nr_dying_descendants (root cgroup.stat) feeding the kernel-leak alarm (host-memory-reduction-2026-09-27 P-010, D-007). 14-day retention, pruned by the writer.';
COMMENT ON COLUMN harness_shared.host_kernel_memory_samples.dying_descendants IS
  'nr_dying_descendants from /sys/fs/cgroup/cgroup.stat; NULL when cgroup v2 is not mounted there.';

GRANT SELECT, INSERT, DELETE ON harness_shared.host_kernel_memory_samples TO harness_app;
