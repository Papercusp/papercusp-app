/**
 * MemoryHealthCard — the Knowledge sub-view's memory-health strip
 * (self-improvement-consume-edges-2026-06-12 P-031 / B-10, EI-366).
 *
 * Renders the extended MemoryHealth shape from `learning.knowledge`:
 * store counts (honest — entity rows are excluded from `memories`),
 * the feedback pulse, and the new recall-quality signals (zero-hit
 * rate + top-score distribution) that make "no relevant memory for
 * this turn" distinguishable from "the index is degraded". A fragment
 * chip appears ONLY when entity-store leakage recurs — it is the
 * EI-366 regression canary and should never render.
 *
 * Pure presentational: the parent (KnowledgeView in LearningTab.tsx —
 * a multi-brief hotspot) passes the snapshot down and keeps its own
 * diff to an import + one render line. Styles ride the existing
 * `.pc-learning__flow*` classes from LearningTab's style block.
 */
import { Activity, AlertTriangle, Brain, Crosshair, Gauge, Radar, TrendingDown, TrendingUp } from 'lucide-react';
import type { MemoryHealth } from '@papercusp/operator-core/lib/memory/knowledge-read';

function fmtScore(v: number | null): string {
  return v == null ? '—' : v.toFixed(2);
}

function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

/** FP@5 trend arrow vs the previous bench: down (green) = improving, up (red) = worsening. */
function fpDeltaIcon(delta: number | null | undefined) {
  if (delta == null || Math.abs(delta) < 0.005) return null;
  return delta < 0 ? (
    <TrendingDown size={10} aria-hidden style={{ color: '#34d399', marginLeft: 3 }} />
  ) : (
    <TrendingUp size={10} aria-hidden style={{ color: '#f87171', marginLeft: 3 }} />
  );
}

/**
 * WI-10004133: the newest monitor fire when it did NOT move the trend — it failed, or the
 * flag was off — and it is newer than the latest recorded run. That is the one case where
 * the FP@5 chip is silently stale; null otherwise (no attempt recorded, or the latest fire
 * recorded a row).
 */
function unrecordedAttempt(precision: MemoryHealth['precision']) {
  const a = precision?.lastAttempt ?? null;
  if (!a || a.outcome === 'recorded') return null;
  const latestAt = precision?.latest?.ranAt;
  if (latestAt && Date.parse(a.attemptedAt) <= Date.parse(latestAt)) return null;
  return a;
}

