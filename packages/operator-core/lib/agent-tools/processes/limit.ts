/**
 * processes:limit — retune a live task's resource budget
 * (task-manager-no-escape-2026-07-27, P-014).
 *
 * The budget is a set of systemd scope properties, so changing it is a
 * `set-property --runtime` on the scope — no restart, no lost work, and the KERNEL
 * enforces the new ceiling from that moment. That is materially different from
 * anything we could enforce ourselves: a limit policed by a timer in the operator
 * dies with the operator, while `MemoryMax` on a cgroup holds regardless.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { limitTask } from '../../task-manager/control';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

export default defineTool({
  name: 'processes:limit',
  profile: 'engineer',
  description:
    "Change a live confined task's resource budget in place — MemoryMax (MB), CPUWeight, TasksMax — with no restart and no lost work; the kernel enforces it immediately. Pass `taskId` for one or `taskIds` for several. Requires a cgroup-confined task; unconfined tasks are REFUSED (a budget we cannot enforce is not a budget).",
  capability: 'processes:control',
  guidance: {
    when: 'One task is starving the box and you want to CAP it rather than kill it — drop its CPUWeight so peers get scheduled, or set a MemoryMax so it OOMs itself instead of wedging the host. Also the way to tighten a budget you initially set too generously.',
    notWhen:
      'NOT a way to raise a limit above what the parent slice allows — the slice ceiling still wins. NOT for `confined:false` rows. To STOP a task consuming entirely, `processes:freeze` is better: a limit still lets it run.',
    chaining: 'Find the offender with `processes:list` (sort by rssMb/cpuSec), limit it, then re-read `processes:list` to confirm the new ceiling holds.',
    returns:
      '{ ok, results:[{ ok, taskId, action, detail | error }], counts } — keyed by taskId. `unsupported` = not cgroup-confined; `no_target` = no limits supplied.',
  },
  args: z
    .object({
      taskId: z.string().max(64).optional(),
      taskIds: z.array(z.string().max(64)).min(1).max(50).optional(),
      memoryMaxMb: z.number().int().positive().max(1_048_576).optional().describe('hard memory ceiling in MB'),
      cpuWeight: z.number().int().min(1).max(10_000).optional().describe('relative CPU share (default 100)'),
      tasksMax: z.number().int().positive().max(1_000_000).optional().describe('max processes/threads in the scope'),
    })
    .refine((a) => Boolean(a.taskId) || (a.taskIds?.length ?? 0) > 0, {
      message: 'pass `taskId` (one) or `taskIds` (many)',
    })
    .refine((a) => a.memoryMaxMb != null || a.cpuWeight != null || a.tasksMax != null, {
      message: 'pass at least one of memoryMaxMb / cpuWeight / tasksMax',
    }),
  result: z
    .object({ ok: z.unknown().optional(), results: z.unknown().optional(), counts: z.unknown().optional() })
    .passthrough(),
  async handler(args) {
    const ids = [...new Set([...toList<string>(args.taskId), ...toList<string>(args.taskIds)])];
    const limits = {
      memoryMaxBytes: args.memoryMaxMb == null ? undefined : args.memoryMaxMb * 1048576,
      cpuWeight: args.cpuWeight,
      tasksMax: args.tasksMax,
    };
    const env = await runBulk(ids, async (taskId) => limitTask(taskId, limits), {
      keyOf: (taskId) => ({ taskId }),
    });
    return bulkContent(env);
  },
});
