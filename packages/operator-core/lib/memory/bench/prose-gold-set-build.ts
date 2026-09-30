/**
 * Build the frozen PROSE gold set
 * (prose-embedding-384-untrained-mrl-fix-2026-08-02 P-001).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/prose-gold-set-build.ts
 *
 * Reuses the memory bench's D-003 methodology — the same four adversarial
 * classes — over the prose corpus instead of the memory corpus. Every
 * `expected` key is validated against the frozen corpus fixture before the
 * gold set is written, so a query can never reference a document that is not
 * in the corpus being scored.
 *
 * ## How each class earns its place
 *
 * - **lexical-gap** — hand-authored. Describes a target section's content
 *   using none of its distinctive vocabulary, so lexical overlap cannot carry
 *   the query. This is the class most sensitive to embedding degradation and
 *   therefore the one P-002 should weight most heavily. Expected is the ONE
 *   section, not its whole page: its sibling sections are left as near-miss
 *   distractors, which is precisely the discrimination under test.
 *
 * - **exact-identifier** — MINED, not authored, and labelled by construction:
 *   an identifier occurring in exactly one cluster has expected = every entry
 *   containing it, which is verifiable from the fixture alone with no human
 *   judgement. Opaque numeric ids (EI-10103, "migration 530") are deliberately
 *   excluded: they are unique and tempting, but no embedder can place an
 *   arbitrary integer in semantic space, so every leg scores ~0 and the query
 *   adds N without adding discrimination — a FLOOR artifact, the mirror image
 *   of the ceiling artifact the corpus design avoids.
 *
 * - **hard-negative** — hand-authored, absence GREP-VERIFIED against the
 *   corpus at build time (the build fails if a supposed negative's anchor
 *   terms actually occur). expected = [], so these score the rejection margin
 *   rather than recall.
 *
 * - **session-start-intent** — hand-authored. Realistic agent boot intents,
 *   i.e. the production query distribution `search:semantic` actually serves.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

import { loadProseCorpusFixture, PROSE_CORPUS_FIXTURE_VERSION } from './prose-corpus';

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
export const PROSE_GOLD_SET_VERSION = 'v1';

/** Hand-authored query with its target section key. */
interface Authored {
  id: string;
  query: string;
  expected: string[];
  note: string;
}

/**
 * lexical-gap: describe the target using NONE of its distinctive tokens.
 * Each note records the vocabulary deliberately avoided, so a reviewer can
 * check the query is really lexically disjoint rather than trust the label.
 */
