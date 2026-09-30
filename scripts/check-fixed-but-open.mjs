#!/usr/bin/env node
/**
 * check-fixed-but-open.mjs — report OPEN work-items whose fix appears to have ALREADY LANDED,
 * evidenced by their id being cited in COMMITTED source.
 *
 * WHY THIS EXISTS
 * ---------------
 * A work-item whose fix landed can sit open indefinitely: the fixing agent stamps the id into a
 * comment or a recurrence guard and never closes the item. The scheduler then keeps serving it.
 * Measured 2026-08-10: four consecutive scheduler-served items (WI-5163, WI-5319, WI-5325,
 * WI-5329) were already fixed in tree — one of them fixed SEVEN MINUTES after being filed and
 * left open for three weeks. An independent agent measured 5/5 the same way. The class had 6+
 * open filings and zero fixes; this is the detector those filings kept describing.
 *
 * THE COST MODEL EVERY PRIOR FILING GOT WRONG
 * -------------------------------------------
 * The obvious implementation — grep the tree once per open id — is ~13k greps and reads as
 * "too expensive to build". Invert it: scan the tree ONCE for every id-shaped token, then
 * intersect with the open set in SQL. Measured at 0.24s for 5,101 distinct ids. That inversion
 * is the whole reason this is cheap.
 *
 * `git grep` searches only TRACKED files, which is exactly the "committed source" criterion —
 * an uncommitted edit must not count as proof that a fix landed.
 *
 * WHY THIS IS A REPORT AND NOT AN AUTO-CLOSER
 * -------------------------------------------
 * A cited id is a CANDIDATE, never a verdict. Two distinct citation kinds are indistinguishable
 * to a naive grep, and only one of them is evidence (all three measured live):
 *
 *   EI-100  →  workItemIds: ['WI-1', 'WI-2', 'EI-100']        ← synthetic FIXTURE. False positive.
 *   WI-559  →  "// WI-559: the owner's signed directory..."   ← explanatory comment. Plausible.
 *   EI-1416 →  "// EI-1416 ... These pin the fix"             ← recurrence guard. True positive.
 *
 * So this tiers by citation CONTEXT and stops there. Closing an item still requires dating the
 * fix (`git log -G '<string the fix introduced>' -- <path> | tail -1`, run INSIDE the owning
 * repo). An auto-closer built on this signal would silently terminate live work.
 *
 * Report-only: always exits 0 unless it could not run at all. It is a triage aid, not a gate.
 *
 * Usage:
 *   node scripts/check-fixed-but-open.mjs [--harness papercusp] [--limit 40] [--tier guard] [--json]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectScriptPg } from './lib/pg-url.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Id shape. 3+ digits deliberately: WI-1/WI-2 are overwhelmingly fixture placeholders. */
const ID_RE = /\b(?:WI|EI)-[0-9]{3,}\b/g;

/** A line whose FIRST non-space is a comment opener. Prose about the fix, not data. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#|--)/;

const TEST_PATH_RE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|selftest)/;

/** Tier ordering, strongest evidence first. */
const TIERS = ['guard', 'source-comment', 'weak'];

/**
 * Active work-item kinds the backward reconciliation sweep must inspect.
 *
 * `feature` is deliberately first and load-bearing. The three incidents that motivated
 * EI-19327225905639728 (WI-5657, WI-5754, WI-5779) were ALL feature-family rows; limiting this
 * query to the issue-store kinds made the detector healthy-looking while excluding the exact
 * backlog class it was meant to find. `chunk` is intentionally absent: its forward write path is
 * retired and only terminal historical rows remain (see work-items.ts).
 *
 * @type {readonly string[]}
 */
export const FIXED_BUT_OPEN_ITEM_KINDS = Object.freeze(['feature', 'bug', 'change', 'task']);

