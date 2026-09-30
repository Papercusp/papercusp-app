/**
 * processes:freeze — pause / resume a confined task via the cgroup freezer
 * (task-manager-no-escape-2026-07-27, P-014).
 *
 * The verb a process table cannot offer and a cgroup gives away free. Under memory
 * pressure the useful move is almost never "kill the three fattest test runs" — it
 * is "stop them consuming for ninety seconds". Freezing preserves the work and
 * stops the thrash immediately; killing throws away minutes of compute and often
 * has to be redone.
 *
 * Gated on `processes:control` rather than `processes:kill`: this is reversible and
 * non-destructive, and putting it behind the never-auto protected set would block
 * precisely the pressure-relief case it exists for. It refuses on an unconfined
 * task rather than falling back to SIGSTOP — a SIGSTOP'd leader with every child
 * still running is a half-frozen subtree, which is worse than an honest refusal.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { freezeTask, thawTask } from '../../task-manager/control';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

export default defineTool({
  name: 'processes:freeze',
  profile: 'engineer',
  description:
    'Pause (or resume) one OR many confined tasks with the cgroup freezer — the whole subtree stops consuming CPU without losing its work. Pass `taskId` for one or `taskIds` for several; `resume:true` thaws. Requires a cgroup-confined task (`processes:list` -> `confined:true`); an unconfined task is REFUSED rather than half-frozen with SIGSTOP.',
  capability: 'processes:control',
  guidance: {
    when: 'Memory or CPU pressure and you want relief WITHOUT throwing away in-flight work — freeze the biggest consumers, let the box recover, then resume. Also useful to hold a task still while you inspect what it did.',
    notWhen:
      'NOT for ending a task — use `processes:kill`. NOT available for `confined:false` rows (check `processes:list` first). A frozen task still holds its memory: freeze relieves CPU/IO thrash and stops further growth, it does not free RSS.',
    chaining: 'Freeze -> diagnose via `processes:list` -> `processes:freeze { taskId, resume:true }` to let it continue.',
    returns:
      '{ ok, results:[{ ok, taskId, action, detail | error }], counts } — keyed by taskId. `unsupported` = the task is not cgroup-confined; `not_live` = already ended, or a residue row we do not own.',
  },
  args: z
    .object({
      taskId: z.string().max(64).optional().describe('a single task id (n=1 shorthand for taskIds)'),
      taskIds: z.array(z.string().max(64)).min(1).max(50).optional(),
      resume: z.boolean().optional().describe('thaw instead of freeze'),
    })
    .refine((a) => Boolean(a.taskId) || (a.taskIds?.length ?? 0) > 0, {
      message: 'pass `taskId` (one) or `taskIds` (many)',
    }),
  result: z
    .object({ ok: z.unknown().optional(), results: z.unknown().optional(), counts: z.unknown().optional() })
    .passthrough(),
  async handler(args) {
    const ids = [...new Set([...toList<string>(args.taskId), ...toList<string>(args.taskIds)])];
    const env = await runBulk(ids, async (taskId) => (args.resume ? thawTask(taskId) : freezeTask(taskId)), {
      keyOf: (taskId) => ({ taskId }),
    });
    return bulkContent(env);
  },
});
