/**
 * The "two different failures, then audit" driver rule, pinned in prose.
 *
 * ── Why it exists (expensive-verification-loops-2026-09-29 P-008 / R-13) ─────
 *
 * P-505's physical drill took 32 runs and ~22h. From run 17 to run 31 every
 * failure printed the same summary line while the real causes were five
 * different harness defects. An audit rule already existed in the agent's
 * instructions and was not followed, so the plan adds a mechanical backstop
 * (the loop gate in `verification-attempts/loop-gate.ts`) AND states the rule
 * in the domain-neutral base persona every agent receives. This module pins
 * that statement so an editor who "tightens" the persona cannot silently drop
 * it. The drill runbook (physical-drill-iteration-speed-2026-09-29 P-006 /
 * R-8) is judged by the same function.
 *
 * ── What it judges ─────────────────────────────────────────────────────────
 *
 * The rule must appear inside ONE paragraph (blank-line separated) that says
 * all three things together, because scattered fragments do not form an
 * instruction an agent can follow:
 *
 *   - trigger:   two failures ("twice" / "two ... failures") with DIFFERENT
 *                causes;
 *   - action:    stop re-running and AUDIT the HARNESS (or test setup);
 *   - timing:    before the next attempt / run.
 *
 * A subject with no qualifying paragraph fails, naming which parts the
 * closest paragraph is missing. Judged on text only.
 */

export type DriverAuditPart = 'trigger' | 'action' | 'timing';

export interface DriverAuditVerdict {
  ok: boolean;
  /** The paragraph that satisfied the rule, when ok. */
  paragraph: string | null;
  /** Parts missing from the closest candidate paragraph, when not ok. */
  missing: DriverAuditPart[];
}

const TRIGGER_RE =
  /\b(?:twice|two(?:\s+\w+){0,4}\s+failures?|two\s+failed)\b[\s\S]{0,120}?\bdifferent\s+(?:causes?|reasons?)\b/i;
const ACTION_RE = /\baudit\b[\s\S]{0,80}?\b(?:harness|test setup|test harness)\b/i;
const TIMING_RE = /\bbefore\s+(?:the\s+)?next\s+(?:attempt|run)\b/i;

function partsOf(paragraph: string): DriverAuditPart[] {
  const flat = paragraph.replace(/\s+/g, ' ');
  const present: DriverAuditPart[] = [];
  if (TRIGGER_RE.test(flat)) present.push('trigger');
  if (ACTION_RE.test(flat)) present.push('action');
  if (TIMING_RE.test(flat)) present.push('timing');
  return present;
}

export function judgeDriverAuditRule(text: string): DriverAuditVerdict {
  const all: DriverAuditPart[] = ['trigger', 'action', 'timing'];
  const paragraphs = text.split(/\n\s*\n/);
  let best: { paragraph: string; present: DriverAuditPart[] } | null = null;
  for (const p of paragraphs) {
    const present = partsOf(p);
    if (present.length === all.length) return { ok: true, paragraph: p.trim(), missing: [] };
    if (!best || present.length > best.present.length) best = { paragraph: p, present };
  }
  return {
    ok: false,
    paragraph: null,
    missing: all.filter((part) => !(best?.present ?? []).includes(part)),
  };
}
