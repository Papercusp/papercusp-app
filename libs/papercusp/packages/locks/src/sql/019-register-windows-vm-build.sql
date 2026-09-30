-- WI-4642 / P-021: the local Windows build VM and its fixed build directory
-- are one correctness-class resource. Two release/build agents previously
-- entered this directory concurrently, exhausted C:, and corrupted the run.
--
-- The name deliberately encodes the concrete host + SSH port + VM_BUILD_DIR.
-- build-windows-on-vm.sh derives the same tuple; an override therefore fails
-- closed as unknown_resource until that distinct target is deliberately
-- registered, instead of accidentally sharing an unrelated mutex.
INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('windows-vm-build:user@127.0.0.1:2223:papercup-build-release',
   'The local Windows 11 build VM target user@127.0.0.1:2223 and C:\\Users\\user\\papercup-build-release. Concurrent extract/cargo/Inno runs corrupt this shared directory and can exhaust the VM disk.',
   'build-windows-on-vm.sh acquires this resource exclusively before any VM preflight, deletion, extract, or build. The lease records purpose + ETA, heartbeats while active, announces a latched release event, and releases with cleanup verification on EXIT/INT/TERM. A second run must fail before mutation while the lease is held.',
   'enforced',
   ARRAY['build-windows-on-vm'])
ON CONFLICT (resource) DO UPDATE
  SET description = EXCLUDED.description,
      rule_text = EXCLUDED.rule_text,
      enforcement = EXCLUDED.enforcement,
      match_patterns = EXCLUDED.match_patterns,
      updated_ts = clock_timestamp();
