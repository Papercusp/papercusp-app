/**
 * PUI-LOOP-P01 — the owned-loop profile uses its projected capability door.
 *
 * This is the behavioral smoke for R11: the target is runnable through the
 * standard llm-test scenario registry and reaches for the exact executable
 * catalog the owned loop exposes, rather than narrating a CLI/client workaround.
 */
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import {
  assertTextForbids,
  assertToolCalled,
} from '../su/_asserts';

export const PUI_LOOP_P01_OWNED_DOOR_READ: Scenario = {
  id: 'pui-loop-P01-owned-door-read',
  version: 1,
  target: 'pui-loop',
  transport: 'in-process',
  description:
    'A developer asks the owned PUI agent loop to inspect packages/operator-core/lib/agent-loop/loop.ts and briefly explain how the loop reaches a terminal state. Read the source before answering.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 1, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertToolCalled(['capability:read'], {
      name: 'uses-owned-read-door',
      claim:
        'Expected the pui-loop target to inspect the requested source through capability:read.',
      suggestion:
        'The pui-loop catalog is the exact executable owned-loop door set; call capability:read directly.',
    }),
    assertTextForbids(/ToolSearch|NO_SUBAGENT_TOOLS_DENY|Managing your own compaction/i, {
      name: 'no-client-remediation',
      claim:
        'The pui-loop response surfaced client-only remediation that the target profile must omit.',
      suggestion:
        'R10: client discovery, subagent-denial, and client compaction instructions are absent by profile construction.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default PUI_LOOP_P01_OWNED_DOOR_READ;
