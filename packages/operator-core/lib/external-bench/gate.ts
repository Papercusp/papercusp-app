/**
 * The flag gate for the external-bench runner (P-005 / BRIEF 3). The adapter + the `external-bench:run` op
 * (P-019) MUST call `assertExternalBenchEnabled()` at their entry — the runner ships dark behind
 * `papercusp-external-bench` (DEFAULT OFF: incomplete M2 modality + infra-heavy Docker/GB image pulls; flips
 * ON after the P-009 pilot proves it). The flag reader is injectable so the gate is unit-testable.
 */
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

/** A flag reader — the live one is `getFlag` from `@papercusp/flags/server`; tests inject a fake. */
export type FlagReader = (key: FlagKey, distinctId: string) => Promise<boolean>;

const DEFAULT_DISTINCT_ID = 'system';

/** Resolve the external-bench flag for `distinctId` (default the system scope). */
export function isExternalBenchEnabled(distinctId: string = DEFAULT_DISTINCT_ID, read: FlagReader = getFlag): Promise<boolean> {
  return read(FLAGS.EXTERNAL_BENCH, distinctId);
}

/** Throw a clear error when the external-bench runner is gated off — call at every runner/op entry. */
export async function assertExternalBenchEnabled(distinctId: string = DEFAULT_DISTINCT_ID, read: FlagReader = getFlag): Promise<void> {
  if (!(await isExternalBenchEnabled(distinctId, read))) {
    throw new Error(
      'external-bench is gated off (flag papercusp-external-bench). It ships dark until the P-009 pilot — ' +
        'enable it at /admin/features to run benchmark tasks.',
    );
  }
}
