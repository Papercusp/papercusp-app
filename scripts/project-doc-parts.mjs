#!/usr/bin/env node
/**
 * P-005 — project `harness_shared.harness_doc_parts` into the per-client files.
 *
 * DIRECTION OF TRUTH. Migration 781 makes this explicit as a COLUMN, not a convention
 * (D-010): when `harness_docs.content_mode='composed'`, the PARTS are canonical and
 * `harness_docs.content` is merely this projector's cached output. So this script is
 * the only thing that may author CLAUDE.md / AGENTS.md, and a hand-edit to either is
 * lost at the next projection — which is what P-006's PreToolUse guard enforces.
 *
 * WHY A FILE EXISTS AT ALL (D-004). Canonical is always PG; a filesystem projection
 * exists IFF there is a reader we do not control. Claude Code and Codex read a file
 * off disk at launch and cannot be taught to query Postgres, so they get one — and
 * each gets its OWN file rather than the AGENTS.md -> CLAUDE.md symlink, which made
 * per-client scoping unrepresentable.
 *
 * THE BUDGET IS ENFORCED HERE, NOT HOPED FOR (D-008). Claude Code warns when a memory
 * file is oversized, and its threshold is COMPUTED, not constant. The formula and its
 * constants are transcribed from the 2.1.226 bundle in `memoryWarningThreshold()`
 * below. D-008 chose a conservative ~42% trim on the explicit understanding that the
 * trim alone is NOT self-sufficient — it is safe only while sessions run at a large
 * context window — and that this projector's rank-and-cap is the actual mitigation.
 * Hence: the output physically cannot exceed the budget. It degrades by dropping the
 * lowest-priority parts and leaving a POINTER to them, and it reports what it cut.
 */
import { readFileSync, writeFileSync, existsSync, lstatSync, unlinkSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectScriptPg } from './lib/pg-url.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The pseudo-section `extractParts()` assigns to blocks above the first `## ` heading.
 * It is a POSITION, not a heading, so the projector must not emit it as one.
 */
export const PREAMBLE = '(preamble)';

/** The heading the spill block is emitted under when the budget forces a cut. */
export const SPILL_SECTION = 'Trimmed to fit this client’s budget';

/**
 * The suffix `load-claude-md-doc-parts.mjs` gives the evidence half of a split block.
 * Declared here rather than imported so composing does not drag the loader (and its
 * manifest/rule-evidence reads) into every consumer of this module; the two are checked
 * against each other by `doc-corpus.test.ts`, so they cannot drift silently.
 */
export const EVIDENCE_SUFFIX = '#evidence';

/** Marker emitted inside evidence rows that preserve pre-compression rule text. */
export const FULL_PRECOMPRESSION_MARKER = '## Full pre-compression rule text (preserved)';

/**
 * Where the composed corpus is written. This is the DB-free subject the doc-claims
 * guards read, and it exists for exactly one reason: those guards are UNIT tests, and
 * the green gate runs `npm run test:affected` with no `--integration`, so a guard that
 * needed Postgres would quietly stop gating the fleet. That is the "migration that
 * greens by weakening a guard" P-004 forbids, so the corpus is projected to a file
 * instead — the same D-004 test the client files pass ("a reader we do not control
 * requires a file on disk"), where the reader is the unit tier.
 */
export const CORPUS_FILE = 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md';

/**
 * Explicit pins for tests that assert live text in a generated client file. The
 * projector is JavaScript, while the pins belong beside the doc-claims tests, so
 * this small JSON manifest is the shared bridge rather than a fragile source-code
 * parser. A pin's `needles` are independent identifying snippets: if any snippet
 * appears in a cut part, the projection cannot safely write that client file.
 */
export const DOC_CLAIM_PINS_FILE = 'packages/operator-core/lib/doc-claims/projection-pins.json';

/**
 * Compare the DB-composed corpus with the committed DB-free subject.
 *
 * The provenance banner's source sha only identifies the CLAUDE.md snapshot from which
 * the rows were initially loaded. A direct edit to a canonical row leaves that sha
 * unchanged, so the live projector must also compare the composed bytes with the file.
 * Keep this pure so the recurrence is testable without Postgres or the working tree.
 */
export function corpusDriftVerdict({ onDisk, composed }) {
  if (onDisk === null) return { ok: false, reason: 'absent' };
  if (onDisk === composed) return { ok: true, reason: 'already-current' };
  return {
    ok: false,
    reason: 'drifted',
    live: sha256(onDisk),
    expected: sha256(composed),
  };
}

/**
 * Deliberately inert: no fenced block, no `npm run`, no grep recipe, no path that the
 * retired-surfaces guard would read as a claim. The banner is part of the text those
 * guards judge, so anything executable-looking here would become a claim the corpus
 * appears to make. Verified: the three guards report identical counters with and
 * without it.
 */
export function corpusBanner({ parts, blocks, sourceSha } = {}) {
  return [
    '<!--',
    '  GENERATED FILE — DO NOT EDIT, and do not treat it as documentation to read.',
    '',
    '  It is the full CLAUDE.md corpus (every part, projected and unprojected alike)',
    '  composed from harness_shared.harness_doc_parts, which is canonical. It exists so',
    '  the doc-claims guards can judge the WHOLE corpus without a database: the client',
    '  files carry only the projected minority, so pointing those guards at CLAUDE.md',
    '  after the cutover would leave them judging a fraction of what they judge today.',
    '',
    '  Written by scripts/project-doc-parts.mjs. Edit the rows, never this file.',
    '',
    '  PROVENANCE — machine-read by doc-corpus.test.ts, which fails if the source sha',
    '  here disagrees with the part manifest. That is the drift alarm: this file, the',
    '  manifest and the rows are three artifacts derived from one CLAUDE.md snapshot,',
    '  and regenerating any one of them alone silently desynchronises the set.',
    `  corpus-parts: ${parts ?? 'unknown'}`,
    `  corpus-blocks: ${blocks ?? 'unknown'}`,
    `  source-sha256: ${sourceSha ?? 'unknown'}`,
    '-->',
  ].join('\n');
}

/** Parse the provenance a corpus file carries. Returns nulls rather than throwing. */
export function readCorpusProvenance(text) {
  const num = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}:\\s*(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const sha = text.match(/^\s*source-sha256:\s*([0-9a-f]{64})\s*$/m);
  return { parts: num('corpus-parts'), blocks: num('corpus-blocks'), sourceSha: sha ? sha[1] : null };
}

/**
 * How many cut parts the spill pointer ENUMERATES before it stops naming them.
 *
 * The cap is load-bearing, not cosmetic. An unbounded list grows with every part cut,
 * so a tighter budget makes the pointer bigger at exactly the moment there is less
 * room for it — and past some point the banner plus the pointer alone exceed the
 * budget and the projector can only refuse. That is a worse degradation than naming
 * fewer parts: a file that fails to generate helps nobody, and the complete cut set
 * stays recoverable from PG either way (it is every projected part whose key does not
 * appear in the file). Bounding it makes the spill block's size O(1), so the refusal
 * below is reserved for a budget too small to hold the banner at all.
 */
export const MAX_SPILL_ENTRIES = 12;

/**
 * Which client file each scope projects into. A part carrying `all` goes to every
 * client; a part carrying a single client is that client's alone. Nothing today
 * diverges — every projected part is `{all}` — which is precisely why the two files
 * must still be generated SEPARATELY: the mechanism has to be exercised before a
 * divergent part exists, or its first use would be its first test.
 */
export const CLIENTS = [
  { client: 'claude', file: 'CLAUDE.md', reader: 'Claude Code' },
  { client: 'codex', file: 'AGENTS.md', reader: 'Codex / OpenAI agents' },
];

/*
 * `part_key` is generated from `target_section` + the first non-blank line of a
 * source block, then truncated to 48 characters. It is useful as a cheap identity
 * witness, but not as a complete re-generation contract: truncation can leave only
 * generic words (or a language marker such as `bash`). Keep the vocabulary
 * conservative so a body that merely contains "the" cannot bless an unrelated
 * replacement.
 */
const IDENTITY_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'bash',
  'before',
  'being',
  'body',
  'can',
  'could',
  'does',
  'docume',
  'doing',
  'each',
  'every',
  'first',
  'fired',
  'from',
  'full',
  'have',
  'here',
  'into',
  'just',
  'more',
  'must',
  'never',
  'only',
  'other',
  'part',
  'parts',
  'read',
  'rule',
  'same',
  'section',
  'should',
  'some',
  'still',
  'that',
  'their',
  'there',
  'these',
  'this',
  'those',
  'under',
  'use',
  'using',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'your',
]);

// Four-character technical tokens are often the only subject text left after key
// truncation. They identify a command/tool family rather than ordinary English prose.
const SHORT_IDENTITY_TOKENS = new Set([
  'dbos',
  'grep',
  'hono',
  'http',
  'json',
  'mcp',
  'node',
  'npm',
  'pgrep',
  'proc',
  'sse',
  'sql',
  'tauri',
  'tsx',
  'uuid',
  'vite',
  'yaml',
  'zero',
]);

