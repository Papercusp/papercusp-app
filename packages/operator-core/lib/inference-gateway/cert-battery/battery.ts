/**
 * cert-battery/battery — the runner (D-005). Runs the four probes over an injected
 * ProbeContext, aggregates the mangling metric across every probe's tool-call emissions,
 * and computes a deterministic pass/fail verdict. No LLM judge — the verdict is a
 * boolean over counted signals (coordination-eval.ts D-002).
 *
 * A run's OUTPUT is a CertReport whose `verdict + config + key metrics` become the
 * certification evidence attached to a provisioner/catalog.ts CERTIFIED_CATALOG entry
 * (flipping it provisional → certified) — never a parallel catalog.
 */
import { CERT_PROBES } from './probes';
import {
  CERT_THRESHOLDS,
  type CertConfig,
  type CertReport,
  type ProbeContext,
  type ProbeResult,
  type ToolCallStats,
} from './types';

export type Probe = (ctx: ProbeContext) => Promise<ProbeResult>;

export interface RunCertBatteryDeps {
  ctx: ProbeContext;
  /** Override which probes run (default: all four). Tests inject a subset; a caller
   *  certifying a backend that (say) offers no tools could drop the tool probes. */
  probes?: readonly Probe[];
}

/** Sum every probe's tool-call accounting into the single aggregate the verdict gates on. */
export function aggregateMangling(probes: readonly ProbeResult[]): { rate: number; detail: ToolCallStats } {
  const detail = probes.reduce<ToolCallStats>(
    (acc, p) => {
      const s = p.toolCallStats;
      if (!s) return acc;
      return { attempts: acc.attempts + s.attempts, malformed: acc.malformed + s.malformed, notFound: acc.notFound + s.notFound };
    },
    { attempts: 0, malformed: 0, notFound: 0 },
  );
  const rate = detail.attempts > 0 ? (detail.malformed + detail.notFound) / detail.attempts : 0;
  return { rate, detail };
}

/** Certified iff every CRITICAL probe passed AND the aggregate mangling rate is within threshold. */
export function computeVerdict(probes: readonly ProbeResult[], manglingRate: number): 'certified' | 'failed' {
  const allCriticalPass = probes.filter((p) => p.critical).every((p) => p.passed);
  return allCriticalPass && manglingRate <= CERT_THRESHOLDS.manglingRateMax ? 'certified' : 'failed';
}

function buildSummary(config: CertConfig, probes: readonly ProbeResult[], rate: number, verdict: string): string {
  const critical = probes.filter((p) => p.critical);
  const criticalPass = critical.filter((p) => p.passed).length;
  const perSlot = config.parallel > 0 ? Math.round(config.numCtx / config.parallel) : config.numCtx;
  return (
    `[${verdict}] ${config.model} ${config.quant} @ ${config.backend} ` +
    `(${config.parallel}×${perSlot} ctx): ${criticalPass}/${critical.length} critical probes pass, ` +
    `mangling ${(rate * 100).toFixed(1)}%`
  );
}

/** Run the certification battery for one locked config. Deterministic given a deterministic
 *  `ctx.chat` — the whole thing is unit-testable with a fake client (no live model). */
export async function runCertBattery(config: CertConfig, deps: RunCertBatteryDeps): Promise<CertReport> {
  const toRun = deps.probes ?? CERT_PROBES;
  const probes: ProbeResult[] = [];
  for (const probe of toRun) probes.push(await probe(deps.ctx));

  const { rate, detail } = aggregateMangling(probes);
  const verdict = computeVerdict(probes, rate);
  const ranAt = new Date(deps.ctx.now()).toISOString();

  return {
    config,
    probes,
    manglingRate: rate,
    manglingDetail: detail,
    verdict,
    ranAt,
    summary: buildSummary(config, probes, rate, verdict),
  };
}
