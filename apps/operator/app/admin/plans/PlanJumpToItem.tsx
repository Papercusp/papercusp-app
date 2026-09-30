'use client';

/** Thin operator type adapter around the shared plan-document jump search. */
import {
  PlanDocumentJump,
  rankPlanDocumentCandidates,
  type PlanDocumentCandidate,
} from '@papercusp/ui-primitives';
import type { RefObject } from 'react';
import type { PlanDecision, PlanItem } from './plans-api';

interface Props {
  items: PlanItem[] | undefined;
  decisions: PlanDecision[] | undefined;
  scopeRef: RefObject<HTMLElement | null>;
}

export function rankCandidates(
  candidates: PlanDocumentCandidate[],
  query: string,
): PlanDocumentCandidate[] {
  return rankPlanDocumentCandidates(candidates, query);
}

export default function PlanJumpToItem({ items, decisions, scopeRef }: Props) {
  return <PlanDocumentJump items={items} decisions={decisions} scopeRef={scopeRef} />;
}
