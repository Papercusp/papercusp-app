/**
 * Retired capacity ENV inputs — the loud readback (capless-inference-gateway-2026-08-28 P-012).
 *
 * WHY THIS EXISTS. The capacity-compatibility group `gateway-concurrency` has always PROMISED a
 * warning readback ("Warn when the legacy value is present, invalid, or stale"), but until P-012
 * nothing implemented it. Outside the census itself, a test, and the systemd unit's comment, no
 * runtime code referenced these names at all. So an operator who had `PAPERCUSP_GATEWAY_CONCURRENCY=24`
 * exported — from a systemd drop-in, a container env, a packaged-app launcher, or their own shell —
 * got SILENCE, and every observable signal agreed with their belief that they had capped the gateway.
 * A retired input that fails silently is worse than one that errors: it produces a confident,
 * unfalsifiable, wrong mental model of the fleet's capacity that survives until someone reads source.
 *
 * P-012's acceptance is that "equivalent inputs produce equivalent admission decisions across
 * deployment paths". These variables already satisfy the decision half — nothing reads them, on any
 * path. This module supplies the missing half: on EVERY deployment path, an equivalent input now
 * produces an equivalent, audible DIAGNOSIS.
 *
 * SCOPE DISCIPLINE — why this list is two names and not six. The census's PAPERCUSP_* `legacyFields`
 * span six variables, but four of them (PAPERCUSP_GATEWAY_AIMD_FLOOR, _MAX_QUEUED, _MIN_ADMISSION,
 * _PER_ACCOUNT_ADMISSION) are STILL READ by gateway.ts and still do useful, non-ceiling work: a
 * minimum admission window, a bounded-resident-memory queue, and the diagnostics readback left over
 * from P-007's retired serviceable clamp. Warning about those would be a lie in the opposite
 * direction — telling an operator that a live, working control is inert. `retired-capacity-env.test.ts`
 * pins this list to the MEASURED truth: every entry must appear in the census AND must be read by
 * nothing, so the list cannot silently drift out of agreement with the code it describes.
 */
import { INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS } from './capacity-inventory';

export interface RetiredCapacityEnvVar {
  /** The environment variable name, exactly as a deployer would export it. */
  readonly name: string;
  /** Which plan item retired it, for an operator who wants the provenance. */
  readonly retiredBy: string;
  /** What now determines this dimension instead — never another number to set. */
  readonly replacedBy: string;
}

/**
 * The genuinely-retired capacity environment inputs.
 *
 * Deliberately a small explicit constant rather than a filter over the census: the census lists
 * legacy field NAMES, which include live variables and non-env code symbols, so deriving from it
 * directly would warn about controls that still work. The companion test performs the derivation
 * as an ASSERTION instead, which gets the drift-safety of a derived list without the wrongness.
 */
export const RETIRED_CAPACITY_ENV_VARS: readonly RetiredCapacityEnvVar[] = Object.freeze([
  Object.freeze({
    name: 'PAPERCUSP_GATEWAY_CONCURRENCY',
    retiredBy: 'P-010',
    replacedBy:
      'admission concurrency is learned per provider lane from measured outcomes; the lane window has a floor and no maximum',
  }),
  Object.freeze({
    name: 'PAPERCUSP_GATEWAY_CODEX_CONCURRENCY',
    retiredBy: 'P-010',
    replacedBy:
      'Codex and Claude share ONE admission lifecycle; there is no Codex-specific admission size to configure',
  }),
]);

export interface RetiredCapacityEnvFinding {
  readonly name: string;
  readonly value: string;
  readonly retiredBy: string;
  readonly replacedBy: string;
}

/**
 * Which retired capacity inputs are present in `env`.
 *
 * An empty string counts as ABSENT: `Environment="FOO="` in a unit file, and a shell `export FOO=`,
 * both mean "not configured" to every other reader here, and warning about them would train
 * operators to ignore this warning.
 */
export function detectRetiredCapacityEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly RetiredCapacityEnvFinding[] {
  const findings: RetiredCapacityEnvFinding[] = [];
  for (const retired of RETIRED_CAPACITY_ENV_VARS) {
    const raw = env[retired.name];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    findings.push({
      name: retired.name,
      value: raw.trim(),
      retiredBy: retired.retiredBy,
      replacedBy: retired.replacedBy,
    });
  }
  return findings;
}

/** Every compatibility-group legacy field that looks like a papercusp environment variable. */
export function censusLegacyEnvNames(
  groups: typeof INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS = INFERENCE_GATEWAY_CAPACITY_COMPATIBILITY_GROUPS,
): readonly string[] {
  const names = new Set<string>();
  for (const group of groups) {
    for (const field of group.legacyFields) {
      if (/^PAPERCUSP_[A-Z0-9_]+$/.test(field)) names.add(field);
    }
  }
  return Object.freeze([...names].sort());
}

/**
 * Log a loud, actionable line per retired input that is set. Returns the findings so a caller can
 * surface them on a status endpoint too.
 *
 * The message states the three things a confused operator actually needs, in order: that the value
 * is having NO effect (the correction to their mental model), what governs the dimension instead,
 * and where to stop setting it. It is emitted at 'warn' rather than 'error' because the gateway is
 * healthy — the configuration is stale, not broken — and a spurious error would be its own bug.
 */
export function reportRetiredCapacityEnv(
  log: (level: 'warn', message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): readonly RetiredCapacityEnvFinding[] {
  const findings = detectRetiredCapacityEnv(env);
  for (const finding of findings) {
    log(
      'warn',
      `inference-gateway: ${finding.name}=${finding.value} is RETIRED (${finding.retiredBy}) and is having NO EFFECT on admission. ` +
        `${finding.replacedBy}. Remove it from this deployment's environment (systemd unit or drop-in, container env, ` +
        `packaged-app launcher, or shell) — it cannot cap or expand the gateway.`,
    );
  }
  return findings;
}
