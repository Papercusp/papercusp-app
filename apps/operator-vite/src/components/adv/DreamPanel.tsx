import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { Moon } from 'lucide-react';
import { Select } from '@/app/harness/Select';
import { Button } from '@/app/harness/Button';
import { Table } from '@/app/harness/Table';
import type { DreamMetrics } from '@papercusp/operator-core/lib/dream/dream-metrics';
import { dreamRunOutcome } from '@papercusp/operator-core/lib/dream/dream-config';
import type { DreamDetail, DreamHistory } from '@papercusp/operator-core/lib/dream/dream-read';
import {
  LearningDisclosure, LearningPageHeader, LearningVisualEmpty, LearningVisualError,
} from './LearningVisuals';
import { snapshotFault } from './snapshot-fault';

const money = (value: number | null | undefined) => value == null ? 'unknown' : `$${value.toFixed(4)}`;
const rate = (value: { numerator: number; denominator: number; value: number | null }) =>
  `${value.numerator} / ${value.denominator} · ${value.value == null ? 'not available' : `${(value.value * 100).toFixed(1)}%`}`;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : 'Not recorded';
const when = (value: string) => new Date(value).toLocaleString();
const sourceId = (runId: string, unit: string, id: string) =>
  `dream-source-${Array.from(JSON.stringify([runId, unit, id]), c => c.codePointAt(0)!.toString(16)).join('-')}`;
function learningLink(params: Record<string, string>) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', 'learning');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

/** A read-only view. Start/Pause remain in the existing pot controls. */
export function DreamPanel({ active = true }: { active?: boolean }) {
  const enabled = useFlag(FLAGS.DREAM_CYCLE);
  return enabled ? <DreamPanelBody active={active} /> : null;
}

function DreamPanelBody({ active }: { active: boolean }) {
  const [pot, setPot] = useQueryState('dreamPot', parseAsString.withDefault(''));
  const [runId, setRun] = useQueryState('dreamRun', parseAsString.withDefault(''));
  const [cursor, setCursor] = useQueryState('dreamBefore', parseAsString.withDefault(''));
  const projects = useSyncQuery<{ slug: string; harness_kind?: string | null }>({
    queryName: 'harnessProjects.lite', args: { includeHiveHomes: true }, staleTime: 60_000, enabled: active,
  });
  const pots = (projects.data ?? []).filter(p => p.harness_kind === 'hive');
  return (
    <section className="pc-dreams" aria-label="Dreams">
      <LearningPageHeader icon={Moon} title="Dreams" question="Which code combinations were tried, and what survived review?" />
      <div className="pc-dreams__toolbar">
        <Select ariaLabel="Dream pot" placeholder="Choose a pot" value={pot || ''}
          triggerChildren={<span>{pot || 'Choose a pot'}</span>}
          options={pots.map(p => ({ value: p.slug, label: p.slug }))}
          onChange={value => { void setPot(value); void setRun(null); void setCursor(null); }} />
        {pot ? <a href={learningLink({ lview: 'pipeline', lpot: pot })}>Start / Pause controls</a> : null}
      </div>
      {projects.error ? <LearningVisualError title="Pot list unavailable" onRetry={() => projects.invalidate()} /> : null}
      {pot ? <DreamPotHistory key={pot} potSlug={pot} runId={runId || ''} setRun={value => void setRun(value || null)}
        cursor={cursor || ''} setCursor={value => void setCursor(value || null)} active={active} />
        : <p className="pc-learning__quietempty">Choose a pot to see its last seven days of Dream attempts. Viewing this history starts no work.</p>}
      <style>{`
        .pc-dreams { margin: 12px 0 20px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-1); color: var(--fg); }
        .pc-dreams__toolbar, .pc-dreams__rates { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
        .pc-dreams p, .pc-dreams li, .pc-dreams dd { font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
        .pc-dreams h4 { margin: 12px 0 6px; }
        .pc-dreams a { color: var(--accent); overflow-wrap: anywhere; }
        .pc-dreams__funnel, .pc-dreams__units { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 10px; margin: 12px 0; }
        .pc-dreams__funnel > div, .pc-dreams__unit { padding: 10px; border: 1px solid var(--border); border-radius: 8px; min-width: 0; }
        .pc-dreams__funnel dt { font-size: 11px; color: var(--fg-mute); }
        .pc-dreams__funnel dd { margin: 4px 0 0; font-size: 18px; font-weight: 650; }
        .pc-dreams__runs { display: flex; flex-direction: column; gap: 8px; }
        .pc-dreams .pc-learning-visual__disclosure-label { white-space: normal; }
        .pc-dreams__quiet { color: var(--fg-mute); }
        .pc-dreams__table { overflow-x: auto; }
        .pc-dreams table { border-collapse: collapse; width: 100%; font-size: 12px; }
        .pc-dreams th, .pc-dreams td { padding: 6px; text-align: left; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
        .pc-dreams pre { font-size: 11px; padding: 10px; background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; }
        .pc-dreams [role=alert] { color: var(--bad); }
      `}</style>
    </section>
  );
}

