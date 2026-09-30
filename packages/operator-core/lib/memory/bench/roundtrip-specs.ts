/**
 * Write-round-trip probe fixtures (memory-backend-benchmark P-006,
 * D-004). Six novel facts NOT in the corpus, each carrying a unique
 * cipher marker so "did the search find THIS fact" never collides with
 * corpus content. Paraphrases deliberately avoid the fact's distinctive
 * vocabulary — the paraphrase-recall column is the embeddings-vs-grep
 * write-side analogue of the lexical-gap class.
 */
import type { RoundtripSpec } from '@papercusp/memory/bench';

export const ROUNDTRIP_SPECS: RoundtripSpec[] = [
  {
    id: 'rt-deploy-window',
    fact: 'Production deploys must land before 15:00 local on Fridays; the cutover window is enforced by the velvet-ostrich gate.',
    paraphrase: 'how late in the week can I ship to prod?',
    updatedText: 'Production deploys must land before 12:00 local on Fridays; the cutover window is enforced by the velvet-ostrich gate.',
    nearDup: 'Friday production deploys have to be in by 15:00 local — the velvet-ostrich gate blocks later cutovers.',
    marker: 'velvet-ostrich',
  },
  {
    id: 'rt-flaky-socket',
    fact: 'The integration suite intermittently fails because the cobalt-mantis proxy keeps half-open sockets across test files; restart it between suites.',
    paraphrase: 'tests randomly break when run back to back but pass alone',
    updatedText: 'The integration suite intermittently fails because the cobalt-mantis proxy keeps half-open sockets across test files; pool them per worker instead.',
    nearDup: 'Half-open sockets from the cobalt-mantis proxy leak across test files and make the integration suite flaky.',
    marker: 'cobalt-mantis',
  },
  {
    id: 'rt-quota-header',
    fact: 'The vendor API silently truncates batch uploads past 4 MB unless the x-saffron-heron-quota header is present.',
    paraphrase: 'why do my bulk submissions lose records after a certain size',
    updatedText: 'The vendor API rejects batch uploads past 4 MB with a 413 unless the x-saffron-heron-quota header is present.',
    nearDup: 'Batch uploads over 4 MB get silently truncated by the vendor API without the x-saffron-heron-quota header.',
    marker: 'saffron-heron',
  },
  {
    id: 'rt-tz-cron',
    fact: 'Scheduled jobs run in UTC; the crimson-ibex digest job must be authored as 11:30 UTC to hit 07:30 New York.',
    paraphrase: 'the morning report email arrives at the wrong hour',
    updatedText: 'Scheduled jobs run in UTC; the crimson-ibex digest job must be authored as 12:30 UTC to hit 07:30 New York in winter.',
    nearDup: 'Author the crimson-ibex digest at 11:30 UTC so it lands at 07:30 Eastern — schedules are UTC.',
    marker: 'crimson-ibex',
  },
  {
    id: 'rt-cache-bust',
    fact: 'Editing the indigo-walrus templates requires bumping ASSET_REV or clients keep the stale bundle for 24h.',
    paraphrase: 'users still see the old page after I changed it',
    updatedText: 'Editing the indigo-walrus templates requires bumping ASSET_REV or clients keep the stale bundle for 72h.',
    nearDup: 'Bump ASSET_REV whenever the indigo-walrus templates change, else the stale bundle persists a day.',
    marker: 'indigo-walrus',
  },
  {
    id: 'rt-perm-model',
    fact: 'Only members of the maroon-pelican group can rotate signing keys; the audit job pages on-call if anyone else tries.',
    paraphrase: 'who is allowed to change the certificates',
    updatedText: 'Only members of the maroon-pelican group can rotate signing keys; failed attempts now just log, no paging.',
    nearDup: 'Signing-key rotation is restricted to the maroon-pelican group — outside attempts page on-call.',
    marker: 'maroon-pelican',
  },
];
