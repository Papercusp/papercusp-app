/**
 * chunk-search-ab-cli.ts — the same-time A/B that instruments acceptance BAR R-33
 * of plan generic-rag-chunking-2026-09-29 (Decision D-040). The method, the
 * budgets and the verdict rules live in `chunk-search-ab.ts`; this file only runs
 * the arms.
 *
 *   PAPERCUSP_EMBED_SIDECAR_URL=http://127.0.0.1:3384 \
 *   npx tsx packages/operator-core/lib/search/bench/chunk-search-ab-cli.ts \
 *     [--rounds 3] [--out chunk-search-ab.json] [--sites plans,turns,...] [--band-wait-min 0]
 *
 * Run it from the repository root. PAPERCUSP_EMBED_SIDECAR_URL must name the
 * operator's embed sidecar (`systemctl --user show papercup-bg-host.service -p
 * Environment`). Embedding is not timed, but an in-process embedder loads a native
 * addon whose teardown can abort this process with exit 134 after the results are
 * written (EI-19464316359123796), which would erase the verdict the exit code carries.
 *
 * Exit 0: the load was in D-041's band and every site has a valid reading within
 * its budget. Exit 1: the load was in band and at least one site is over budget or
 * has no valid reading (the JSON says which and why). Exit 2: no reading — the
 * 1-min load was outside D-041's band at the start or end of the timed rounds, or
 * the run itself failed. `--band-wait-min N` waits up to N minutes, after warmup,
 * for the load to enter the band before timing; without it an out-of-band start
 * exits 2 without timing anything.
 *
 * NULL MODE (D-042): `--null` makes the B slot run arm A again, so each site's
 * "added p95" is pure instrument noise. The JSON carries `nullSpreads` (the
 * absolute A-vs-A p95 difference per site) instead of budget verdicts. Exit 0: in
 * band and every site valid. Exit 1: in band but a site invalid. Exit 2: no reading.
 * A site's noise floor is the largest spread over R33_AB_NULL_RUNS valid null runs
 * (r33AbNoiseFloorMs).
 *
 * WHAT RUNS
 * Everything runs in this process against the operator database, with THIS tree's
 * code: arm B is the shipped function, so the reading is of the checkout the CLI
 * runs from, and the evidence file records its commit and whether the measured
 * source files were dirty. There is no MCP door, embedding or lexical leg in the
 * timed span except where the site's own function contains them (work_items:search
 * runs its lexical legs in both arms). Every query is embedded once, up front; both
 * arms of a pair get the same vector, so embedding latency is in neither.
 *
 * Arm A reproduces each site's vector query as of 9a9473af95, before any
 * chunk-aware leg, statement for statement (`git show 9a9473af95:<path>` on the
 * paths cited at each arm). It runs on the current helpers (withIterativeScan,
 * withWorkspace, the prose-profile predicate), which both arms share, so the pair
 * differs only in the SQL the chunking work changed. Arm B also carries anything
 * else that changed on those paths since 9a9473af95, so the reading is an upper
 * bound on chunking's own cost, never a flattering one.
 *
 * A failed call is recorded, not retried: an error invalidates that site's reading
 * (see r33AbVerdicts). Both arms see the same instant, but what B adds still grows
 * with load (D-041), so the 1-min load average is gated at both ends of the timed
 * rounds against the load D-024's baselines were measured at (r33AbLoadCheck).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { withIterativeScan, type PgHandle, type SearchSourceParams } from '@papercusp/search';
import { HEADLINE_OPTS, SEARCH_SOURCES } from '../../agent-tools/search/sources';
import { buildQueryEmbedderResolved } from '../../agent-tools/search/embedder';
import { queryTopPlansReal } from '../../agent-tools/plans/semantic-leg';
import { resolvePlanScope } from '../../agent-tools/plans/source';
import { extractSettledAnswer, peersKnowLookup } from '../../consult/peers-know';
import { searchWorkItems } from '../../work-items';
import {
  proseProfilePredicateSql,
  resolveProseProfileIdSelection,
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../prose-vector-dims';
import { CHUNK_SEARCH_LATENCY_QUERIES as QUERIES, D024_QUERY_SET_HASH, querySetHash } from './chunk-search-latency';
import {
  R33_AB_ARMS,
  R33_AB_PRE_CHANGE_REF,
  R33_AB_SITES,
  R33_AB_LOAD_BAND,
  armOrder,
  inR33AbLoadBand,
  r33AbBudgetMs,
  r33AbLoadCheck,
  r33AbNullSpreads,
  r33AbPasses,
  r33AbVerdicts,
  summarisePaired,
  type PairedSample,
  type PairedSummary,
  type R33AbSite,
} from './chunk-search-ab';

const WORKSPACE = process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
/**
 * Consult arms rank with floor -1 (sim = 1 - cosine distance >= -1), so each arm
 * returns its top settled answer whenever one exists. The floor is a JavaScript
 * comparison after the query; it changes nothing that is timed, and it lets
 * "B returned nothing where A did" mean a failing B arm rather than a floor miss.
 */
