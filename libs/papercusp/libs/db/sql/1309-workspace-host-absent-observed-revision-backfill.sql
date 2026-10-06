-- WI-10004969: backfill observed_revision for destroyed workspace hosts.
--
-- updateWorkspaceHostLifecycleState used to write desired_state/observed_state = 'absent'
-- on destroy completion without advancing observed_revision, while the destroy operation
-- had already bumped desired_revision. Every destroyed host therefore stayed at
-- observed_revision < desired_revision, and release.cleanup's convergence predicate
-- (absent/absent AND observed_revision = desired_revision) could never pass.
--
-- The code now advances observed_revision on that write. This converges the existing rows,
-- but ONLY where a succeeded destroy operation for that host carries exactly the host's
-- current desired_revision — i.e. the host provably converged on that revision. Any other
-- gap is left untouched for a human to inspect.
UPDATE harness_shared.workspace_hosts AS host
   SET observed_revision = host.desired_revision,
       updated_at = now()
 WHERE host.desired_state = 'absent'
   AND host.observed_state = 'absent'
   AND host.observed_revision < host.desired_revision
   AND EXISTS (
     SELECT 1
       FROM harness_shared.workspace_host_operations operation
      WHERE operation.workspace_id = host.workspace_id
        AND operation.host_id = host.id
        AND operation.action = 'destroy'
        AND operation.status = 'succeeded'
        AND operation.desired_revision = host.desired_revision
   );
