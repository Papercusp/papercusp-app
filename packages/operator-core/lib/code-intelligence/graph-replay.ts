/**
 * Historical replay accounting for gitnexus-deterministic-integration P-003/R-4.
 * This consumes evidence; it is NOT another graph backend or test selector.
 * A hypothesis, current index, missing source, or empty graph never earns credit.
 * D-006's count and red-rate thresholds are deliberately separate denominators.
 */
export const REPLAY_SIGNALS = ['graph-added-workspaces', 'edit-time-impact', 'graph-ordering'] as const;
export type ReplaySignal = (typeof REPLAY_SIGNALS)[number];
export type ReplayVerdict = 'incremental' | 'not-incremental' | 'unknown';

export interface ReplayObservation {
  verdict: ReplayVerdict;
  comparison: 'observed' | 'counterfactual' | 'unavailable';
  graphHealth: 'verified' | 'stale' | 'failed' | 'empty-unproven';
  sourceSha: string | null;
  evidenceRefs: string[];
  /** Required to claim material acceleration even when static reach already selected it. */
  savedMs?: number;
}

export interface ReplayIncident {
  id: string;
  kind: 'cross-workspace-red' | 'retracted-absence';
  rootCauseVerified: boolean;
  staticIndex: {
    verdict: 'caught' | 'missed' | 'unknown';
    sourceSha: string | null;
    positiveControl: boolean;
    evidenceRefs: string[];
  };
  signals: Record<ReplaySignal, ReplayObservation>;
}

function hasReferences(refs: string[]): boolean {
  return refs.length > 0 && refs.every((ref) => ref.trim().length > 0);
}

export function classifyReplayIncident(incident: ReplayIncident): {
  id: string;
  signals: Record<ReplaySignal, ReplayVerdict>;
  graphOnly: boolean | null;
} {
  const staticArm = incident.staticIndex;
  const bound = incident.rootCauseVerified && staticArm.positiveControl &&
    staticArm.verdict !== 'unknown' && /^[a-f0-9]{40}$/i.test(staticArm.sourceSha ?? '') &&
    hasReferences(staticArm.evidenceRefs);
  const signals = Object.fromEntries(REPLAY_SIGNALS.map((signal) => {
    const observation = incident.signals[signal];
    let verdict: ReplayVerdict = 'unknown';
    if (bound && observation.comparison === 'observed' && observation.graphHealth === 'verified' &&
      observation.sourceSha === staticArm.sourceSha && hasReferences(observation.evidenceRefs)) {
      verdict = observation.verdict;
      if (verdict === 'incremental') {
        const accelerated = Number.isFinite(observation.savedMs) && (observation.savedMs ?? 0) > 0;
        // Adding an already selected workspace is not a new catch. Ordering requires
        // an actually measured improvement, not the existence of a call edge.
        if ((signal === 'graph-added-workspaces' && staticArm.verdict !== 'missed') ||
          (signal === 'graph-ordering' && !accelerated) ||
          (signal === 'edit-time-impact' && staticArm.verdict !== 'missed' && !accelerated)) {
          verdict = 'unknown';
        }
      }
    }
    return [signal, verdict];
  })) as Record<ReplaySignal, ReplayVerdict>;
  const values = REPLAY_SIGNALS.map((signal) => signals[signal]);
  return {
    id: incident.id,
    signals,
    graphOnly: values.includes('incremental') ? true :
      values.every((verdict) => verdict === 'not-incremental') ? false : null,
  };
}

/** Unknown evidence does not authorize either a go or a negative scale-back claim. */
export function evaluateReplayThreshold(incidents: ReplayIncident[]): {
  decision: 'go' | 'scale-back' | 'unresolved';
  graphOnlyIncidents: number;
  sampledReds: number;
  graphOnlyReds: number;
  unknownIds: string[];
  unqualifiedIds: string[];
} {
  const ids = incidents.map((incident) => incident.id);
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Replay incident ids must be nonempty and unique; repeated failures are not new incidents.');
  }
  const rows = incidents.map((incident) => ({ incident, classified: classifyReplayIncident(incident) }));
  const reds = rows.filter(({ incident }) => incident.rootCauseVerified && incident.kind === 'cross-workspace-red');
  const graphOnlyIncidents = rows.filter(({ classified }) => classified.graphOnly === true).length;
  const graphOnlyReds = reds.filter(({ classified }) => classified.graphOnly === true).length;
  const unknownIds = rows.filter(({ classified }) => classified.graphOnly === null).map(({ incident }) => incident.id);
  const unqualifiedIds = rows.filter(({ incident }) => !incident.rootCauseVerified).map(({ incident }) => incident.id);
  let decision: 'go' | 'scale-back' | 'unresolved' = 'unresolved';
  if (graphOnlyIncidents >= 3 || (unqualifiedIds.length === 0 && reds.length > 0 && graphOnlyReds / reds.length >= 0.2)) {
    decision = 'go';
  } else if (incidents.length > 0 && unknownIds.length === 0 && unqualifiedIds.length === 0) {
    decision = 'scale-back';
  }
  return { decision, graphOnlyIncidents, sampledReds: reds.length, graphOnlyReds, unknownIds, unqualifiedIds };
}
