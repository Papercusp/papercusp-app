/**
 * LearningEfficacyPanel — the "is the system actually LEARNING" strip on the
 * Learning tab (relight-self-learning-edges-2026-06-14 P-020).
 *
 * The flow strip above it measures THROUGHPUT (captured / resolved / recurring /
 * watchdog). This strip is the complementary EFFICACY view — four metrics that
 * say whether the learning actually HELD:
 *
 *   • auto-fix survival — of matured fix-survival bets, the share whose fix held;
 *   • champion Δ vs gen-0 — the latest IQ-battery generation's composite minus the
 *     gen-0 baseline (gen0-93b50cb39, composite 5.950);
 *   • recurrence decay — verified / (verified + recurred): fixes that decayed clean;
 *   • memory FP@5 — the latest memory-precision bench false-positive rate (P-033).
 *
 * Most of this data is YOUNG, so each metric renders its honest STATE: a real
 * number when matured (`ok`), a muted "warming" when the machinery is live but
 * nothing has matured, and "—" when there is no machinery/data yet. Pure
 * presentational over the `learning.efficacy` sync query; styles ride the
 * existing `.pc-learning__flow*` classes (mirrors MemoryHealthCard).
 */
import type { ReactNode } from 'react';
import { Crosshair, GraduationCap, Repeat2, ShieldCheck } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import type { EfficacyMetric, LearningEfficacy } from '@papercusp/operator-core/lib/learning/efficacy-read';
import { LoopSection } from './LearningVisuals';

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

/** Signed two-decimal composite delta (+0.42 / −0.18); the champion-vs-gen-0 number. */
function signed(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
}

function Chip({
  icon,
  label,
  m,
  fmt,
}: {
  icon: ReactNode;
  label: string;
  m: EfficacyMetric;
  fmt: (v: number | null) => string;
}): ReactNode {
  // A metric can be entirely absent (no machinery/data yet) — render the honest "—"
  // no-data state rather than crashing on `m.state` (the LearningTab 13-test crash, EI-1454).
  const muted = m?.state !== 'ok';
  const valueText = m?.state === 'ok' ? fmt(m.value) : m?.state === 'warming' ? 'warming' : '—';
  return (
    <span className="pc-learning__flowchip" title={m?.detail ?? label} style={muted ? { opacity: 0.55 } : undefined}>
      {icon}
      {label} <strong>{valueText}</strong>
    </span>
  );
}

export default function LearningEfficacyPanel(): ReactNode {
  const sync = useSyncQuery<LearningEfficacy>({ queryName: 'learning.efficacy', args: {}, staleTime: 30_000 });
  const eff = sync.data?.[0];
  // P-004: the panel wraps ITSELF in its "Did it stick?" section, because it is
  // the only thing that knows it has no data — a caller-side wrapper would leave
  // a labelled card standing empty on every workspace whose efficacy read is
  // still cold.
  if (!eff) return null;

  return (
    <LoopSection label="Did it stick?" answer="whether past fixes and lessons actually held">
    <div className="pc-learning__flow" aria-label="Learning efficacy">
      <span
        className="pc-learning__flowchip"
        style={{ opacity: 0.7 }}
        title="Did the learning HOLD? The flow strip above counts items in/out; these four measure whether the fixes, champions, and memory actually got better. Most are young — they read 'warming' until enough matures."
      >
        efficacy
      </span>
      <Chip
        icon={<ShieldCheck size={11} aria-hidden />}
        label="auto-fix survival"
        m={eff.autoFixSurvival}
        fmt={pct}
      />
      <Chip
        icon={<GraduationCap size={11} aria-hidden />}
        label={`champion Δ vs gen-0${
          eff.gen0Baseline?.composite != null ? ` (${eff.gen0Baseline.composite.toFixed(2)})` : ''
        }`}
        m={eff.championDelta}
        fmt={signed}
      />
      <Chip icon={<Repeat2 size={11} aria-hidden />} label="recurrence decay" m={eff.recurrenceDecay} fmt={pct} />
      <Chip icon={<Crosshair size={11} aria-hidden />} label="memory FP@5" m={eff.memoryFpAt5} fmt={pct} />
    </div>
    </LoopSection>
  );
}
