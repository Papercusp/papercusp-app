#!/usr/bin/env node
/**
 * facts-expiry-audit.mjs — WI-2141854, plan standing-facts-expiry-audit-2026-09-02.
 *
 * `facts:assert` defaults `ttlSec` to 7 days when the caller omits it, and callers
 * omitted it almost universally — so the whole standing-fact corpus sits on a 7-day
 * fuse whether a fact states a durable invariant or a passing observation. This script
 * is the audit instrument: it DUMPS the corpus into reviewable shards, and APPLIES the
 * per-fact verdicts back on two axes (expiry, kind).
 *
 * Why a direct UPDATE and not facts:assert (plan D-002) — assert SUPERSEDES the row:
 * new version, `created_by` rewritten to the restoring agent, `created_at` reset, TTL
 * capped at 90d. That destroys exactly the provenance an audit exists to preserve, and
 * would stamp ~8,000 facts as authored by one session.
 *
 * The audit surface is defined by the fold predicate itself (store.ts liveFactPredicate):
 * a fold serves `superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()`,
 * so every row that is a CURRENT version and unretracted is in scope regardless of
 * whether it has already lapsed. Superseded rows (a corrected prior version) and
 * retracted rows (a decision, or a cap eviction) are out of scope — see D-001.
 *
 * Usage:
 *   node scripts/facts-expiry-audit.mjs dump   --out <dir> [--shard 200] [--excerpt 200]
 *   node scripts/facts-expiry-audit.mjs apply  --verdicts <dir> [--execute] [--allow-partial]
 *   node scripts/facts-expiry-audit.mjs verify --verdicts <dir>
 *
 * `apply` is DRY-RUN unless --execute is passed, and REFUSES a ledger that does not
 * carry a verdict for every row in the population (coverage is the whole point).
 *
 * ## Verdict file format (compact, one fact per line)
 *
 *     <id> <expiry> <kind> <reason>
 *
 *   expiry : P        permanent (expires_at = 'infinity')
 *            L        leave as-is (already correct: correctly lapsed, or correctly short-lived)
 *            E<days>  extend to now() + <days> days
 *   kind   : -  leave | C convention | N conclusion | A assumption | U undecidable
 *   reason : a short token, no spaces (invariant, ephemeral, session-bound, snapshot, ...)
 *
 * Lines beginning `#` are comments. A `CLASS <sql-predicate-name> <expiry> <kind> <reason>`
 * line is NOT supported on purpose: a class verdict is expanded to its member ids at dump
 * time so that coverage stays checkable per row.
 */
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectScriptPg } from './lib/pg-url.mjs';

/** The audit surface — every CURRENT, unretracted fact (plan D-001). */
const SURFACE = `retracted_at IS NULL AND superseded_at IS NULL`;

/**
 * The TENANT this audit is scoped to. `harness_shared.agent_facts` is MULTI-TENANT
 * (workspace_id), and every query below used to omit that predicate — so the audit
 * population was drawn cross-tenant and, worse, `apply`'s UPDATEs matched on bare
 * `id = ANY(...)` and could write rows belonging to another workspace.
 *
 * That is not hypothetical: measured 2026-09-02T19:35Z, this script had already
 * extended FIVE foreign rows during a papercusp apply — 4991 / 5172 / 5247 in
 * workspace `default` and 16112 / 27584 in workspace `*` — pushing them +90d/+180d.
 * The prior expires_at is UNRECOVERABLE: the UPDATE overwrites in place and writes no
 * supersede row, so there is no version to read the old value back from. Extending a
 * foreign fact is low-harm, but the same defect under a `P` verdict would have made
 * another tenant's row PERMANENT, and nothing in the script would have reported it.
 *
 * Every agent_facts query in this file is therefore tenant-bound. Ids are global, so
 * the id-keyed UPDATEs need this predicate just as much as the population SELECTs do.
 */
const WORKSPACE = String(arg('workspace', 'papercusp-workspace'));

