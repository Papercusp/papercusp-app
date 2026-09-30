/**
 * `host:memory_pressure` — resolver lens for the `host.memoryPressure` cell.
 *
 * The tool owns no thresholds and performs no second derivation. It reads the same
 * perf-signals-v1 capture as the infra-liveness panel, delegates the verdict to
 * `evaluateMemoryPressure`, and adds an independent in-process free-memory probe as
 * evidence for the cell's explicit assessment. Agents should normally use
 * `state:read { cell: 'host.memoryPressure' }`; this tool is the read-only door that
 * the cell dispatcher needs.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getHostSnapshot, type HostSnapshot } from '../../host-snapshot';
import { evaluateMemoryPressure, readLatestPerfSignals, type PerfSignalsV1 } from '../../system-health/perf-budgets';

export interface HostMemoryPressureDeps {
  nowMs?: number;
  readSignals?: () => Promise<PerfSignalsV1 | null>;
  readHost?: () => HostSnapshot;
}

export const HOST_MEMORY_FREE_CAPACITY_WARN_PCT = 10;

export type HostMemoryPressureAssessment = 'critical' | 'warning' | 'stable-low-free' | 'stable';

/** PURE. Keep PSI pressure and free-memory capacity as separate inputs. */
export function assessHostMemoryPressure(input: {
  pressure: 'ok' | 'warn' | 'crit' | null;
  stale: boolean;
  unknownCount: number;
  memFreePct: number | null;
}): HostMemoryPressureAssessment | null {
  if (input.pressure === null || input.stale || input.unknownCount > 0) return null;
  switch (input.pressure) {
    case 'crit':
      return 'critical';
    case 'warn':
      return 'warning';
    case 'ok':
      return input.memFreePct !== null && input.memFreePct < HOST_MEMORY_FREE_CAPACITY_WARN_PCT
        ? 'stable-low-free'
        : 'stable';
    default: {
      const exhaustive: never = input.pressure;
      return exhaustive;
    }
  }
}

/** Build the exact plain payload projected by the tool and walked by `readCell`. */
export async function buildHostMemoryPressurePayload(deps: HostMemoryPressureDeps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const [signals, host] = await Promise.all([
    (deps.readSignals ?? readLatestPerfSignals)(),
    Promise.resolve((deps.readHost ?? getHostSnapshot)()),
  ]);
  const memory = evaluateMemoryPressure(signals, nowMs);
  const memFreePct = host.memFreePct ?? null;
  return {
    ok: true,
    assessment: assessHostMemoryPressure({
      pressure: memory.pressure,
      stale: memory.stale,
      unknownCount: memory.unknown.length,
      memFreePct,
    }),
    memory,
    /**
     * Independent evidence: `freemem()/totalmem()` shares no input with the
     * periodic PSI capture. Keys are always present; null means unmeasured, never 0.
     */
    host: {
      measuredAt: host.now,
      memFreePct,
      memTotalGb: host.memTotalGb ?? null,
      psiMemSome60: host.psiMemSome60 ?? null,
    },
  };
}

export default defineTool({
  name: 'host:memory_pressure',
  description:
    'Read the canonical infra-liveness memory-pressure verdict from the latest perf-signals capture, plus an independent free-memory reading. Normally call state:read { cell:"host.memoryPressure" }; this is its resolver lens.',
  guidance: {
    when:
      'As the resolver behind host.memoryPressure. Direct use is mainly for debugging the state-cell wiring.',
    notWhen:
      'General service health, process forensics, or waiting for the condition to change. Use state:read/state:subscribe on host.memoryPressure.',
    chaining:
      'state:read { cell:"host.memoryPressure" } → branch on assessment.code and follow assessment.safeAction; inspect value/evidence for diagnosis. state:subscribe { cell:"host.memoryPressure" } waits for a semantic band transition.',
  },
  // @cell-lens host.memoryPressure
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({}),
  async handler() {
    const payload = await buildHostMemoryPressurePayload();
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
