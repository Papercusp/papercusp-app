/**
 * Pin every prose statement of "which mug/kettle verbs refuse" to the one module that
 * knows — `agent-tools/_mug-kettle-gate-population.ts` (WI-10002068 step 2).
 *
 * ── Why this guard exists ────────────────────────────────────────────────────
 * EI-23782708033448780 found the su instance prompt wrong FOUR times in ONE sentence,
 * in BOTH directions. That sentence was fixed by hand; the REASON it drifted was not.
 * Every prose copy of the split sat at rung 4 (CURATED) of the derived-truth ladder
 * while rung 1 (DERIVE) was available, and the drift is silent in the dangerous
 * direction: a verb wrongly labelled REFUSES is simply never called, so it emits no
 * error and leaves no trace. `curation:state-of-pot` went unexercised across many
 * sessions that way, while sitting in a mandatory grounding read.
 *
 * ── Two legs, because one of them could go vacuous alone ─────────────────────
 * 1. BLOCK EQUALITY (rung 1). Each block-carrying surface must contain
 *    `renderMugKettleDispositionBlock()` byte-for-byte. This cannot pass vacuously
 *    and cannot be satisfied by rewording — the canonical sentence is rendered from
 *    the rows, so changing the population changes the required text.
 * 2. WRONG-SIDE SCAN (rung 2). The block cannot absorb the scattered narrative
 *    mentions ("the TOOL `pot:declare-wake` REFUSES", "`cup:spawn` REFUSES"), and
 *    those are exactly where the measured drift lived. So the rest of each surface is
 *    scanned for a disposition CLAIM attached to a population verb, and the claim must
 *    agree with the row.
 *
 * ⚠ Leg 2 is a lexicon matcher, and a lexicon matcher is the guard shape that silently
 * becomes a false green once prose is reworded past it (measured twice on 2026-09-20 —
 * workspace fact `guard-rail:literal-pinned-guard-silently-becomes-a-false-green`).
 * Two things are therefore load-bearing and must not be removed as redundant:
 *   • the CONTROL FIXTURES in the test — verbatim copies of the four real pre-fix
 *     sentences, asserted to still be CAUGHT. They are independent of the live prose,
 *     so the scanner stays provably alive even if every surface goes quiet.
 *   • `JUDGED_CLAIM_FLOOR` — a denominator. Reword past the lexicon and the judged
 *     count falls through the floor, turning a silent pass into a loud red.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MUG_KETTLE_BLOCK_BEGIN,
  MUG_KETTLE_BLOCK_END,
  MUG_KETTLE_VERBS,
  type MugKettleDisposition,
} from '../agent-tools/_mug-kettle-gate-population';
import { ROOT } from './corpus-subject';

export interface PinnedSurface {
  /** Repo-relative path. Repo-qualified nowhere else: these all live in THIS checkout. */
  readonly relpath: string;
  /**
   * Whether this surface must carry the generated block verbatim.
   *
   * The `.mdx` docs page does NOT: the block is delimited by HTML comments, and no
   * `.mdx` in `apps/operator-docs` carries a bare HTML comment (measured 2026-09-20),
   * so introducing one here would be an unverified bet on the MDX compiler rather than
   * a pin. That surface is covered by the wrong-side scan alone.
   */
  readonly carriesBlock: boolean;
  readonly why: string;
}

export const PINNED_SURFACES: readonly PinnedSurface[] = Object.freeze([
  {
    relpath: 'apps/operator/prompts/pot-instances/papercup-pot.su.md',
    carriesBlock: true,
    why: 'The su instance prompt override — the surface EI-23782708033448780 found wrong four times in one sentence.',
  },
  {
    relpath: 'apps/operator/prompts/papercusp-su-power.tools.md',
    carriesBlock: true,
    why: 'The su power playbook. Carried the same drift independently: `cup:spawn` REFUSES (it is deleted) and `pot:declare-wake` survives ungated (it is gated).',
  },
  {
    relpath: 'apps/operator/prompts/papercusp-su-engineer.tools.md',
    carriesBlock: true,
    why: 'The su engineer playbook — same two drifted claims as the power playbook, hand-copied separately.',
  },
  {
    relpath: 'apps/operator-docs/src/content/docs/agent-insights/mug-kettle-cup-tier-is-retired.mdx',
    carriesBlock: false,
    why: 'The agent-insights page for the retirement. Its gate-membership list is a historical record that had gone stale as a present-tense claim.',
  },
]);

export const surfacePath = (relpath: string): string => resolve(ROOT, relpath);