const LEXICAL_GAP: Authored[] = [
  {
    id: 'plg-001',
    query:
      'a privileged connection ignores the per-tenant row filter, so one customer can end up seeing another customer trust entry unless the boundary is added by hand',
    expected: ['doc:papercusp-engineering#agent-insights/admission-subqueries-must-be-workspace-scoped#the-trap'],
    note: "avoids 'workspace-scoped/RLS/admin handle/subquery/user_trust_list/migration/policy'",
  },
  {
    id: 'plg-002',
    query:
      'you cannot see the cross-tenant leak with a single-tenant fixture; the second tenant has to exist in the setup before the bug shows up at all',
    expected: [
      'doc:papercusp-engineering#agent-insights/admission-subqueries-must-be-workspace-scoped#prove-it-with-a-test-not-by-reading',
    ],
    note: "avoids 'workspace/test/read/prove/RLS'; probes the prove-with-a-test section vs its siblings",
  },
  {
    id: 'plg-003',
    query:
      'background helper processes keep dying part-way through their job and we assumed the service bouncing was to blame, but the model provider was stalling them out instead',
    expected: [
      'doc:papercusp-engineering#agent-insights/auto-implement-orphans-are-gateway-deaths-not-restarts#tl-dr',
    ],
    note: "avoids 'auto-implement/orphan/gateway/restart/dispatch/host-restart'",
  },
  {
    id: 'plg-004',
    query:
      'stop tightening the shutdown deadline or rewriting the graceful-exit path, because the teardown is already quick and is not what is going wrong',
    expected: ['doc:papercusp-engineering#agent-insights/auto-implement-orphans-are-gateway-deaths-not-restarts#don-t'],
    note: "avoids 'TimeoutStopUSec/SIGTERM/DBOS/drain/orphan'; a DIRECTIVE section vs its explanatory siblings",
  },
  {
    id: 'plg-005',
    query:
      'we shipped the change and bounced the main server, but other long-lived programs carried on running their own stale copy of that file',
    expected: [
      'doc:papercusp-engineering#agent-insights/behavior-cutover-must-enumerate-every-process-that-loads-the-module#tl-dr-for-the-next-agent',
    ],
    note: "avoids 'cutover/enumerate/module/deploy/:3070/process'",
  },
  {
    id: 'plg-006',
    query:
      'the machines report a healthy link to each other and yet nothing actually replicates, because the queue pump was never started on the already-running path',
    expected: ['doc:papercusp-engineering#agent-insights/boot-wire-drain-ordering#symptom'],
    note: "avoids 'peer_connected/federation/outbox/wire/drain/boot'",
  },
  {
    id: 'plg-007',
    query:
      'each piece was demonstrated working on its own, but nobody exercised the join between them, so the defect lived exactly in the untested handoff',
    expected: [
      'doc:papercusp-engineering#agent-insights/boot-wire-drain-ordering#why-the-tests-didn-t-catch-it-the-blind-spot-to-avoid-repeating',
    ],
    note: "avoids 'seam/test/blind spot/isolation'; sibling-discrimination probe within the same page",
  },
  {
    id: 'plg-008',
    query:
      'once you save more than a few hundred notes the rolled-up listing quietly stops covering all of them, so lookups look healthy while silently missing entries',
    expected: ['doc:papercusp-engineering#agent-insights/claude-file-memory-index-cap#the-three-layer-trap'],
    note: "avoids 'MEMORY.md/projection/cap/stale/topic files/index'",
  },
  {
    id: 'plg-009',
    query:
      'do not build anything that assumes the on-disk note store keeps scaling, because past a few hundred records it is no longer visible at startup',
    expected: ['doc:papercusp-engineering#agent-insights/claude-file-memory-index-cap#what-to-do-with-this'],
    note: "avoids 'file store/cap/boot/design'; DIRECTIVE section vs the mechanism section on the same page",
  },
  {
    id: 'plg-010',
    query:
      'the automatic lifecycle pings only reach the agents who opted into that area, instead of going out to everybody',
    expected: ['doc:papercusp-engineering#agent-insights/coord-emit-subscription-scoping#gotchas'],
    note: "avoids 'coord/emit/subscription-scoped/broadcast/audience'",
  },
  {
    id: 'plg-011',
    query:
      'every alert funnels through one shared helper that fans out to both destinations the moment something important is written, with no polling loop anywhere',
    expected: [
      'doc:papercusp-engineering#agent-insights/attention-push-delivery#one-helper-two-channels-event-driven',
    ],
    note: "avoids 'notifyAttention/push/channel/event-driven/attention/producer'",
  },
  {
    id: 'plg-012',
    query:
      'to introduce another category of alert you invoke the common helper where the record is created and register the new label so the phone build knows about it',
    expected: ['doc:papercusp-engineering#agent-insights/attention-push-delivery#extending-it'],
    note: "avoids 'extending/notifyAttention/kind/MOBILE_KIND'; sibling of plg-011 on the same page",
  },
  {
    id: 'plg-013',
    query:
      'the fact that a change already landed in version control is not evidence that a compile failure is permanent rather than half-delivered',
    expected: ['doc:papercusp-engineering#agent-insights/committed-is-not-settled-git-sync-landing-race#the-one-line-rule'],
    note: "avoids 'committed/settled/git-sync/red/standing/tick'",
  },
  {
    id: 'plg-014',
    query:
      'never raise a complaint about a brand-new file the first moment you notice it — pause, then look again a few minutes later',
    expected: ['doc:papercusp-engineering#agent-insights/committed-is-not-settled-git-sync-landing-race#rules-of-thumb'],
    note: "avoids 'file/type red/re-run/first sight'; sibling of plg-013",
  },
  {
    id: 'plg-015',
    query:
      'the number handed back by the listing only describes the slice you just received, not how many records exist altogether',
    expected: [
      'doc:papercusp-engineering#agent-insights/coord-escalations-pagination-semantics#total-count-is-just-the-size-of-this-page-not-the-backlog-size',
    ],
    note: "avoids 'total/count/page/backlog/escalations/offset'",
  },
  {
    id: 'plg-016',
    query:
      'before rewriting the description of a task that keeps failing, go and inspect the actual storage its mechanism depends on and quote the real shape',
    expected: ['doc:papercusp-engineering#agent-insights/cursed-item-respec-verify-data-model#the-guard'],
    note: "avoids 'cursed/re-spec/verify/data model/grep/dispatch'",
  },
  {
    id: 'plg-017',
    query:
      'a unit of work that fails to be placed enough times trips a protective cutout and gets flagged as unusable',
    expected: ['doc:papercusp-engineering#agent-insights/cursed-item-respec-verify-data-model#what'],
    note: "avoids 'cursed/breakerThreshold/circuit breaker/placement'; sibling of plg-016",
  },
  {
    id: 'plg-018',
    query:
      'telling apart a process that has never actually run from one that is simply too new to have produced any numbers yet',
    expected: ['doc:papercusp-engineering#agent-insights/dark-learning-loops-are-triple-gated#how-to-tell-dark-from-young'],
    note: "avoids 'dark/young/loop/gate/firing/stale/scored'",
  },
  {
    id: 'plg-019',
    query:
      'a wait-until-it-is-live helper that matches on one precise fingerprint will hang forever when the shipping system bundles several changes together',
    expected: [
      'doc:papercusp-engineering#agent-insights/deploy-await-exact-sha-batched-deploy-strand#the-lesson-an-auto-serve-batching-pipeline-breaks-exact-identity-waits',
    ],
    note: "avoids 'sha/deploy/await/batched/exact identity/strand'",
  },
  {
    id: 'plg-020',
    query:
      'somebody finishes a fix, asks to be told the moment it starts serving, and then simply never gets woken up',
    expected: ['doc:papercusp-engineering#agent-insights/deploy-await-exact-sha-batched-deploy-strand#the-symptom'],
    note: "avoids 'sha/await/deploy/strand'; sibling of plg-019",
  },
  {
    id: 'plg-021',
    query:
      'a single failing checkpoint produced three different explanations from three different people in one sitting',
    expected: ['doc:papercusp-engineering#agent-insights/deploy-pipeline-is-async-self-healing#the-mistake-this-prevents'],
    note: "avoids 'gate/red/diagnoses/agents/session'",
  },
  {
    id: 'plg-022',
    query:
      'if it really has jammed, do not sit there watching it — either raise it with a person or push it out by hand yourself',
    expected: [
      'doc:papercusp-engineering#agent-insights/deploy-pipeline-is-async-self-healing#on-a-genuine-stall-don-t-wait-escalate-or-force-the-deploy',
    ],
    note: "avoids 'stall/wait/escalate/force/deploy'; sibling of plg-021",
  },
  {
    id: 'plg-023',
    query:
      'you leave the edit sitting in place and a chain of scheduled jobs records it, checks it, and promotes it over the following few minutes',
    expected: [
      'doc:papercusp-engineering#agent-insights/deploy-pipeline-is-async-self-healing#the-pipeline-async-minutes-two-ports',
    ],
    note: "avoids 'pipeline/async/git-sync/commit/gate/port'; third sibling on the same page",
  },
  {
    id: 'plg-024',
    query:
      'there is no dedicated role that pushes releases out; the machinery recovers on its own and the existing repair agents cover it',
    expected: [
      'doc:papercusp-engineering#agent-insights/deploy-pipeline-is-async-self-healing#the-deployer-already-exists-as-the-fixer-family',
    ],
    note: "avoids 'deployer/fixer family/self-heals/pipeline'; fourth sibling — maximal same-page competition",
  },
];

