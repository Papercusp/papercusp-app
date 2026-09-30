import { registerEvaluator } from './index';
import type { Violation } from '../types';

registerEvaluator('card_emitted', (a, run) => {
  const v: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const matching = run.turns[i].cards.filter((c) => c.kind === a.cardKind);
    if (matching.length === 0) continue;
    if (a.voiceAnswerable && !matching.some((c) => c.voiceAnswerable)) {
      v.push({
        assertKind: 'card_emitted',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Card '${a.cardKind}' emitted but not voiceAnswerable`,
      });
    }
    if (a.optionsInclude && matching[0].options) {
      const have = new Set(matching[0].options.map((o) => o.id));
      const missing = a.optionsInclude.filter((id) => !have.has(id));
      if (missing.length > 0) {
        v.push({
          assertKind: 'card_emitted',
          severity: 'warn',
          evidenceTurnIdx: i,
          claim: `Card '${a.cardKind}' missing options: ${missing.join(', ')}`,
        });
      }
    }
    return v;
  }
  v.push({
    assertKind: 'card_emitted',
    severity: 'error',
    claim: `Expected card '${a.cardKind}' to be emitted; none seen.`,
  });
  return v;
});
