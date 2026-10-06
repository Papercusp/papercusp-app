/**
 * chunk-search-latency-cli.ts — time every chunk-aware search site over the
 * fixed D-024 query set and report each site's p95 against its R-33 bound
 * (plan generic-rag-chunking-2026-09-29).
 *
 *   PAPERCUSP_SID=<your session id> \
 *   PAPERCUSP_EMBED_SIDECAR_URL=http://127.0.0.1:3384 \
 *   npx tsx packages/operator-core/lib/search/bench/chunk-search-latency-cli.ts \
 *     --ports 3070 [--rounds 3] [--out r33.json] [--no-consult]
 *
 * PAPERCUSP_EMBED_SIDECAR_URL must name the operator's embed sidecar (the systemd
 * units' value: `systemctl --user show papercup-bg-host.service -p Environment`).
 * D-024 timed the consult site through that sidecar; without it this process loads
 * the embedder in process, which times a different path, so the CLI refuses to time
 * the consult site unless the variable is set (or --no-consult is passed).
 *
 *   --ports 3070,3170   same-time A/B: every (round, query, site) sample is taken
 *                       on both operators back to back, alternating which goes
 *                       first, so both builds see the same load instant.
 *
 * SITES
 *   plans              plans:search { query, limit:10 }                       (MCP, end to end)
 *   turns              search:semantic { scope:['turns'] }                    (MCP)
 *   work_item          search:semantic { scope:['work_item'] }                (MCP)
 *   work_items_search  work_items:search { query, limit:10 }                  (MCP)
 *   consult            peersKnowLookup, in process, with the orient caller's wiring
 *                      (consult:get_feedback has side effects, so it is not called).
 *                      It runs THIS tree's code, whichever port is measured.
 *
 * Rounds are interleaved (round -> query -> site) so load drift spreads evenly over
 * sites. A transport failure (connection refused or reset, a 5xx) is not a latency
 * sample: the bench waits for /api/health and re-times the same call, up to 3 tries.
 *
 * D-024's re-measure rule applies to the RESULT, not to this tool: a site over its
 * bound is re-measured once with load average within 20% of the baseline run before
 * it is reported as a regression, and both readings are kept.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { getOrgPg } from '@papercusp/db-org';
import { peersKnowLookup } from '../../consult/peers-know';
import { buildQueryEmbedderResolved } from '../../agent-tools/search/embedder';
import { resolveProseProfileSelection } from '../prose-vector-dims';
import {
  CHUNK_SEARCH_LATENCY_QUERIES as QUERIES,
  D024_QUERY_SET_HASH,
  d024LoadMatch,
  querySetHash,
  r33Verdicts,
  summariseSite,
  type LatencySample,
  type SiteSummary,
} from './chunk-search-latency';

type CallResult = { ok: boolean; degraded: boolean; bytes: number; error?: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const WORKSPACE = process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
const HARNESS = process.env.PAPERCUSP_HARNESS ?? 'papercusp';

function readToken(): string {
  const fromEnv = process.env.PAPERCUSP_SUPERUSER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readFileSync(`${os.homedir()}/.papercusp/superuser-token`, 'utf8').trim();
}

let rpcId = 1;

async function mcp(port: number, sid: string, token: string, tool: string, args: Record<string, unknown>): Promise<CallResult> {
  const url =
    `http://127.0.0.1:${port}/api/mcp?superuser=1&client=${encodeURIComponent(sid)}` +
    `&workspace=${encodeURIComponent(WORKSPACE)}&harness=${encodeURIComponent(HARNESS)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  const dataLines = raw.split('\n').filter((l) => l.startsWith('data:'));
  let msg: {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  } | null;
  try {
    msg = JSON.parse(dataLines.length ? dataLines[dataLines.length - 1].slice(5) : raw);
  } catch {
    return { ok: false, degraded: false, bytes: raw.length, error: `unparseable http=${res.status} ${raw.slice(0, 160)}` };
  }
  if (msg?.error) return { ok: false, degraded: false, bytes: raw.length, error: JSON.stringify(msg.error).slice(0, 200) };
  const text = (msg?.result?.content ?? []).map((c) => c?.text ?? '').join('');
  if (msg?.result?.isError) return { ok: false, degraded: false, bytes: text.length, error: text.slice(0, 200) };
  return { ok: true, degraded: /"degraded"\s*:\s*true/.test(text), bytes: text.length };
}

async function consultSite(query: string): Promise<CallResult> {
  // Mirrors orient's peersKnow closure, the live caller of this leg.
  const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: 1_500 });
  const profile = resolved ? resolveProseProfileSelection(resolved.mode, resolved.profile) : null;
  if (!resolved || !profile) return { ok: false, degraded: true, bytes: 0, error: 'no query embedder resolved' };
  // peersKnowLookup returns null on an embed failure BEFORE its SQL runs, which looks
  // like a no-match; count the vector so a failed embed is reported as degraded.
  let dims = 0;
  const embed = async (t: string) => {
    const v = await resolved.embed(t);
    dims = v?.length ?? 0;
    return v;
  };
  const hit = await peersKnowLookup(getOrgPg().sql, { embed, profile }, { workspaceId: WORKSPACE, intent: query });
  return { ok: true, degraded: dims === 0, bytes: hit ? JSON.stringify(hit).length : 0 };
}

async function health(port: number): Promise<{ sha?: string } | null> {
  return fetch(`http://127.0.0.1:${port}/api/health`)
    .then((r) => r.json() as Promise<{ sha?: string }>)
    .catch(() => null);
}

async function timed(port: number | null, fn: () => Promise<CallResult>): Promise<{ ms: number; retries: number } & CallResult> {
  let res: CallResult = { ok: false, degraded: false, bytes: 0, error: 'not run' };
  let ms = 0;
  let retries = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = performance.now();
    try {
      res = await fn();
    } catch (e) {
      res = { ok: false, degraded: false, bytes: 0, error: String(e).slice(0, 200) };
    }
    ms = performance.now() - t0;
    const transport = !res.ok && /ECONNREFUSED|ECONNRESET|fetch failed|unparseable http=5\d\d|socket/i.test(res.error ?? '');
    if (!transport || port === null) break;
    retries++;
    for (let w = 0; w < 60; w++) {
      if (await fetch(`http://127.0.0.1:${port}/api/health`).then((x) => x.ok).catch(() => false)) break;
      await new Promise((z) => setTimeout(z, 2000));
    }
  }
  return { ms, retries, ...res };
}

async function main(): Promise<void> {
  const sid = process.env.PAPERCUSP_SID ?? '';
  if (!sid) throw new Error('PAPERCUSP_SID is unset: the MCP sites are called as this session');
  const ports = (arg('--ports') ?? '3070').split(',').map((p) => Number(p.trim()));
  if (ports.length < 1 || ports.length > 2 || ports.some((p) => !Number.isInteger(p) || p <= 0)) {
    throw new Error('--ports takes one port, or two for a same-time A/B');
  }
  const rounds = Number(arg('--rounds') ?? 3);
  const withConsult = !process.argv.includes('--no-consult');
  if (withConsult && !process.env.PAPERCUSP_EMBED_SIDECAR_URL?.trim()) {
    throw new Error(
      'PAPERCUSP_EMBED_SIDECAR_URL is unset: D-024 timed the consult site through the embed sidecar, ' +
        'and an in-process embedder times a different path. Set it (see the header) or pass --no-consult.',
    );
  }
  const out = arg('--out') ?? `chunk-search-latency-${ports.join('-')}.json`;
  const hash = querySetHash();
  if (hash !== D024_QUERY_SET_HASH) throw new Error(`query set hash ${hash} is not D-024's ${D024_QUERY_SET_HASH}`);
  const token = readToken();

  const mcpSites: Record<string, (port: number, q: string) => Promise<CallResult>> = {
    plans: (p, q) => mcp(p, sid, token, 'plans:search', { query: q, limit: 10 }),
    turns: (p, q) => mcp(p, sid, token, 'search:semantic', { query: q, scope: ['turns'], limit: 10 }),
    work_item: (p, q) => mcp(p, sid, token, 'search:semantic', { query: q, scope: ['work_item'], limit: 10 }),
    work_items_search: (p, q) => mcp(p, sid, token, 'work_items:search', { query: q, limit: 10 }),
  };

  const builds = Object.fromEntries(await Promise.all(ports.map(async (p) => [p, await health(p)] as const)));
  const load0 = os.loadavg();
  const startedAt = new Date().toISOString();

  // Warmup: the first 3 queries once per site and port, untimed (embedder and pools warm).
  for (const q of QUERIES.slice(0, 3)) {
    for (const fn of Object.values(mcpSites)) for (const p of ports) await fn(p, q).catch(() => null);
    if (withConsult) await consultSite(q).catch(() => null);
  }

  const samples: Record<string, Record<string, LatencySample[]>> = {};
  for (const p of ports) samples[p] = Object.fromEntries(Object.keys(mcpSites).map((s) => [s, []]));
  const consultSamples: LatencySample[] = [];
  let flip = false;
  for (let r = 0; r < rounds; r++) {
    for (let qi = 0; qi < QUERIES.length; qi++) {
      for (const [site, fn] of Object.entries(mcpSites)) {
        const order = ports.length === 2 && flip ? [...ports].reverse() : ports;
        flip = !flip;
        for (const p of order) samples[p][site].push({ round: r, q: qi, ...(await timed(p, () => fn(p, QUERIES[qi]))) });
      }
      if (withConsult) consultSamples.push({ round: r, q: qi, ...(await timed(null, () => consultSite(QUERIES[qi]))) });
    }
    console.log(`round ${r + 1}/${rounds} done ${new Date().toISOString()}`);
  }

  const consultSummary = withConsult ? summariseSite(consultSamples, rounds) : null;
  const perPort = Object.fromEntries(
    ports.map((p) => {
      const summary: Record<string, SiteSummary> = Object.fromEntries(
        Object.entries(samples[p]).map(([site, xs]) => [site, summariseSite(xs, rounds)]),
      );
      if (consultSummary) summary.consult = consultSummary;
      return [p, { build: builds[p], summary, r33: r33Verdicts(summary) }];
    }),
  );
  const loadEnd = os.loadavg();
  const loadMatch = d024LoadMatch(load0, loadEnd);
  const result = {
    bench: 'chunk-search-latency',
    plan: 'generic-rag-chunking-2026-09-29',
    bar: 'R-33',
    baselineDecision: 'D-024',
    loadRuleDecision: 'D-038',
    ports,
    rounds,
    startedAt,
    finishedAt: new Date().toISOString(),
    loadavgStart: load0,
    loadavgEnd: loadEnd,
    loadMatch,
    cores: os.cpus().length,
    querySetHash: hash,
    queries: QUERIES,
    consultRunsThisTree: withConsult,
    perPort,
    samples: { ...samples, consult: consultSamples },
  };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(
    'R33_SUMMARY ' +
      JSON.stringify({
        querySetHash: hash.slice(0, 12),
        loadMatched: loadMatch.matched,
        outOfBand: loadMatch.outOfBand,
        perPort: Object.fromEntries(Object.entries(perPort).map(([p, v]) => [p, { sha: v.build?.sha, r33: v.r33 }])),
        out,
      }),
  );
}

main()
  .then(async () => {
    await getOrgPg()
      .sql.end?.()
      .catch(() => null);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