/** Read a pinned surface. Absence yields '' so the test reports a LOUD missing-file, not a crash. */
export function readSurface(relpath: string): string {
  const abs = surfacePath(relpath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

/**
 * Phrases that ASSERT a disposition. Deliberately over-broad rather than precise: a
 * phrase that fires on a claim we then confirm as correct costs nothing, while a phrase
 * missing from this set is a hole the drift walks through.
 */
export const DISPOSITION_PHRASES: Readonly<Record<MugKettleDisposition, readonly RegExp[]>> =
  Object.freeze({
    // `\bgated\b` deliberately does NOT match inside "ungated" — the boundary before
    // `g` fails there — which is what lets the excluded lexicon own that word instead.
    gated: [/\brefuses?\b/i, /\brefused\b/i, /\bgated\b/i, /\bmug_kettle_retired\b/],
    excluded: [
      /\bstill works?\b/i,
      /\bsurvives?\b/i,
      /\bungated\b/i,
      /\bstays? reachable\b/i,
      /\bstill reachable\b/i,
      /\bstill available\b/i,
    ],
    deleted: [
      /\bdeleted\b/i,
      /\bis gone\b/i,
      /\bare gone\b/i,
      /\bremoved\b/i,
      /\bno longer exists?\b/i,
      /\bdoes not exist\b/i,
    ],
  });

export const ALL_DISPOSITIONS: readonly MugKettleDisposition[] = Object.freeze([
  'gated',
  'excluded',
  'deleted',
]);

/** How far past a verb mention a trailing claim is still considered attached to it. */
const TRAILING_WINDOW = 40;

export interface DispositionClaim {
  readonly verb: string;
  /** What the rows say. */
  readonly actual: MugKettleDisposition;
  /** What the prose says. */
  readonly claimed: MugKettleDisposition;
  readonly form: 'trailing' | 'leading-list';
  readonly line: number;
  readonly excerpt: string;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every generated block, removed — those legitimately contain all three claim forms. */
export function stripGeneratedBlocks(text: string): string {
  let out = text;
  for (;;) {
    const begin = out.indexOf(MUG_KETTLE_BLOCK_BEGIN);
    if (begin < 0) return out;
    const end = out.indexOf(MUG_KETTLE_BLOCK_END, begin);
    if (end < 0) return out;
    out = `${out.slice(0, begin)}${out.slice(end + MUG_KETTLE_BLOCK_END.length)}`;
  }
}

/**
 * Claims of the form "`verb` REFUSES" — the verb first, its disposition just after.
 *
 * A window that ALSO carries a phrase for the verb's own disposition is treated as
 * agreeing. That is not leniency: it is what keeps a correct sentence like
 * "`kettle:declare-wake` was deleted outright and the TOOL `pot:declare-wake` REFUSES"
 * from flagging on the neighbouring verb's (correct) claim bleeding into the window.
 */
function scanTrailing(text: string): DispositionClaim[] {
  const found: DispositionClaim[] = [];
  for (const verb of MUG_KETTLE_VERBS) {
    // The lookarounds stop `pot:wake` matching inside a longer token; without them a
    // hypothetical `pot:wake-later` would be judged as the row it is not.
    const re = new RegExp(`(?<![\\w-])\`?${escapeForRegex(verb.name)}\`?(?![\\w-])`, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const window = text.slice(m.index + m[0].length, m.index + m[0].length + TRAILING_WINDOW);
      const agrees = DISPOSITION_PHRASES[verb.disposition].some((p) => p.test(window));
      if (agrees) {
        found.push({
          verb: verb.name,
          actual: verb.disposition,
          claimed: verb.disposition,
          form: 'trailing',
          line: lineOf(text, m.index),
          excerpt: `${m[0]}${window}`,
        });
        continue;
      }
      for (const other of ALL_DISPOSITIONS) {
        if (other === verb.disposition) continue;
        if (!DISPOSITION_PHRASES[other].some((p) => p.test(window))) continue;
        found.push({
          verb: verb.name,
          actual: verb.disposition,
          claimed: other,
          form: 'trailing',
          line: lineOf(text, m.index),
          excerpt: `${m[0]}${window}`,
        });
        break;
      }
    }
  }
  return found;
}

/**
 * Claims of the form "The five gated actuator tools: `a`, `b`, `c`" — the disposition
 * first, introducing a COLON-led list of two or more verbs. The colon and the
 * two-verb minimum are what keep this off "the gate flag was DELETED: `cup:spawn`
 * REFUSES", where the leading word is about the flag rather than the verb.
 */
function scanLeadingLists(text: string): DispositionClaim[] {
  const found: DispositionClaim[] = [];
  const listRe = /:\s*((?:`[a-z_]+:[a-z_-]+`(?:\s*,\s*(?:and\s+)?)?){2,})/gi;
  for (let m = listRe.exec(text); m; m = listRe.exec(text)) {
    const lead = text.slice(Math.max(0, m.index - 60), m.index);
    const claimed = ALL_DISPOSITIONS.find((d) =>
      DISPOSITION_PHRASES[d].some((p) => p.test(lead)),
    );
    if (!claimed) continue;
    const names = m[1].match(/`[a-z_]+:[a-z_-]+`/gi) ?? [];
    for (const ticked of names) {
      const name = ticked.replace(/`/g, '');
      const row = MUG_KETTLE_VERBS.find((v) => v.name === name);
      if (!row) continue;
      found.push({
        verb: row.name,
        actual: row.disposition,
        claimed,
        form: 'leading-list',
        line: lineOf(text, m.index),
        excerpt: `${lead.slice(-40)}${m[0]}`.trim(),
      });
    }
  }
  return found;
}

/** Every disposition claim this scanner can see in `text`, agreeing or not. */
export function scanDispositionClaims(text: string): DispositionClaim[] {
  const body = stripGeneratedBlocks(text);
  return [...scanTrailing(body), ...scanLeadingLists(body)];
}

export const violationsOf = (claims: readonly DispositionClaim[]): DispositionClaim[] =>
  claims.filter((c) => c.claimed !== c.actual);

/**
 * The denominator. Measured 2026-09-20 across the four pinned surfaces AFTER the drift
 * was repaired: 9 claims judged (2 + 3 + 3 + 1), 0 violations. Floored below that with
 * headroom, because prose is edited continuously and a floor pinned to the exact count
 * reds on any honest removal.
 *
 * It is not decoration. This is the assertion that fails when someone rewords past
 * `DISPOSITION_PHRASES` — the one failure mode leg 2 cannot otherwise report, because
 * an unrecognised claim looks exactly like no claim at all. If it legitimately drops,
 * say why; do not just lower the number.
 */
export const JUDGED_CLAIM_FLOOR = 6;
