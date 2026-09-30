/**
 * DIAGNOSTIC: enroll ONE task (clone+member+feature), claim it to a synthetic bee id, then directly
 * spawnInvokeOnce a `bee` with the directive brief + FEATURE_ID, and PRINT its full raw stdout/stderr +
 * exit. Isolates why a placed bee does $0 work. KEEP_FILES so nothing is cleaned. Removed after.
 */
import { liveHiveBacklogOps } from './hive-backlog-live';
import { resolveBenchWorkspace } from './bench-workspace';
import type { BenchTask } from './types';

const WS = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID);
const SRC = process.env.XBENCH_SRC_REPO ?? '/tmp/xbench-ansible-repo';

async function main() {
  process.env.PAPERCUSP_KEEP_FILES = '1';
  const ops = liveHiveBacklogOps({ workspaceId: WS });
  const task: BenchTask = {
    benchmark: 'swe-bench-pro',
    instanceId: 'instance_probe__ansible-probe',
    problemStatement:
      'Add a function get_locally_reachable_ips(self, ip_path) to lib/ansible/module_utils/facts/network/linux.py returning {"ipv4": [...], "ipv6": [...]}. Implement it for real.',
    repo: SRC,
    baseCommit: 'e1daaae42af1a4e465edbdad4bb3c6dd7e7110d5',
    graderMeta: {},
  };

  const { hiveHome } = await ops.createHive({ runId: 'probe', arm: 'hive', workspaceId: WS });
  console.log('[probe] hiveHome', hiveHome);
  const enrolled = await ops.enrollTask({ hiveHome, task, budget: { maxUsd: 8 }, workspaceId: WS });
  console.log('[probe] enrolled member', enrolled.member, 'workItemId', enrolled.workItemId, 'clone', enrolled.clonePath);

  // Directly spawn a bee with FEATURE_ID + the directive brief (bypass the planner/drain loop).
  const { spawnInvokeOnce } = await import('../dbos/orchestrator-runner');
  const { buildPipelineExtraEnv } = await import('../dbos/orchestrator-spawn-env');
  const extraEnv = {
    ...buildPipelineExtraEnv({ harnessSlug: enrolled.member, workspaceId: WS }),
    PAPERCUSP_FLEET_SANDBOX: '0',
    PAPERCUSP_SPAWN_BACKEND: 'claude-code',
    MUG_BRIEF:
      'You are placed on a single-task benchmark harness. This member holds EXACTLY ONE feature work-item. Claim it (work_items:claim_next for this harness) and IMPLEMENT it as real code edits to a working diff. Do not exit taskless.',
  };
  console.log('[probe] spawning bee directly with FEATURE_ID=' + enrolled.workItemId);
  const res = await spawnInvokeOnce(enrolled.clonePath, 'cup', [`FEATURE_ID=${enrolled.workItemId}`], extraEnv, {
    timeoutMs: Number(
      process.env.XBENCH_CUP_TIMEOUT_MS ?? process.env.XBENCH_BEE_TIMEOUT_MS /* legacy env name — dual-accept until callers migrate */ ?? 8 * 60 * 1000,
    ),
  });
  console.log('\n===== BEE INVOKE RESULT =====');
  console.log('exitCode', res.exitCode, 'timedOut', res.timedOut);
  console.log('--- stdout (first 4000 chars) ---');
  console.log((res.output || '(empty)').slice(0, 4000));
  console.log('--- stderr (first 2000 chars) ---');
  console.log((res.stderr || '(empty)').slice(0, 2000));

  // Did it write anything?
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ex = promisify(execFile);
  await ex('git', ['-C', enrolled.clonePath, 'add', '-A']).catch(() => {});
  const { stdout: stat } = await ex('git', ['-C', enrolled.clonePath, '-c', 'core.fileMode=false', 'diff', '--cached', '--stat', task.baseCommit!, '--', '.', ':(exclude).papercusp/**']).catch(() => ({ stdout: '(diff failed)' }) as { stdout: string });
  console.log('\n===== CLONE DIFF STAT (excl .papercusp) =====');
  console.log(stat || '(no change)');
  console.log('[probe] clone left at', enrolled.clonePath, '(inspect, then rm)');
  process.exit(0);
}

main().catch((e) => {
  console.error('[probe] FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