/** The same slug normalization used by gen-claude-md-manifest.mjs, kept local to avoid a cycle. */
function identitySlug(value, max = 48) {
  return String(value ?? '')
    .replace(/`|\*\*/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
}

function identityTokens(value) {
  return [
    ...new Set(String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []),
  ].filter(
    (token) =>
      (token.length >= 5 && !IDENTITY_STOPWORDS.has(token)) ||
      SHORT_IDENTITY_TOKENS.has(token),
  );
}

function hasIdentityToken(body, token) {
  const lower = String(body ?? '').toLowerCase();
  // Key tokens can be truncated words (`therefor`) or punctuation-collapsed phrases
  // (`tabviewmode`, `scriptsmutation`). Check both the literal body and the same
  // punctuation-stripped form used to create part keys.
  return lower.includes(token) || identitySlug(lower, Number.MAX_SAFE_INTEGER).includes(token);
}

/**
 * Extract the subject fragment that remains in a generated part key after its
 * target-section prefix. Returns [] when the key does not have the shape this
 * projector itself generates; custom/manual keys are deliberately not guessed.
 */
function partKeyIdentityTokens(part) {
  if (!part || typeof part.part_key !== 'string' || typeof part.target_section !== 'string') return [];
  const sectionSlug = identitySlug(part.target_section, 28);
  if (!sectionSlug) return [];
  const prefix = `${sectionSlug}-`;
  if (!part.part_key.startsWith(prefix)) return [];
  // Duplicate keys receive a numeric suffix during extraction; it is not subject text.
  const subject = part.part_key.slice(prefix.length).replace(/-\d+$/, '');
  return identityTokens(subject);
}

/**
 * Find canonical projected rows whose identity has become internally inconsistent.
 *
 * This is intentionally a conservative guard, not a full natural-language
 * classifier: generated projecting rows must retain at least one discriminating
 * token from the subject fragment in their body, while custom keys, corpus-only
 * prose, tombstones, and `#evidence` rows are not judged by the key/body heuristic.
 * Evidence rows carrying a pre-compression block must still have a live projecting
 * sibling with at least one discriminating content token in common. The function
 * only reports; it never rewrites canonical rows or expands evidence into the
 * client projection.
 *
 * @returns {Array<{part_key: string, code: string, detail: string, tokens?: string[]}>}
 */
export function docPartIdentityProblems(parts) {
  const live = (Array.isArray(parts) ? parts : []).filter(
    (part) => part && part.tombstone !== true,
  );
  const byKey = new Map(
    live
      .filter((part) => typeof part.part_key === 'string')
      .map((part) => [part.part_key, part]),
  );
  const problems = [];

  for (const part of live) {
    if (typeof part.part_key !== 'string' || part.part_key.endsWith(EVIDENCE_SUFFIX)) continue;
    if (!Array.isArray(part.client_scope) || part.client_scope.length === 0) continue;

    const tokens = partKeyIdentityTokens(part);
    if (!tokens.length) continue;
    const body = typeof part.body === 'string' ? part.body : '';
    if (tokens.some((token) => hasIdentityToken(body, token))) continue;

    problems.push({
      part_key: part.part_key,
      code: 'key-body-mismatch',
      detail:
        `projecting body contains none of the discriminating tokens from its key ` +
        `subject (${tokens.map((token) => JSON.stringify(token)).join(', ')})`,
      tokens,
    });
  }

  for (const evidence of live) {
    if (typeof evidence.part_key !== 'string' || !evidence.part_key.endsWith(EVIDENCE_SUFFIX)) continue;
    if (typeof evidence.body !== 'string') continue;
    const markerAt = evidence.body.indexOf(FULL_PRECOMPRESSION_MARKER);
    if (markerAt === -1) continue;

    const baseKey = evidence.part_key.slice(0, -EVIDENCE_SUFFIX.length);
    const sibling = byKey.get(baseKey);
    if (!sibling || !Array.isArray(sibling.client_scope) || sibling.client_scope.length === 0) {
      problems.push({
        part_key: evidence.part_key,
        code: 'orphaned-full-precompression-evidence',
        detail: `full pre-compression evidence has no live projecting sibling ${JSON.stringify(baseKey)}`,
      });
      continue;
    }

    const tokens = identityTokens(evidence.body.slice(markerAt + FULL_PRECOMPRESSION_MARKER.length));
    if (!tokens.length) continue;
    const siblingBody = typeof sibling.body === 'string' ? sibling.body : '';
    if (tokens.some((token) => hasIdentityToken(siblingBody, token))) continue;

    problems.push({
      part_key: evidence.part_key,
      code: 'evidence-not-backed-by-projected-sibling',
      detail:
        `full pre-compression evidence shares no discriminating token with its ` +
        `projecting sibling ${JSON.stringify(baseKey)}`,
      tokens,
    });
  }

  return problems;
}

/**
 * Parse an explicit, compare-and-swap acknowledgement for a generated client file
 * whose useful hand edit has already been moved into the canonical parts.
 *
 * The full live SHA is mandatory: a peer edit after the review changes the bytes and
 * makes the later overwrite refuse again. Client qualification matters too — accepting
 * CLAUDE.md drift must never weaken AGENTS.md's independent guard.
 */
export function parseAcceptedCanonicalizedDrift(argv) {
  const knownClients = new Set(CLIENTS.map((entry) => entry.client));
  const accepted = new Map();
  for (const arg of argv) {
    if (!arg.startsWith("--accept-canonicalized-drift=")) continue;
    const value = arg.slice("--accept-canonicalized-drift=".length);
    const separator = value.indexOf(":");
    const client = separator === -1 ? "" : value.slice(0, separator);
    const sha =
      separator === -1 ? "" : value.slice(separator + 1).toLowerCase();
    if (!knownClients.has(client)) {
      throw new Error(
        `--accept-canonicalized-drift requires a known client (${[...knownClients].join(", ")}); got ${JSON.stringify(client)}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      throw new Error(
        `--accept-canonicalized-drift=${client}:… requires the full 64-character SHA-256 of the reviewed on-disk file`,
      );
    }
    if (accepted.has(client)) {
      throw new Error(
        `--accept-canonicalized-drift was supplied more than once for ${client}`,
      );
    }
    accepted.set(client, sha);
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/**
 * Claude Code's own oversized-memory-file threshold, transcribed from the shipped
 * bundle so this cannot drift into folklore. Verified against version 2.1.226:
 *
 *   function $dn(e = ls()) {
 *     let t = hT(e, u0());
 *     let r = Number.isFinite(t) && t > 0 ? t : nbr;      // nbr = 200000
 *     return Math.max(si_, Math.round(r * ii_ * pk(e)));  // si_ = 40000, ii_ = 0.05
 *   }
 *   function pk(e) { ...; return Bby.has(model) ? 4 : 3 }
 *
 * `pk` is chars-per-token and returns 4 for every model id in the bundle's known set
 * (claude-opus-4-5/4-6, claude-sonnet-4-5/4-6, claude-haiku-4-5, the 3.x family, ...)
 * and 3 for anything it does not recognise. So 3 is the UNRECOGNISED-ID fallback, not
 * a smaller-model case, and every model actually in use here yields 4.
 *
 * Consequences worth stating, because they are the whole reason P-005 exists:
 *   400_000 context, 4 chars/token -> 80_000
 *   200_000 context, 4 chars/token -> 40_000  (the floor, si_)
 *   any context, unrecognised id   -> max(40_000, ctx * 0.05 * 3)
 * The floor means NO configuration ever permits more than the budget without also
 * permitting 40_000, so 40_000 is the smallest threshold this formula can produce.
 */
export const MEMORY_WARN_FLOOR_CHARS = 40_000; // si_
export const MEMORY_WARN_CONTEXT_FRACTION = 0.05; // ii_
export const MEMORY_WARN_DEFAULT_CONTEXT_TOKENS = 200_000; // nbr
export const CHARS_PER_TOKEN_KNOWN_MODEL = 4; // pk() for a recognised model id
export const CHARS_PER_TOKEN_UNKNOWN_MODEL = 3; // pk() fallback

export function memoryWarningThreshold({
  contextTokens = MEMORY_WARN_DEFAULT_CONTEXT_TOKENS,
  charsPerToken = CHARS_PER_TOKEN_KNOWN_MODEL,
} = {}) {
  const ctx = Number.isFinite(contextTokens) && contextTokens > 0
    ? contextTokens
    : MEMORY_WARN_DEFAULT_CONTEXT_TOKENS;
  return Math.max(
    MEMORY_WARN_FLOOR_CHARS,
    Math.round(ctx * MEMORY_WARN_CONTEXT_FRACTION * charsPerToken),
  );
}

/**
 * The budget this projector ACTUALLY enforces — deliberately ABOVE the reader's warning
 * threshold computed by `memoryWarningThreshold()`.
 *
 * [owner 2026-08-26] Raised from 80,000 to 160,000 by owner directive, verbatim:
 * "lets just raise the cap" / "raise it to 160k".
 *
 * State the trade plainly rather than burying it:
 *   - BOUGHT: every rule reaches the agent. At 80,000 the projector was dropping real
 *     repo rules to fit. That is a silent correctness failure — an agent cannot follow a
 *     rule it was never shown, and the dropped rules were invisible to everyone except
 *     whoever happened to read the cut footer.
 *   - PAID: Claude Code emits its oversized-memory warning for CLAUDE.md/AGENTS.md, and
 *     the file costs roughly twice the per-session context it did before.
 *
 * This is safe ONLY because the reader's threshold gates a WARNING, not a truncation:
 * `$dn()` in the 2.1.226 bundle feeds a size warning, and the reader still receives the
 * whole file. If that ever becomes a hard truncation, REVERT THIS CONSTANT — a truncated
 * file drops rules from the tail with no report at all, which is strictly worse than the
 * ranked, reported cut it replaced. That is the falsifier to watch, and it is the reason
 * `memoryWarningThreshold()` stays transcribed above and is still reported beside this
 * number: the headroom against the real reader threshold must stay VISIBLE rather than
 * decay into folklore.
 *
 * The cap remains ENFORCED (D-008) — raising it does not make it a hope. The output still
 * physically cannot exceed it, still degrades by dropping the lowest-priority parts, and
 * still reports what it cut.
 */
export const PROJECTION_BUDGET_CHARS = 160_000;

/** The enforced budget. One definition, shared by the projector and set-doc-part. */
export function projectionBudget() {
  return PROJECTION_BUDGET_CHARS;
}

/**
 * The configurations a projected file could be read under. Reported on every run so
 * the headroom is VISIBLE rather than implied by one number — D-008's failure mode is
 * a file that is comfortably under the threshold of the session that generated it and
 * over the threshold of the session that reads it.
 */
export function budgetMatrix() {
  const rows = [];
  for (const contextTokens of [200_000, 400_000, 1_000_000]) {
    for (const charsPerToken of [CHARS_PER_TOKEN_KNOWN_MODEL, CHARS_PER_TOKEN_UNKNOWN_MODEL]) {
      rows.push({
        contextTokens,
        charsPerToken,
        threshold: memoryWarningThreshold({ contextTokens, charsPerToken }),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Composition (pure — no fs, no db, no clock)
// ---------------------------------------------------------------------------

/** Does this part project into `client`? */
export function partTargetsClient(part, client) {
  const scope = part.client_scope ?? [];
  return scope.includes('all') || scope.includes(client);
}

/**
 * identities-v1 P-022 — the second projection axis: WHO the part is for.
 *
 * `stack_scope` is a list of addressing tokens (`blueprint:<id>` / `slot:<slot>` /
 * `role:<role>` — the grammar lives ONCE, in operator-core's `guide-address.ts`; this
 * script treats tokens as OPAQUE strings). Empty = UNADDRESSED = the part reaches every
 * reader and lives in the default file. Non-empty = the part reaches only a wearer
 * whose expanded stack intersects it — `stack_scope && tokens`, the same OR-semantics
 * `client_scope` has.
 */
export function partIsAddressed(part) {
  return (part.stack_scope ?? []).length > 0;
}

/**
 * Does this part reach `audience`? `audience === null` is the DEFAULT projection — the
 * file every reader gets — so only unaddressed parts qualify; an addressed part is for
 * somebody in particular and never lands in the default file. An audience (a wearer's
 * token list) gets the unaddressed parts PLUS every part addressed to any of its tokens.
 */
export function partReachesAudience(part, audience) {
  if (!partIsAddressed(part)) return true;
  if (audience === null || audience === undefined) return false;
  const scope = part.stack_scope ?? [];
  return scope.some((token) => audience.includes(token));
}

/**
 * The addressed inventory of a part set: per token, the parts that carry it (in read
 * order) and their total size. What the CLI reports so an author can see which audiences
 * a doc currently distinguishes without composing each one.
 */
export function addressedInventory(parts) {
  const byToken = new Map();
  for (const p of [...parts].sort(readOrder)) {
    for (const token of p.stack_scope ?? []) {
      if (!byToken.has(token)) byToken.set(token, { token, parts: [], chars: 0 });
      const entry = byToken.get(token);
      entry.parts.push(p.part_key);
      entry.chars += p.body.length;
    }
  }
  return [...byToken.values()].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

/** Parse `--audience=<token,token,…>` — tokens are opaque here; an empty list is a misuse. */
export function parseAudienceArg(argv) {
  const raw = argv.find((a) => a.startsWith('--audience='))?.slice('--audience='.length);
  if (raw === undefined) return null;
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) throw new Error('--audience needs at least one token, e.g. --audience=blueprint:su.fleet-leader');
  return [...new Set(tokens)].sort();
}

/**
 * Deterministic read order. `ordinal` is the document position and is the only order
 * that matters; `part_key` breaks a tie so two parts sharing an ordinal (a rule and a
 * later-inserted sibling) can never swap between runs. P-012 asserts byte-identical
 * output for unchanged rows, and a nondeterministic sort is the obvious way to fail it.
 */
export function readOrder(a, b) {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.part_key < b.part_key ? -1 : a.part_key > b.part_key ? 1 : 0;
}

/**
 * Cut order — the FIRST part in this order is the first to be dropped when the budget
 * bites. Three keys, each deliberate:
 *   1. project_rank DESC — the declared budget axis (D-008). Rank is assigned when a
 *      part is classified; re-deciding it here would silently override that decision.
 *   2. body length DESC — within one rank, dropping the largest part first retains the
 *      greatest NUMBER of rules per char surrendered.
 *   3. ordinal DESC — a final deterministic tiebreak, cutting from the document tail.
 */
export function cutOrder(a, b) {
  if (a.project_rank !== b.project_rank) return b.project_rank - a.project_rank;
  if (a.body.length !== b.body.length) return b.body.length - a.body.length;
  return b.ordinal - a.ordinal;
}

/**
 * Rank makes invariants the LAST content cut, but "last" is not "never". P-007's
 * accepted 80k budget relied on every invariant surviving; corpus growth eventually
 * crossed that boundary while the projector still exited green (EI-21429056183505097).
 * Keep the detector pure so the refusal has a positive control without a live database.
 */
export function invariantCutKeys(dropped) {
  return dropped.filter((part) => part.kind === 'invariant').map((part) => part.part_key);
}

/**
 * How many chars must be freed elsewhere for each cut invariant to be RETAINED.
 *
 * `invariantCutKeys` above answers WHICH rail was evicted; on its own that sends the
 * author bisecting their own prose to discover BY HOW MUCH, which is the expensive half
 * (EI-21457175960786261). The projector already holds both numbers, so it should say so.
 *
 * The arithmetic is the same one an author would do by hand: a composition that currently
 * omits the part must additionally accommodate its body, so the excess over budget is
 * `composed + body - budget`. It is a FLOOR, not an exact figure — re-including a part can
 * also re-flow its section heading and shrink the spill block, both of which move the true
 * number DOWNWARD. Reporting a floor is the safe direction: acting on it always clears the
 * refusal, whereas an under-estimate would send the author back for a second round, which
 * is the very loop this exists to end.
 */
export function shortfallsForCutInvariants(out, budget) {
  return out.dropped
    .filter((part) => part.kind === 'invariant')
    .map((part) => ({ ...part, shortfall: Math.max(1, out.text.length + part.body.length - budget) }))
    .sort((a, b) => a.shortfall - b.shortfall);
}

/**
 * Return the dropped parts carrying a registered live-doc assertion pin.
 *
 * This is deliberately separate from `invariantCutKeys`: a test may pin a rule
 * whose canonical row is a pointer, recipe, or another future kind. The budget
 * guard protects the consumer (the test), not the row's classification.
 */
export function docClaimCutMatches(dropped, { client, pins }) {
  const applicable = pins.filter((pin) => pin.client === client);
  return dropped.flatMap((part) => {
    const matches = applicable.filter((pin) => pin.needles.some((needle) => part.body.includes(needle)));
    return matches.length ? [{ part_key: part.part_key, pins: matches }] : [];
  });
}

/** Read and validate the checked-in projection-pin manifest used by the CLI. */
export function readDocClaimPins(file = resolve(ROOT, DOC_CLAIM_PINS_FILE)) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || parsed.schema !== 'doc-claim-projection-pins/1' || !Array.isArray(parsed.pins)) {
    throw new Error(`invalid doc-claim projection-pin manifest: ${file}`);
  }
  const clients = new Set(CLIENTS.map((entry) => entry.client));
  const ids = new Set();
  return parsed.pins.map((pin, index) => {
    if (!pin || typeof pin !== 'object') throw new Error(`invalid doc-claim pin at index ${index}`);
    if (typeof pin.id !== 'string' || !pin.id) throw new Error(`doc-claim pin ${index} has no id`);
    if (ids.has(pin.id)) throw new Error(`duplicate doc-claim pin id: ${pin.id}`);
    ids.add(pin.id);
    if (!clients.has(pin.client)) throw new Error(`doc-claim pin ${pin.id} names unknown client: ${pin.client}`);
    if (!Array.isArray(pin.needles) || pin.needles.length === 0 || pin.needles.some((needle) => typeof needle !== 'string' || !needle)) {
      throw new Error(`doc-claim pin ${pin.id} must have non-empty string needles`);
    }
    if (typeof pin.source !== 'string' || !pin.source) throw new Error(`doc-claim pin ${pin.id} has no source`);
    return { id: pin.id, client: pin.client, needles: [...pin.needles], source: pin.source };
  });
}

/** The banner every projected file opens with. */
/**
 * The phrase that identifies a file as OUR OUTPUT rather than anyone's source.
 *
 * Exported because the LOADER imports it to refuse re-ingesting a projection (P-013).
 * Sharing the constant is what keeps the two sides from drifting: an edit to the banner
 * wording cannot silently blind that guard, because there is only one string.
 */
export const PROJECTION_MARKER = 'Projected from Postgres: harness_shared.harness_doc_parts';

export function projectionBanner({ client, file, reader, docId }) {
  return [
    `<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->`,
    `<!-- ${PROJECTION_MARKER} (doc_id=${docId}, client=${client}). -->`,
    ``,
    `> ⚠ **${file} is GENERATED — editing it here does nothing durable.** ${reader} reads this file`,
    `> off disk, which is the only reason it exists (the canonical content is in Postgres:`,
    `> \`harness_shared.harness_doc_parts\`, with \`harness_docs.content_mode='composed'\`). A hand-edit`,
    `> is overwritten by the next projection and is invisible to every other client.`,
    `>`,
    // Both halves name a RUNNABLE command on purpose (WI-39623). This said "edit its
    // PART" for months while no agent-facing write path existed — `dev:pg_query` is
    // read-only and no docs:*/harness_docs:* tool addresses a part — so the instruction
    // named an operation nobody could perform, and the actual practice became hand-rolled
    // UPDATEs outside every guard (which left `author` null, losing who changed a rule).
    `> **To change a rule:** edit its PART, then re-project — both halves are commands:`,
    `> \`npm run set-doc-part -- --part-key <key> --body-file <path> --write\``,
    `> (\`--list <prefix>\` to find the key; dry-run without \`--write\`), then`,
    `> \`node scripts/project-doc-parts.mjs --write\`.`,
    `>`,
    `> Supporting evidence for these rules is deliberately NOT here — it lives in the corpus`,
    `> (\`kind='prose'\` rows, searchable) so a rule reaches the agent without its case history.`,
  ].join('\n');
}

/**
 * Render the spill pointer for parts the budget cut. This is itself a pointer part in
 * the sense D-004 means: the content is not gone, it is one query away, and the file
 * says where. Emitting nothing here would make a budget cut SILENT, which is the one
 * outcome worse than a trimmed file.
 */
export function spillBlock(dropped, { budget, docId, client }) {
  if (!dropped.length) return null;
  const chars = dropped.reduce((a, p) => a + p.body.length, 0);
  const lines = [
    `## ${SPILL_SECTION}`,
    ``,
    `> ⚠ **${dropped.length} part(s) (${chars.toLocaleString('en-US')} chars) did not fit this client's`,
    `> ${budget.toLocaleString('en-US')}-char budget and were cut from this file.** They are NOT deleted and NOT`,
    `> deprecated — they are canonical rows in Postgres, and this list is how you find them:`,
    `>`,
    `> \`\`\`sql`,
    `> SELECT part_key, target_section, body FROM harness_shared.harness_doc_parts`,
    `>  WHERE doc_id = '${docId}' AND tombstone = false AND part_key = ANY(...);`,
    `> \`\`\``,
    `>`,
    `> A rule appearing here means the budget, not a decision, removed it. If one of these`,
    `> matters more than something still above, change its \`project_rank\` — do not re-add it`,
    `> by hand, which the next projection would undo.`,
    ``,
  ];
  for (const p of dropped.slice(0, MAX_SPILL_ENTRIES)) {
    const head = (p.body.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
    const section = p.target_section === PREAMBLE ? '(preamble)' : p.target_section;
    lines.push(`- \`${p.part_key}\` — *${section}* — ${head.slice(0, 110)}${head.length > 110 ? '…' : ''}`);
  }
  if (dropped.length > MAX_SPILL_ENTRIES) {
    lines.push(
      `- …and ${dropped.length - MAX_SPILL_ENTRIES} more. The list is capped so the pointer cannot itself` +
        ` consume the budget; the COMPLETE cut set is every projected part whose \`part_key\` does not` +
        ` appear above in this file, which the query above returns.`,
    );
  }
  return lines.join('\n');
}

/**
 * Assemble the file body from parts already filtered to one client.
 *
 * Headings are emitted HERE and are not parts — `gen-claude-md-manifest.mjs` skips
 * `## ` lines when extracting precisely so that the section structure is derived from
 * `target_section` rather than stored twice and allowed to disagree. A section whose
 * every part was cut therefore loses its heading automatically, because the heading
 * only exists while a surviving part claims it.
 */
export function assemble(parts, { banner = null, spill = null } = {}) {
  const blocks = [];
  if (banner) blocks.push(banner);
  let section = null;
  for (const p of parts) {
    if (p.target_section !== section) {
      section = p.target_section;
      if (section && section !== PREAMBLE) blocks.push(`## ${section}`);
    }
    blocks.push(p.body);
  }
  if (spill) blocks.push(spill);
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Project one client's file, enforcing the budget.
 *
 * The cut loop recomposes after every drop rather than subtracting lengths, because
 * the spill block GROWS with each cut part: a subtractive estimate would undershoot
 * and could still emit an over-budget file, which is the exact outcome D-008 forbids.
 * 116 parts of ~57k chars makes this trivially cheap.
 */
export function projectClient(allParts, { client, docId, file, reader, budget, banner = true, audience = null }) {
  // P-022: `audience` (a wearer's token list) selects the addressed parts that join the
  // unaddressed ones; the default `null` composes the file every reader gets, from the
  // unaddressed parts alone — so an addressed row's existence never changes that file.
  const mine = allParts
    .filter((p) => partTargetsClient(p, client) && partReachesAudience(p, audience))
    .sort(readOrder);
  const head = banner ? projectionBanner({ client, file, reader, docId }) : null;

  let text = assemble(mine, { banner: head });
  if (text.length <= budget) {
    return { text, kept: mine, dropped: [], warnings: danglingProjectionWarnings(mine), budget, overBudget: false };
  }

  const candidates = [...mine].sort(cutOrder);
  let droppedKeys = new Set();
  for (const victim of candidates) {
    // The cascade below can already have taken this part; dropping it again would
    // spend a loop iteration without shrinking the text.
    if (droppedKeys.has(victim.part_key)) continue;
    droppedKeys.add(victim.part_key);
    droppedKeys = cascadeDanglingLedes(mine, droppedKeys);
    const kept = mine.filter((p) => !droppedKeys.has(p.part_key));
    const dropped = mine.filter((p) => droppedKeys.has(p.part_key));
    const spill = spillBlock([...dropped].sort(readOrder), { budget, docId, client });
    text = assemble(kept, { banner: head, spill });
    if (text.length <= budget) {
      const keptInOrder = kept.sort(readOrder);
      return {
        text,
        kept: keptInOrder,
        dropped: [...dropped].sort(readOrder),
        warnings: danglingProjectionWarnings(keptInOrder),
        budget,
        overBudget: false,
      };
    }
  }

  // Every part dropped and still over budget: the banner plus the spill list alone
  // exceed it. Refusing is correct — an over-budget file is the failure this exists
  // to prevent, and silently emitting one would hide it behind a passing run.
  throw new Error(
    `projector cannot fit ${file} within ${budget} chars even with every part dropped ` +
      `(${text.length} chars of banner + spill pointer). The budget is too small to be honoured.`,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Every kept part's body must appear VERBATIM in the output. This is the composition
 * self-check: it catches a join/heading bug that would corrupt or truncate a rule
 * while still producing a plausible-looking file of roughly the right size.
 */
export function verifyBodiesPresent(text, kept) {
  const missing = [];
  for (const p of kept) if (!text.includes(p.body)) missing.push(p.part_key);
  return missing;
}

/**
 * Warn when projection leaves an imperative-looking part dangling at the end of its section.
 *
 * A colon-terminated part is commonly a promise that its next part supplies the payload (for
 * example, a table or a recipe). If the next emitted row changes section — or does not exist —
 * the reader sees the promise and none of the promised content. This is deliberately a warning,
 * not a failed projection: a short section can end in a colon for a legitimate reason, but the
 * shape must be visible at build time instead of silently disappearing.
 */
export function danglingProjectionParts(parts) {
  const ordered = [...parts].sort(readOrder);
  const orphans = [];
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i];
    if (!current.body.trimEnd().endsWith(':')) continue;
    const next = ordered[i + 1];
    if (next && next.target_section === current.target_section) continue;
    orphans.push(current);
  }
  return orphans;
}

export function danglingProjectionWarnings(parts) {
  return danglingProjectionParts(parts).map(
    (current) =>
      `${current.part_key}: emitted part ends with ':' with no following emitted part in section ` +
      `${JSON.stringify(current.target_section)}`,
  );
}

/**
 * Cohesion cascade — a lede must never outlive the list it introduces.
 *
 * `cutOrder` ranks by project_rank DESC, then body length DESC. Within one rank that
 * tiebreak guarantees a SHORT lede is dropped AFTER the LONG list it introduces, so
 * when budget frees up the lede is restored FIRST — alone. The emitted file then
 * carries a requirement whose content is withheld ("…read these first, then act:"
 * followed by nothing), which is strictly worse than the section being absent,
 * because it fails loudly at the reader instead of silently at the projector.
 *
 * `danglingProjectionParts` already DETECTS that state, but its only consumer prints
 * a console warning — nothing stops the write. So detection alone leaves the fault in
 * the file. Cascading the orphan into the drop set stops the projector producing it,
 * and the detector stays as the backstop that proves the cascade worked.
 *
 * Dropping strictly shrinks the emitted text, so the caller's cut loop still
 * terminates. Iterates to a fixed point: dropping a lede can orphan the lede above it.
 */
export function cascadeDanglingLedes(mine, droppedKeys) {
  const keys = new Set(droppedKeys);
  for (;;) {
    const kept = mine.filter((p) => !keys.has(p.part_key));
    const orphans = danglingProjectionParts(kept);
    if (orphans.length === 0) return keys;
    for (const orphan of orphans) keys.add(orphan.part_key);
  }
}

/**
 * May we overwrite what is on disk?
 *
 * The projector reads PG, never the file, so on its own it cannot notice that a peer
 * edited CLAUDE.md after the parts were loaded — those edits would simply be erased.
 * The file is only safe to overwrite when its current bytes are one of the two things
 * we already know about, and the two cases correspond to the two phases of this plan:
 *
 *   • BEFORE cutover the file is hand-authored, and the parts were loaded from exactly
 *     that text — so it must hash to `generated_from_sha`.
 *   • AFTER cutover the file is our own output — so it must hash to `content_hash`,
 *     the cached projection.
 *
 * Anything else means the bytes on disk are neither the source we read nor the output
 * we wrote, i.e. somebody changed them, and overwriting would destroy that change. On
 * this tree CLAUDE.md is edited several times an hour, so this is the expected case,
 * not a hypothetical one. `absent` is safe: there is nothing to lose.
 *
 * ⚠ "OUR OWN OUTPUT" IS PER CLIENT (EI-20055472930397669). One doc row projects into N
 * files, so a single stored hash cannot answer this question for more than one of them.
 * The first version compared EVERY client's file against `content_hash` — the PRIMARY
 * client's cached composition — so AGENTS.md, whose bytes legitimately differ from
 * CLAUDE.md's, could never match and was refused on every subsequent run. The per-client
 * record in `harness_docs.projected_clients` is the answer, and it is why
 * `lastProjectionSha` is the FIRST hash consulted; `contentHash` survives only as the
 * pre-column fallback for the primary client.
 *
 * `nextText` (the bytes we are about to write) is accepted outright when it matches: a
 * write that changes nothing cannot destroy anything, whoever produced the bytes. That
 * is what lets an un-recorded file re-join the steady state instead of needing a
 * backfill — but it is NOT sufficient on its own, and reading it as the fix would be a
 * mistake: the moment a part changes, the next output differs from disk and only the
 * per-client record can distinguish "our last projection" from "a peer's edit".
 */
export function overwriteVerdict({
  onDisk,
  generatedFromSha,
  contentHash,
  lastProjectionSha = null,
  nextText = null,
  acceptedCanonicalizedDriftSha = null,
}) {
  if (onDisk === null) return { ok: true, reason: "absent" };
  const live = sha256(onDisk);
  if (nextText !== null && live === sha256(nextText))
    return { ok: true, reason: "already-current", live };
  if (lastProjectionSha && live === lastProjectionSha)
    return { ok: true, reason: "matches-last-projection", live };
  if (generatedFromSha && live === generatedFromSha)
    return { ok: true, reason: "matches-loaded-source", live };
  if (contentHash && live === contentHash)
    return { ok: true, reason: "matches-cached-composition", live };
  if (
    typeof acceptedCanonicalizedDriftSha === "string" &&
    /^[0-9a-f]{64}$/i.test(acceptedCanonicalizedDriftSha) &&
    live === acceptedCanonicalizedDriftSha.toLowerCase()
  ) {
    return { ok: true, reason: "accepted-canonicalized-drift", live };
  }
  return { ok: false, reason: "drifted", live };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function connect() {
  return connectScriptPg();
}

export async function readProjectedParts(client, docId) {
  const { rows } = await client.query(
    `SELECT part_key, kind, body, ordinal, client_scope, target_section, project_rank, stack_scope
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND tombstone = false AND cardinality(client_scope) > 0
      ORDER BY ordinal, part_key`,
    [WORKSPACE_ID, HARNESS_SLUG, docId],
  );
  return rows;
}

/**
 * Every live part, projected or not — the corpus. Same query as `readProjectedParts`
 * minus the `cardinality(client_scope) > 0` filter, and ordered identically so a rule
 * always precedes its `#evidence` half ('foo' sorts before 'foo#evidence').
 */
export async function readAllParts(client, docId) {
  const { rows } = await client.query(
    `SELECT part_key, kind, body, ordinal, client_scope, target_section, project_rank, stack_scope
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND tombstone = false
      ORDER BY ordinal, part_key`,
    [WORKSPACE_ID, HARNESS_SLUG, docId],
  );
  return rows;
}

/**
 * Compose the whole corpus, closing the (rule, evidence) seam the loader cut.
 *
 * The halves are rejoined with NO separator, because `ruleAndEvidence` guarantees
 * `rule + evidence === raw` by arithmetic for its exact modes — joining them the way
 * `assemble` joins blocks would fabricate a blank line that was never in the source
 * and split one paragraph into two.
 *
 * ⚠ The result is deliberately NOT byte-identical to the hand-authored CLAUDE.md, and
 * no test should assert that it is: P-015 re-authored 55 of the 253 blocks into
 * (rule, evidence) pairs, so 55 blocks carry text that never appeared in the file.
 * P-017 is what verified that separation dropped no rule; identity was given up there,
 * on purpose. What IS asserted is the property that matters here — that the corpus
 * yields at least as many judged claims as the file it replaced (see doc-corpus.test.ts).
 */
export function composeCorpus(allParts, { banner = true, sourceSha = null } = {}) {
  const byKey = new Map(allParts.map((p) => [p.part_key, p]));
  const blocks = [];
  for (const p of allParts) {
    if (p.part_key.endsWith(EVIDENCE_SUFFIX)) continue;
    const evidence = byKey.get(`${p.part_key}${EVIDENCE_SUFFIX}`);
    blocks.push({
      body: p.body + (evidence ? evidence.body : ''),
      target_section: p.target_section,
    });
  }
  const body = assemble(blocks);
  const head = banner ? corpusBanner({ parts: allParts.length, blocks: blocks.length, sourceSha }) : null;
  return { text: head ? `${head}\n\n${body}` : body, blocks: blocks.length, parts: allParts.length };
}

export async function readDocRow(client, docId) {
  const { rows } = await client.query(
    `SELECT content_mode, content, content_hash, generated_from_sha, projected_clients
       FROM harness_shared.harness_docs
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId],
  );
  return rows[0] ?? null;
}

/**
 * Cache the composed output back onto the parent doc row.
 *
 * `content_hash` is the hash of the CACHED CONTENT (its documented meaning), and the
 * sha of the source the parts were loaded from goes in `generated_from_sha`, the
 * column that already means exactly that. P-003's loader wrote the source sha into
 * `content_hash` because `content` was empty at the time; keeping that would leave the
 * two columns meaning different things on different rows.
 */
export async function writeCache(client, docId, text, generatedFromSha) {
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET content = $4, content_hash = $5, generated_from_sha = COALESCE($6, generated_from_sha),
            updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, text, sha256(text), generatedFromSha ?? null],
  );
}

/**
 * Record what we just wrote to each client's file (migration 783).
 *
 * `||` shallow-merges, so a client whose write was REFUSED keeps its previous record
 * instead of being erased by a run that only succeeded for its sibling. That coupling is
 * the compounding half of EI-20055472930397669: the original code gated the single cache
 * write on a GLOBAL `failed` flag, so one client's refusal also threw away the other
 * client's fresh record, and every subsequent run started further behind.
 *
 * Called only after a successful write — a dry run records nothing, because nothing on
 * disk changed.
 */
export function projectionRecord({ file, text }) {
  return { file, sha: sha256(text), chars: text.length, written_at: new Date().toISOString() };
}

export async function writeProjectionRecords(client, docId, records) {
  if (!records || Object.keys(records).length === 0) return;
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET projected_clients = COALESCE(projected_clients, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, JSON.stringify(records)],
  );
}

/** The sha this client's file carried at its last successful projection, or null. */
export function lastProjectionShaFor(doc, client) {
  const rec = doc?.projected_clients?.[client];
  return typeof rec?.sha === 'string' && rec.sha.length === 64 ? rec.sha : null;
}

/**
 * What to pass `writeCache` as `generatedFromSha` — the sha of the SOURCE the parts were
 * loaded from.
 *
 * P-003's loader parked that sha in `content_hash` (there was no `content` yet), so a
 * legacy row needs it moved across exactly once. This is a ONE-TIME migration and must
 * be conditional on the column still being empty: after the first projection
 * `content_hash` holds our OUTPUT, and seeding from it unconditionally would overwrite
 * the real provenance with the previous projection's hash on the very next run — a
 * quiet corruption of the field `overwriteVerdict` trusts to recognise pre-cutover
 * files.
 */
export function sourceShaSeed(doc) {
  if (doc?.generated_from_sha) return null; // already recorded — never re-seed
  return doc?.content_hash || null;
}

/**
 * Artifacts that the frozen green-checkpoint candidate owns for this check.
 *
 * A candidate run must judge the bytes that were committed to the candidate, not
 * re-compose against the mutable operator database. Keep this list explicit: a
 * missing entry is a missing proof surface, not permission to fall back to PG.
 */
export const CANDIDATE_ARTIFACTS = [
  { label: 'CLAUDE.md', path: 'CLAUDE.md' },
  { label: 'AGENTS.md', path: 'AGENTS.md' },
  { label: 'claude-md-corpus.generated.md', path: CORPUS_FILE },
];

/**
 * Read the exact committed candidate blobs without consulting the live checkout or PG.
 *
 * `PAPERCUSP_TEST_RUN_COMMIT` is stamped by the green-checkpoint runner with the
 * candidate it is judging. `git show <candidate>:<path>` is intentionally used instead
 * of readFileSync: a repair process can have a mutable working tree around the candidate,
 * but the gate's subject is the committed artifact. Missing, empty, or unreadable blobs
 * fail closed so a broken candidate cannot turn the no-DB branch into a false green.
 */
export function readCommittedCandidateArtifacts({
  commit,
  root = ROOT,
  runGit = spawnSync,
} = {}) {
  const candidate = typeof commit === 'string' ? commit.trim() : '';
  if (!candidate) {
    return { ok: false, reason: 'missing-commit', commit: candidate, artifacts: [] };
  }

  const artifacts = [];
  for (const artifact of CANDIDATE_ARTIFACTS) {
    const ref = `${candidate}:${artifact.path}`;
    let result;
    try {
      result = runGit(
        'git',
        ['show', '--format=', '--no-ext-diff', '--end-of-options', ref],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      return {
        ok: false,
        reason: 'unreadable',
        commit: candidate,
        artifact,
        detail: error instanceof Error ? error.message : String(error),
        artifacts,
      };
    }

    const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
    if (result?.error || result?.status !== 0 || stdout.length === 0) {
      return {
        ok: false,
        reason: result?.error || result?.status !== 0 ? 'unreadable' : 'empty',
        commit: candidate,
        artifact,
        detail:
          result?.error?.message ||
          stderr ||
          (result?.status === null ? 'git show terminated without an exit status' : `git show exited ${result?.status}`),
        artifacts,
      };
    }
    artifacts.push({
      ...artifact,
      bytes: Buffer.byteLength(stdout, 'utf8'),
      sha256: sha256(stdout),
    });
  }
  return { ok: true, reason: 'committed-artifacts-readable', commit: candidate, artifacts };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fmt(n) {
  return n.toLocaleString('en-US');
}

export const HELP_TEXT = `Usage:
  node scripts/project-doc-parts.mjs [options]

Project the canonical harness_shared.harness_doc_parts rows into CLAUDE.md and
AGENTS.md. With no write flag, the command only checks and reports the projection.

Options:
  --write                                      write client projections and cache
  --write-corpus                               write the DB-free corpus projection
  --doc-id=<id>                                document id (default: claude-md)
  --context-tokens=<count>                     context window used for the budget
  --chars-per-token=<count>                    budget chars/token (default: 4)
  --accept-canonicalized-drift=<client>:<sha>  acknowledge reviewed file drift
  --audience=<token,…>                         PREVIEW the guide a wearer whose stack
                                               expands to these tokens receives
                                               (blueprint:<id> | slot:<slot> | role:<role>);
                                               prints the composition per client, writes
                                               nothing — add --audience-out=<dir> to write
                                               <dir>/<client file> for inspection
  -h, --help                                   show this help and exit

The default CLAUDE.md / AGENTS.md are composed from UNADDRESSED parts only (empty
stack_scope). An addressed part (identities-v1 P-022) reaches a launch whose stack
matches one of its tokens — spliced by role-launch-spec at launch, never written to
the repo root — and this command reports that inventory on every run.

Examples:
  node scripts/project-doc-parts.mjs
  node scripts/project-doc-parts.mjs --write
  node scripts/project-doc-parts.mjs --write-corpus
  node scripts/project-doc-parts.mjs --audience=blueprint:su.fleet-leader,slot:autonomy`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const write = argv.includes('--write');
  const writeCorpus = argv.includes('--write-corpus');
  let acceptedCanonicalizedDrift;
  try {
    acceptedCanonicalizedDrift = parseAcceptedCanonicalizedDrift(argv);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (acceptedCanonicalizedDrift.size > 0 && !write) {
    console.error(
      "✗ --accept-canonicalized-drift is meaningful only with --write.",
    );
    process.exit(2);
  }
  // P-022: an audience PREVIEW is a dry read — never combined with a write, so a preview
  // can never be mistaken for (or accidentally become) the default file on disk.
  let audience = null;
  try {
    audience = parseAudienceArg(argv);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const audienceOut = argv.find((a) => a.startsWith('--audience-out='))?.slice('--audience-out='.length) ?? null;
  if (audience && (write || writeCorpus)) {
    console.error('✗ --audience is a preview and cannot be combined with --write / --write-corpus.');
    process.exit(2);
  }
  if (audienceOut && !audience) {
    console.error('✗ --audience-out needs --audience=<token,…>.');
    process.exit(2);
  }
  const docId = (argv.find((a) => a.startsWith('--doc-id='))?.split('=')[1]) ?? 'claude-md';
  const contextTokens = Number(argv.find((a) => a.startsWith('--context-tokens='))?.split('=')[1] ?? 400_000);
  const charsPerToken = Number(
    argv.find((a) => a.startsWith('--chars-per-token='))?.split('=')[1] ?? CHARS_PER_TOKEN_KNOWN_MODEL,
  );
  const budgetOverride = Number(argv.find((a) => a.startsWith('--budget-chars='))?.split('=')[1] ?? NaN);
  const budget = Number.isFinite(budgetOverride) && budgetOverride > 0
    ? budgetOverride
    : projectionBudget();

  // A frozen green-checkpoint candidate is immutable. Comparing its committed
  // artifacts with live PG is not a consistency check: it compares two different
  // moments and can flip solely because another agent edited a canonical row after
  // the candidate was cut. Resolve the exact candidate blobs and stop before the
  // first connect() call. Write modes are refused rather than degraded because this
  // branch must never turn a candidate check into a silent no-op mutation.
  const candidateCommit = process.env.PAPERCUSP_TEST_RUN_COMMIT?.trim() ?? '';
  if (process.env.GREEN_CHECKPOINT === '1' && candidateCommit) {
    if (write || writeCorpus || audience || audienceOut) {
      console.error(
        '✗ candidate artifact checks are read-only; --write, --write-corpus, and --audience are not allowed in a frozen candidate run.',
      );
      process.exit(2);
    }
    const candidate = readCommittedCandidateArtifacts({ commit: candidateCommit });
    console.log(`project-doc-parts: frozen candidate ${candidateCommit} (GREEN_CHECKPOINT=1)`);
    if (!candidate.ok) {
      console.error(
        `✗ candidate artifact check failed: ${candidate.artifact?.path ?? 'candidate commit'} ` +
          `is ${candidate.reason}${candidate.detail ? ` (${candidate.detail})` : ''}.`,
      );
      console.error('  Refusing to consult live Postgres for a frozen candidate.');
      process.exit(1);
    }
    for (const artifact of candidate.artifacts) {
      console.log(`  ${artifact.path}  ${fmt(artifact.bytes)} bytes — committed ${artifact.sha256.slice(0, 16)}`);
    }
    console.log('  ✓ frozen candidate artifacts are readable; no live Postgres read performed.');
    process.exit(0);
  }

  // The reader's own threshold, kept separate from the budget we enforce so the gap
  // between them is reported rather than assumed. See PROJECTION_BUDGET_CHARS.
  const readerWarnThreshold = memoryWarningThreshold({ contextTokens, charsPerToken });
  let docClaimPins;
  try {
    docClaimPins = readDocClaimPins();
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // ── no-DB degrade, CHECK PATH ONLY ───────────────────────────────────────
  // `gen:client-docs:check` is this file with no flags, and until EI-20272515693397454
  // it ran on NO blocking path: the only thing that would notice a hand-edit to the
  // generated CLAUDE.md/AGENTS.md was an agent happening to run the projector, which is
  // how one jam sat undetected for four days. Wiring it as a repo-wide guard is what
  // closes that, and this branch is the precondition — `connect()` sat OUTSIDE the try,
  // so an unreachable Postgres exited non-zero with a stack trace, and registering it
  // would have failed EVERY off-box run and taught the fleet to ignore the leg. Same
  // reasoning, and same shape, as the sibling `project-authored-docs.ts --check`.
  //
  // ⚠ DELIBERATELY NOT extended to --write / --write-corpus. Those MUTATE the tree, and
  // a write that silently no-ops because its database was unreachable is worse than a
  // loud failure: the caller believes the files were projected when nothing was. A
  // skipped CHECK under-reports drift for one run; a skipped WRITE corrupts the premise
  // every later run is judged against.
  let client;
  try {
    client = await connect();
  } catch (err) {
    if (!write && !writeCorpus) {
      console.log(
        `project-doc-parts: SKIPPED — Postgres unreachable, so projection drift cannot be measured here.\n` +
          `  This is NOT a pass: nothing was checked. Re-run where the operator DB is reachable.\n` +
          `  reason: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(0);
    }
    throw err;
  }
  let failed = false;
  try {
    const doc = await readDocRow(client, docId);
    if (!doc) {
      console.error(`✗ no harness_docs row for ${WORKSPACE_ID}/${HARNESS_SLUG}/${docId} — run the loader first.`);
      process.exit(1);
    }
    if (doc.content_mode !== 'composed') {
      console.error(
        `✗ ${docId} is content_mode='${doc.content_mode}', so its CONTENT is canonical and the parts are` +
          ` derived. Projecting would overwrite the authored source with a composition of derived rows.`,
      );
      process.exit(1);
    }

    const parts = await readProjectedParts(client, docId);
    console.log(`project-doc-parts: ${WORKSPACE_ID}/${HARNESS_SLUG}/${docId}`);
    console.log(`  parts          ${parts.length} projected (${fmt(parts.reduce((a, p) => a + p.body.length, 0))} chars of bodies)`);

    // ── P-022: the addressed inventory ───────────────────────────────────────
    // Reported on EVERY run, because an addressed part is invisible in the default
    // files by design: without this line the only way to learn a doc distinguishes
    // audiences would be to launch as each one.
    const addressed = parts.filter(partIsAddressed);
    const inventory = addressedInventory(addressed);
    if (addressed.length === 0) {
      console.log('  addressed      none — every projected part is unaddressed (stack_scope empty), so the default files carry all of them');
    } else {
      console.log(
        `  addressed      ${addressed.length} part(s) (${fmt(addressed.reduce((a, p) => a + p.body.length, 0))} chars) ` +
          `reach ONLY a matching stack — they are NOT in the default files below:`,
      );
      for (const entry of inventory) {
        console.log(`    ${entry.token.padEnd(36)} ${String(entry.parts.length).padStart(3)} part(s)  ${fmt(entry.chars).padStart(7)} chars  ${entry.parts.slice(0, 4).join(', ')}${entry.parts.length > 4 ? ` (+${entry.parts.length - 4})` : ''}`);
      }
    }

    // ── P-022: audience preview ──────────────────────────────────────────────
    // `--audience=<tokens>` composes what a wearer whose stack expands to those tokens
    // would receive: the unaddressed parts PLUS the parts addressed to any token. The
    // SAME projectClient the default files use, so the preview cannot drift from the
    // launch-time composition's part selection (the launch seam adds the addressed
    // sections after the default file; here they compose in document order — the
    // preview answers "which parts, how large", not the exact launch bytes).
    if (audience) {
      console.log(`\n  audience preview — tokens: ${audience.join(', ')}`);
      const reached = addressed.filter((p) => partReachesAudience(p, audience));
      if (reached.length === 0) {
        console.log('    ⓘ no addressed part matches these tokens — this audience receives exactly the default files');
      }
      for (const spec of CLIENTS) {
        const out = projectClient(parts, { ...spec, docId, budget, audience });
        const joined = out.kept.filter(partIsAddressed).map((p) => p.part_key);
        console.log(`    ${spec.file.padEnd(10)} ${fmt(out.text.length).padStart(7)} chars — ${out.kept.length} part(s), ${joined.length} addressed joined${joined.length ? `: ${joined.join(', ')}` : ''}${out.dropped.length ? `; ${out.dropped.length} cut by budget` : ''}`);
        if (audienceOut) {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(audienceOut, { recursive: true });
          const target = resolve(audienceOut, spec.file);
          writeFileSync(target, out.text, 'utf8');
          console.log(`               wrote ${target}`);
        }
      }
      console.log('\n  ✓ audience preview — nothing projected. The default files are unaffected by addressed parts.');
      await client.end();
      process.exit(failed ? 1 : 0);
    }

    // ── the corpus ───────────────────────────────────────────────────────────
    // Written independently of --write, and that separation is deliberate: D-014
    // gates overwriting the CLIENT files (which would erase 108k of prose every
    // agent reads) behind P-004. This file is NEW and nothing reads it yet, so
    // writing it destroys nothing — and P-004 cannot land without it, since it is
    // the location the doc-claims guards are being re-pointed at.
    const allParts = await readAllParts(client, docId);
    const identityProblems = docPartIdentityProblems(allParts);
    const canonicalRowsSafe = identityProblems.length === 0;
    if (identityProblems.length) {
      failed = true;
      console.error(
        `\n  ✗ DOC-PART IDENTITY REFUSAL: ${identityProblems.length} canonical row(s) ` +
          `do not agree with their generated key/body identity.`,
      );
      for (const problem of identityProblems) {
        console.error(`    ${problem.part_key} [${problem.code}] ${problem.detail}`);
      }
    }
    const corpus = composeCorpus(allParts, { sourceSha: doc.generated_from_sha ?? doc.content_hash ?? null });
    const corpusPath = resolve(ROOT, CORPUS_FILE);
    const corpusOnDisk = existsSync(corpusPath) ? readFileSync(corpusPath, 'utf8') : null;
    const corpusVerdict = corpusDriftVerdict({ onDisk: corpusOnDisk, composed: corpus.text });
    console.log(`\n  ${CORPUS_FILE}`);
    console.log(
      `    composed     ${fmt(corpus.text.length)} chars — ${corpus.blocks} block(s) from ${allParts.length} part(s)` +
        ` (${allParts.filter((p) => !p.client_scope.length).length} unprojected)`,
    );
    if (corpusOnDisk === null) console.log('    on disk      absent');
    else console.log(`    on disk      ${fmt(corpusOnDisk.length)} chars — ${corpusVerdict.ok ? 'IDENTICAL ✓' : 'DIFFERS'}`);
    if (!write && !writeCorpus && !corpusVerdict.ok) {
      failed = true;
      if (corpusVerdict.reason === 'absent') {
        console.error(`    ✗ CHECK: ${CORPUS_FILE} is absent; the canonical rows were not measured against a committed subject.`);
      } else {
        console.error(
          `    ✗ CHECK: ${CORPUS_FILE} differs from the canonical row composition ` +
          `(live ${corpusVerdict.live.slice(0, 16)}, expected ${corpusVerdict.expected.slice(0, 16)}).`,
        );
      }
      console.error(
        `      The source sha identifies the original CLAUDE.md load only; this byte comparison catches direct row edits too. ` +
        `Re-run with --write-corpus after reviewing the canonical rows.`,
      );
    }
    if ((write || writeCorpus) && canonicalRowsSafe) {
      writeFileSync(corpusPath, corpus.text, 'utf8');
      console.log(`    ✓ wrote ${CORPUS_FILE}`);
    } else if (write || writeCorpus) {
      console.error(`    ✗ NOT writing ${CORPUS_FILE}: canonical doc-part identity check failed.`);
    }

    console.log(`  budget         ${fmt(budget)} chars  (context ${fmt(contextTokens)} × ${MEMORY_WARN_CONTEXT_FRACTION} × ${charsPerToken} chars/token, floor ${fmt(MEMORY_WARN_FLOOR_CHARS)})`);

    /** Per-client projection records for this run — see writeProjectionRecords. */
    const records = {};
    let primaryText = null;

    for (const spec of CLIENTS) {
      const out = projectClient(parts, { ...spec, docId, budget });
      const invariantCuts = invariantCutKeys(out.dropped);
      const docClaimCuts = docClaimCutMatches(out.dropped, { client: spec.client, pins: docClaimPins });
      const path = resolve(ROOT, spec.file);
      const missing = verifyBodiesPresent(out.text, out.kept);
      const onDisk = existsSync(path) && !lstatSync(path).isSymbolicLink() ? readFileSync(path, 'utf8') : null;
      const isSymlink = existsSync(path) && lstatSync(path).isSymbolicLink();

      console.log(`\n  ${spec.file}  (client=${spec.client})`);
      console.log(`    composed     ${fmt(out.text.length)} chars — ${out.kept.length} part(s) kept, ${out.dropped.length} cut by budget`);
      console.log(`    headroom     ${fmt(budget - out.text.length)} chars under the ${fmt(budget)}-char budget`);
      if (out.text.length > readerWarnThreshold) {
        console.log(
          `    reader       OVER the ${fmt(readerWarnThreshold)}-char warn threshold by ${fmt(out.text.length - readerWarnThreshold)}` +
          ` — ${spec.reader} will flag this file as oversized (advisory: it still reads the whole file)`,
        );
      }
      if (isSymlink) console.log(`    on disk      SYMLINK -> ${readlinkSync(path)} (retired by --write)`);
      else if (onDisk === null) console.log('    on disk      absent');
      else console.log(`    on disk      ${fmt(onDisk.length)} chars — ${onDisk === out.text ? 'IDENTICAL ✓' : 'DIFFERS'}`);

      if (missing.length) {
        failed = true;
        console.error(`    ✗ ${missing.length} kept part(s) missing from the composed output: ${missing.slice(0, 5).join(', ')}`);
      }
      if (out.dropped.length) {
        console.log(`    ⚠ cut: ${out.dropped.map((d) => d.part_key).slice(0, 8).join(', ')}${out.dropped.length > 8 ? ` (+${out.dropped.length - 8})` : ''}`);
      }
      if (invariantCuts.length) {
        failed = true;
        console.error(
          `    ✗ SAFETY REFUSAL: the budget would cut ${invariantCuts.length} invariant(s): ` +
            `${invariantCuts.join(', ')}. Split evidence out of those canonical rows or ` +
          `reduce other invariant prose; never green a projection that silently omits a safety rail.`,
        );
        // Name the SHORTFALL, not just the victim. Without this the author knows only
        // WHICH rail was evicted, and the only way to find out by how much is to bisect
        // their own prose against repeated runs — measured at roughly an hour in
        // EI-21457175960786261, for a number the projector already holds. The victim is
        // also typically unrelated to the part being edited (cutOrder is project_rank DESC
        // then body-length DESC, so the LARGEST equal-rank invariant goes first), which is
        // exactly why "trim what you just added until it fits" is such a poor strategy.
        for (const part of shortfallsForCutInvariants(out, budget)) {
          console.error(
            `      → free at least ${fmt(part.shortfall)} char(s) elsewhere to keep ` +
              `\`${part.part_key}\` (${fmt(part.body.length)} chars).`,
          );
        }
      }
      if (docClaimCuts.length) {
        failed = true;
        console.error(
          `    ✗ DOC-CLAIM PIN REFUSAL: the budget would cut ${docClaimCuts.length} part(s) carrying ` +
            `live assertions for ${spec.client}:`,
        );
        for (const cut of docClaimCuts) {
          for (const pin of cut.pins) {
            console.error(`      ${cut.part_key} carries ${pin.id} (${pin.source}) via ${pin.needles.map((needle) => JSON.stringify(needle)).join(', ')}`);
          }
        }
      }
      for (const warning of out.warnings) console.warn(`    ⚠ projection warning: ${warning}`);

      // A symlink has no content of its own to protect — retiring it destroys nothing,
      // because its target is the OTHER client's file, which is written separately.
      //
      // `contentHash` is offered ONLY to the primary client, because that is the only
      // client it describes (it is the hash of the cached `content`, which is the
      // primary's composition). Offering it to every client is precisely
      // EI-20055472930397669 — it can never match a second client's bytes, so that
      // client was refused forever.
      const isPrimary = spec.client === CLIENTS[0].client;
      const verdict = isSymlink
        ? { ok: true, reason: "symlink" }
        : overwriteVerdict({
            onDisk,
            generatedFromSha: doc.generated_from_sha,
            contentHash: isPrimary ? doc.content_hash : null,
            lastProjectionSha: lastProjectionShaFor(doc, spec.client),
            nextText: out.text,
            acceptedCanonicalizedDriftSha:
              acceptedCanonicalizedDrift.get(spec.client) ?? null,
          });
      if (!verdict.ok) {
        const expected = [
          lastProjectionShaFor(doc, spec.client) && `last ${spec.client} projection ${lastProjectionShaFor(doc, spec.client).slice(0, 16)}`,
          doc.generated_from_sha && `loaded-from ${String(doc.generated_from_sha).slice(0, 16)}`,
          isPrimary && doc.content_hash && `cached composition ${String(doc.content_hash).slice(0, 16)}`,
        ].filter(Boolean).join(', ') || 'nothing on record';
        console.error(
          `    ✗ REFUSING to overwrite ${spec.file}: on-disk bytes are neither the source the parts were\n` +
            `      loaded from nor a projection we wrote — somebody edited it (live ${verdict.live.slice(0, 16)};\n` +
            `      on record: ${expected}).\n` +
            `      Writing would erase that edit, so this refusal is correct — RESOLVE IT BY HAND:\n` +
            `      diff the file against the parts, move anything worth keeping INTO the parts\n` +
            `      (harness_shared.harness_doc_parts), then re-run this projector.\n` +
            `      If canonicalization changes the projected budget/cut set, explicitly bind the\n` +
            `      reviewed bytes with --accept-canonicalized-drift=${spec.client}:${verdict.live}\n` +
            `      on the --write retry. The full SHA is a compare-and-swap guard: any later peer edit\n` +
            `      changes it and makes the overwrite refuse again.\n` +
            `      ⛔ Do NOT "fix" this by re-running the loader over the file. Post-cutover this\n` +
            `         file is our OUTPUT and carries only the projected subset, so re-ingesting it\n` +
            `         TOMBSTONES every unprojected prose part — the whole corpus. The loader now\n` +
            `         refuses that (P-013), and the refusal is the guard, not an obstacle.`,
        );
        failed = true;
      } else if (missing.length) {
        // The composition self-check failed above. Writing anyway would put a file on
        // disk that is missing a rule the rows carry — exactly what verifyBodiesPresent
        // exists to catch — and a non-zero exit does not un-write a file.
        console.error(`    ✗ NOT writing ${spec.file}: the composition self-check above failed.`);
      } else if (invariantCuts.length) {
        console.error(`    ✗ NOT writing ${spec.file}: the invariant-cut safety check above failed.`);
      } else if (docClaimCuts.length) {
        console.error(`    ✗ NOT writing ${spec.file}: the doc-claim pin safety check above failed.`);
      } else if (write && !canonicalRowsSafe) {
        console.error(`    ✗ NOT writing ${spec.file}: canonical doc-part identity check failed.`);
      } else if (write) {
        // The symlink is retired here, not by hand, so each client genuinely owns its
        // file. Unlinking first matters: writeFileSync THROUGH a symlink would write
        // the other client's file instead.
        if (isSymlink) unlinkSync(path);
        writeFileSync(path, out.text, 'utf8');
        records[spec.client] = projectionRecord({ file: spec.file, text: out.text });
        if (isPrimary) primaryText = out.text;
        console.log(`    ✓ wrote ${spec.file}  (${verdict.reason})`);
      } else {
        // Reported on a dry run too, and deliberately: the verdict is the interesting
        // half of `--check`. Without it a dry run cannot distinguish "this file would be
        // updated" from "this file would be REFUSED", which is exactly the state
        // EI-20055472930397669 sat in undetected — and it makes the guard falsifiable
        // against the live database with no write.
        console.log(`    overwrite    allowed (${verdict.reason}) — dry run, not written`);
      }
    }

    if (write && canonicalRowsSafe) {
      // Per client, and merged — so a client that was refused keeps its old record
      // rather than having it dropped by its sibling's successful run. Gating this on a
      // GLOBAL failure flag is what made the original drift COMPOUND: one refusal threw
      // away the other file's fresh record too, so the next run started further behind.
      await writeProjectionRecords(client, docId, records);
      if (Object.keys(records).length) {
        console.log(`\n  ✓ recorded ${Object.keys(records).length} client projection(s) on harness_docs.projected_clients`);
      }
      // Only the primary client's composition is cached in `content`; AGENTS.md is a
      // second projection of the same parts, not a second document.
      if (primaryText !== null) {
        await writeCache(client, docId, primaryText, sourceShaSeed(doc));
        console.log(`  ✓ cached the ${CLIENTS[0].file} composition on harness_docs.content`);
      }
    } else if (write) {
      console.error(`\n  ✗ NOT recording projection metadata/cache: canonical doc-part identity check failed.`);
    }

    if (!write) {
      console.log('\n  budget matrix (a file must fit the SMALLEST threshold it may be read under):');
      for (const r of budgetMatrix()) {
        console.log(`    ${fmt(r.contextTokens).padStart(9)} ctx × ${r.charsPerToken} chars/token -> ${fmt(r.threshold).padStart(7)}`);
      }
      console.log('\n  ✓ dry run — nothing written. Re-run with --write to project.');
    }
  } finally {
    await client.end();
  }
  if (write && !failed && !argv.includes('--no-verify')) {
    failed = !verifyDocClaims();
  }
  process.exit(failed ? 1 : 0);
}

/**
 * Run the doc-claims guards against the corpus this script just regenerated.
 *
 * WHY HERE, and nowhere else on the authoring path (WI-10001827).
 *
 * The doc-claims guards pin LITERAL PROSE from these same parts — their subject is
 * `packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md` (and, for some,
 * the projected CLAUDE.md / AGENTS.md), i.e. exactly the files written above. An edit that
 * compresses a part can therefore delete a rule a guard requires, and NOTHING else on the
 * path can see it:
 *
 *   - `lint:launch-prose-budget` measures BYTES ONLY. During the incident it stayed green on
 *     all eight surfaces while seven doc-claim files were red — a deleted rule makes a byte
 *     budget MORE satisfied, not less, so that gate reports the damage as progress.
 *   - `set-doc-part` prints a diff, but no reader can tell from a diff which clause a guard
 *     pins; two of the losses were inside paragraphs that still read as coherent prose.
 *   - `test:affected` selects by CHANGED PATHS, and a doc-part edit changes a Postgres ROW,
 *     not a file. The radius does not reach `lib/doc-claims/` until this projection is
 *     written AND swept into a commit — by which point the red is in the gate's candidate
 *     and `main` cannot promote, for the whole fleet rather than for the editing lane.
 *
 * The projection is the first moment the guards' real subject exists on disk, which makes it
 * the only point where the whole class is catchable BEFORE the sweep. ~40s on an operation
 * that runs a handful of times a day.
 *
 * Escape hatches, both deliberate: `--no-verify` for a bootstrap/repair projection that must
 * land while the corpus is knowingly mid-repair, and PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY=1 for a
 * non-interactive caller (a test that invokes this script) that must not recurse into Vitest.
 * A MISSING or unrunnable Vitest is reported as NOT VERIFIED and fails, rather than passing
 * quietly — an unrun guard suite and a green one are the same silence, which is the precise
 * failure this function exists to end.
 */
function verifyDocClaims() {
  if (process.env.PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY === '1') {
    console.log('\n  ⚠ doc-claims verification SKIPPED (PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY=1) — NOT verified.');
    return true;
  }
  console.log('\n  running doc-claims guards against the regenerated corpus…');
  const res = spawnSync(
    'npx',
    ['vitest', 'run', '--root', 'packages/operator-core', '--config', 'vitest.config.ts', 'lib/doc-claims/'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY: '1' } },
  );
  if (res.error || typeof res.status !== 'number') {
    console.error(`  ✗ doc-claims guards could NOT be run (${res.error?.message ?? 'no exit status'}).`);
    console.error('    Treating as NOT VERIFIED. Re-run `npx vitest run --root packages/operator-core --config vitest.config.ts lib/doc-claims/`');
    console.error('    by hand, or pass --no-verify if you are deliberately projecting a mid-repair corpus.');
    return false;
  }
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const summary = out.split('\n').filter((l) => /^\s*(Test Files|Tests)\s/.test(l));
  if (res.status === 0) {
    for (const l of summary) console.log(`    ${l.trim()}`);
    console.log('  ✓ doc-claims guards pass against the new corpus.');
    return true;
  }
  console.error('\n  ✗ doc-claims guards FAILED against the corpus just written.');
  for (const l of summary) console.error(`    ${l.trim()}`);
  for (const l of out.split('\n').filter((l) => l.includes('FAIL '))) console.error(`    ${l.trim()}`);
  console.error('\n    A guard here means a doc PART lost text the guard pins — almost always a');
  console.error('    compression that dropped a load-bearing clause. Recover the ORIGINAL wording from');
  console.error('    git (`git log -S "<missing literal>" -- CLAUDE.md`, then read the parent commit)');
  console.error('    rather than writing a minimal string that satisfies the matcher: the guard pins the');
  console.error('    rule, and a string that only matches the regex leaves the rule gone.');
  return false;
}