/** Permanent-expiry sentinel — FACT_PERMANENT_EXPIRY in agent-facts/store.ts. */
const PERMANENT = 'infinity';

/** Kind letters used in the verdict files. */
const KINDS = { C: 'convention', N: 'conclusion', A: 'assumption', U: 'undecidable' };

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/**
 * One-line review record.
 *
 * ⚠ THE EXCERPT MUST NOT SILENTLY TRUNCATE. The original default was 200 chars, which
 * hid 98.1% of the corpus (8,279 of 8,439 current rows exceed 200 chars; mean 357-1129,
 * max 1200) — and the hidden tail is exactly where durable content lives, because facts
 * are written with a status preamble first. Measured cost: the first urgent-reaper pass
 * judged 9 rows off the excerpt and got 8 of them wrong (6 L->P, 2 L->E); each opened
 * "WI-6451 DONE (36a92d5)..." or "Owner grant re-issued..." and read as completion
 * status, while the durable trap sat past the cut. They were hours from a hard DELETE.
 *
 * So: the default is now the full body, and any truncation ANNOUNCES itself inline.
 * A reviewer must never be unable to tell a complete body from a clipped one.
 */
function reviewLine(r, excerpt) {
  const flags = [
    r.kind ? r.kind[0].toUpperCase() : '-',
    r.confidence ? r.confidence[0] : '-',
    r.has_measurement ? 'M' : '',
    r.has_recheck ? 'R' : '',
    r.settled_by ? 'S' : '',
    r.expires_at === 'infinity' ? 'PERM' : r.lapsed ? 'LAPSED' : 'live',
  ]
    .filter(Boolean)
    .join('');
  const full = String(r.body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // excerpt <= 0 means "no limit". Any real clip is marked, never silent.
  const body =
    excerpt > 0 && full.length > excerpt
      ? `${full.slice(0, excerpt)} …⚠CLIPPED+${full.length - excerpt}ch — READ THE FULL BODY BEFORE JUDGING`
      : full;
  const ref = r.scope === 'workspace' ? '' : `:${r.scope_ref ?? ''}`;
  return `${r.id} ${r.scope}${ref} | ${r.key} | ${flags} | ${body}`;
}

async function cmdDump() {
  const outDir = String(arg('out', '.papercusp/scratch/facts-expiry-audit'));
  const shardSize = Number(arg('shard', 200));
  // 0 = full body (the default). Only pass a positive --excerpt for a deliberate
  // skim; the clip then announces itself on every affected line.
  const excerpt = Number(arg('excerpt', 0));
  mkdirSync(join(outDir, 'shards'), { recursive: true });
  mkdirSync(join(outDir, 'verdicts'), { recursive: true });

  const client = await connectScriptPg();
  try {
    const { rows } = await client.query(`
      SELECT id, workspace_id, scope, scope_ref, key, body, source_ref, created_by,
             created_at::text AS created_at, expires_at::text AS expires_at,
             (expires_at <= now()) AS lapsed,
             kind, confidence, audience_scope, settled_by,
             (measurement IS NOT NULL) AS has_measurement,
             (recheck IS NOT NULL) AS has_recheck,
             (depends_on IS NOT NULL) AS has_depends_on
        FROM harness_shared.agent_facts
       WHERE ${SURFACE} AND workspace_id = $1
       ORDER BY scope, coalesce(scope_ref,''), key, id`, [WORKSPACE]);

    writeFileSync(
      join(outDir, 'population.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    // Two machine-written classes are judged as classes (plan D-006). They are split out
    // so the heterogeneous remainder is what gets read row by row — but their member ids
    // are still written out individually, so coverage stays checkable per row.
    const isClass = (r) => r.key === 'launch-provenance' || r.key.startsWith('mode-instructions:');
    const classRows = rows.filter(isClass);
    const residual = rows.filter((r) => !isClass(r));

    writeFileSync(
      join(outDir, 'class-members.txt'),
      classRows
        .map((r) => `${r.id} ${r.key === 'launch-provenance' ? 'launch-provenance' : 'mode-instructions'}`)
        .join('\n') + '\n',
    );

    // Homogeneity evidence for the class verdicts: distinct body SHAPES per class, so the
    // claim "these are homogeneous" is measured rather than asserted (D-006).
    const shapes = {};
    for (const r of classRows) {
      const cls = r.key === 'launch-provenance' ? 'launch-provenance' : 'mode-instructions';
      const shape = String(r.body ?? '')
        .replace(/\s+/g, ' ')
        .replace(/su-[0-9a-f-]{6,}/g, '<agent>')
        .replace(/[a-z0-9-]+-\d{4}-\d{2}-\d{2}/g, '<plan>')
        .replace(/[0-9]+/g, '<n>')
        .slice(0, 110);
      shapes[cls] ??= {};
      shapes[cls][shape] = (shapes[cls][shape] ?? 0) + 1;
    }
    const shapeReport = Object.entries(shapes)
      .map(([cls, m]) => {
        const sorted = Object.entries(m).sort((a, b) => b[1] - a[1]);
        const total = sorted.reduce((a, [, n]) => a + n, 0);
        return [
          `## ${cls} — ${total} rows, ${sorted.length} distinct body shapes`,
          ...sorted.slice(0, 25).map(([s, n]) => `${String(n).padStart(5)}  ${s}`),
        ].join('\n');
      })
      .join('\n\n');
    writeFileSync(join(outDir, 'class-homogeneity.txt'), shapeReport + '\n');

    // Shard the residual by scope so a reviewer works one blast-radius tier at a time.
    const order = { workspace: 0, harness: 1, role: 2, owner: 3, work_item: 4 };
    residual.sort(
      (a, b) =>
        (order[a.scope] ?? 9) - (order[b.scope] ?? 9) ||
        String(a.scope_ref ?? '').localeCompare(String(b.scope_ref ?? '')) ||
        a.key.localeCompare(b.key),
    );
    let n = 0;
    for (let i = 0; i < residual.length; i += shardSize) {
      const chunk = residual.slice(i, i + shardSize);
      const name = `shard-${String(++n).padStart(3, '0')}.txt`;
      const header = `# ${name} — ${chunk.length} facts | scopes: ${[...new Set(chunk.map((r) => r.scope))].join(',')}\n# <id> <scope>:<ref> | <key> | <kind><conf><flags><expiry-state> | <body excerpt>\n`;
      writeFileSync(
        join(outDir, 'shards', name),
        header + chunk.map((r) => reviewLine(r, excerpt)).join('\n') + '\n',
      );
    }

    console.log(`POPULATION\t${rows.length}`);
    console.log(`CLASS_ROWS\t${classRows.length}`);
    console.log(`RESIDUAL\t${residual.length}`);
    console.log(`SHARDS\t${n}\t(${shardSize}/shard, ${excerpt}-char excerpts)`);
    console.log(`OUT\t${outDir}`);
  } finally {
    await client.end();
  }
}

/** Parse every `*.txt` verdict file in a directory into id → verdict. */
function readVerdicts(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  const verdicts = new Map();
  const dupes = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    for (const [i, raw] of lines.entries()) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(\d+)\s+(P|L|E\d+)\s+([-CNAU])\s+(\S+)\s*$/);
      if (!m) throw new Error(`${f}:${i + 1} unparseable verdict line: ${line.slice(0, 120)}`);
      const id = Number(m[1]);
      if (verdicts.has(id)) dupes.push(`${id} (${f}:${i + 1})`);
      verdicts.set(id, { id, expiry: m[2], kind: m[3], reason: m[4], src: `${f}:${i + 1}` });
    }
  }
  return { verdicts, dupes, files };
}

