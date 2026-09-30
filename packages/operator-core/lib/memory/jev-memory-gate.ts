/**
 * Jev on the memory push path (plan jev-decision-model-integration-2026-09-29,
 * P-007 Log only; P-008 On). The owner's switch lives in jev-settings.ts (D-008).
 *
 * Decision D-012 measured this filter with the memory text in `state` and did
 * NOT adopt it: about 1 in 10 answers flipped when the candidate order was
 * reversed. D-013 re-measured it with the memory text inside each question
 * (`instructions`) and it met the full D-007 bar: order flip 1.9%, 0 to 1 of 30
 * hard-negative queries admitting anything vs 8 of 30 for the floor alone, no
 * measurable recall loss. The mode stays the owner's choice (default Off). The
 * contract:
 *
 *  - effective `off` (mode off, OR no key stored) makes ZERO decision calls and
 *    returns before building anything, so the injection block is byte-identical
 *    to the pre-Jev system (D-009, pinned in jev-memory-gate.test.ts).
 *  - `shadow` (Log only) fires ONE request per turn and does not wait for it.
 *    Injection is never delayed or changed; the decision client's ledger hook
 *    records the call, including every P(yes), in decision_model_calls
 *    (consumer `memory-injection`). A would-drop is any P(yes) below the threshold.
 *  - `on` waits for the answer under the client's hard bound (400 ms) and returns
 *    which candidates to keep. Any inconclusive outcome (timeout, error, no key,
 *    malformed answer) fails OPEN: the caller keeps every candidate (D-002).
 *
 * Jev only filters; it never reorders and never authorizes anything (D-001).
 */
import type { DecisionClient } from '@papercusp/decision-model';

import { activeWorkspaceId } from '../workspace-registry';
import { admissionPYes, buildAdmissionRequest, type AdmissionEncoding } from './jev-admission-request';
import { ensureJevDecisionClient, getJevMode, resolveJevMemoryInjection, type JevMemoryInjectionResolution } from './jev-settings';

/** The ledger consumer label for push-path calls (the bench uses `memory-bench`). */
export const JEV_MEMORY_CONSUMER = 'memory-injection';

/**
 * The operating point D-013 adopted (arm B, P-015): the production floor, then
 * keep a candidate when Jev's P(yes) >= 0.3, with the memory text inside each
 * yes-no question. Changing either value invalidates the D-013 measurements;
 * re-run P-004 and P-005 (bench/jev-admission-cli, bench/jev-robustness-cli)
 * before keeping a new one.
 */
export const JEV_MEMORY_ADMIT_THRESHOLD = 0.3;
export const JEV_MEMORY_ENCODING: AdmissionEncoding = 'instructions';

export interface JevGateCandidate {
  readonly id: string;
  readonly text: string;
}

export type JevMemoryGateResult =
  /** No call was made. */
  | { readonly effective: 'off' }
  /** Log only: the request was fired and nothing waits for it. */
  | { readonly effective: 'shadow'; readonly fired: boolean }
  /**
   * On, answered: `keep` is index-aligned with the candidates. `model` is the id
   * the provider says answered (not the pin we asked for), so a served-model
   * change is visible wherever the verdict is recorded (P-008).
   */
  | {
      readonly effective: 'on';
      readonly outcome: 'answered';
      readonly keep: readonly boolean[];
      readonly scores: readonly number[];
      readonly model: string;
    }
  /** On, no verdict: the caller keeps every candidate (fail open). */
  | { readonly effective: 'on'; readonly outcome: 'inconclusive'; readonly reason: string };

export interface JevMemoryGateDeps {
  readonly resolve: (workspaceId: string) => Promise<Pick<JevMemoryInjectionResolution, 'effective'>>;
  readonly client: () => DecisionClient;
}

const defaultDeps: JevMemoryGateDeps = {
  // Hot path: every injection passes here, so Off (the default) costs one cached
  // mode read and never touches the key store.
  resolve: async (workspaceId) => ((await getJevMode(workspaceId)) === 'off' ? { effective: 'off' } : resolveJevMemoryInjection(workspaceId)),
  client: ensureJevDecisionClient,
};

export interface JevMemoryGateInput {
  readonly workspaceId?: string;
  /** The recall query the candidates were retrieved for (the recent user turn text). */
  readonly message: string;
  /** Floor-admitted candidates in retrieval order. */
  readonly candidates: readonly JevGateCandidate[];
  /**
   * Ledger consumer label. Defaults to {@link JEV_MEMORY_CONSUMER}; the weekly
   * precision monitor passes `memory-bench` so its replay calls are never
   * counted as live injection traffic in decision_model_calls.
   */
  readonly consumer?: string;
}

export async function runJevMemoryGate(input: JevMemoryGateInput, deps: JevMemoryGateDeps = defaultDeps): Promise<JevMemoryGateResult> {
  let effective: JevMemoryInjectionResolution['effective'];
  try {
    effective = (await deps.resolve(input.workspaceId ?? activeWorkspaceId())).effective;
  } catch {
    // An unreadable setting is not consent to call out: behave as Off.
    return { effective: 'off' };
  }
  if (effective === 'off') return { effective: 'off' };

  const candidates = input.candidates.filter((c) => c.text.trim().length > 0);
  if (candidates.length === 0 || !input.message.trim()) {
    return effective === 'shadow' ? { effective, fired: false } : { effective, outcome: 'inconclusive', reason: 'no-candidates' };
  }

  const { request, questionIds } = buildAdmissionRequest(input.message, candidates, JEV_MEMORY_ENCODING);
  const options = { consumer: input.consumer ?? JEV_MEMORY_CONSUMER, subjectIds: candidates.map((c) => c.id) };

  if (effective === 'shadow') {
    // Fire and forget. decide() never throws for expected failures; the catch is
    // for the unexpected, so a shadow fault can never reach the turn.
    void Promise.resolve()
      .then(() => deps.client().decide(request, options))
      .catch(() => undefined);
    return { effective, fired: true };
  }

  try {
    const outcome = await deps.client().decide(request, options);
    const p = admissionPYes(outcome, questionIds);
    if ('failure' in p) return { effective, outcome: 'inconclusive', reason: p.failure };
    // `candidates` may be shorter than `input.candidates` (empty texts were never
    // asked about); map back so `keep` stays aligned with the caller's list.
    const byId = new Map(candidates.map((c, i) => [c.id, p.scores[i]]));
    const scores = input.candidates.map((c) => byId.get(c.id) ?? 1);
    // admissionPYes only yields scores for an answered outcome; the guard is for the type.
    const model = outcome.kind === 'answered' ? outcome.model : 'unknown';
    return { effective, outcome: 'answered', scores, keep: scores.map((s) => s >= JEV_MEMORY_ADMIT_THRESHOLD), model };
  } catch (e) {
    return { effective, outcome: 'inconclusive', reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
