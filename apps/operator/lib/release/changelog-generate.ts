/**
 * The agent-written changelog. (WI-4446, owner ask #4: "we should also have the
 * agent auto generate a high level changelog.")
 *
 * The registry already answers "WHAT shipped" exactly — every work item that went
 * terminal in the window, grouped by the plan that produced it. That list is a
 * FACT, and it is also unreadable: a real window here is ~80 user-facing items
 * with titles written by engineers for engineers ("Global docs-search shortcut:
 * OFF by default + a real disable option"). A beta tester wants six sentences.
 * This turns the one into the other.
 *
 * ⛔ THE FAILURE MODE THIS MODULE IS BUILT AROUND: a changelog that LIES.
 *
 * Today (2026-07-13) 0.0.9 was cut with a headline that would have read
 * "auto-update works now" while auto-update was, on Windows, still completely
 * dead — the fix was compiled into the binary but never reached the process that
 * serves the update check. Every gate was green; the claim was false. A beta
 * tester could not possibly have caught it, because a broken updater and "no
 * update available" look identical from the outside.
 *
 * A model handed a list of work-item titles will cheerfully write that same
 * sentence, because the titles say the work was DONE. Done is not WORKS. So:
 *
 *   1. The model is given FACTS ONLY (titles + plan names) and told, explicitly,
 *      to describe what was worked on and never to assert that anything now
 *      works, is fixed, or is verified on any platform.
 *   2. The output is a DRAFT ON DISK, not a value recorded straight into the
 *      release row. A human or agent reads it, edits the claims it cannot stand
 *      behind, and records THAT file. Generation and publication are separate
 *      decisions, like every other step on this rail.
 *   3. Re-running the generator REUSES an existing draft rather than re-rolling
 *      it. Without this, "review the draft, then record it" records a DIFFERENT
 *      changelog than the one that was reviewed — the model is nondeterministic,
 *      so the second call is a different document. The reviewed bytes are the
 *      recorded bytes.
 *
 * Identity scrubbing is NOT done here on purpose. `release-history-page.ts`
 * scrubs at render and `gate-release-site.ts` re-checks the finished bytes; a
 * second implementation of "what counts as identity" would drift from those two
 * and give false confidence. One rule, one place.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHaikuTurn } from '@papercusp/operator-core/lib/haiku';
import { groupItemsByPlan, type ShippedItem, type ShippedPlan } from './release-registry';

/** Titles are cheap but not free; a pathological window must not blow the prompt. */
const MAX_ITEMS_IN_PROMPT = 150;

export interface ChangelogInput {
  version: string;
  channel: string;
  /** The release this one follows, when there is one — lets the notes say "since 0.0.8". */
  previousVersion: string | null;
  items: ShippedItem[];
  plans: ShippedPlan[];
  /** EI-* count: shown as a number, never enumerated (see `isUserFacing`). */
  internalCount: number;
}

/**
 * The prompt. Pure and exported so the RULES are unit-testable — the constraints
 * below are the entire safety story of this module, and a silent edit that drops
 * one of them should red a test, not ship a confident lie in a release note.
 */
export function buildChangelogPrompt(input: ChangelogInput): string {
  const groups = groupItemsByPlan(input.items, input.plans);
  let shown = 0;
  const lines: string[] = [];
  for (const g of groups) {
    if (shown >= MAX_ITEMS_IN_PROMPT) break;
    const take = g.items.slice(0, MAX_ITEMS_IN_PROMPT - shown);
    shown += take.length;
    lines.push(`\n${g.plan ? `Workstream: ${g.plan.title}` : 'Unplanned / one-off fixes'}`);
    for (const it of take) lines.push(`  - ${it.title}`);
  }
  const omitted = input.items.length - shown;
  if (omitted > 0) lines.push(`\n(+ ${omitted} more items not listed here)`);

  return `You are writing the release notes for Papercusp ${input.version} (${input.channel} channel), a desktop app currently in private beta.

AUDIENCE: our beta testers. They are users, not engineers on this project. They have never heard of our internal work items, plans, agents, or fleet.

Below is the complete list of work that was completed between ${
    input.previousVersion ? `${input.previousVersion} and ${input.version}` : `the last release and ${input.version}`
  }, grouped by workstream. These are internal titles written by engineers.
${lines.join('\n')}

${input.internalCount > 0 ? `There were also ${input.internalCount} internal engineering-tooling fixes that do not affect users.\n` : ''}
Write a high-level changelog in markdown.

RULES — follow every one:
- Start with "## Highlights", then 4-8 bullet points. No top-level heading (the page adds its own).
- Write for a user: say what CHANGED FOR THEM, in plain language. One line each.
- Describe ONLY what the titles above actually say. If a title is ambiguous, LEAVE IT OUT. Never guess what a change did.
- NEVER claim that something "now works", "is fixed", "is verified", or works "on all platforms". The list above says the work was COMPLETED; it does not say the result was tested on any particular machine. Describe the change, not its success. (Write "reworked how the app checks for updates", never "auto-update now works".)
- Do not invent anything that is not in the list. No performance numbers, no percentages, no dates.
- Never mention: work item ids (WI-…, EI-…), plan slugs, file paths, agents, the fleet, or any person's name or email address.
- Skip anything that is purely internal tooling.
- End with a short "## Also in this release" section: one sentence noting the number of smaller fixes.

Output the markdown only — no preamble, no code fences.`;
}

/**
 * Strip the wrapper a model puts around markdown even when told not to: a fenced
 * block, or a "Here are the release notes:" line before the real content.
 */