function DreamPotHistory({ potSlug, runId, setRun, cursor, setCursor, active }: {
  potSlug: string; runId: string; setRun: (value: string) => void;
  cursor: string; setCursor: (value: string) => void; active: boolean;
}) {
  const metrics = useSyncQuery<DreamMetrics>({
    queryName: 'learning.dream', args: { potSlug, view: 'metrics' }, enabled: active, staleTime: 30_000,
  });
  const metricFault = snapshotFault(metrics.error, metrics.data?.[0], 'Dream metrics');
  const summary = metricFault.failed ? undefined : metrics.data?.[0];
  const history = useSyncQuery<DreamHistory>({
    queryName: 'learning.dream', args: { potSlug, view: 'history', since: summary?.scope.since,
      until: summary?.scope.until, ...(cursor ? { cursor } : {}) },
    enabled: active && Boolean(summary), staleTime: 30_000,
  });
  const historyFault = snapshotFault(history.error, history.data?.[0], 'Dream attempts');
  const page = historyFault.failed ? undefined : history.data?.[0];
  const reload = () => { metrics.invalidate(); history.invalidate(); };
  return <>
    <div className="pc-dreams__toolbar"><Button onClick={reload}>Refresh Dream history</Button>
      {summary ? <span className="pc-dreams__quiet">{when(summary.scope.since)} – {when(summary.scope.until)}</span> : null}</div>
    {metricFault.failed ? <LearningVisualError title={metricFault.message!} onRetry={reload} />
      : !summary ? <p role="status">{metrics.loading ? 'Loading Dream metrics…' : 'Dream metrics unavailable.'}</p>
      : <DreamFunnel metrics={summary} />}
    {historyFault.failed ? <LearningVisualError title={historyFault.message!} onRetry={reload} />
      : !page ? summary ? <p role="status">{history.loading ? 'Loading Dream attempts…' : 'Dream attempts unavailable.'}</p> : null
        : <>
          {page.runs.length === 0 ? <LearningVisualEmpty icon={Moon} title="No Dream attempts in this page"
            body="This history includes accepted, rejected, duplicate, abstained, malformed, failed and running attempts." /> : null}
          <div className="pc-dreams__runs">
            {page.runs.map(run => <LearningDisclosure key={run.runId}
              label={`${when(run.startedAt)} · ${dreamRunOutcome(run.status, run.review)} · ${run.title ?? run.runId}`}
              subtitle={`${run.mode} · ${money(run.costUsd)} accounted · cycle ${run.cycleId}`}
              open={runId === run.runId} onOpenChange={open => setRun(open ? run.runId : '')}>
              <DreamDetailLoader potSlug={potSlug} runId={run.runId} />
            </LearningDisclosure>)}
          </div>
          {runId && !page.runs.some(r => r.runId === runId) ? <LearningDisclosure label="Selected Dream attempt" open onOpenChange={() => setRun('')}>
            <DreamDetailLoader potSlug={potSlug} runId={runId} />
          </LearningDisclosure> : null}
          <div className="pc-dreams__toolbar">
            {cursor ? <Button onClick={() => setCursor('')}>Newest attempts</Button> : null}
            {page.nextCursor ? <Button onClick={() => setCursor(page.nextCursor!)}>Older attempts</Button> : null}
          </div>
        </>}
  </>;
}