async function cmdApply() {
  const dir = String(arg('verdicts'));
  const execute = arg('execute') === true;
  const allowPartial = arg('allow-partial') === true;
  if (!dir || !existsSync(dir)) throw new Error(`--verdicts <dir> required (got ${dir})`);
  const { verdicts, dupes, files } = readVerdicts(dir);
  if (dupes.length) {
    throw new Error(`REFUSED: ${dupes.length} duplicate verdicts, e.g. ${dupes.slice(0, 5).join(', ')}`);
  }
  console.log(`VERDICT_FILES\t${files.length}`);
  console.log(`VERDICTS\t${verdicts.size}`);

  const client = await connectScriptPg();
  try {
    const { rows: popRows } = await client.query(
      `SELECT id, kind, (expires_at='infinity') AS permanent, (expires_at<=now()) AS lapsed
         FROM harness_shared.agent_facts WHERE ${SURFACE} AND workspace_id = $1`,
      [WORKSPACE],
    );
    const population = new Map(popRows.map((r) => [Number(r.id), r]));

    // The corpus is LIVE — ~10 agents were writing to it during this audit and the surface
    // grew by 7 rows in 20 minutes. So coverage must be judged against the SNAPSHOT that was
    // actually audited, not against the moving table: rows created after the dump were never
    // reviewable and must not block the apply, while rows that WERE audited and have since
    // been reaped or superseded must not be demanded either. Pass --snapshot <population.jsonl>
    // to get that honest denominator; without it the check falls back to the live table.
    const snapshotPath = arg('snapshot');
    let auditable = new Set(population.keys());
    let postSnapshotNew = 0;
    if (typeof snapshotPath === 'string') {
      const snapIds = new Set(
        readFileSync(snapshotPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => Number(JSON.parse(l).id)),
      );
      auditable = new Set([...population.keys()].filter((id) => snapIds.has(id)));
      postSnapshotNew = population.size - auditable.size;
      const goneSinceSnapshot = [...snapIds].filter((id) => !population.has(id)).length;
      console.log(`SNAPSHOT_ROWS\t${snapIds.size}`);
      console.log(`POST_SNAPSHOT_NEW\t${postSnapshotNew}\t(not auditable — created after the dump)`);
      console.log(`GONE_SINCE_SNAPSHOT\t${goneSinceSnapshot}\t(reaped/retracted/superseded since the dump)`);
    }

    const missing = [...auditable].filter((id) => !verdicts.has(id));
    const unknown = [...verdicts.keys()].filter((id) => !population.has(id));

    console.log(`POPULATION\t${population.size}`);
    console.log(`AUDITABLE\t${auditable.size}`);
    console.log(`UNJUDGED\t${missing.length}`);
    console.log(`NOT_IN_POPULATION\t${unknown.length}`);
    if (unknown.length) console.log(`NOT_IN_POPULATION_SAMPLE\t${unknown.slice(0, 10).join(',')}`);
    if (missing.length && !allowPartial) {
      console.log(`UNJUDGED_SAMPLE\t${missing.slice(0, 20).join(',')}`);
      throw new Error(
        `REFUSED: ${missing.length} facts carry no verdict. The audit must cover every row; ` +
          `pass --allow-partial only for a deliberate staged batch.`,
      );
    }

    /** @type {Map<string, number[]>} */
    const expiryBuckets = new Map(); // 'infinity' | '<days>' -> ids
    /** @type {Map<string, number[]>} */
    const kindBuckets = new Map(); // kind name -> ids
    let expiryNoop = 0;
    let kindNoop = 0;

    for (const [id, cur] of population) {
      const v = verdicts.get(id);
      if (!v) continue;
      if (v.expiry === 'P') {
        if (cur.permanent) expiryNoop++;
        else push(expiryBuckets, 'infinity', id);
      } else if (v.expiry.startsWith('E')) {
        push(expiryBuckets, v.expiry.slice(1), id);
      } else {
        expiryNoop++;
      }
      if (v.kind !== '-') {
        const want = KINDS[v.kind];
        if (cur.kind === want) kindNoop++;
        else push(kindBuckets, want, id);
      } else {
        kindNoop++;
      }
    }

    for (const [k, ids] of expiryBuckets) console.log(`PLAN_EXPIRY_${k}\t${ids.length}`);
    console.log(`PLAN_EXPIRY_UNCHANGED\t${expiryNoop}`);
    for (const [k, ids] of kindBuckets) console.log(`PLAN_KIND_${k}\t${ids.length}`);
    console.log(`PLAN_KIND_UNCHANGED\t${kindNoop}`);

    if (!execute) {
      console.log('DRY_RUN — nothing written. Re-run with --execute to apply.');
      return;
    }

    await client.query('BEGIN');
    let writes = 0;
    for (const [bucket, ids] of expiryBuckets) {
      const r =
        bucket === 'infinity'
          ? await client.query(
              `UPDATE harness_shared.agent_facts SET expires_at=$2::timestamptz, updated_at=now()
                WHERE id = ANY($1::bigint[]) AND ${SURFACE} AND workspace_id = $3`,
              [ids, PERMANENT, WORKSPACE],
            )
          : await client.query(
              `UPDATE harness_shared.agent_facts
                  SET expires_at = now() + ($2::int * interval '1 day'), updated_at=now()
                WHERE id = ANY($1::bigint[]) AND ${SURFACE} AND workspace_id = $3`,
              [ids, Number(bucket), WORKSPACE],
            );
      writes += r.rowCount;
      console.log(`APPLIED_EXPIRY_${bucket}\t${r.rowCount}`);
    }
    for (const [kind, ids] of kindBuckets) {
      const r = await client.query(
        `UPDATE harness_shared.agent_facts SET kind=$2, updated_at=now()
          WHERE id = ANY($1::bigint[]) AND ${SURFACE} AND workspace_id = $3`,
        [ids, kind, WORKSPACE],
      );
      writes += r.rowCount;
      console.log(`APPLIED_KIND_${kind}\t${r.rowCount}`);
    }
    await client.query('COMMIT');
    console.log(`APPLIED_TOTAL\t${writes}`);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the txn may never have opened */
    }
    throw err;
  } finally {
    await client.end();
  }
}