export function sanitizeChangelog(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  // Drop any chatter before the first heading or bullet — never drop content
  // when there is no heading at all (that would silently empty the changelog).
  const start = text.search(/^(#{2,3} |[-*] )/m);
  if (start > 0) text = text.slice(start).trim();
  return text;
}

/**
 * The changelog we write when the model call fails. Deterministic, dull, TRUE.
 *
 * It exists because the alternative is a release with no notes at all: inference
 * is a network call on a rail whose whole job is to work while unattended, and
 * "the changelog is blank because an API call 529'd" is not an acceptable outcome
 * for the page our beta testers read. It states only what the registry already
 * knows, so it cannot be wrong.
 */
export function fallbackChangelog(input: ChangelogInput): string {
  const groups = groupItemsByPlan(input.items, input.plans).filter((g) => g.plan);
  const out: string[] = ['## What shipped', ''];
  out.push(
    `${input.items.length} tracked change${input.items.length === 1 ? '' : 's'} landed in ${input.version}` +
      (input.previousVersion ? `, since ${input.previousVersion}.` : '.'),
  );
  if (groups.length > 0) {
    out.push('', 'The largest workstreams in this release:', '');
    for (const g of groups.slice(0, 8)) {
      out.push(`- **${g.plan!.title}** — ${g.items.length} change${g.items.length === 1 ? '' : 's'}`);
    }
  }
  if (input.internalCount > 0) {
    out.push('', `## Also in this release`, '', `${input.internalCount} internal engineering fixes.`);
  }
  out.push('', '_The full list of work items and plans in this release is below._');
  return out.join('\n');
}

/**
 * Warn about the two things the model reliably gets wrong even when told not to,
 * so the reviewer's eyes go straight to them instead of having to hold every rule
 * in their head. WARNINGS, never failures: this is a draft a human is about to
 * edit, and the honest fix ("reworded", "cut the line") is theirs to make — a
 * hard gate here would just be bypassed. Observed on the very first live run
 * (2026-07-13): the model wrote "fleet-wide", "agents", and "Fixed …".
 *
 *   1. INTERNAL VOCABULARY a beta tester has no context for (agents, the fleet,
 *      work-item / plan ids) — leaked despite the explicit ban.
 *   2. SUCCESS CLAIMS ("fixed", "now works", "resolved") — the exact class that
 *      turns a changelog into a lie when the work shipped but was never verified
 *      on the reader's platform. See the module header.
 */
export function lintChangelogClaims(md: string): string[] {
  const warnings: string[] = [];
  const internal: Array<[RegExp, string]> = [
    [/\b(the )?fleet\b/i, 'mentions "fleet" (internal)'],
    [/\bagents?\b/i, 'mentions "agent(s)" (internal)'],
    [/\b(WI|EI)-\d+/, 'contains a work-item/issue id'],
  ];
  const claims: Array<[RegExp, string]> = [
    [/\bnow works\b/i, 'claims something "now works" — describe the change, not its success'],
    [/\bis (now )?fixed\b/i, 'claims something "is fixed" — the work shipped; that is not "verified"'],
    [/\b(fixed|resolved)\b/i, 'asserts "fixed/resolved" — prefer "reworked/changed" unless verified on the user\'s platform'],
    [/\bon all platforms\b/i, 'claims "on all platforms" — only claim platforms you watched it work on'],
  ];
  const lines = md.split('\n');
  for (const [i, line] of lines.entries()) {
    for (const [re, why] of [...internal, ...claims]) {
      if (re.test(line)) warnings.push(`  line ${i + 1}: ${why}\n    ${line.trim().slice(0, 100)}`);
    }
  }
  return warnings;
}

export interface ChangelogResult {
  md: string;
  source: 'model' | 'fallback' | 'existing-draft';
  /** Where the draft was written — the file a reviewer edits and then records. */
  draftPath: string;
  /** Warn-only claim-lint hits, so the CLI can point the reviewer at them. */
  warnings: string[];
}

export interface GenerateDeps {
  /** Injected so the prompt/parse/fallback logic is testable without a model. */
  complete?: (prompt: string) => Promise<string | null>;
}

async function defaultComplete(prompt: string): Promise<string | null> {
  const r = await runHaikuTurn(prompt, {
    maxTokens: 1500,
    // 15s (the default, sized for one-line titles) is too tight for ~1000 output
    // tokens over a cold connection; a cut must not lose its notes to a stopwatch.
    timeoutMs: 90_000,
    attribution: { role: 'release-changelog' },
  });
  return r?.text ?? null;
}

/**
 * Generate (or reuse) the changelog draft for a release.
 *
 * Reuse is the important half: see the module header. Pass `force` to re-roll.
 */
export async function generateChangelog(
  input: ChangelogInput,
  draftPath: string,
  opts: { force?: boolean } = {},
  deps: GenerateDeps = {},
): Promise<ChangelogResult> {
  if (!opts.force && fs.existsSync(draftPath)) {
    const existing = fs.readFileSync(draftPath, 'utf8').trim();
    if (existing) {
      return { md: existing, source: 'existing-draft', draftPath, warnings: lintChangelogClaims(existing) };
    }
  }

  const complete = deps.complete ?? defaultComplete;
  const raw = await complete(buildChangelogPrompt(input)).catch(() => null);
  const cleaned = raw ? sanitizeChangelog(raw) : '';

  const md = cleaned.length > 0 ? cleaned : fallbackChangelog(input);
  const source: ChangelogResult['source'] = cleaned.length > 0 ? 'model' : 'fallback';

  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, `${md}\n`, 'utf8');
  return { md, source, draftPath, warnings: lintChangelogClaims(md) };
}
