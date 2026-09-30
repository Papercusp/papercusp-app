import { registerEvaluator } from './index';
import type { RunSummary, Violation } from '../types';

registerEvaluator('text_contains', (a, run) => {
  const turns = a.turnIdx !== undefined ? [run.turns[a.turnIdx]].filter(Boolean) : run.turns;
  const re = a.pattern instanceof RegExp ? a.pattern : new RegExp(escapeRegex(a.pattern), 'i');
  const hit = turns.some((t) => re.test(t.assistantText));
  if (!hit) {
    return [{
      assertKind: 'text_contains',
      severity: 'error',
      evidenceTurnIdx: a.turnIdx,
      claim: `Assistant text did not contain ${re}`,
    }];
  }
  return [];
});

registerEvaluator('text_excludes', (a, run) => {
  const turns = a.turnIdx !== undefined
    ? turnAt(run, a.turnIdx)
    : run.turns.map((turn, index) => ({ turn, index }));
  const re = a.pattern instanceof RegExp ? a.pattern : new RegExp(escapeRegex(a.pattern), 'i');
  const v: Violation[] = [];
  for (const { turn, index } of turns) {
    if (hasActionableBannedMatch(turn.assistantText, re)) {
      v.push({
        assertKind: 'text_excludes',
        severity: 'warn',
        evidenceTurnIdx: index,
        claim: `Assistant text contained banned pattern ${re}`,
      });
    }
  }
  return v;
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function turnAt(run: RunSummary, index: number) {
  const turn = run.turns[index];
  return turn ? [{ turn, index }] : [];
}

function hasActionableBannedMatch(text: string, re: RegExp): boolean {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const scanner = new RegExp(re.source, flags);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text))) {
    if (!isNegatedBannedPatternMention(text, match.index, match[0].length)) {
      return true;
    }
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
  return false;
}

function isNegatedBannedPatternMention(text: string, start: number, length: number): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf('\n', start - 1),
    text.lastIndexOf('.', start - 1),
    text.lastIndexOf('?', start - 1),
    text.lastIndexOf('!', start - 1),
  ) + 1;
  const nextBreaks = ['\n', '.', '?', '!']
    .map((ch) => text.indexOf(ch, start + length))
    .filter((idx) => idx >= 0);
  const clauseEnd = nextBreaks.length > 0 ? Math.min(...nextBreaks) : text.length;
  const before = text.slice(Math.max(clauseStart, start - 120), start).toLowerCase();
  const after = text.slice(start + length, Math.min(clauseEnd, start + length + 120)).toLowerCase();

  const negationBeforeEnd =
    /(?:\b(do\s+not|don['’]?t|won['’]?t|must\s+not|shouldn['’]?t|cannot|can['’]?t|never|avoid|rather\s+than|instead\s+of|without|forbidden|disallowed|anti-?pattern|retired|wrong)\b|(?:not|no)\s+(?:an?\s+)?)$/;
  const negationBefore =
    /\b(do\s+not|don['’]?t|must\s+not|shouldn['’]?t|never|avoid|forbidden|disallowed|not\s+allowed|anti-?pattern|retired|wrong)\b/;
  const negationAfter =
    /^\W*(is|are|was|were|would\s+be)?\W*(forbidden|disallowed|not\s+allowed|an?\s+anti-?pattern|retired|wrong)\b/;

  return negationBeforeEnd.test(before.trim()) || negationBefore.test(before) || negationAfter.test(after.trim());
}