const CONSULT_FLOOR = -1;

/** The files whose code arm B runs, recorded with the commit they were read at. */
const MEASURED_SOURCES: ReadonlyArray<{ repo: string; path: string }> = [
  { repo: '.', path: 'packages/operator-core/lib/agent-tools/search/sources.ts' },
  { repo: '.', path: 'packages/operator-core/lib/agent-tools/plans/semantic-leg.ts' },
  { repo: '.', path: 'packages/operator-core/lib/consult/peers-know.ts' },
  { repo: '.', path: 'packages/operator-core/lib/work-items.ts' },
  { repo: '.', path: 'packages/operator-core/lib/search/chunks/registry.ts' },
  { repo: 'libs/generic/search', path: 'src/chunks/vector-leg.ts' },
];

interface ArmResult {
  rows: number;
  top: string | null;
}
type Arm = (i: number) => Promise<ArmResult>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    }).trim();
  } catch (e) {
    return `error: ${String(e).slice(0, 120)}`;
  }
}

/** Commit, blob and dirty state of every measured source, so the reading names its code. */
function measuredCode() {
  const repos = [...new Set(MEASURED_SOURCES.map((s) => s.repo))];
  return {
    commits: Object.fromEntries(repos.map((r) => [r, git(r, ['rev-parse', 'HEAD'])])),
    files: MEASURED_SOURCES.map(({ repo, path }) => ({
      repo,
      path,
      headBlob: git(repo, ['rev-parse', `HEAD:${path}`]),
      dirty: git(repo, ['status', '--porcelain', '--', path]) !== '',
    })),
  };
}