/**
 * A citation can name an item as STILL OUTSTANDING rather than as fixed — a third false-positive
 * mode, distinct from fixture data and invisible to the tiering (the line is a genuine comment in
 * a genuine guard file; it just says the opposite of what we are looking for).
 *
 * Measured 2026-08-10: 4 of 329 high-tier candidates (1.2%). Rare, but the exemplar is the kind
 * of thing that costs an hour — `WI-560` is cited as "blocked on the fed-a→fed-b federation fix
 * WI-559", i.e. as an open release gate. Flagged, not filtered: the phrasing is a heuristic and
 * dropping a real candidate is worse than annotating a false one.
 */
export const CITED_AS_OUTSTANDING_RE =
  /\b(?:blocked on|pending|not yet|still (?:open|outstanding|fails|failing)|TODO|will be|once .{0,40} lands|awaiting)\b/i;

function parseArgs(argv) {
  const args = { harness: 'papercusp', limit: 40, json: false, tier: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--harness') args.harness = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--tier') args.tier = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/**
 * git grep in one repo. Returns raw "path:lineno:content" rows.
 *
 * ⚠ git grep exits 1 on NO MATCH. That is not an error, and treating it as one is how the
 * submodule leg of this check dies on the first clean submodule (hit live on libs/generic/cache).
 */
function gitGrepLines(cwd) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-nIE', '(WI|EI)-[0-9]{3,}', '--', '*.ts', '*.tsx', '*.mjs', '*.js', '*.sh', '*.sql'],
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // SELF-CONTAMINATION: this detector's own test file quotes REAL citation lines verbatim as
    // fixtures (that is deliberate — inventing example lines is how the classifier drifts from
    // the tree). But those fixtures then read as genuine citations of the real ids inside them,
    // so the detector cites itself as evidence about other people's work items. Measured
    // 2026-08-10: WI-560 surfaced in a 20-item guard-tier sample with one of its two citations
    // pointing at fixed-but-open-citation-tiering.test.ts. Excluded by path.
    return out.split('\n').filter(Boolean).filter((l) => !l.includes('fixed-but-open-citation-tiering.test.ts'));
  } catch (err) {
    if (err && err.status === 1) return []; // genuine no-match
    return [];
  }
}