/**
 * session-start-intent: realistic agent boot intents — what an agent actually
 * types into semantic search on waking, phrased as a goal rather than a
 * keyword. This is the production distribution the surface really serves.
 */
const SESSION_START_INTENT: Authored[] = [
  {
    id: 'psi-001',
    query: 'I need to add a database migration without colliding with another agent picking the same number',
    expected: [
      'doc:papercusp-engineering#agent-insights/migration-number-collisions-and-reservation-dx#how-to-allocate-a-number-now-the-supported-path',
    ],
    note: 'boot intent: the supported allocation path, not the post-mortem sections on the same page',
  },
  {
    id: 'psi-002',
    query: 'figure out whether I should be running a shell command or calling a tool for this read',
    expected: ['doc:papercusp-engineering#agent-insights/bash-vs-tool-routing#1-the-registry-is-the-single-source-of-truth'],
    note: 'boot intent over a 23-section page — heavy sibling competition',
  },
  {
    id: 'psi-003',
    query: 'ToolSearch will not resolve a tool name I copied out of the docs, find me the workaround',
    expected: [
      'doc:papercusp-engineering#agent-insights/toolsearch-cannot-select-colon-form-tool-names#the-fix-the-escape-hatch-already-exists-it-was-just-undocumented',
    ],
    note: 'boot intent aimed at the FIX section rather than the root-cause section',
  },
  {
    id: 'psi-004',
    query: 'my database connections are erroring right after connecting and I need a way to turn it off without shipping code',
    expected: [
      'doc:papercusp-engineering#agent-insights/pgbouncer-rejects-statement-timeout-startup-param#immediate-kill-switch-no-deploy',
    ],
    note: 'boot intent selecting the kill-switch section over symptom/root-cause siblings',
  },
  {
    id: 'psi-005',
    query: 'work out what a headless agent is actually allowed to do and whether the blocklist really holds',
    expected: [
      'doc:papercusp-engineering#agent-insights/claude-code-headless-permissions#honest-limits-the-deny-list-alone-is-not-a-sandbox',
    ],
    note: 'boot intent over an 8-section page with several near-identical update sections',
  },
  {
    id: 'psi-006',
    query: 'a URL parameter is arriving as the wrong type and my toggle reads false when it should be true',
    expected: [
      'doc:papercusp-engineering#agent-insights/nuqs-tanstack-search-coercion-and-clobber#1-tanstack-coerces-dock-1-to-the-number-1-1-is-false',
    ],
    note: 'boot intent describing the symptom in user terms, not the library names',
  },
  {
    id: 'psi-007',
    query: 'some in-memory value seems to differ depending on which process handled the request',
    expected: [
      'doc:papercusp-engineering#agent-insights/module-scoped-state-is-per-worker-the-operator-is-a-forked-cluster#the-one-line-version',
    ],
    note: 'boot intent over a 10-section page; targets the summary section',
  },
  {
    id: 'psi-008',
    query: 'how do I tell whether this state is really shared or is per-process before I trust it',
    expected: [
      'doc:papercusp-engineering#agent-insights/module-scoped-state-is-per-worker-the-operator-is-a-forked-cluster#the-discrimination-test',
    ],
    note: 'SAME page as psi-007, DIFFERENT section — a direct sibling-discrimination pair',
  },
];