async function main(): Promise<number> {
  const rounds = Number(arg('--rounds') ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds takes a positive integer');
  const sites = (arg('--sites')?.split(',').map((s) => s.trim()) ?? [...R33_AB_SITES]) as R33AbSite[];
  const unknown = sites.filter((s) => !(R33_AB_SITES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`unknown site(s) ${unknown.join(', ')}; sites are ${R33_AB_SITES.join(', ')}`);
  const out = arg('--out') ?? 'chunk-search-ab.json';
  if (!process.env.PAPERCUSP_EMBED_SIDECAR_URL?.trim()) {
    throw new Error(
      'PAPERCUSP_EMBED_SIDECAR_URL is unset: an in-process embedder can abort this process with exit 134 ' +
        'at teardown, which would erase the verdict in the exit code. Set it (see the header).',
    );
  }
  const hash = querySetHash();
  if (hash !== D024_QUERY_SET_HASH) throw new Error(`query set hash ${hash} is not D-024's ${D024_QUERY_SET_HASH}`);

  const pg = getOrgPg().sql;
  const handle = pg as unknown as PgHandle;
  const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: 30_000 });
  const profile: ProseProfileSelection | null = resolved
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  if (!resolved || !profile) throw new Error('no query embedder resolved into an accepted prose profile');
  // What the pre-change sources derived from the engine's embeddingProfile.
  const selection = resolveProseProfileIdSelection(profile.profileId, profile.legacyMode);
  if (!selection) throw new Error(`profile ${profile.profileId} is not an accepted prose profile`);

  const vecs: number[][] = [];
  for (const q of QUERIES) {
    const v = await resolved.embed(q);
    if (!v?.length) throw new Error(`empty embedding for "${q}"`);
    vecs.push(v);
  }
  const vecLits = vecs.map((v) => JSON.stringify(v));
  const vecByText = new Map(QUERIES.map((q, i) => [q, vecs[i]]));
  let precomputedMisses = 0;

  const source = (name: string) => {
    const s = SEARCH_SOURCES.find((x) => x.name === name);
    if (!s?.embedding) throw new Error(`search source ${name} has no embedding leg`);
    return s.embedding.bind(s);
  };
  const sourceParams = (i: number, limit: number): SearchSourceParams & { qVec: string } => ({
    sql: handle,
    query: QUERIES[i],
    workspaceId: WORKSPACE,
    scopeFilter: null,
    embeddingProfile: { profileId: profile.profileId, legacyMode: profile.legacyMode },
    limit,
    qVec: vecLits[i],
  });
  const keys = (rows: ReadonlyArray<{ key: string }>): ArmResult => ({ rows: rows.length, top: rows[0]?.key ?? null });

  const turnsB = source('turns');
  const workItemB = source('work_item');
  // searchWorkItems embeds internally; hand it the precomputed vector instead.
  const precomputedResolver = async () => ({
    ...resolved,
    embed: async (t: string) => {
      const v = vecByText.get(t);
      if (v) return v;
      precomputedMisses++;
      return resolved.embed(t);
    },
  });

  const arms: Record<R33AbSite, { A: Arm; B: Arm }> = {
    plans: {
      // git show 9a9473af95:packages/operator-core/lib/agent-tools/plans/semantic-leg.ts, queryTopPlansReal.
      A: async (i) => {
        const limit = R33_AB_ARMS.plans.limit;
        const { workspaceId, harnessSlug } = await resolvePlanScope({});
        const vecLit = vecLits[i];
        const rows = await withWorkspace(workspaceId, async (tx) => tx<Array<{ plan_slug: string }>>`
          SELECT plan_slug, harness_slug, title, status, archived,
                 1 - (embedding <=> ${vecLit}::vector) AS similarity
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND embedding IS NOT NULL
             AND (embedding_profile = ${selection.profileId}
                  OR (${selection.legacyMode !== null}
                      AND embedding_profile IS NULL
                      AND embedding_mode = ${selection.legacyMode ?? resolved.mode}))
             AND template_slug IS NULL
             AND archived = false
           ORDER BY embedding <=> ${vecLit}::vector
           LIMIT ${limit}`);
        return { rows: rows.length, top: rows[0]?.plan_slug ?? null };
      },
      B: async (i) => {
        const rows = await queryTopPlansReal(vecs[i], resolved.mode, { limit: R33_AB_ARMS.plans.limit }, profile);
        return { rows: rows.length, top: rows[0]?.slug ?? null };
      },
    },
    turns: {
      // git show 9a9473af95:packages/operator-core/lib/agent-tools/search/sources.ts, turns.embedding.
      A: async (i) => {
        const { query, limit, qVec } = sourceParams(i, R33_AB_ARMS.turns.limit);
        const rows = (await withIterativeScan(handle, (sql) => sql`
          SELECT t.id, t.role, t.text,
                 1 - (t.text_embedding <=> ${qVec}::vector) AS sim,
                 ts_headline('english', t.text,
                   plainto_tsquery('english', ${query}),
                   ${HEADLINE_OPTS}) AS highlight
            FROM harness_shared.operator_turns t
            JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
           WHERE c.workspace_id = ${WORKSPACE}
             AND t.text_embedding IS NOT NULL
             AND ${proseProfilePredicateSql(pg, selection, 't.text_embedding_profile', 't.text_embedding_mode')}
        ORDER BY t.text_embedding <=> ${qVec}::vector
           LIMIT ${limit}
        `)) as unknown as Array<{ id: string }>;
        return { rows: rows.length, top: rows[0] ? `turns:${rows[0].id}` : null };
      },
      B: async (i) => keys(await turnsB(sourceParams(i, R33_AB_ARMS.turns.limit))),
    },
    work_item: {
      // git show 9a9473af95:packages/operator-core/lib/agent-tools/search/sources.ts, work_item.embedding.
      A: async (i) => {
        const { query, limit, qVec } = sourceParams(i, R33_AB_ARMS.work_item.limit);
        const scopeFilter: string | null = null;
        const rows = (await withIterativeScan(handle, (sql) => sql`
          SELECT issue_id, scope, title, body, kind, state, severity, lane,
                 coalesce(updated_at, created_at) AS updated_at,
                 1 - (embedding <=> ${qVec}::vector) AS sim,
                 ts_headline('english', coalesce(title, '') || E'\n' || coalesce(body, ''),
                   plainto_tsquery('english', ${query}),
                   ${HEADLINE_OPTS}) AS highlight
            FROM harness_shared.engineer_issues
           WHERE workspace_id = ${WORKSPACE}
             AND (${scopeFilter}::text IS NULL OR scope = 'harness:' || ${scopeFilter}::text)
             AND embedding IS NOT NULL
             AND ${proseProfilePredicateSql(pg, selection, 'embedding_profile', 'embedding_mode')}
        ORDER BY embedding <=> ${qVec}::vector
           LIMIT ${limit}
        `)) as unknown as Array<{ issue_id: string }>;
        return { rows: rows.length, top: rows[0] ? `work_item:${rows[0].issue_id}` : null };
      },
      B: async (i) => keys(await workItemB(sourceParams(i, R33_AB_ARMS.work_item.limit))),
    },
    work_items_search: {
      // No fair pre-change arm (D-033): A is the same search with the semantic legs off.
      A: async (i) => {
        const r = await searchWorkItems(QUERIES[i], { limit: R33_AB_ARMS.work_items_search.limit, semantic: false });
        return { rows: r.items.length, top: r.items[0]?.id ?? null };
      },
      B: async (i) => {
        const r = await searchWorkItems(QUERIES[i], {
          limit: R33_AB_ARMS.work_items_search.limit,
          semantic: true,
          embedderResolver: precomputedResolver,
        });
        // A semantic leg that did not run is cheap and empty; it is not a reading.
        // Check the semantic leg itself, not `legs.degraded`: that flag is also
        // set when the LEXICAL leg found nothing, and the semantic leg's cost is
        // still fully paid on such a query (run 1, 2026-10-02: 12 of 90 B calls).
        const sem = r.legs.semantic;
        if (sem.status !== 'ran' || sem.callsFailed > 0) {
          throw new Error(`semantic leg ${sem.status} (${sem.callsFailed} failed): ${sem.blocked ?? r.legs.warning ?? 'no detail'}`);
        }
        return { rows: r.items.length, top: r.items[0]?.id ?? null };
      },
    },
    consult: {
      // git show 9a9473af95:packages/operator-core/lib/consult/peers-know.ts, peersKnowLookup's body.
      A: async (i) => {
        const qVec = vecLits[i];
        const rows = (await pg`
          SELECT conversation_id, responder_id, outcome, closed_at,
                 1 - (query_embedding <=> ${qVec}::vector) AS sim
            FROM harness_shared.consult_state
           WHERE workspace_id = ${WORKSPACE}
             AND state = 'closed_answered'
             AND query_embedding IS NOT NULL
             AND ${proseProfilePredicateSql(pg, profile, 'query_embedding_profile', 'query_embedding_mode')}
             AND (outcome->>'source' IS DISTINCT FROM 'archive')
        ORDER BY query_embedding <=> ${qVec}::vector
           LIMIT 1
        `) as unknown as Array<{ conversation_id: string; outcome: unknown; sim: number }>;
        const top = rows[0];
        const hit = top && Number(top.sim) >= CONSULT_FLOOR && extractSettledAnswer(top.outcome) ? top : null;
        return { rows: hit ? 1 : 0, top: hit?.conversation_id ?? null };
      },
      B: async (i) => {
        const hit = await peersKnowLookup(
          pg,
          { embed: async () => vecs[i], profile },
          { workspaceId: WORKSPACE, intent: QUERIES[i], floor: CONSULT_FLOOR },
        );
        return { rows: hit ? 1 : 0, top: hit?.ref ?? null };
      },
    },
  };

  // D-042 null mode: the B slot runs arm A again, so B - A is the instrument's noise.
  const nullMode = process.argv.includes('--null');
  if (nullMode) for (const site of sites) arms[site].B = arms[site].A;

  // Warmup, untimed: every arm once per query (pools, plans, caches). The
  // work-items query embedder warms in the background on first use, so B is
  // retried until its semantic leg runs or 60 s pass.
  const warmupErrors: string[] = [];
  for (const site of sites) {
    for (let i = 0; i < QUERIES.length; i++) {
      for (const arm of ['A', 'B'] as const) {
        await arms[site][arm](i).catch((e) => warmupErrors.push(`${site} ${arm}: ${String(e).slice(0, 160)}`));
      }
    }
  }
  if (sites.includes('work_items_search')) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await arms.work_items_search.B(0).then(() => true, () => false))) {
      await new Promise((z) => setTimeout(z, 2_000));
    }
  }

  // D-041: wait (bounded) for the 1-min load to enter the band before timing.
  const bandWaitMin = Number(arg('--band-wait-min') ?? 0);
  if (!Number.isFinite(bandWaitMin) || bandWaitMin < 0) throw new Error('--band-wait-min takes a non-negative number');
  const bandDeadline = Date.now() + bandWaitMin * 60_000;
  while (!inR33AbLoadBand(os.loadavg()[0]) && Date.now() < bandDeadline) {
    await new Promise((z) => setTimeout(z, 15_000));
  }
  if (!inR33AbLoadBand(os.loadavg()[0])) {
    console.log(
      'R33_AB_SUMMARY ' +
        JSON.stringify({
          passes: false,
          reading: 'load-unmatched',
          loadCheck: r33AbLoadCheck(os.loadavg(), os.loadavg()),
          note: `1-min load never entered ${R33_AB_LOAD_BAND.low}-${R33_AB_LOAD_BAND.high} within ${bandWaitMin} min; nothing was timed`,
        }),
    );
    return 2;
  }

  const samples = Object.fromEntries(sites.map((s) => [s, [] as PairedSample[]])) as Record<R33AbSite, PairedSample[]>;
  const loadavgStart = os.loadavg();
  const startedAt = new Date().toISOString();
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < QUERIES.length; i++) {
      for (const site of sites) {
        const sample: PairedSample = { round: r, q: i, aMs: 0, bMs: 0, aRows: 0, bRows: 0 };
        for (const arm of armOrder(r, i)) {
          const t0 = performance.now();
          try {
            const res = await arms[site][arm](i);
            const ms = performance.now() - t0;
            if (arm === 'A') Object.assign(sample, { aMs: ms, aRows: res.rows, aTop: res.top });
            else Object.assign(sample, { bMs: ms, bRows: res.rows, bTop: res.top });
          } catch (e) {
            const ms = performance.now() - t0;
            const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
            if (arm === 'A') Object.assign(sample, { aMs: ms, aError: error });
            else Object.assign(sample, { bMs: ms, bError: error });
          }
        }
        samples[site].push(sample);
      }
    }
    console.log(`round ${r + 1}/${rounds} done ${new Date().toISOString()}`);
  }
  const loadavgEnd = os.loadavg();

  const summaries: Partial<Record<R33AbSite, PairedSummary>> = Object.fromEntries(
    sites.map((s) => [s, summarisePaired(samples[s])]),
  );
  const verdicts = r33AbVerdicts(summaries);
  const loadCheck = r33AbLoadCheck(loadavgStart, loadavgEnd);
  const nullSpreads = nullMode ? r33AbNullSpreads(summaries) : null;
  const nullValid = nullSpreads ? nullSpreads.every((s) => s.spread !== null) : null;
  const budgetsPass = nullMode ? null : r33AbPasses(verdicts);
  const passes = nullMode ? null : loadCheck.matched && budgetsPass === true;
  const result = {
    bench: 'chunk-search-ab',
    mode: nullMode ? 'null' : 'ab',
    ...(nullMode ? { nullDecision: 'D-042', nullSpreads, nullValid } : {}),
    plan: 'generic-rag-chunking-2026-09-29',
    bar: 'R-33',
    methodDecision: 'D-040',
    loadDecision: 'D-041',
    reading: loadCheck.matched ? 'valid' : 'load-unmatched',
    loadCheck,
    budgetsPass,
    baselineDecision: 'D-024',
    preChangeRef: R33_AB_PRE_CHANGE_REF,
    startedAt,
    finishedAt: new Date().toISOString(),
    rounds,
    sites,
    arms: Object.fromEntries(sites.map((s) => [s, { ...R33_AB_ARMS[s], budgetMs: r33AbBudgetMs(s) }])),
    embedder: { mode: resolved.mode, profileId: profile.profileId },
    measuredCode: measuredCode(),
    loadavgStart,
    loadavgEnd,
    cores: os.cpus().length,
    querySetHash: hash,
    queries: QUERIES,
    precomputedMisses,
    warmupErrors: warmupErrors.slice(0, 10),
    summaries,
    verdicts: nullMode ? [] : verdicts,
    passes,
    samples,
  };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(
    'R33_AB_SUMMARY ' +
      JSON.stringify({
        mode: result.mode,
        passes,
        reading: result.reading,
        loadCheck,
        budgetsPass,
        ...(nullMode ? { nullSpreads, nullValid } : {}),
        commit: result.measuredCode.commits['.'],
        dirty: result.measuredCode.files.filter((f) => f.dirty).map((f) => f.path),
        verdicts: (nullMode ? [] : verdicts).map((v) => ({
          site: v.site,
          addedP95: v.addedP95,
          budget: v.budget,
          withinBudget: v.withinBudget,
          ...(v.invalidReason ? { invalidReason: v.invalidReason } : {}),
          a95: summaries[v.site]?.a.p95 ?? null,
          b95: summaries[v.site]?.b.p95 ?? null,
          top: summaries[v.site]?.topHitAgreement ?? null,
        })),
        out,
      }),
  );
  if (!loadCheck.matched) return 2;
  if (nullMode) return nullValid ? 0 : 1;
  return passes ? 0 : 1;
}

main()
  .then(async (code) => {
    await getOrgPg()
      .sql.end?.()
      .catch(() => null);
    process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  });