function push(map, key, val) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(val);
}

/**
 * Expand the two CLASS verdicts (plan D-006) to one verdict line per member id, so
 * coverage stays checkable per row rather than per class.
 *
 * Both classes are session/mode-BOUND by their own text — "report milestones to them
 * while live", "while '<mode>' is on ... retracted when the mode is turned off" — so
 * their correct expiry is the lifetime of that binding, not permanence. Two carve-outs,
 * each measured rather than assumed:
 *
 *  - OFF-TEMPLATE rows (15 launch-provenance, 1 mode-instructions as of 2026-09-02) are
 *    NOT covered by the class verdict. Somebody wrote something else under that key; they
 *    go to a review shard and are judged individually.
 *  - A `mode-instructions:<m>` fact whose agent is STILL REGISTERED in mode <m> is the
 *    exact bug this audit exists to fix: the agent is in the mode but silently lost its
 *    scope instructions when the 7-day default fired. Those are EXTENDED. 90 days, not
 *    permanent: mode:set retracts the fact when the mode exits, so the retraction is the
 *    real terminator and the TTL only has to outlive any realistic mode while still
 *    self-cleaning if the agent dies without exiting.
 */
async function cmdClassVerdicts() {
  const outDir = String(arg('out', '.papercusp/scratch/facts-expiry-audit'));
  const client = await connectScriptPg();
  try {
    const { rows } = await client.query(`
      SELECT f.id, f.key, f.body, (f.expires_at <= now()) AS lapsed,
             (m.owner_id IS NOT NULL) AS still_in_mode
        FROM harness_shared.agent_facts f
        LEFT JOIN harness_shared.agent_modes m
               ON m.owner_id = f.scope_ref
              AND m.mode = replace(f.key, 'mode-instructions:', '')
              AND f.key LIKE 'mode-instructions:%'
       WHERE ${SURFACE} AND f.workspace_id = ${`'${WORKSPACE.replace(/'/g, "''")}'`}
         AND (f.key = 'launch-provenance' OR f.key LIKE 'mode-instructions:%')`);

    const verdicts = [];
    const offTemplate = [];
    let extended = 0;
    for (const r of rows) {
      const body = String(r.body ?? '');
      const isLp = r.key === 'launch-provenance';
      const onTemplate = isLp
        ? body.startsWith('You were launched by')
        : /^[A-Z-]+ SCOPE — while /.test(body);
      if (!onTemplate) {
        offTemplate.push(r);
        continue;
      }
      if (!isLp && r.still_in_mode) {
        // NOT a liveness claim: agent_modes is not reliably cleaned (6,235 distinct agents
        // hold rows while ~90 are alive), so a standing row means only "this mode was set
        // and never explicitly exited". Extending anyway is the safe direction because the
        // asymmetry is stark — a wrong EXTEND costs one dead agent's private owner scope,
        // which nothing folds; a wrong LEAVE silently strips an owner-given mode scope from
        // an agent that is still in that mode, which is the defect this audit exists to fix.
        verdicts.push(`${r.id} E90 - mode-row-still-standing`);
        extended++;
      } else {
        verdicts.push(`${r.id} L - ${isLp ? 'session-bound' : 'mode-bound'}`);
      }
    }

    const header = [
      '# CLASS verdicts — plan standing-facts-expiry-audit-2026-09-02 D-006, expanded per row.',
      '# launch-provenance + mode-instructions:* are machine-written and session/mode-BOUND by',
      '# their own text, so their correct expiry is that binding, not permanence.',
      `# Carve-out: ${extended} mode-instructions facts whose agent_modes row still STANDS are`,
      '# EXTENDED to 90d. That is not a liveness claim (agent_modes is not reliably cleaned);',
      '# it is the safe side of an asymmetry — a wrong extend costs one dead agent private',
      '# scope nothing folds, a wrong leave strips an owner-set mode scope from a live agent.',
      `# ${offTemplate.length} off-template rows are NOT class-judged; see shards/shard-000-off-template.txt`,
      '',
    ].join('\n');
    writeFileSync(join(outDir, 'verdicts', 'class-000.txt'), header + verdicts.join('\n') + '\n');

    if (offTemplate.length) {
      const lines = offTemplate.map(
        (r) => `${r.id} ${r.key} | ${r.lapsed ? 'LAPSED' : 'live'} | ${String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 400)}`,
      );
      writeFileSync(
        join(outDir, 'shards', 'shard-000-off-template.txt'),
        `# Off-template rows under a CLASS key — judged individually, NOT by the class verdict.\n# <id> <key> | <state> | <body>\n` +
          lines.join('\n') +
          '\n',
      );
    }

    console.log(`CLASS_ROWS\t${rows.length}`);
    console.log(`CLASS_VERDICTS\t${verdicts.length}`);
    console.log(`EXTENDED_STILL_IN_MODE\t${extended}`);
    console.log(`OFF_TEMPLATE_FOR_REVIEW\t${offTemplate.length}`);
  } finally {
    await client.end();
  }
}