/**
 * hard-negative: topics with NO presence in this corpus. Absence is
 * grep-verified at build time against every anchor term — if any anchor
 * actually occurs, the build FAILS rather than silently shipping a query
 * whose expected=[] is wrong (a false negative inflates the rejection margin
 * and would flatter every leg equally).
 */
const HARD_NEGATIVES: Array<{ id: string; query: string; anchors: string[] }> = [
  { id: 'phn-001', query: 'how long should sourdough starter proof before baking', anchors: ['sourdough', 'proof before', 'baking'] },
  { id: 'phn-002', query: 'diagnosing a failing turbocharger on a diesel engine', anchors: ['turbocharger', 'diesel'] },
  { id: 'phn-003', query: 'best knitting stitch for a wool scarf', anchors: ['knitting', 'wool scarf'] },
  { id: 'phn-004', query: 'calculating a Hohmann transfer orbit between two planets', anchors: ['hohmann', 'transfer orbit'] },
  { id: 'phn-005', query: 'symptoms and treatment of feline hyperthyroidism', anchors: ['feline', 'hyperthyroid'] },
  { id: 'phn-006', query: 'how to prune apple trees in early spring', anchors: ['prune apple', 'apple tree'] },
  { id: 'phn-007', query: 'rules for castling in chess and when it is illegal', anchors: ['castling', 'chess'] },
  // 'drop d' was rejected by the build guard as a false negative: it matches
  // inside 'drop database'/'drop down'. Kept as a reminder that the anchors are
  // the real assertion, not the query text.
  { id: 'phn-008', query: 'tuning a guitar to drop D by ear', anchors: ['guitar', 'fretboard'] },
  { id: 'phn-009', query: 'mortgage amortization schedule with biweekly payments', anchors: ['mortgage', 'amortization'] },
  { id: 'phn-010', query: 'identifying edible mushrooms in temperate woodland', anchors: ['mushroom', 'woodland'] },
  { id: 'phn-011', query: 'training plan for a first marathon in sixteen weeks', anchors: ['marathon', 'training plan'] },
  { id: 'phn-012', query: 'how tides are affected by the lunar cycle', anchors: ['tides', 'lunar'] },
];

interface ProseGoldFixture {
  version: string;
  corpusVersion: string;
  frozenAt: string;
  count: number;
  classes: Record<string, number>;
  note: string;
  queries: GoldQuery[];
}

/** camelCase / schema.table / filename shapes — see the docblock. */
const ID_PATTERNS = [
  /\b[a-z_]{3,}_[a-z_]{3,}\.[a-z_]{4,}\b/g,
  /\b[a-z][a-zA-Z0-9]{3,}[A-Z][a-zA-Z][a-zA-Z0-9]{2,}\b/g,
  /\b[a-z][a-z0-9-]{7,}\.(?:ts|tsx|mjs)\b/g,
];

/** Generic enough that "the one section containing it" is an arbitrary label. */
const MIN_IDENTIFIER_LEN = 14;