/** Top-level submodule paths. These are SEPARATE repos: a superproject grep does not see inside. */
function submodulePaths(cwd) {
  try {
    const out = execFileSync('git', ['submodule', 'status'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Does `content` assert that a value PRODUCED BY the system under test contains/equals `id`?
 *
 * This separates the two opposite things that both look like "the id sits inside quotes", and
 * getting it wrong is what made the detector under-tier WI-5332 (a genuine already-fixed item)
 * into the bucket its own report labels "likely FIXTURE data":
 *
 *   expect(exhaustedEvents()[0]!.message).toContain('WI-5332');   ← GUARD. The id appears only as
 *     the EXPECTED value, asserted against output the code emitted. A committed test pinning the
 *     fix's own message is the strongest already-fixed evidence there is.
 *
 *   expect(encodeScopedRef(null, 'WI-1')).toBe('WI-1');           ← FIXTURE. The id is ALSO an
 *     INPUT — a synthetic value round-tripped through an encoder. Says nothing about WI-1.
 *
 * So "inside an expect()" is NOT the discriminator; both lines satisfy it. The discriminator is
 * whether the id ALSO appears in the assertion's SUBJECT (everything left of `.toXxx(`). We split
 * on the matcher rather than paren-matching the expect() call — adequate here and far harder to
 * get subtly wrong than a hand-rolled balanced-paren scan.
 *
 * ⚠ Deliberately NOT handled: an id standing alone as a test-block name, `it('WI-1234', ...)`.
 * That shape was searched for in this tree on 2026-08-10 and returned ZERO hits, so there is no
 * measured case to anchor it to. Adding a branch for it would be inventing a shape.
 *
 * @param {string} content
 * @param {string} id
 * @returns {boolean}
 */
function assertsProducedValue(content, id) {
  const esc = id.replace('-', '\\-');
  const matcher = new RegExp(
    `\\.(?:toContain|toBe|toMatch|toEqual|toStrictEqual|toHaveBeenCalledWith)\\(\\s*['"\`]${esc}['"\`]`,
  );
  const hit = matcher.exec(content);
  if (!hit) return false;
  const subject = content.slice(0, hit.index);
  if (!subject.includes('expect(')) return false;
  // A NEGATED assertion says the id must NOT appear — the id is being scrubbed FROM output, which
  // is the opposite of "the fix emits it". Measured: release-history-integration.test.ts:259
  // `expect(html).not.toContain('EI-100')`, on the original false-positive id.
  if (/\.not\s*$/.test(subject) || /\.not\./.test(subject)) return false;
  // The id also appears left of the matcher => it was fed IN, not just asserted about.
  return !new RegExp(`['"\`]${esc}['"\`]`).test(subject);
}

/**
 * Classify ONE citation of `id` on `content`.
 *   'comment'   — the line is prose about the change (the evidence-bearing shape)
 *   'assertion' — a committed guard asserting the id appears in output the code PRODUCED
 *                 (see `assertsProducedValue`). Evidence, despite being quoted.
 *   'literal'   — the id sits inside quotes, i.e. it is DATA (fixture rows, id arrays)
 *   'code'      — anything else
 *
 * ⚠ The return type is DECLARED, not inferred, and that is load-bearing for
 * `gen:declarations:check`. `generate()` unlinks the existing declarations before running tsc
 * while `check()` emits into a temp dir without unlinking, so the two runs hand tsc different
 * compilation inputs. tsc orders union members by internal type id, so an INFERRED literal union
 * can come out permuted between the two — emitting `"comment" | "code" | "literal"` one way and
 * `"code" | "comment" | "literal"` the other. The check byte-compares, so that permutation reads
 * as a stale declaration that regenerating cannot fix (observed live 2026-08-10). Declaring the
 * union pins the order. Keep the annotation on any exported function here returning 3+ literals.
 *
 * @param {string} content
 * @param {string} id
 * @returns {'comment' | 'assertion' | 'literal' | 'code'}
 */
export function classifyCitation(content, id) {
  if (COMMENT_LINE_RE.test(content)) return 'comment';
  if (assertsProducedValue(content, id)) return 'assertion';
  const quoted = new RegExp(`['"\`]${id.replace('-', '\\-')}['"\`]`);
  if (quoted.test(content)) return 'literal';
  return 'code';
}

function scanCitations() {
  const repos = [{ label: '.', cwd: REPO_ROOT }];
  for (const sm of submodulePaths(REPO_ROOT)) {
    repos.push({ label: sm, cwd: path.join(REPO_ROOT, sm) });
  }

  /** id -> { contexts:Set, inTest:bool, everLiteral:bool, samples:[] } */
  const cited = new Map();

  for (const repo of repos) {
    for (const row of gitGrepLines(repo.cwd)) {
      // "path:lineno:content" — content may itself contain colons, so split only twice.
      const first = row.indexOf(':');
      const second = row.indexOf(':', first + 1);
      if (first < 0 || second < 0) continue;
      const file = row.slice(0, first);
      const lineNo = row.slice(first + 1, second);
      const content = row.slice(second + 1);

      const displayPath = repo.label === '.' ? file : `${repo.label}/${file}`;
      const isTest = TEST_PATH_RE.test(displayPath);

      const ids = content.match(ID_RE);
      if (!ids) continue;

      for (const id of new Set(ids)) {
        let rec = cited.get(id);
        if (!rec) {
          rec = {
            contexts: new Set(),
            inTest: false,
            everLiteral: false,
            hasAssertion: false,
            vetoedBy: null,
            samples: [],
          };
          cited.set(id, rec);
        }
        const ctx = classifyCitation(content, id);
        rec.contexts.add(ctx);
        if (ctx === 'literal') rec.everLiteral = true;
        if (ctx === 'assertion' && isTest) rec.hasAssertion = true;
        if ((ctx === 'comment' || ctx === 'assertion') && isTest) rec.inTest = true;
        // AUDITABILITY: the literal that trips the veto is the one citation `samples` drops, so a
        // `weak` verdict used to arrive with its grounds withheld — three strong-looking guard
        // citations and no visible reason for the demotion. Keep the FIRST one so the report can
        // show what it demoted on. (Measured on WI-5332: the hidden line was an assertion, not
        // fixture data at all, which is how the misclassification stayed invisible.)
        if (ctx === 'literal' && !rec.vetoedBy) {
          rec.vetoedBy = { file: displayPath, line: Number(lineNo), text: content.trim().slice(0, 160) };
        }
        if (rec.samples.length < 3 && ctx !== 'literal') {
          rec.samples.push({ file: displayPath, line: Number(lineNo), text: content.trim().slice(0, 160), ctx });
        }
      }
    }
  }
  return cited;
}

/**
 * Tier an id by the strength of its citation evidence.
 *
 * `everLiteral` DOMINATES: once an id is used as data anywhere, its other citations cannot be
 * distinguished from fixture scaffolding, so it drops to 'weak' no matter how it reads elsewhere.
 * This is the filter that removed the measured EI-100 false positive.
 *
 * ⚠ An assertion does NOT override this veto, and that restraint was measured, not assumed.
 * The WI-5332 fix (2026-08-10) stops an assertion from *triggering* the veto — an assertion is
 * not fixture data — but an earlier draft went further and let `hasAssertion` outrank it. Running
 * that draft over the real tree promoted EI-100, the original documented false positive, straight
 * back to `guard`. Two measured shapes defeat any line-scoped rule:
 *
 *   expect(w).toContain('EI-100');                    ← claim.blocked-warning.test.ts:101, where
 *     the id was fed IN five lines earlier by `mockResolvedValue([{ ref: 'EI-100' }])`. The
 *     round-trip is real; it just does not fit on one line, so the subject check cannot see it.
 *
 *   expect(html).not.toContain('EI-100');             ← release-history-integration.test.ts:259,
 *     an assertion of ABSENCE — the id is scrubbed FROM output, the opposite of evidence.
 *
 * The asymmetry decides it: a false negative leaves a fixed item in a lower tier where a human
 * still reads it, while a false positive recommends closing a LIVE item. So affirmative evidence
 * gets an id OUT of the veto's blast radius only when nothing else quotes it as data.
 *
 * @param {{ contexts: Set<string>, inTest: boolean, everLiteral: boolean, hasAssertion?: boolean }} rec
 * @returns {'guard' | 'source-comment' | 'weak'}
 */
export function tierFor(rec) {
  if (rec.everLiteral) return 'weak';
  if (rec.inTest) return 'guard';
  if (rec.contexts.has('comment')) return 'source-comment';
  return 'weak';
}

async function openWorkItems(harness) {
  const client = await connectScriptPg();
  try {
    // Observations dominate the table (~72% of rows) and are reflection notes, not work — they are
    // not "fixed-but-open" candidates in any useful sense.
    const { rows } = await client.query(
      `SELECT feature_id, item_kind, title,
              payload->'_ei'->>'severity' AS severity,
              to_char(to_timestamp(created_ts/1000), 'YYYY-MM-DD') AS created
         FROM harness_shared.work_items
        WHERE harness_slug = $1
          AND status = 'open'
          AND item_kind = ANY($2::text[])
          AND coalesce(payload->>'lane','') <> 'observation'`,
      [harness, FIXED_BUT_OPEN_ITEM_KINDS],
    );
    return rows;
  } finally {
    await client.end();
  }
}

function renderText(report, args) {
  const { counts, candidates, harness } = report;
  const lines = [];
  lines.push('');
  lines.push(`fixed-but-open candidates — harness ${harness}`);
  lines.push('='.repeat(64));
  lines.push(`  open non-observation items : ${counts.openItems}`);
  lines.push(`  ids cited in committed src : ${counts.citedIds}`);
  lines.push(`  CANDIDATES                 : ${counts.candidates}`);
  lines.push('');
  lines.push(`    guard          ${String(counts.byTier.guard).padStart(4)}  cited in a test/guard COMMENT, or ASSERTED against code-produced output`);
  lines.push(`    source-comment ${String(counts.byTier['source-comment']).padStart(4)}  cited in a source COMMENT, never used as data`);
  lines.push(`    weak           ${String(counts.byTier.weak).padStart(4)}  used as a string literal somewhere — likely FIXTURE data (the ⊘ line says which)`);
  lines.push('');

  const shown = candidates.slice(0, args.limit);
  for (const c of shown) {
    const flag = c.citedAsOutstanding ? '  ⚠ cited as STILL-OUTSTANDING — read before closing' : '';
    lines.push(`[${c.tier}] ${c.id}  (${c.item_kind}/${c.severity ?? '-'}, opened ${c.created})${flag}`);
    lines.push(`    ${c.title.slice(0, 96)}`);
    for (const s of c.samples) lines.push(`    ↳ ${s.file}:${s.line}  ${s.text}`);
    // Show the grounds for a demotion. Without this a `weak` verdict arrives beside three
    // strong-looking guard citations with nothing explaining the gap, and the only way to audit
    // it is to re-grep by hand — which is how this tool's own misclassification of WI-5332 went
    // unnoticed. Only meaningful when the veto actually decided the tier.
    if (c.tier === 'weak' && c.vetoedBy) {
      lines.push(`    ⊘ demoted by literal use: ${c.vetoedBy.file}:${c.vetoedBy.line}  ${c.vetoedBy.text}`);
    }
    lines.push('');
  }
  if (candidates.length > shown.length) {
    lines.push(`  … ${candidates.length - shown.length} more (raise --limit, or --json)`);
    lines.push('');
  }

  lines.push('A CITATION IS NOT A VERDICT. Before closing any of these, DATE the fix:');
  lines.push("  cd <owning repo> && git log --format='%h %cI' -G'<string the fix introduced>' -- <path> | tail -1");
  lines.push('⚠ Run that INSIDE the owning submodule — from the superproject it returns a false empty.');
  lines.push('⚠ Use -G (not -S) when searching by a name you did not introduce; -S is blind to rewrites.');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/check-fixed-but-open.mjs [--harness S] [--limit N] [--tier guard|source-comment|weak] [--json]');
    return;
  }

  const cited = scanCitations();
  const items = await openWorkItems(args.harness);

  const candidates = [];
  for (const item of items) {
    const rec = cited.get(item.feature_id);
    if (!rec) continue;
    const tier = tierFor(rec);
    if (args.tier && tier !== args.tier) continue;
    candidates.push({
      id: item.feature_id,
      tier,
      item_kind: item.item_kind,
      severity: item.severity,
      created: item.created,
      title: item.title ?? '',
      // Annotated, never filtered — see CITED_AS_OUTSTANDING_RE.
      citedAsOutstanding: rec.samples.some((s) => CITED_AS_OUTSTANDING_RE.test(s.text)),
      samples: rec.samples,
      // The citation that caused a `weak` verdict, so the demotion is auditable from the JSON
      // alone. null on a non-demoted row. Emitted for every tier because a `guard` row that ALSO
      // has literal use is exactly the ambiguous case a reader may want to eyeball.
      vetoedBy: rec.vetoedBy,
    });
  }

  const rank = (t) => TIERS.indexOf(t);
  candidates.sort((a, b) => rank(a.tier) - rank(b.tier) || a.created.localeCompare(b.created));

  const byTier = { guard: 0, 'source-comment': 0, weak: 0 };
  for (const c of candidates) byTier[c.tier] += 1;

  const report = {
    harness: args.harness,
    counts: {
      openItems: items.length,
      citedIds: cited.size,
      candidates: candidates.length,
      byTier,
    },
    candidates,
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report, args));
}

// Run ONLY when executed directly. Without this guard, importing the module to unit-test the
// classifier would fire main() and open a PG connection as a side effect of the import.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`check-fixed-but-open: ${err?.message ?? err}`);
    process.exit(2);
  });
}
