/** Curated, bounded source snapshots. The expected labels live separately.
 * These are synthetic program fragments, not claims about deployed integrations. */
export interface DreamBenchmarkCase {
  id: string;
  split: 'calibration' | 'held-out';
  a: string | null;
  b: string;
  c: string | null;
  prior: string;
  proposal: string;
  falsifier: string;
  freshness: 'current' | 'stale' | 'missing';
}

const total = '(rows) => rows.reduce((sum, row) => sum + row.cents, 0)';
const exceeds = '(value, cap) => value > cap';
const base = {
  a: total,
  b: exceeds,
  c: null,
  prior: 'The two functions exist separately; no composition is present in this bounded source snapshot.',
  proposal: 'Evaluate B(A(rows), cap) to flag aggregate spend above cap. A computes the total; B applies the policy threshold. This is a proposed experiment, not a measured improvement.',
  falsifier: 'For rows [{cents:40},{cents:70}] and cap=100 return true; for cap=120 return false. Removing either primary loses the stated behavior.',
  freshness: 'current' as const,
};

export const DREAM_BENCHMARK_CASES: readonly DreamBenchmarkCase[] = [
  { ...base, id: 'T01', split: 'calibration' },
  { ...base, id: 'T02', split: 'calibration', prior: 'Already implemented: (rows, cap) => B(A(rows), cap). Its tests cover aggregate spend above and below cap.' },
  { ...base, id: 'H01', split: 'held-out', a: '(rows) => Math.max(...rows.map(row => row.cents))', proposal: 'Evaluate B(A(rows), cap) to flag any single entry above cap. A finds the largest entry; B applies the threshold.', falsifier: 'Rows [{cents:40},{cents:70}] with cap=100 must return false despite total=110; cap=60 must return true. Removing either primary loses the stated behavior.' },
  { ...base, id: 'H02', split: 'held-out', prior: 'Already implemented: (rows, cap) => B(A(rows), cap). Its tests cover aggregate spend above and below cap.' },
  { ...base, id: 'H03', split: 'held-out', a: 'async () => 4', b: '(value) => value + 1', proposal: 'Call B(A()) synchronously, without await or changes to either function, and return the number 5.', falsifier: 'The synchronous result must have typeof number and equal 5.' },
  { ...base, id: 'H04', split: 'held-out', a: '() => "refresh"', b: '(value) => "cache:" + value', proposal: 'The shared cache/refresh terminology guarantees that B(A()) invalidates a stored cache entry. There is no other source or state.', falsifier: 'Observe a stored cache entry being invalidated after calling B(A()).' },
  { ...base, id: 'H05', split: 'held-out', a: '(rows, cap) => rows.reduce((sum, row) => sum + row.cents, 0) > cap', b: '(value) => value', proposal: 'B(A(rows, cap)) flags aggregate spend above cap. Both primaries are claimed to be indispensable.', falsifier: 'Removing B must lose the spend-cap decision.' },
  { ...base, id: 'H06', split: 'held-out', a: '(rows) => rows', b: '(rows, cap) => rows.reduce((sum, row) => sum + row.cents, 0) > cap', proposal: 'B(A(rows), cap) flags aggregate spend above cap. Both primaries are claimed to be indispensable.', falsifier: 'Removing A must lose the spend-cap decision.' },
  { ...base, id: 'H07', split: 'held-out', c: '() => "blue"', proposal: 'B(A(rows), cap) flags aggregate spend above cap. C is labeled an enabling mechanism, but its value is never read and it changes no precondition or consumer. All three units are claimed indispensable.', falsifier: 'Removing C must lose the stated spend-cap behavior.' },
  { ...base, id: 'H08', split: 'held-out', freshness: 'stale', prior: 'The captured A source above is stale. Current A is () => 0. No refreshed packet or test receipt exists.' },
  { ...base, id: 'H09', split: 'held-out', a: null, freshness: 'missing', proposal: 'An unavailable A is asserted to compute a sum; compose it with B to check the cap. No implementation or tests for A can be read.' },
  { ...base, id: 'H10', split: 'held-out', c: '(account) => account.dailyCapCents', proposal: 'Evaluate B(A(rows), C(account)) to flag aggregate spend above the account-specific cap. C supplies the policy constraint, which is otherwise unavailable; A sums and B compares.', falsifier: 'For rows [{cents:40},{cents:70}], accounts with dailyCapCents=100/120 must yield true/false. Removing C loses the account-specific constraint.' },
  { ...base, id: 'H11', split: 'held-out', prior: 'Baseline is B(A(rows), cap): one call to A and one call to B.', proposal: 'Keep the exact baseline expression B(A(rows), cap), with no implementation or input changes. Claim that the new composition halves its function-call count.', falsifier: 'Count invocations of A and B under baseline and proposed code: the proposal must make fewer calls.' },
  { ...base, id: 'H12', split: 'held-out', a: '(keys) => keys.map(key => key.trim().toLowerCase())', b: '(keys) => [...new Set(keys)]', proposal: 'Evaluate B(A(keys)) to collapse whitespace/case variants into one canonical key. A canonicalizes; B removes repeated canonical values.', falsifier: 'Input [" One ","one","TWO"] must yield ["one","two"]. A alone retains two "one" values; B alone retains all three original strings.' },
];
