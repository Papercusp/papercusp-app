import { getOrgPg } from '@papercusp/db-org';
import { rerankCapabilityPriors } from '../../dream/capability-review.ts';
import { buildSidecarAwareReranker } from '../../memory/embed-sidecar-wiring.ts';
import { installFlagOverrideStore } from '../../flag-override-store.ts';
import { getPilotCapabilityManifest } from '../../dream/capability-catalog.ts';
import { buildCapabilityPacket } from '../../dream/capability-packets.ts';
import { buildCapabilityReviewSources } from '../../dream/capability-review-sources.ts';
import { moduleRepoRoot } from '../../module-repo-root.ts';

if (process.env.PAPERCUSP_EMBED_SIDECAR_URL !== 'http://127.0.0.1:3384') throw new Error('Use the verified local scorer');
process.env.PAPERCUSP_WORKSPACE_ID = 'papercusp-workspace';
installFlagOverrideStore();
const { sql } = getOrgPg();
try {
  const [row] = await sql`SELECT review, outcome FROM harness_shared.dream_runs
    WHERE workspace_id='papercusp-workspace'
      AND run_id='dream-cycle:papercusp-workspace:papercusp:cc713651-7d82-4a4e-a69d-c66336363cc6:dream:1'`;
  if (!row?.review?.priorMatches?.length) throw new Error('Missing saved evidence');
  const candidate = row.outcome.insight.capability;
  const query = candidate.behavior + '\n' + candidate.priorArt.proposedDelta;
  const priors = row.review.priorMatches;
  console.log(JSON.stringify({ phase: 'saved-input', queryChars: query.length, priorChars: priors.map(p => p.text.length), priorRefs: priors.map(p => p.ref), original: row.review.coverage.rerank }));
  const began = Date.now();
  const ranked = await rerankCapabilityPriors(query, priors);
  console.log(JSON.stringify({ phase: 'production-replay', elapsedMs: Date.now() - began, outcome: ranked.outcome }));
  const scorer = await buildSidecarAwareReranker();
  const started = Date.now();
  try {
    const scores = await scorer(query, priors.map(p => p.text), { deadline: Date.now() + 5000 });
    console.log(JSON.stringify({ phase: 'direct-replay', elapsedMs: Date.now() - started, count: scores.length, finite: scores.every(Number.isFinite) }));
  } catch (error) {
    console.log(JSON.stringify({ phase: 'direct-error', elapsedMs: Date.now() - started, error: String(error), cause: String(error?.cause ?? '') }));
  }
  const rootPath = moduleRepoRoot(import.meta.url);
  const manifest = getPilotCapabilityManifest();
  const scope = { workspaceId: 'papercusp-workspace', potSlug: 'papercusp', repositoryId: 'papercusp' };
  const packets = [];
  for (const unit of manifest.units) {
    const built = await buildCapabilityPacket({ rootPath, scope, unit, manifestRevision: manifest.revision });
    if (built.status !== 'ready') throw new Error('Current packet missing');
    packets.push(built.packet);
  }
  const sources = buildCapabilityReviewSources({ sql, scope, rootPath, manifest, packets });
  const answers = await Promise.all(row.review.coverage.searches.map(s => sources.search({ scope, facet: s.facet, query: s.query, kinds: s.kinds, limit: 8 })));
  const found = [...new Map(answers.flatMap(a => a.matches).map(p => [p.ref, p])).values()];
  console.log(JSON.stringify({ phase: 'current-union', count: found.length, originalCount: new Set(row.review.coverage.searches.flatMap(s => s.refs)).size, refs: found.map(p => p.ref), chars: found.map(p => p.text.length) }));
  try {
    const scores = await scorer(query, found.map(p => p.text), { deadline: Date.now() + 5000 });
    console.log(JSON.stringify({ phase: 'union-direct', count: scores.length, finite: scores.every(Number.isFinite) }));
  } catch (error) {
    console.log(JSON.stringify({ phase: 'union-error', error: String(error), cause: String(error?.cause ?? '') }));
  }
  const fullRanked = await rerankCapabilityPriors(query, found);
  console.log(JSON.stringify({ phase: 'union-production', count: found.length, outcome: fullRanked.outcome }));
  // Change only the local probe query to avoid cached pair scores. This is an
  // execution probe, not a new study observation or a replacement verdict.
  const uncachedQuery = query + '\nExecution probe ' + new Date().toISOString();
  const coldStart = Date.now();
  const uncached = await rerankCapabilityPriors(uncachedQuery, found, { timeoutMs: 180_000 });
  console.log(JSON.stringify({ phase: 'uncached-budgeted-union', elapsedMs: Date.now() - coldStart, count: found.length, outcome: uncached.outcome }));
} finally { await sql.end(); }
process.exit(0);
