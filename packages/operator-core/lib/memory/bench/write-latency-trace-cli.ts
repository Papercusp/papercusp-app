/**
 * write-latency-trace-cli.ts — per-stage attribution of `memory:remember`
 * (memory-write-latency-2026-07-26 P-001, and the before/after harness P-006
 * re-runs).
 *
 *   PAPERCUSP_EMBED_SIDECAR_URL=http://127.0.0.1:3384 \
 *     npx tsx packages/operator-core/lib/memory/bench/write-latency-trace-cli.ts
 *   npx tsx ... --runs 5 --keep
 *
 * Replays the EXACT stage sequence of `agent-tools/memory/remember.ts` against
 * the LIVE backend, timing each stage separately, so "the 7.1s is embed+store"
 * is MEASURED rather than inferred from module headers. Stage names below map
 * 1:1 onto that handler — keep them in sync if the handler's order changes.
 *
 * Writes real rows; by default it cleans up after itself (backend.forget + the
 * journal row) unless --keep. Run it with the same env the live operator has
 * (notably PAPERCUSP_EMBED_SIDECAR_URL) or the embed leg measures a path
 * production never takes.
 */
import { lexicalSimilarity } from '@papercusp/memory';
import { getOrgPg } from '@papercusp/db-org';

// Side-effect: wires the LIVE operator memory host (harness_shared).
import '../configure';
import { getMemoryBackend } from '../backend';
import { anchorMetadata } from '../anchors';
import { detectPossibleSecrets } from '../secret-detect';
import { conflictCheckEnabled, checkConflicts } from '../conflict-check';
import { resolveConflictJudge } from '../conflict-judge';
import { neighbourSearchQuery } from '../../agent-tools/memory/remember';
import { expandRefsForEmbed } from '../ref-expand';
import { journalPendingWrite, markJournalCommitted } from '../write-journal';
import { isMemoryPaused } from '../memory-pause';
import { getWorkItem } from '../../work-items';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const RUNS = Number(argValue('--runs') ?? 3);
const KEEP = process.argv.includes('--keep');
const DEDUP_TOP_K = 3;
/** Body size to probe. The handler embeds the FULL body TWICE — once as the
 *  neighbour-search QUERY (`backend.search(args.content, …)`) and once to store
 *  it — so latency scales with content length. Real agent memories run
 *  1–3KB, well above a toy probe string. */
const CHARS = Number(argValue('--chars') ?? 250);

/** Same shape the handler builds, with a unique body so each run is a genuine
 *  new write (a near-dup would exercise a different, cheaper path). */
function sampleContent(i: number): string {
  const head =
    `[latency-trace ${new Date().toISOString()} #${i}] Papercusp memory write-path ` +
    `stage attribution probe for plan memory-write-latency-2026-07-26 P-001. ` +
    `This row is written by write-latency-trace-cli.ts and removed unless --keep. `;
  if (head.length >= CHARS) return head;
  // Pad with varied prose (not a repeated token) so the embedder sees a
  // realistic token distribution rather than a trivially compressible run.
  const filler =
    'The neighbour search embeds the entire memory body as its query vector, then the store ' +
    'embeds the same body again, so a longer fact pays the embedder twice over. Agent-written ' +
    'facts routinely carry file paths, work-item refs and multi-clause technical detail. ';
  let out = head;
  let n = 0;
  while (out.length < CHARS) out += `${filler}[${n++}] `;
  return out.slice(0, CHARS);
}

interface Stage { name: string; ms: number; note?: string }

async function timed<T>(name: string, stages: Stage[], fn: () => Promise<T> | T, note?: (v: T) => string): Promise<T> {
  const t0 = performance.now();
  let v: T;
  try {
    v = await fn();
  } catch (err) {
    stages.push({ name, ms: performance.now() - t0, note: `THREW: ${(err as Error)?.message ?? err}` });
    throw err;
  }
  const ms = performance.now() - t0;
  stages.push({ name, ms, ...(note ? { note: note(v) } : {}) });
  return v;
}

