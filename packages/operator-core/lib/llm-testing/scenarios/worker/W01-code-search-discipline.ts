/**
 * WORKER-W01 — the coding role's run of the code-search discipline scenarios
 * (gitnexus-deterministic-integration-2026-10-05 P-015). Same world and asserts as
 * SU-S37; see `../su/S37-code-search-discipline.ts` for the design.
 */
import type { Scenario } from '@papercusp/testing-shell/llm';

import { makeS37Scenarios } from '../su/S37-code-search-discipline';

export const WORKER_W01_CODE_SEARCH: Scenario[] = makeS37Scenarios('worker', {
  absence: 'worker-W01a-absence-claim',
  impact: 'worker-W01b-signature-impact',
  definition: 'worker-W01c-definition-lookup',
});
