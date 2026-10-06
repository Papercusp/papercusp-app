import { costFromTokens, priceFor } from '@papercusp/model-pricing';
import type { ScoutLlmAdmission } from '../../scout/run.ts';

export interface StudyCall {
  id: number; model: string; reservedUsd: number;
  status: 'reserved' | 'settled' | 'unknown';
  costUsd?: number; inputTokens?: number; outputTokens?: number;
}

/** One UTF-8 byte per input token plus framing headroom is deliberately conservative.
 * Scout keeps its real prompts/output limits. Refuse absent bounds and unpinned models. */
export function createBlenderAdmission(capUsd: number, models: readonly string[], persist: (calls: StudyCall[]) => Promise<void>) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('Invalid Blender study cost cap');
  const calls: StudyCall[] = [];
  let fault: Error | undefined;
  const accounted = () => calls.reduce((sum, c) => sum + (c.status === 'settled' ? c.costUsd! : c.reservedUsd), 0);
  const admit: ScoutLlmAdmission = async (opts, invoke) => {
    if (fault) throw fault;
    if (!models.includes(opts.model) || !priceFor(opts.model)) throw new Error('Blender study model drift/unpriced model');
    const bytes = Buffer.byteLength(JSON.stringify({ system: opts.system, messages: opts.messages }), 'utf8');
    if (bytes > 512_000 || !Number.isInteger(opts.maxTokens) || opts.maxTokens! <= 0 || opts.maxTokens! > 65_536)
      throw new Error('Blender study call lacks bounded input/output');
    const reservedUsd = costFromTokens(opts.model, { inputTokens: bytes + 4096, outputTokens: opts.maxTokens! }).usd;
    if (!Number.isFinite(reservedUsd) || reservedUsd <= 0 || accounted() + reservedUsd > capUsd)
      throw new Error('Blender study hard per-cycle cost admission refused');
    // Synchronous reservation before the first await serializes concurrent critics.
    const call: StudyCall = { id: calls.length, model: opts.model, reservedUsd, status: 'reserved' };
    calls.push(call);
    try {
      await persist(structuredClone(calls));
      if (fault) throw fault;
      const result = await invoke();
      if (!Number.isFinite(result.costUsd) || result.costUsd < 0 ||
          !Number.isFinite(result.inputTokens) || !Number.isFinite(result.outputTokens) ||
          ((result.inputTokens + result.outputTokens) > 0 && result.costUsd === 0) ||
          result.costUsd > reservedUsd + 1e-9) throw new Error('Blender study usage missing or exceeds reservation');
      Object.assign(call, { status: 'settled', costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      await persist(structuredClone(calls));
      return result;
    } catch (error) {
      call.status = 'unknown';
      fault = error instanceof Error ? error : new Error(String(error));
      throw fault;
    }
  };
  return { admit, calls, accounted, assertSettled() {
    if (fault || calls.some(c => c.status !== 'settled')) throw fault ?? new Error('Blender study calls remain unresolved');
  } };
}

export interface BlenderTick {
  cycleId: string; pin: string; reservedUsd: number; settled: boolean; costUsd: number | null;
}
/** Reservation and final receipts share a real Scout cycle id. A lost final retains the full cap. */
export function sumBlenderTicks(rows: BlenderTick[]) {
  const cycles = new Map<string, BlenderTick>();
  for (const row of rows) {
    if (!row.cycleId || !Number.isFinite(row.reservedUsd) || row.reservedUsd <= 0 ||
        (row.settled && (row.costUsd === null || !Number.isFinite(row.costUsd) || row.costUsd < 0 || row.costUsd > row.reservedUsd)))
      throw new Error('Invalid Blender study receipt');
    const prior = cycles.get(row.cycleId);
    if (prior && (prior.pin !== row.pin || prior.reservedUsd !== row.reservedUsd ||
        (prior.settled && row.settled && prior.costUsd !== row.costUsd))) throw new Error('Conflicting Blender study receipts');
    if (!prior || row.settled) cycles.set(row.cycleId, row);
  }
  const totals = new Map<string, { pin: string; arm: 'blender'; attempts: number; cost: number }>();
  for (const row of cycles.values()) {
    const total = totals.get(row.pin) ?? { pin: row.pin, arm: 'blender', attempts: 0, cost: 0 };
    total.attempts++;
    total.cost += row.settled ? row.costUsd! : row.reservedUsd;
    totals.set(row.pin, total);
  }
  return [...totals.values()];
}