async function cmdVerify() {
  const dir = String(arg('verdicts'));
  const { verdicts } = readVerdicts(dir);
  const wantPermanent = [...verdicts.values()].filter((v) => v.expiry === 'P').map((v) => v.id);
  const wantExtended = [...verdicts.values()].filter((v) => v.expiry.startsWith('E')).map((v) => v.id);
  const wantConvention = [...verdicts.values()].filter((v) => v.kind === 'C').map((v) => v.id);
  const client = await connectScriptPg();
  try {
    const chk = async (label, ids, predicate) => {
      if (!ids.length) return console.log(`${label}\t0\t0`);
      const { rows } = await client.query(
        `SELECT count(*) AS matched FROM harness_shared.agent_facts
          WHERE id = ANY($1::bigint[]) AND workspace_id = $2 AND ${predicate}`,
        [ids, WORKSPACE],
      );
      console.log(`${label}\t${ids.length}\t${rows[0].matched}`);
    };
    console.log('CHECK\texpected\tactual');
    await chk('PERMANENT', wantPermanent, `expires_at = 'infinity'`);
    await chk('EXTENDED_LIVE', wantExtended, `expires_at > now()`);
    await chk('KIND_CONVENTION', wantConvention, `kind = 'convention'`);
    const { rows: sum } = await client.query(
      `SELECT count(*) AS surface,
              count(*) FILTER (WHERE expires_at > now()) AS live,
              count(*) FILTER (WHERE expires_at = 'infinity') AS permanent,
              count(*) FILTER (WHERE expires_at <= now()) AS lapsed,
              count(*) FILTER (WHERE kind='convention') AS conventions
         FROM harness_shared.agent_facts WHERE ${SURFACE} AND workspace_id = $1`,
      [WORKSPACE],
    );
    console.log(`SURFACE_AFTER\t${JSON.stringify(sum[0])}`);
  } finally {
    await client.end();
  }
}