export function DreamFunnel({ metrics: m }: { metrics: DreamMetrics }) {
  const f = m.funnel, accepted = f.statuses.accepted ?? 0;
  const phaseCosts = Object.entries(m.cost.phases).map(([phase, cost]) => ({ phase, cost }));
  return <>
    <dl className="pc-dreams__funnel" aria-label="Dream funnel">
      {Object.entries({ Attempts: m.population.attempts, 'Eligible attempts': f.eligibleAttempts,
        'Proposals claimed': f.proposalAttempts, Reviewed: f.reviewedAttempts,
        'Review passed': f.reviewPassedAttempts, 'Accepted to corpus': accepted, 'Routed artifacts': f.uniqueRoutedArtifacts }).map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <p>Claim rate (eligible attempts): {rate(f.proposalsPerEligibleAttempt)}.</p>
    <p>Review pass rate (decisive reviews): {rate(f.reviewPassRate)}.</p>
    {f.reviewOutcomes ? <p>Review outcomes: {Object.entries(f.reviewOutcomes).map(([key, n]) => `${key}: ${n}`).join(' · ')}. Unverified and unavailable reviews are not substantive rejections.</p> : null}
    <p>Dedupe / sink survival (review-passed attempts): {rate(f.dedupeSurvival)}.</p>
    <p className="pc-dreams__quiet">Metrics cover every attempt in this window, including older pages. Acceptance is a review decision; downstream usefulness is measured separately.</p>
    <p>Known model charges: {money(m.cost.knownCallUsd)} · unresolved reservations: {money(m.cost.unresolvedBoundUsd)} · fully attributed discovery cost: {money(m.cost.fullyAttributedDiscoveryUsd)}.</p>
    <p>Packet costs: {money(m.cost.distinctPacketHistoricalUsd)} historical · {m.cost.unknownUsageCount} calls with unknown usage · {m.cost.unknownPackets} packets with unknown cost.</p>
    {m.cost.reconciliationErrors.length ? <p role="alert">Cost accounting does not reconcile for {m.cost.reconciliationErrors.length} recorded checks.</p> : null}
    <LearningDisclosure label="Sources, outcomes and phase costs">
      <p>Selected units: {m.coverage.selectedUnits} · domain pairs: {m.coverage.domainPairs} · population coverage: {rate(m.coverage.sourcePopulationCoverage)}.</p>
      <p>Qualified families: {f.qualifiedFamilies} · repeated-family rate: {rate(m.novelty.repeatedFamilyRate)} · legacy attempts: {m.population.legacy}.</p>
      {m.reuse ? <p>Rediscoveries: {m.reuse.rediscovery} · refinements: {m.reuse.refinement} · linked to prior work: {m.reuse.linkedToPrior}. Assessed usefulness: {Object.entries(m.reuse.usefulness).map(([key, n]) => `${key}: ${n}`).join(' · ')}. These earn no new-discovery credit.</p> : null}
      <p>Downstream outcomes: {Object.entries(m.downstream.outcomes).map(([key, n]) => `${key}: ${n}`).join(' · ') || 'Not recorded'}.</p>
      <p>Human grades: {Object.entries(m.downstream.grades).map(([key, n]) => `${key}: ${n}`).join(' · ') || 'Not recorded'}.</p>
      <p>Experiments: {m.experiments.executed} executed / {m.experiments.declaredLinks} linked · {m.experiments.missingResults} results missing · engineer time: unknown.</p>
      <div className="pc-dreams__table"><Table
        caption="Model call costs by phase"
        columns={[
          { key: 'phase', header: 'Phase', render: row => row.phase },
          { key: 'known', header: 'Known', render: row => money(row.cost.knownUsd) },
          { key: 'unresolved', header: 'Unresolved bound', render: row => money(row.cost.unresolvedBoundUsd) },
          { key: 'actual', header: 'Actual total', render: row => money(row.cost.actualUsd) },
        ]}
        rows={phaseCosts}
        getRowKey={row => row.phase}
      /></div>
    </LearningDisclosure>
  </>;
}

export function DreamDetailLoader({ potSlug, runId }: { potSlug: string; runId: string }) {
  const query = useSyncQuery<DreamDetail>({ queryName: 'learning.dream', args: { potSlug, view: 'run', runId }, staleTime: 30_000 });
  const fault = snapshotFault(query.error, query.data?.[0], 'Dream detail');
  if (fault.failed) return <LearningVisualError title={fault.message!} onRetry={() => query.invalidate()} />;
  const detail = query.data?.[0];
  if (!detail) return <p role="status">{query.loading ? 'Loading Dream detail…' : 'This attempt was not found in this pot.'}</p>;
  return <DreamRunDetail detail={detail} />;
}

export function DreamRunDetail({ detail: d }: { detail: DreamDetail }) {
  const { run, provenance: p, proposal: c, capabilityReview: review } = d;
  const selection = p?.sampling?.status === 'selected' ? p.sampling.selection : null;
  const units = selection ? [{ label: 'A', entry: selection.a }, { label: 'B', entry: selection.b },
    ...(selection.c ? [{ label: 'C', entry: selection.c.entry }] : [])] : [];
  const citations = (refs: Array<{ unit: string; evidenceId: string }>) => refs.map((ref, i) =>
    <a key={`${ref.unit}:${ref.evidenceId}:${i}`} href={`#${sourceId(run.runId, ref.unit, ref.evidenceId)}`}>{ref.unit}/{ref.evidenceId} </a>);
  return <article aria-label={`Dream ${run.runId}`}>
    <p><strong>{dreamRunOutcome(run.status, run.review)}</strong> · {run.mode} · {when(run.startedAt)} · {money(run.costUsd)} accounted</p>
    <p>Run {run.runId} · cycle {run.cycleId}</p>
    {run.error ? <p role="alert">{run.error}</p> : null}
    {run.routedRef ? <a href={learningLink({ lview: 'improvements', impq: run.routedRef.replace(/^[a-z-]+:/i, ''), lscope: 'all' })}>Open accepted proposal in Improvements: {run.routedRef}</a> : null}
    {!p ? <p>Legacy attempt: capability packets, phase receipts and current source freshness were not recorded.</p>
      : <>
        <p>Source freshness now: not rechecked. Versions and index health below describe the captured attempt.</p>
        <p>Manifest {p.manifestRevision} · generation {p.dreamPromptVersion} · review {p.reviewPromptVersion}</p>
        <p>Catalogue coverage: partial. Unmapped repository behaviors remain unknown; these units are not a repository census.</p>
        {p.sampling ? <p>Sampling: {p.sampling.log.strategy} · {p.sampling.log.mode} · seed {p.sampling.log.seed} · snapshot {p.sampling.log.snapshotFingerprint}</p> : <p>Source selection was not recorded.</p>}
        {p.sampling?.status === 'no-pair' ? <p>No eligible composition: {p.sampling.reason}</p> : null}
        {p.sampling?.log.exclusions.length ? <ul>{p.sampling.log.exclusions.map((e, i) => <li key={i}>{e.unitId}: {e.reason}</li>)}</ul> : null}
      </>}
    <div className="pc-dreams__units">
      {units.map(({ label, entry: { packet, contentVersion } }) => <section className="pc-dreams__unit" key={label} aria-label={`Source ${label}`}>
        <h4>{label} · {packet.unit.id}</h4><p>{packet.unit.homeDomain} · {packet.unit.granularity}</p>
        <p>{label === 'C' ? `Third role: ${selection?.c?.declaration.role}` : 'Primary unit'}</p>
        <p>Content version: {contentVersion}</p><p>Captured: {when(packet.extraction.capturedAt)} · index {packet.extraction.indexHealth}</p>
        <p>Commit: {packet.extraction.sourceCommit ?? 'not recorded'} · working-tree changes: {packet.extraction.dirty == null ? 'unknown' : packet.extraction.dirty ? 'present' : 'none at capture'}</p>
        {(['purpose', 'mechanism', 'evaluation'] as const).map(facet => <p key={facet}><strong>{facet}: </strong>{packet.unit[facet].map(f => f.text).join(' ')}</p>)}
        {packet.sources.map(source => <p key={source.id}><a href={`#${sourceId(run.runId, label, source.id)}`}>{source.kind}: {source.path}:{source.startLine}–{source.endLine}</a></p>)}
        <p className="pc-dreams__quiet">{packet.coverage.note}</p>
      </section>)}
    </div>
    {d.problemContext ? <section aria-label="Problem context">
      <h4>{d.problemContext.mode === 'observed-problems' ? 'Observed problem context' : 'Open exploration'}</h4>
      <p>{d.problemContext.note}</p>
      {d.problemContext.evidence.map(problem => <p key={problem.ref}>{problem.ref} · reported by {problem.attributedTo} · {when(problem.capturedAt)}: {problem.text}</p>)}
    </section> : null}
    {c ? <>
      <h4>{c.behavior}</h4><p>For: {c.beneficiary}</p><p>Hypothesis: {c.hypothesis}</p>
      {c.problemFit ? <p>Addresses {c.problemFit.refs.join(', ')} for {c.problemFit.beneficiary}: {c.problemFit.proposedImprovement} (proposed benefit).</p> : null}
      <h4>What each unit contributes</h4>
      {Object.entries(c.primaryContributions).map(([label, part]) => <p key={label}><strong>{label}: </strong>{part.uniqueContribution} Removing it: {part.removalEffect} {citations(part.sources)}</p>)}
      {c.thirdContribution ? <p><strong>C ({c.thirdContribution.role}): </strong>{c.thirdContribution.uniqueContribution} Removing it: {c.thirdContribution.removalEffect} {citations(c.thirdContribution.sources)}</p> : null}
      <h4>Observed evidence and proposed connections</h4>
      {c.observed.map((o, i) => <p key={i}>{o.claim} {citations(o.sources)}</p>)}
      {c.relations.map((r, i) => <p key={i}>{r.kind}: {r.mapping} Preconditions: {r.preconditions.join('; ')}. Risks: {r.transferRisks.join('; ')}. {citations([r.from, r.to])}</p>)}
      <p>Assumptions: {c.assumptions.join('; ') || 'None declared'}</p><p>Missing evidence: {c.missingEvidence.join('; ') || 'None declared'}</p>
      <h4>Difference from prior work</h4><p>{c.priorArt.proposedDelta} (proposal claim; {c.priorArt.verification})</p>
      {c.priorArt.knownRelatedWork.map((r, i) => <p key={i}>{r.ref}: {r.overlap}</p>)}
      <h4>Falsifiable experiment</h4><p>Baseline: {c.experiment.baseline}</p><p>Change: {c.experiment.change}</p>
      <p>Measure: {c.experiment.measurement}</p><p>Success: {c.experiment.successCriterion}</p><p>Falsifier: {c.experiment.falsifier}</p>
    </> : <p>Proposal: {text((run.outcome?.insight as Record<string, unknown> | undefined)?.text)} · {text(run.outcome?.verdict)}</p>}
    <h4>Independent review</h4>
    {d.reuse ? <section aria-label="Existing work and reuse">
      <p>{d.reuse.kind === 'refinement' ? 'Refinement of existing work' : 'Rediscovery of existing work'} · assessed usefulness: {d.reuse.usefulness}. No new-discovery credit; no duplicate work is created.</p>
      <p>Existing work: {d.reuse.priorRefs.join(', ') || 'No verified prior reference recorded'}.</p>
      <p>Assessed families: {d.reuse.familyIds.join(', ') || 'unknown'}.</p>
    </section> : null}
    <p>Dreamer: {run.dreamerModel ?? 'unknown'} · reviewer: {run.reviewerModel ?? 'unknown'}</p>
    {run.review ? <p>{text(run.review.verdict)} · {text(run.review.reason)} · {text(run.review.note ?? run.review.rejectionReason)}</p> : <p>No review recorded.</p>}
    {d.nextCheck ? <section aria-label="Next evidence check">
      <h4>Next evidence check</h4><p>{d.nextCheck.instruction}</p>
      {d.nextCheck.evidenceNeeded.length ? <ul>{d.nextCheck.evidenceNeeded.map((needed, i) => <li key={i}>{needed}</li>)}</ul> : null}
      <p>At most {d.nextCheck.maxSourceQueries} source searches per review. Opening this result starts no work.</p>
    </section> : null}
    {review ? <>
      {review.evidenceFollowUp ? <p>Missing-evidence follow-up: {review.evidenceFollowUp.queries.length} / {review.evidenceFollowUp.maxQueries} bounded searches; {review.evidenceFollowUp.deferred.length} further requests deferred. Retrieval alone does not establish the claim.</p> : null}
      <p>Review evidence: {review.evidenceHash} · candidate: {review.candidateHash}</p>
      <p>Novelty beyond the searched corpus: {review.coverage.globalNovelty}.</p>
      {review.coverage.unknown.map((note, i) => <p key={i}>Unknown: {note}</p>)}
      {review.judgment?.comparisons.map((match, i) => <p key={i}>{match.ref}: {match.disposition} — {match.note}</p>)}
      {(['aOnly', 'bOnly'] as const).map(key => <p key={key}>{key === 'aOnly' ? 'A-only control' : 'B-only control'}: {review.controls[key] ? `${review.controls[key]!.unchanged == null ? 'unknown' : review.controls[key]!.unchanged ? 'proposal survives unchanged' : 'proposal changes'} · ${review.controls[key]!.note}` : 'Not recorded'}</p>)}
      {review.judgment ? <><p>Relation: {review.judgment.relation.status} · {review.judgment.relation.note}</p><p>Feasibility: {review.judgment.feasibility.status} · {review.judgment.feasibility.note}</p><p>Reviewer falsifier: {review.judgment.experiment.falsifier}</p></> : null}
    </> : null}
    {d.assessments.map(a => <p key={a.id}>Assessment by {a.assessor}: family {a.familyId ?? 'unknown'} · novelty {a.novelty} · usefulness {a.usefulness} · maintainability {a.maintainability} · experiments {a.experimentBatteryIds.join(', ') || 'none linked'}</p>)}
    <h4>Phase charges</h4>
    {p ? <div className="pc-dreams__table"><Table
      columns={[
        { key: 'phase', header: 'Phase / model', render: call => `${call.phase} / ${call.model}` },
        { key: 'status', header: 'Status', render: call => `${call.status}${call.error ? ` · ${call.error}` : ''}` },
        { key: 'actual', header: 'Actual', render: call => money(call.usage?.costUsd) },
        { key: 'reserved', header: 'Reserved', render: call => money(call.reservedUsd) },
      ]}
      rows={p.calls}
      getRowKey={call => call.callId}
    /></div> : <p>Legacy summary: generation {money(run.dreamUsage?.costUsd)} · review {money(run.reviewUsage?.costUsd)}.</p>}
    {units.length ? <LearningDisclosure label="Captured code and test evidence" defaultOpen>
      {units.flatMap(({ label, entry: { packet } }) => packet.sources.map(source => <section key={`${label}:${source.id}`} id={sourceId(run.runId, label, source.id)}>
        <h4>{label}/{source.id} · {source.path}:{source.startLine}–{source.endLine}</h4><p>Source hash: {source.sourceHash}</p><p>{source.proves}</p><pre>{source.excerpt}</pre>
      </section>))}
    </LearningDisclosure> : null}
  </article>;
}
