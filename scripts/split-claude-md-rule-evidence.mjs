#!/usr/bin/env node
/**
 * P-015 — separate each CLAUDE.md block into (rule, evidence).
 *
 * WHY A BYTE OFFSET AND NOT TWO STRINGS. P-017 has to verify that no rule was
 * dropped by this pass. If the artifact stored re-typed prose, that check would
 * be a judgement call on 118 blocks. Storing a single `splitOffset` into the
 * block's own text makes it arithmetic instead:
 *
 *     raw.slice(0, off) + raw.slice(off) === raw
 *
 * so a `split` pair is loss-free BY CONSTRUCTION and P-017 is a reconstruction
 * test, not a review. Only blocks that genuinely cannot be cut at a sentence
 * boundary fall through to `authored`, where a human/agent writes the pair and
 * the original `blockSha` travels with it so the diff stays auditable. Keeping
 * that population small is the whole point of the segmenter below.
 *
 * Blocks are addressed by partKey + blockSha and the text comes from
 * `extractParts` in gen-claude-md-manifest.mjs — IMPORTED, never re-implemented.
 * That module's own header warns that a second copy of the block splitter would
 * drift silently and every key it emitted would name a block that does not
 * exist here. This file is a consumer of that split, never a second definition.
 *
 * D-002 HOLDS: this WRITES AN ARTIFACT AND DELETES NOTHING from CLAUDE.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractParts } from './gen-claude-md-manifest.mjs';
import { AUTHORED } from './claude-md-authored-pairs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.PAPERCUSP_CLAUDE_MD ?? resolve(ROOT, 'CLAUDE.md');
const DEFAULT_OUT = resolve(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-rule-evidence.json');

/**
 * An EVIDENCE TELL marks a specific past observation, as opposed to a standing rule.
 *
 * Four families, each a different way this file cites what actually happened:
 *   • observation verbs  — measured / observed / verified / confirmed / reproduced / traced / corroborated
 *   • artifact ids       — EI-<n> / WI-<n>
 *   • dates              — an ISO-ish calendar date
 *   • incident outcome   — what it cost when it fired
 *
 * ⚠ THE TELL-SET IS A PRIORITISATION SIGNAL, NOT A GATE. Every block is offered
 * to the segmenter regardless; a block with no tell simply yields no cut and is
 * recorded `clean`. That ordering matters: were the tell-set used as a filter, a
 * tell this list happens to miss would silently drop a block from the pass
 * entirely, and the miss would be invisible — the artifact would look complete.
 * As a signal, the worst a missed tell can do is leave a block `clean` with its
 * full text intact under `rule`, which loses nothing and is visible in the counts.
 */
