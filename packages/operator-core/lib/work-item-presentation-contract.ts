/**
 * P-010's shared presentation vocabulary. This leaf is client-safe: the intake
 * classifier imports node:crypto, while fleet metric parsers and UI need only
 * these stage keys and labels. Acceptance remains owned by agent-review-policy.
 */
export const WORK_ITEM_PRESENTATION_STAGES = [
  'observation', 'candidate', 'accepted-ready', 'accepted-active',
  'accepted-blocked', 'verified-completion', 'terminal-other', 'unknown',
] as const;
export type WorkItemPresentationStage = (typeof WORK_ITEM_PRESENTATION_STAGES)[number];

/** Bounded list/detail explanation; the complete contract stays on the source item. */
export interface WorkItemPresentation {
  stage: WorkItemPresentationStage;
  reason: string;
  evidenceRefs: string[];
  completionRef: string | null;
}

export const WORK_ITEM_PRESENTATION_REASONS: Record<string, string> = {
  'observation-evidence': 'Observation retained as evidence',
  'legacy-readiness-unknown': 'No versioned readiness decision',
  'malformed-readiness-unknown': 'Readiness decision is malformed',
  'qualifying-acceptance': 'Current acceptance contract approved',
  'ready-without-executable-acceptance': 'Ready verdict lacks a qualifying acceptance contract',
  'acceptance-authority-invalid': 'Acceptance authority is invalid',
  'acceptance-revision-stale': 'Source changed since acceptance; review again',
  'awaiting-qualifying-acceptance': 'Awaiting an acceptance decision or revision',
  'accepted-work-held': 'Accepted work is held by a dependency, blocker or lifecycle state',
  'accepted-work-in-progress': 'Accepted work is assigned or running',
  'accepted-work-with-verified-success': 'Accepted work completed with verified authority',
  'terminal-without-verified-accepted-success': 'Terminal history without verified accepted delivery',
};

export const WORK_ITEM_PRESENTATION_LABELS: Record<WorkItemPresentationStage, string> = {
  observation: 'Observation evidence',
  candidate: 'Candidates awaiting decision or revision',
  'accepted-ready': 'Accepted ready work',
  'accepted-active': 'Active accepted work',
  'accepted-blocked': 'Blocked accepted work',
  'verified-completion': 'Verified accepted completions',
  'terminal-other': 'Other terminal history',
  unknown: 'Unknown legacy or malformed readiness',
};
