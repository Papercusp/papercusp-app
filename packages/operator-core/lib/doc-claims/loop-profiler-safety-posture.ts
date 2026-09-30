/**
 * Doc claim: the IN-PROCESS V8 CPU profiler stays default-OFF and hard-capped.
 *
 * `agent-insights/is-this-process-actually-doing-work` tells agents, in its
 * "Do NOT reach for the in-process V8 profiler on a saturated loop" section, that
 * `captureCpuProfile()` is (a) opt-in rather than on-by-default and (b) skipped
 * entirely above a finite `profileMaxP95Ms` band. That advice is load-bearing in an
 * unusual direction: it is what stops an agent diagnosing a CPU-pinned service from
 * re-arming WI-3797, where the profiler's `node:inspector` session — which must
 * complete over the SAME event loop it is diagnosing — died on an uncatchable
 * `Napi::Error` native abort and crash-looped the green-release operator 8x on
 * 2026-07-10 (SIGABRT, 60-90s downtime per crash).
 *
 * If either rail is removed, the doc does not merely go stale — it keeps promising a
 * safety net that is no longer there, which is worse than saying nothing. So pin both
 * to the code instead of to prose (the derived-truth ladder's PIN rung).
 *
 * This judge is deliberately a PURE function over source text so the test can prove it
 * is falsifiable against fixtures before trusting it against the live tree.
 */

/** The dev/test-only env override. It is NOT the production gate — see the module comment. */
export const PROFILER_ENV_GATE = 'PAPERCUSP_LOOP_PROFILER';

export interface ProfilerPostureVerdict {
  ok: boolean;
  problems: string[];
  /** The env override is a strict `=== '1' | 'true'` opt-in, not a `!== '0'` default-on. */
  envGateStrictOptIn: boolean;
  /** The production gate falls back to the env gate, never to a literal `true`. */
  optsGateDefaultsToEnv: boolean;
  /** The finite default of `profileMaxP95Ms`, or null when no finite default survives. */
  maxP95DefaultMs: number | null;
}

/**
 * Strip `//` line comments AND block comments.
 *
 * BOTH are required here, and the block half is the one that matters: every claim site
 * in the monitor sits beside long JSDoc that names `profileMaxP95Ms` and
 * `profileOnSaturation` several times, so a scan that did not strip comments would keep
 * passing after the assignment itself was deleted — the exact shape of a detector that
 * cannot fail.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function judgeProfilerSafetyPosture(args: { monitorSource: string }): ProfilerPostureVerdict {
  const problems: string[] = [];
  const code = stripComments(args.monitorSource);

  // (1) The env override must be a strict opt-in. A `!==` comparison is the shape that
  // silently inverts the default to ON for everyone who has not set the variable.
  const strictEnvReads = code.match(
    new RegExp(String.raw`process\.env\.${PROFILER_ENV_GATE}\s*===\s*['"][^'"]+['"]`, 'g'),
  );
  const negatedEnvRead = new RegExp(String.raw`process\.env\.${PROFILER_ENV_GATE}\s*!==`).test(code);
  const envGateStrictOptIn = (strictEnvReads?.length ?? 0) > 0 && !negatedEnvRead;
  if (!strictEnvReads?.length) {
    problems.push(
      `${PROFILER_ENV_GATE} is no longer read as a strict === opt-in; the doc's "default-OFF" claim is unbacked.`,
    );
  }
  if (negatedEnvRead) {
    problems.push(
      `${PROFILER_ENV_GATE} is read with !== — that inverts the gate to default-ON, which is the WI-3797 posture.`,
    );
  }

  // (2) The production gate must DEFAULT to the env gate. `?? true` would turn the
  // profiler on for every caller that did not explicitly pass false.
  const defaultsToLiteralTrue = /opts\.profileOnSaturation\s*\?\?\s*true\b/.test(code);
  const optsGateDefaultsToEnv =
    /opts\.profileOnSaturation\s*\?\?/.test(code) && !defaultsToLiteralTrue;
  if (!/opts\.profileOnSaturation\s*\?\?/.test(code)) {
    problems.push(
      'opts.profileOnSaturation no longer has a `??` fallback; the opt-in default cannot be confirmed.',
    );
  }
  if (defaultsToLiteralTrue) {
    problems.push('opts.profileOnSaturation defaults to literal `true` — that is default-ON.');
  }

  // (3) The saturation cap must have a FINITE numeric default. Removing it (or defaulting
  // to Infinity) re-opens exactly the deeply-blocked-loop band where the native abort lives.
  const capMatch = code.match(/opts\.profileMaxP95Ms\s*\?\?\s*([A-Z][A-Z0-9_]*|[0-9_]+)/);
  const capToken = capMatch?.[1] ?? '';
  const resolvedCap = /^[0-9_]+$/.test(capToken)
    ? capToken
    : code.match(new RegExp(`(?:const|let)\\s+${capToken}\\s*=\\s*([0-9_]+)`))?.[1] ?? '';
  const rawCap = Number(resolvedCap.replace(/_/g, ''));
  const maxP95DefaultMs = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : null;
  if (maxP95DefaultMs === null) {
    problems.push(
      'profileMaxP95Ms has no finite positive default — the safe-band ceiling the doc cites is gone.',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    envGateStrictOptIn,
    optsGateDefaultsToEnv,
    maxP95DefaultMs,
  };
}