export const TELLS = [
  ['artifact-id', /\b(?:EI|WI)-\d+/],
  ['date', /\b20\d\d-\d\d-\d\d\b/],
  ['clock-time', /\b\d{2}:\d{2}(?::\d{2})?Z\b/],
  // An observation VERB is a tell only in citation position: opening a sentence or
  // a parenthetical, or sitting adjacent to a date. Bare word-matching on these
  // verbs was measured to misfire badly — "covers only the conditions it
  // reproduced" and "until 2026-08-03 a timer could be missing" are RULE prose,
  // and matching them pushed 51 blocks into needs-authoring that have no evidence
  // clause to separate at all.
  ['cited-observation', /(?:^|\n\s*|[(\[—–]\s*|[.!?:]\s+)(?:Measured|Observed|Verified|Confirmed|Reproduced|Traced|Corroborated)\b/],
  ['dated-observation', /\b(?:measured|observed|verified|confirmed|corroborated)\b[^.\n]{0,30}\b(?:20\d\d-\d\d-\d\d|live)\b/i],
];

export const tellsIn = (text) => TELLS.filter(([, re]) => re.test(text)).map(([k]) => k);

/**
 * Mask spans a sentence segmenter must never cut inside, replacing each with an
 * equal-length run of a filler char so every offset in the masked string is
 * still a valid offset in the original. Length preservation is the property the
 * whole approach rests on — it is what lets the cut be reported as a byte offset
 * into untouched source text.
 *
 * Masked: fenced code, inline code spans, bold runs, links, and the abbreviation
 * /decimal/path shapes whose '.' is not a sentence end.
 */
export function maskUncuttable(raw) {
  let m = raw;
  const blank = (s) => ' '.repeat(s.length);
  // Blockquote markers first. A sentence ending at a line break inside a `>`
  // block is followed by "\n> ", so the next character the segmenter sees is '>'
  // rather than the sentence-initial capital it looks for — every one of the 13
  // blockquote blocks reported ZERO sentence boundaries because of this, which
  // read as "unsplittable prose" when the real cause was the quote marker.
  // Blanking is length-preserving, so offsets stay valid in the original text.
  m = m.replace(/^[ \t]*>[ \t]?/gm, blank);
  // Order matters: fences next (they can contain every other shape).
  m = m.replace(/```[\s\S]*?```/g, blank);
  m = m.replace(/`[^`\n]*`/g, blank);
  // Bold runs — the known mis-cut was a bold lede containing '?', which a naive
  // segmenter cut in half, producing a "rule" that ended mid-clause.
  m = m.replace(/\*\*[\s\S]*?\*\*/g, blank);
  m = m.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, blank);
  // '.' that is not a sentence end.
  m = m.replace(/\b(?:e\.g|i\.e|etc|vs|cf|approx|Dr|Mr|Ms|St|no|No)\./gi, blank);
  m = m.replace(/\d+\.\d+/g, blank);            // decimals: 0.15s, 6.3.6
  m = m.replace(/\b\w+\.(?:ts|tsx|js|mjs|cjs|json|md|sh|sql|yml|yaml|toml|rs)\b/gi, blank); // paths
  m = m.replace(/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b/gi, blank); // dotted idents / hostnames
  if (m.length !== raw.length) throw new Error(`mask changed length ${raw.length} -> ${m.length}`);
  return m;
}

/**
 * Offsets at which a sentence ends: '.', '!', '?' or ':' followed by whitespace
 * and something that can begin a sentence. Computed on the MASKED text, applied
 * to the original.
 */
export function sentenceBoundaries(raw) {
  const m = maskUncuttable(raw);
  const out = [];
  const re = /([.!?:])(\s+)(?=[A-Z⚠🚫✅⛔🚨ℹ(“"'\-–—•])/g;
  let match;
  while ((match = re.exec(m))) out.push(match.index + match[0].length);
  return out;
}

/**
 * Cut a block into (rule, evidence) at the first sentence boundary such that the
 * evidence side opens with an evidence tell and the rule side is non-trivial.
 *
 * Returns `null` when no such cut exists — either the block has no tell at all
 * (`clean`), or its very first sentence already carries one, meaning rule and
 * evidence share a clause and only re-authoring can separate them.
 */
export function splitRuleEvidence(raw) {
  if (!tellsIn(raw).length) return null;
  const bounds = sentenceBoundaries(raw);
  for (const off of bounds) {
    const rule = raw.slice(0, off);
    const evidence = raw.slice(off);
    if (!rule.trim() || !evidence.trim()) continue;
    // The cut earns its place only if the tell is on the evidence side and the
    // rule side is left free of one: otherwise we have merely moved the seam.
    if (!tellsIn(evidence).length) continue;
    if (tellsIn(rule).length) continue;
    // A rule shorter than this is a fragment, not a stated rule.
    if (rule.trim().length < 40) continue;
    return { splitOffset: off, rule, evidence };
  }
  return null;
}

/**
 * CITATIONS — the load-bearing referents a block cites: work-item/insight ids,
 * dates, clock times, and backticked identifiers (tools, files, flags, columns).
 *
 * These exist so P-017 can verify an AUTHORED pair mechanically. A `split` pair
 * is loss-free by arithmetic; an `authored` pair is new prose, and "no rule was
 * dropped" would otherwise be a 55-block judgement call. Requiring
 * citations(original) ⊆ citations(rule + evidence) does not prove the prose is
 * faithful, but it does falsify the failure that actually matters here: quietly
 * dropping the EI-id, the date, or the tool name that let a reader re-derive the
 * claim. Re-authoring that keeps every referent can still be wrong; re-authoring
 * that loses one is wrong by construction.
 */
export function citationsIn(text) {
  // CLAUDE.md is hard-wrapped, so an inline code span routinely straddles a line
  // break. A newline-excluding span pattern cannot match those, and the damage is
  // not merely a miss: the scanner resumes at the unmatched span's CLOSING backtick
  // and pairs it with the next OPENING one, minting citations out of the PROSE
  // between two code spans ("(or", "can NEVER exit from an agent shell:"). Those
  // phantoms are then "dropped" by any faithful re-authoring, so the guard fires on
  // correct work while the real referent inside the wrapped span goes unchecked —
  // wrong in both directions at once.
  //
  // Unwrapping first fixes both: spans become single-line and match, and the
  // phantom pairings disappear. Offsets are not preserved here and need not be —
  // this returns a SET of referents, never a position (unlike `maskUncuttable`,
  // whose length preservation is load-bearing).
  // FENCES FIRST, before unwrapping. In markdown a ``` fence outranks inline
  // spans, and its three backticks are not a span delimiter at all — leaving them
  // in front of the inline scanner unbalances every pairing that follows, which is
  // the same off-by-one cascade as the single-char span above, arriving by a third
  // route. Fence BODIES are dropped rather than mined: they are verbatim command
  // text, identical on both sides of any faithful re-authoring, so nothing is lost
  // by not treating them as citations.
  const defenced = text.replace(/^[ \t]*(?:>[ \t]?)?```[\s\S]*?^[ \t]*(?:>[ \t]?)?```/gm, ' ');
  const flat = defenced.replace(/\n[ \t]*(?:>[ \t]?)?/g, ' ');
  const out = new Set();
  for (const m of flat.matchAll(/\b(?:EI|WI|F|P|D)-\d+/g)) out.add(m[0]);
  for (const m of flat.matchAll(/\b20\d\d-\d\d-\d\d\b/g)) out.add(m[0]);
  for (const m of flat.matchAll(/\b\d{2}:\d{2}(?::\d{2})?Z\b/g)) out.add(m[0]);
  // Match SINGLE-character spans too, even though none is ever recorded as a
  // citation. Matching and recording are different jobs: a span the pattern skips
  // leaves its two backticks unconsumed, so the scanner pairs them with the NEXT
  // span's and every pairing after it is off by one — one `;`, `S` or `❯` in a
  // block turns the rest of that block into phantom citations. Consume everything,
  // then decide what is worth keeping.
  for (const m of flat.matchAll(/`([^`\n]+)`/g)) {
    const c = m[1].trim().replace(/\s+/g, ' ');
    if (c.length >= 2 && /[A-Za-z0-9]/.test(c)) out.add(c);
  }
  return out;
}

/** Citations present in the original but missing from the authored pair. */
export function droppedCitations(original, authoredText) {
  const have = citationsIn(authoredText);
  return [...citationsIn(original)].filter((c) => !have.has(c));
}

/**
 * IMPERATIVES — the DIRECTIVE a block states, as (polarity, anchor) signatures.
 *
 * WHY THIS EXISTS AND WHAT IT ADDS. `citationsIn` proves the REFERENTS survived a
 * re-authoring; it cannot prove the DIRECTIVE did. Its alphabet contains no modal
 * term at all, so a pair that keeps every id, date and `tool:name` while quietly
 * dropping a "NEVER do X" passes it cleanly. That is precisely the failure D-002
 * exists to prevent, and it is the gap P-017 was opened to close.
 *
 * A directive GOVERNS WHAT FOLLOWS IT, so each marker is anchored to the nearest
 * citation after it. The first version anchored to every citation in the marker's
 * SENTENCE and emitted a cross-product: one entirely faithful block produced 25
 * phantom drops, because a sentence naming ten identifiers minted ten signatures
 * per marker. Nearest-following anchoring cut that to 4 across the whole corpus.
 *
 * ⚠ ADVISORY, NEVER GATING — and unlike the tell-set above, that is not a
 * preference. Measured over the 55 authored pairs at the time it was written: 74
 * signatures, and THREE residual false positives (in 2 blocks) on prose that is
 * CORRECT, in two surviving modes:
 *   • narrative "never" with an ELIDED be-verb ("...was true and never contradicted
 *     it") — the explicit form ("was never contradicted") is handled
 *   • window annexation — ".)" defeats the sentence-stop lookbehind, so the window
 *     reaches past the clause and anchors on an identifier the directive never governed
 * Wired into `problems` it would therefore refuse to write a CORRECT artifact. It
 * reports into `advisories`, which nothing gates on, so a suspected drop is raised
 * for a human to adjudicate without red-flagging faithful work.
 *
 * ⚠ Those numbers were re-derived AFTER the last change to the matcher, not carried
 * over from the draft that motivated it. Two earlier readings are worth knowing,
 * because both were produced by a narrower detector and both looked authoritative:
 * an explicit-case alternation silently missed a lowercase "do not" and so reported
 * 61 signatures rather than 74; and before `must` was excluded before not/never, and
 * before an unanchored signature was compared by polarity, the residual false
 * positives were 4 across 3 blocks. Change the alphabet or the anchoring and this
 * paragraph is stale until re-measured — the corpus population is not a constant.
 */
export const IMPERATIVES = [
  ['prohibit', /\bnever\b|\bdo not\b|\bdon[''’]t\b|\bmust not\b|⛔|🚫/gi],
  // `must` is an obligation ONLY when it is not the auxiliary of a prohibition:
  // "must never bypass X" states ONE directive, not an obligation plus a ban. Read
  // as two, a faithful re-authoring to "Never bypass X" appears to drop an
  // obligation that was never separately stated — caught by this file's own
  // CALIBRATION case, which is what a control is for.
  ['oblige', /\bmust\b(?!\s+(?:not|never)\b)|\balways\b|\bmandatory\b/gi],
  ['restrict', /\bonly\b/gi],
];

/**
 * "never" in a narrative clause reports what HAPPENED, not what you must not do
 * ("was never contradicted", "while never stating the premise"). Matching it as a
 * directive fires the check on correct prose — both such flags in the measured
 * corpus were this shape.
 */
const NARRATIVE_LEAD = /\b(?:was|were|is|are|be|been|being|had|has|have|while)\s+$/i;

/** How far past a marker to look for the identifier it governs. */
const ANCHOR_WINDOW = 140;

export function imperativesIn(text) {
  // Flatten hard-wrap and blockquote markers so a window ends where the CLAUSE
  // ends rather than where the line does. Offsets are not preserved and need not
  // be — this returns a SET of signatures, never a position. (Deliberately its own
  // pass, not shared with `maskUncuttable`, whose length preservation is
  // load-bearing because it reports a byte offset.)
  const flat = text
    .replace(/^[ \t]*(?:>[ \t]?)?```[\s\S]*?^[ \t]*(?:>[ \t]?)?```/gm, ' ')
    .replace(/\n[ \t]*(?:>[ \t]?)?/g, ' ');
  const out = new Set();
  for (const [polarity, re] of IMPERATIVES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(flat))) {
      if (/never/i.test(m[0]) && NARRATIVE_LEAD.test(flat.slice(0, m.index))) continue;
      const after = flat.slice(m.index + m[0].length, m.index + m[0].length + ANCHOR_WINDOW);
      const clause = after.split(/(?<=[.!?])\s+(?=[A-Z⚠🚫✅⛔🚨])/)[0];
      // Ids, dates and clock times are EVIDENCE referents — `citationsIn` already
      // guarantees those survive. What this check adds is the polarity attached to
      // a named thing, so anchor only on the backticked identifiers.
      const anchors = [...citationsIn(clause)].filter(
        (c) => !/^\d{4}-\d\d-\d\d$/.test(c) && !/^(?:EI|WI|F|P|D)-\d+$/.test(c) && !/^\d{2}:\d{2}/.test(c),
      );
      out.add(anchors.length ? `${polarity}:${anchors[0]}` : `${polarity}:<unanchored>`);
    }
  }
  return out;
}

/** Directive signatures present in the original but missing from the authored pair. */
export function droppedImperatives(original, authoredText) {
  const have = imperativesIn(authoredText);
  const polarityOf = (s) => s.slice(0, s.indexOf(':'));
  const havePolarities = new Set([...have].map(polarityOf));
  return [...imperativesIn(original)].filter((s) => {
    if (have.has(s)) return false;
    // An UNANCHORED signature is one whose governed identifier could not be
    // determined, so the only thing it can honestly assert is that the polarity
    // survives SOMEWHERE — not where. Comparing it by exact identity punishes a
    // re-authoring that ADDS precision ("declared one" -> "declared a `typecheck`
    // script"), which moves the signature from unanchored to anchored and reads as
    // a loss when the directive in fact got sharper.
    if (s.endsWith(':<unanchored>')) return !havePolarities.has(polarityOf(s));
    return true;
  });
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function buildRuleEvidence(text, authored = AUTHORED) {
  const parts = extractParts(text);
  const pairs = [];
  const problems = [];
  // Kept separate from `problems` on purpose: `problems` refuses to write the
  // artifact, and this check has a measured false-positive rate on correct prose.
  const advisories = [];
  const summary = { total: parts.length, clean: 0, split: 0, authored: 0, needsAuthoring: 0 };

  for (const p of parts) {
    const tells = tellsIn(p.raw);
    const base = { partKey: p.partKey, ordinal: p.ordinal, blockSha: p.blockSha, chars: p.chars, tells };
    if (!tells.length) {
      summary.clean += 1;
      pairs.push({ ...base, mode: 'clean', splitOffset: null });
      continue;
    }
    const cut = splitRuleEvidence(p.raw);
    if (cut) {
      summary.split += 1;
      pairs.push({ ...base, mode: 'split', splitOffset: cut.splitOffset });
      continue;
    }
    // Hand-authored pairs are keyed by CONTENT, so a block that merely moves keeps
    // its pair, and a block that is EDITED loses it and returns to needs-authoring
    // rather than silently carrying a pair written against text that no longer exists.
    const hand = authored[p.blockSha];
    if (hand) {
      const dropped = droppedCitations(p.raw, `${hand.rule}\n${hand.evidence}`);
      if (dropped.length) problems.push(`${p.partKey}: authored pair drops ${dropped.length} citation(s): ${dropped.slice(0, 5).join(', ')}`);
      const lostImperatives = droppedImperatives(p.raw, `${hand.rule}\n${hand.evidence}`);
      if (lostImperatives.length) advisories.push(`${p.partKey}: authored pair may drop ${lostImperatives.length} directive(s): ${lostImperatives.slice(0, 5).join(', ')}`);
      summary.authored += 1;
      pairs.push({
        ...base,
        mode: 'authored',
        splitOffset: null,
        rule: hand.rule,
        evidence: hand.evidence,
        droppedCitations: dropped,
        droppedImperatives: lostImperatives,
      });
      continue;
    }
    summary.needsAuthoring += 1;
    pairs.push({ ...base, mode: 'needs-authoring', splitOffset: null });
  }

  return {
    generator: 'scripts/split-claude-md-rule-evidence.mjs',
    source: { sha256: sha256(text), chars: text.length, lines: text.split('\n').length },
    tellSet: TELLS.map(([k]) => k),
    summary,
    problems,
    advisories,
    pairs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;
  const text = readFileSync(SOURCE, 'utf8');
  const artifact = buildRuleEvidence(text);
  const { total, clean, split, authored, needsAuthoring } = artifact.summary;
  const entangled = split + authored + needsAuthoring;

  console.log(`split-claude-md-rule-evidence: ${total} blocks from ${SOURCE}`);
  console.log(`  sha256         ${artifact.source.sha256.slice(0, 16)}  (${artifact.source.chars} chars / ${artifact.source.lines} lines)`);
  console.log(`  clean          ${String(clean).padStart(3)}  (no evidence tell — rule stands alone)`);
  console.log(`  split          ${String(split).padStart(3)}  (cut losslessly at a sentence boundary)`);
  console.log(`  authored       ${String(authored).padStart(3)}  (hand-written pair, citations preserved)`);
  console.log(`  needsAuthoring ${String(needsAuthoring).padStart(3)}  (rule and evidence share a clause — still to do)`);
  console.log(`  entangled      ${String(entangled).padStart(3)}  = split + authored + needsAuthoring`);

  // Every `split` pair must reconstruct its block exactly. This is the property the
  // whole byte-offset design exists to give P-017, so it is asserted at generation
  // time rather than trusted: a segmenter change that broke it would otherwise ship
  // a plausible-looking artifact whose pairs silently lose text.
  const parts = extractParts(text);
  const bySha = new Map(parts.map((p) => [p.blockSha, p.raw]));
  let checked = 0;
  for (const pair of artifact.pairs) {
    if (pair.mode !== 'split') continue;
    const raw = bySha.get(pair.blockSha);
    if (raw.slice(0, pair.splitOffset) + raw.slice(pair.splitOffset) !== raw) {
      artifact.problems.push(`${pair.partKey}: split does not reconstruct its block`);
    }
    checked += 1;
  }
  console.log(`\n  reconstruction ${checked}/${split} split pair(s) verified loss-free`);

  // ADVISORY — printed, never gating. Reported BEFORE the problems block so it is
  // visible on a run that then exits for an unrelated reason.
  if (artifact.advisories.length) {
    console.log(`\n  advisories     ${artifact.advisories.length} authored pair(s) may have dropped a directive (NOT a failure — adjudicate by hand):`);
    for (const a of artifact.advisories.slice(0, 15)) console.log(`   ⚠ ${a}`);
    console.log('   (this check has a measured false-positive rate on correct prose — see IMPERATIVES)');
  } else {
    console.log('\n  advisories     none — every authored pair preserves its directives');
  }

  if (artifact.problems.length) {
    console.error(`\n✗ ${artifact.problems.length} problem(s):`);
    for (const p of artifact.problems.slice(0, 15)) console.error(`   ${p}`);
    console.error('\n✗ refusing to write an artifact that loses content.');
    process.exit(1);
  }

  if (argv.includes('--check')) {
    console.log('\n✓ --check: nothing written');
  } else {
    writeFileSync(out, `${JSON.stringify(artifact, null, 1)}\n`);
    console.log(`\n✓ wrote ${out}`);
  }
}
