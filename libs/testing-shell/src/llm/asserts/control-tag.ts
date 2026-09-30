import { registerEvaluator } from './index';
import type { Violation } from '../types';

registerEvaluator('control_tag_present', (a, run) => {
  const count = run.turns.reduce((n, t) => n + t.controlTags.filter((ct) => ct.tag === a.tag).length, 0);
  const min = a.minCount ?? 1;
  const max = a.maxCount ?? Infinity;
  const v: Violation[] = [];
  if (count < min) {
    v.push({
      assertKind: 'control_tag_present',
      severity: 'error',
      claim: `Expected <${a.tag}/> at least ${min}× — saw ${count}`,
    });
  }
  if (count > max) {
    v.push({
      assertKind: 'control_tag_present',
      severity: 'warn',
      claim: `<${a.tag}/> emitted ${count}× — cap was ${max}`,
    });
  }
  return v;
});