function mineIdentifiers(corpus: CorpusEntry[], limit: number): Authored[] {
  const byCluster = new Map<string, Set<string>>();
  const byKey = new Map<string, string[]>();

  for (const e of corpus) {
    const cluster = String(e.metadata?.cluster ?? '');
    const found = new Set<string>();
    for (const rx of ID_PATTERNS) for (const m of e.text.match(rx) ?? []) found.add(m);
    for (const tok of found) {
      if (tok.length < MIN_IDENTIFIER_LEN && !tok.includes('.')) continue;
      if (!byCluster.has(tok)) byCluster.set(tok, new Set());
      byCluster.get(tok)!.add(cluster);
      byKey.set(tok, [...(byKey.get(tok) ?? []), e.key]);
    }
  }

  const seenCluster = new Set<string>();
  const out: Authored[] = [];
  for (const tok of [...byCluster.keys()].sort()) {
    const clusters = byCluster.get(tok)!;
    const keys = byKey.get(tok)!;
    if (clusters.size !== 1 || keys.length > 3) continue;
    const cluster = [...clusters][0];
    if (seenCluster.has(cluster)) continue; // one per cluster -> maximal spread
    seenCluster.add(cluster);
    out.push({
      id: `pei-${String(out.length + 1).padStart(3, '0')}`,
      query: tok,
      expected: [...new Set(keys)].sort(),
      note: `mined: occurs in exactly one cluster (${cluster.slice(0, 60)}); label correct by construction`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function main(): void {
  const corpus = loadProseCorpusFixture();
  const corpusKeys = new Set(corpus.map((e) => e.key));
  const haystack = corpus.map((e) => e.text.toLowerCase()).join('\n');

  const queries: GoldQuery[] = [];
  const problems: string[] = [];

  const pushAuthored = (list: Authored[], cls: GoldQuery['class']) => {
    for (const a of list) {
      for (const k of a.expected) {
        if (!corpusKeys.has(k)) problems.push(`${a.id}: expected key NOT in corpus -> ${k}`);
      }
      queries.push({ id: a.id, class: cls, query: a.query, expected: a.expected, note: a.note });
    }
  };

  pushAuthored(LEXICAL_GAP, 'lexical-gap');
  pushAuthored(SESSION_START_INTENT, 'session-start-intent');

  // Hard negatives: absence must be PROVEN, not asserted. Match on WORD
  // BOUNDARIES, not substrings — a bare `includes('drop d')` reports a hit
  // inside 'drop database' and rejects a perfectly good negative (it did).
  const occurs = (term: string): boolean => {
    const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`).test(haystack);
  };
  for (const hn of HARD_NEGATIVES) {
    const present = hn.anchors.filter(occurs);
    if (present.length > 0) {
      problems.push(`${hn.id}: NOT a hard negative — anchors present in corpus: ${present.join(', ')}`);
      continue;
    }
    queries.push({
      id: hn.id,
      class: 'hard-negative',
      query: hn.query,
      expected: [],
      note: `grep-verified absent (anchors: ${hn.anchors.join(', ')})`,
    });
  }

  const mined = mineIdentifiers(corpus, 90);
  pushAuthored(mined, 'exact-identifier');

  if (problems.length > 0) {
    console.error('REFUSING to write gold set — validation failed:');
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }

  const classes: Record<string, number> = {};
  for (const q of queries) classes[q.class] = (classes[q.class] ?? 0) + 1;

  const fixture: ProseGoldFixture = {
    version: PROSE_GOLD_SET_VERSION,
    corpusVersion: PROSE_CORPUS_FIXTURE_VERSION,
    frozenAt: new Date().toISOString(),
    count: queries.length,
    classes,
    note:
      'Prose-surface gold set (prose-embedding-384-untrained-mrl-fix P-001), D-003 methodology ' +
      'over the prose corpus. lexical-gap targets ONE section, leaving its page-siblings as ' +
      'near-miss distractors. exact-identifier is mined and labelled by construction; opaque ' +
      'numeric ids are excluded as floor artifacts. hard-negative absence is grep-verified at ' +
      'build time. Expected keys bind to prose-corpus.' +
      PROSE_CORPUS_FIXTURE_VERSION +
      '.json — regenerate BOTH together as a new version, never in place.',
    queries,
  };

  const file = path.join(FIXTURES_DIR, `prose-gold-set.${PROSE_GOLD_SET_VERSION}.json`);
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  console.log(`wrote ${file}`);
  console.log(`  count=${fixture.count} classes=${JSON.stringify(classes)}`);
  const answerable = queries.filter((q) => q.class !== 'hard-negative').length;
  console.log(`  answerable=${answerable} hard-negative=${queries.length - answerable}`);
}

main();