/**
 * reshard — re-render existing shard .txt files from the audited population.jsonl.
 *
 * Deliberately does NOT re-query the database. A fresh `dump` would re-snapshot a corpus
 * that ~100 agents are writing to and that the 30-day reaper is deleting from, producing
 * a DIFFERENT population and a DIFFERENT partition — which would silently invalidate
 * every verdict already keyed to the current shard boundaries. This re-renders the same
 * ids, in the same shards, in the same order, changing only how much of each body a
 * reviewer is shown.
 */
async function cmdReshard() {
  const outDir = String(arg('out', '.papercusp/scratch/facts-expiry-audit'));
  const excerpt = Number(arg('excerpt', 0));
  const byId = new Map();
  for (const line of readFileSync(join(outDir, 'population.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    byId.set(String(r.id), r);
  }
  const shardDir = join(outDir, 'shards');
  let files = 0;
  let rendered = 0;
  let missing = 0;
  for (const name of readdirSync(shardDir).filter((f) => f.endsWith('.txt')).sort()) {
    const prev = readFileSync(join(shardDir, name), 'utf8').split('\n');
    const ids = prev
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.split(' ')[0]);
    const rows = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r) rows.push(r);
      else missing++;
    }
    const header =
      `# ${name} — ${rows.length} facts | scopes: ${[...new Set(rows.map((r) => r.scope))].join(',')}\n` +
      `# <id> <scope>:<ref> | <key> | <kind><conf><flags><expiry-state> | <body${excerpt > 0 ? ' excerpt' : ' — FULL'}>\n`;
    writeFileSync(join(shardDir, name), header + rows.map((r) => reviewLine(r, excerpt)).join('\n') + '\n');
    files++;
    rendered += rows.length;
  }
  console.log(`RESHARD_FILES\t${files}`);
  console.log(`RESHARD_ROWS\t${rendered}`);
  console.log(`RESHARD_MISSING_FROM_SNAPSHOT\t${missing}`);
  console.log(`RESHARD_EXCERPT\t${excerpt > 0 ? `${excerpt} (clips marked)` : 'FULL BODY'}`);
}

const cmd = process.argv[2];
const run =
  cmd === 'dump'
    ? cmdDump
    : cmd === 'class-verdicts'
      ? cmdClassVerdicts
      : cmd === 'apply'
        ? cmdApply
        : cmd === 'verify'
          ? cmdVerify
          : cmd === 'reshard'
            ? cmdReshard
            : null;
if (!run) {
  console.error(
    'usage: facts-expiry-audit.mjs <dump|class-verdicts|apply|verify|reshard> [...]',
  );
  process.exit(2);
}
run().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
