import type { DreamBenchmarkLabel } from '../lib/dream/dream-evaluation';

/** Source-grounded answer key, authored before receipt of the blinded reviewer judgments.
 * A held-out judge receives dream-benchmark-cases.ts only. Disagreements remain evidence. */
export const DREAM_BENCHMARK_LABELS: readonly DreamBenchmarkLabel[] = [
  {
    id: 'T01',
    split: 'calibration',
    expected: 'accept',
    class: 'positive-transfer',
    evidence: 'A computes aggregate cents; B supplies the threshold; neither alone implements the proposed boolean.',
  },
  {
    id: 'T02',
    split: 'calibration',
    expected: 'reject',
    class: 'existing-integration',
    evidence: 'The bounded prior already implements the exact proposed composition and test cases.',
  },
  {
    id: 'H01',
    split: 'held-out',
    expected: 'accept',
    class: 'positive-transfer',
    evidence:
      'max(entries) and the policy comparison compose; the 110-total/70-maximum counterexample distinguishes this from a sum cap.',
  },
  {
    id: 'H02',
    split: 'held-out',
    expected: 'reject',
    class: 'existing-integration',
    evidence: 'The prior explicitly contains B(A(rows), cap) and its threshold tests.',
  },
  {
    id: 'H03',
    split: 'held-out',
    expected: 'reject',
    class: 'impossible-composition',
    evidence: 'A returns a Promise; adding 1 without await produces a string, not the promised number 5.',
  },
  {
    id: 'H04',
    split: 'held-out',
    expected: 'reject',
    class: 'lexical-only',
    evidence: 'Both functions construct strings and neither reads or invalidates cache state.',
  },
  {
    id: 'H05',
    split: 'held-out',
    expected: 'reject',
    class: 'a-only',
    evidence: 'B is identity; A already implements the entire decision.',
  },
  {
    id: 'H06',
    split: 'held-out',
    expected: 'reject',
    class: 'b-only',
    evidence: 'A is identity; B already implements the entire decision.',
  },
  {
    id: 'H07',
    split: 'held-out',
    expected: 'reject',
    class: 'irrelevant-c',
    evidence: 'The constant blue is never consumed and supplies no constraint or consumer.',
  },
  {
    id: 'H08',
    split: 'held-out',
    expected: 'unverified',
    class: 'stale-source',
    evidence:
      'Captured A sums, current A returns zero; the evidence version does not support admitting the proposed experiment.',
  },
  {
    id: 'H09',
    split: 'held-out',
    expected: 'unverified',
    class: 'missing-source',
    evidence: 'A is unavailable; its claimed contribution cannot be independently checked.',
  },
  {
    id: 'H10',
    split: 'held-out',
    expected: 'accept',
    class: 'meaningful-c',
    evidence: 'C supplies the account-specific cap, A sums and B compares; changing the account changes the decision.',
  },
  {
    id: 'H11',
    split: 'held-out',
    expected: 'reject',
    class: 'absent-benefit',
    evidence: 'The proposed expression and baseline are identical, so both make one A and one B call.',
  },
  {
    id: 'H12',
    split: 'held-out',
    expected: 'accept',
    class: 'positive-transfer',
    evidence:
      'Canonicalization creates duplicate canonical keys and Set removes them; neither alone returns the expected list.',
  },
];