export default function MemoryHealthCard({ memory }: { memory: MemoryHealth | null }) {
  if (!memory) {
    return (
      <div className="pc-learning__flow" aria-label="Memory health">
        <span className="pc-learning__flowchip">
          <Brain size={11} aria-hidden />
          memory health unavailable
        </span>
      </div>
    );
  }

  const zeroHitPct = memory.recalls7d > 0 ? `${Math.round(memory.zeroHitRate7d * 100)}%` : '—';
  // Some zero-hits are healthy (off-topic turns). A majority of recalls
  // returning nothing, on real volume, is the degradation signal.
  const zeroHitWorrying = memory.recalls7d >= 10 && memory.zeroHitRate7d >= 0.5;
  const stalledAttempt = unrecordedAttempt(memory.precision);

  return (
    <div className="pc-learning__flow" aria-label="Memory health">
      <span
        className="pc-learning__flowchip"
        title={`The shared canonical memory store agents recall from at session start. ${memory.entityRows} mem0 entity-linking rows share the table but are segregated out of recall and this count (EI-366).`}
      >
        <Brain size={11} aria-hidden />
        <strong>{memory.totalMemories}</strong> memories
      </span>
      <span
        className="pc-learning__flowchip"
        title="Feedback events (edits, forgets, corrections) against memories in the trailing 30 days — zero means the store is written but never corrected. Deletions feed recall back-pressure: deleted content is suppressed from injection and demoted in search."
      >
        <Activity size={11} aria-hidden />
        <strong>{memory.feedback30d}</strong> feedback events
        <em>30d</em>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Memory recalls recorded in the last 7 days across both surfaces — memory:search (pull) and the pre-turn auto-injection (push)."
      >
        <Radar size={11} aria-hidden />
        <strong>{memory.recalls7d}</strong> recalls
        <em>7d</em>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Share of recalls returning nothing, 7 days. Some zero-hits are healthy (off-topic turns have no relevant memory); a sustained majority alongside a collapsing score distribution means the index is degraded, not the questions."
      >
        <span
          className={`pc-learning__flownet ${zeroHitWorrying ? 'pc-learning__flownet--warn' : 'pc-learning__flownet--flat'}`}
        >
          {zeroHitPct}
        </span>
        zero-hit
        <em>7d</em>
      </span>
      <span
        className="pc-learning__flowchip"
        title={
          `Median / 90th-percentile top relevance score across non-empty recalls, 7 days` +
          (memory.topScoreScale
            ? `, on the ${memory.topScoreScale} scale (${memory.topScoreSamples} of ` +
              `${Object.values(memory.scaleMix).reduce((a, b) => a + b, 0)} scored recalls). ` +
              (memory.topScoreScale === 'rrf'
                ? `⚠ rrf is a RANK, not a similarity: it is bounded above by 2/61 = 0.033 and something is ` +
                  `ALWAYS rank 1, so a healthy-looking value here says nothing about whether the QUERY was ` +
                  `any good. Do not read it as a relevance floor.`
                : `cosine is an absolute similarity — a p50 collapsing toward the 0.45 injection floor means ` +
                  `recall quality is degrading even while hits still return.`)
            : `. No scored recalls in the window.`) +
          ` Scores from different backends live on incomparable scales, so this percentile covers ONE scale only.`
        }
      >
        <Gauge size={11} aria-hidden />
        score p50 <strong>{fmtScore(memory.topScoreP50)}</strong> · p90 <strong>{fmtScore(memory.topScoreP90)}</strong>
        {/* The scale is part of the number's MEANING, not a footnote: 0.03 is a
            broken retrieval on the cosine scale and a perfect rank-1 hit on the
            rrf one. Rendering the value bare is the exact ambiguity that
            produced (and then forced the retraction of) this audit's headline. */}
        {memory.topScoreScale ? <em> {memory.topScoreScale}</em> : null}
      </span>
      {memory.precision?.latest ? (
        <span
          className="pc-learning__flowchip"
          title={
            `Memory injection precision from the weekly memory-precision bench (relight P-033): the frozen gold set ` +
            `replayed against the production hybrid backend at the push floor (${memory.precision.latest.floorCosine}/${memory.precision.latest.floorLex}). ` +
            `FP@5 = the hard-negative false-positive rate (share of must-return-nothing queries that still surfaced a top-5 hit); ` +
            `lower is better — the solved floor sits ~17% (FP cannot reach 0; the hard negatives genuinely overlap real hits). ` +
            `R@10 = recall@10 over the positive queries. ${memory.precision.runCount} bench run(s).` +
            (memory.precision.latest.jevGate
              ? ` This run was gated by Jev (${memory.precision.latest.jevGate.model}, keep when P(yes) ≥ ` +
                `${memory.precision.latest.jevGate.threshold}), because the Jev switch is On: it measures what the ` +
                `injector actually admits. The model is the one the provider says answered, so a model change shows here.`
              : '')
          }
        >
          <Crosshair size={11} aria-hidden />
          FP@5 <strong>{fmtPct(memory.precision.latest.fpAt5)}</strong>
          {fpDeltaIcon(memory.precision.fpAt5Delta)}
          {memory.precision.latest.rAt10 != null ? (
            <>
              {' '}· R@10 <strong>{fmtPct(memory.precision.latest.rAt10)}</strong>
            </>
          ) : null}
          {memory.precision.latest.jevGate ? (
            <em data-testid="memory-precision-jev-gate"> · Jev-gated · {memory.precision.latest.jevGate.model}</em>
          ) : null}
        </span>
      ) : null}
      {stalledAttempt ? (
        <span
          className="pc-learning__flowchip"
          data-testid="memory-precision-last-attempt"
          style={stalledAttempt.outcome === 'failed' ? { borderColor: 'rgba(248, 113, 113, 0.5)', color: '#f87171' } : undefined}
          title={
            `The newest memory-precision monitor fire (${stalledAttempt.attemptedAt}) recorded no bench row, so the ` +
            `FP@5 figure is older than it looks. ` +
            (stalledAttempt.outcome === 'failed'
              ? `It failed at the ${stalledAttempt.stage ?? 'unknown'} step: ${stalledAttempt.error ?? '(no error text)'}`
              : `The MEMORY_PRECISION_BENCH flag was off, so nothing ran by design.`)
          }
        >
          <AlertTriangle size={11} aria-hidden />
          {stalledAttempt.outcome === 'failed'
            ? <>precision bench <strong>failed</strong> at {stalledAttempt.stage ?? '?'}</>
            : <>precision bench <strong>skipped</strong> (flag off)</>}
        </span>
      ) : null}
      {memory.fragmentHits7d > 0 ? (
        <span
          className="pc-learning__flowchip"
          style={{ borderColor: 'rgba(248, 113, 113, 0.5)', color: '#f87171' }}
          title="Entity-store fragments (entityType payloads) leaked into recall results in the last 7 days. This is the EI-366 regression canary — it must be zero; a non-zero value means the canonical-store segregation broke."
        >
          <AlertTriangle size={11} aria-hidden />
          <strong>{memory.fragmentHits7d}</strong> fragment hits
          <em>7d</em>
        </span>
      ) : null}
    </div>
  );
}
