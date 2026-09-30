-- EI-21952442899555746: keep the registered bare `git-sync` resource
-- description aligned with the runtime lock set.
--
-- Every git-sync fire acquires shared(git-sync) as the workspace-wide restart
-- barrier, then acquires exclusive(git-sync:<slug>) for its harness. The
-- dev:restart path acquires exclusive(git-sync) before draining/restarting a
-- git-sync-sensitive host, so this resource is not a single-harness back-off
-- lock. Forward migration: update the existing row in place.

UPDATE agent_resource_registry
   SET description =
         'The workspace-wide git-sync restart barrier shared by every automated git-sync fire. '
         || 'Each fire also holds its own git-sync:<slug> resource exclusively for the full '
         || 'commit -> submodule-push -> pointer-bump -> push sequence, while dev:restart '
         || 'takes this bare resource exclusively before draining and restarting a git-sync-sensitive host.',
       rule_text =
         'Every system:git-sync fire acquires shared(git-sync) as the workspace-wide restart barrier, '
         || 'then exclusive(git-sync:<slug>) for its harness and any registered extra resources. '
         || 'Different harnesses can commit in parallel, but dev:restart acquires exclusive(git-sync) '
         || 'to refuse new fires and drain active ones before restarting; the bare resource is the '
         || 'cross-harness barrier, not a per-harness extra.',
       updated_ts = clock_timestamp()
 WHERE resource = 'git-sync';