async function traceOnce(i: number): Promise<{ stages: Stage[]; total: number }> {
  const stages: Stage[] = [];
  const content = sampleContent(i);
  const scopeKey = 'harness:papercusp';
  const t0 = performance.now();

  const backend = getMemoryBackend();

  await timed('isMemoryPaused', stages, () => isMemoryPaused('trace-probe-user'));

  const anchors = await timed('anchorMetadata (sync)', stages, () => anchorMetadata(content));
  const secrets = await timed('detectPossibleSecrets (sync)', stages, () => detectPossibleSecrets(content));

  const metadata: Record<string, unknown> = {
    scope: 'harness',
    harness_slug: 'papercusp',
    source: 'agent',
    latency_trace: true,
    ...(anchors ? { anchors: anchors.anchors, anchor_count: anchors.anchor_count } : {}),
    ...(secrets.matched ? { possible_secret: true } : {}),
  };

  const journalId = await timed('journalPendingWrite (PG INSERT — durability point)', stages,
    () => journalPendingWrite({ scope: scopeKey, kind: 'reference', content, metadata, verbatim: true }),
    (v) => (v ? `journal_id=${v}` : 'NULL (journaling degraded)'));

  await timed('backend.available() (connectivity probe)', stages,
    () => backend.available(), (v) => `ok=${v.ok}`);

  // Mirrors remember.ts's gate EXACTLY (P-007): the neighbour search runs only
  // when something can CONSUME it — dedup opt-in, or conflict-check with a REAL
  // judge. Before P-007 this was `dedupEnabled() || conflictCheckEnabled()`, so
  // on live config it ran on every write purely to feed a no-op judge.
  // Keep this in sync with the handler, or the trace stops measuring the real path.
  let neighbors: Array<{ id: string; text: string; score?: number }> = [];
  const dedupWanted = process.env.PAPERCUSP_MEMORY_DEDUP === 'on';
  const conflictWanted = conflictCheckEnabled();
  // Same resolution the handler uses (jev-decision-model-integration P-009 /
  // D-016): a stored Jev key first, then ANTHROPIC_API_KEY, else no judge.
  const resolution = conflictWanted ? await resolveConflictJudge() : null;
  const judgeAvailable = resolution?.available === true;
  const conflictUsable = conflictWanted && judgeAvailable;
  const judgeStage = resolution?.available
    ? `checkConflicts (${resolution.backend} judge)`
    : 'checkConflicts (no judge)';
  if (dedupWanted || conflictUsable) {
    neighbors = await timed('backend.search() (dedup/conflict neighbours)', stages,
      // P-008: length-capped query, exactly as the handler passes it.
      () => backend.search(neighbourSearchQuery(content), { scope: scopeKey, limit: DEDUP_TOP_K }),
      (v) => `${v.length} neighbours`);
    // lexicalSimilarity is what the dedup judgement uses (EI-10544) — time the
    // CPU cost so it is attributed rather than hidden inside the search stage.
    await timed('lexicalSimilarity scan (sync)', stages,
      () => neighbors.map((n) => lexicalSimilarity(content, n.text)));
    if (resolution?.available) {
      const judge = resolution.judge;
      await timed(judgeStage, stages,
        () => checkConflicts({
          newText: content,
          neighbors: neighbors.map((n) => ({ id: n.id, text: n.text, ...(n.score !== undefined ? { score: n.score } : {}) })),
          judge,
        }),
        (v) => `${v.conflicts.length} conflicts`);
    } else {
      stages.push({ name: judgeStage, ms: 0, note: 'n/a — dedup-only run, conflict-check off or no judge' });
    }
  } else {
    const why = conflictWanted && !judgeAvailable
      ? `SKIPPED (P-007: conflict-check ON but no usable judge — ${resolution && !resolution.available ? resolution.reason : 'nothing can consume it'})`
      : 'SKIPPED (dedup off and conflict-check off)';
    stages.push({ name: 'backend.search() (dedup/conflict neighbours)', ms: 0, note: why });
    stages.push({ name: 'lexicalSimilarity scan (sync)', ms: 0, note: 'n/a — no neighbours' });
    stages.push({ name: judgeStage, ms: 0, note: 'n/a — no neighbours' });
  }

  const embedText = await timed('expandRefsForEmbed (ref → title lookups)', stages,
    () => expandRefsForEmbed(content, async (id) => {
      const w = await getWorkItem(id);
      return w?.title ? { id, title: w.title } : null;
    }).catch(() => undefined),
    (v) => (v ? 'expanded' : 'no refs'));

  const { ids } = await timed('backend.remember() (EMBED + STORE)', stages,
    () => backend.remember(content, {
      scope: scopeKey, kind: 'reference', metadata,
      ...(embedText ? { embedText } : {}),
      verbatim: true,
    }),
    (v) => `${v.ids.length} id(s)`);

  // The handler fires this WITHOUT awaiting (`void markJournalCommitted(...)`),
  // so it is off the caller's critical path — timed here only for completeness.
  if (journalId) {
    await timed('markJournalCommitted (fire-and-forget in handler)', stages,
      () => markJournalCommitted(journalId, ids[0] ?? null));
  }

  const total = performance.now() - t0;

  if (!KEEP) {
    // Report cleanup failures LOUDLY — a silently-swallowed forget leaves probe
    // rows in the live store, where they pollute every later neighbour search
    // (and this CLI's own subsequent runs). Observed leaking 3 rows before this.
    for (const id of ids) {
      try {
        await backend.forget(id);
      } catch (err) {
        console.warn(`  ! cleanup FAILED for memory ${id}: ${(err as Error)?.message ?? err} — remove it by hand`);
      }
    }
    if (journalId) {
      try {
        const { sql } = getOrgPg();
        await sql`DELETE FROM harness_shared.memory_write_journal WHERE id = ${journalId}`;
      } catch (err) {
        console.warn(`  ! cleanup FAILED for journal row ${journalId}: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  return { stages, total };
}

async function main(): Promise<void> {
  console.log(`env: PAPERCUSP_EMBED_SIDECAR_URL=${process.env.PAPERCUSP_EMBED_SIDECAR_URL ?? '(unset)'}`);
  console.log(`env: PAPERCUSP_MEMORY_CONFLICT_CHECK=${process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK ?? '(unset → ON)'}`);
  console.log(`env: PAPERCUSP_MEMORY_DEDUP=${process.env.PAPERCUSP_MEMORY_DEDUP ?? '(unset → off)'}`);
  console.log(`env: ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? 'set' : '(unset)'} (a stored Jev key takes precedence as the conflict judge)`);
  console.log(`runs: ${RUNS}${KEEP ? ' (--keep: rows retained)' : ' (rows cleaned up)'}\n`);

  const all: Array<{ stages: Stage[]; total: number }> = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`run ${i + 1}/${RUNS} ... `);
    const r = await traceOnce(i);
    console.log(`${r.total.toFixed(0)}ms`);
    all.push(r);
  }

  const names = all[0].stages.map((s) => s.name);
  console.log(`\n${'stage'.padEnd(52)} ${'median ms'.padStart(10)} ${'% of total'.padStart(11)}`);
  console.log('-'.repeat(78));
  const medianTotal = median(all.map((r) => r.total));
  for (const name of names) {
    const vals = all.map((r) => r.stages.find((s) => s.name === name)?.ms ?? 0);
    const m = median(vals);
    console.log(`${name.padEnd(52)} ${m.toFixed(0).padStart(10)} ${((m / medianTotal) * 100).toFixed(1).padStart(10)}%`);
  }
  console.log('-'.repeat(78));
  console.log(`${'TOTAL'.padEnd(52)} ${medianTotal.toFixed(0).padStart(10)} ${'100.0%'.padStart(11)}`);

  console.log('\nnotes (first run):');
  for (const s of all[0].stages) if (s.note) console.log(`  ${s.name}: ${s.note}`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
