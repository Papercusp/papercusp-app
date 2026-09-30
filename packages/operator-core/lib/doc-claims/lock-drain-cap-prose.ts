/**
 * `max_drain_sec` is ONE ARGUMENT NAME WITH TWO DIFFERENT CAPS, and this guard stops
 * prose from handing agents the wrong one.
 *
 * ── The measured reality (EI-21673430317554145) ──────────────────────────────
 *
 *   locks:acquire_resource   `wait.max_drain_sec` ≤ MAX_LOCK_WAIT_SEC = 45
 *                            (agent-tools/locks/lock-config.ts). Over-cap is
 *                            REJECTED — `Too big expected <=45` — not clamped.
 *   dev:restart / db:migrate each declare their OWN `MAX_DRAIN_SEC = 300`
 *                            (defaults 120 / 60) for their own `max_drain_sec` arg.
 *
 * Same key, two ceilings, 6.7× apart. The named-resource-locks doc stated only the
 * 300 — "`max_drain_sec` caps at **300s**" — in a paragraph about acquire_resource,
 * and the merge-resolver blueprint prompt told every resolver to open with
 * `locks:acquire_resource { … wait: { max_drain_sec: 120 } }`. That call cannot
 * succeed: 120 > 45, and the rejection is total, so step 1 of that agent's job
 * failed every time it was followed. The filed report read the mismatch as the
 * live server drifting from checked-in source; it had not drifted at all — the
 * tool description interpolates `${MAX_WAIT_SEC}`, so it CANNOT drift. The prose
 * around it could, and did.
 *
 * ── Why a guard and not just a correction ────────────────────────────────────
 *
 * This is the derived-truth-ladder failure the repo names: a value that DESCRIBES
 * code, maintained by hand in prose. Rung 1 (DERIVE) is unavailable to a document
 * — a doc has to print a number — so this is rung 2 (PIN). Nothing about the
 * corrected wording stops a future editor from "simplifying" the two caps back
 * into one, and the failure is silent at authoring time: the sentence still reads
 * fluently, and only an agent's rejected call reveals it.
 *
 * ── What it judges ───────────────────────────────────────────────────────────
 *
 * RULE 1 — the executable one. Any prose that shows an `acquire_resource` call
 * carrying `max_drain_sec: N` with N > the lock cap is a violation, wherever it
 * lives (doc, runbook, blueprint prompt). This is the rule that would have caught
 * the merge-resolver prompt on the day it was written.
 *
 * RULE 2 — the explanatory one. A subject that quotes the WRAPPER cap as though it
 * were the `max_drain_sec` cap, while never mentioning the lock cap, recreates the
 * exact sentence that misled the reporter.
 *
 * RULE 3 — the both-directions property (the gate-candidate-ref shape). If the two
 * constants ever converge, a subject still warning that they differ has silently
 * rotted, and is reported too. A guard that only fails one way teaches the next
 * editor to delete it.
 *
 * ── Bound ────────────────────────────────────────────────────────────────────
 *
 * Judged on TEXT, so a call assembled at runtime from a variable is invisible to
 * it; it fails CLOSED (toward silence) there rather than guessing. `measured` is
 * the non-vacuity denominator — a subject set that has stopped discussing
 * `max_drain_sec` at all is a REFUSAL, not a pass, so a moved or emptied file can
 * never read as compliance.
 */

/** A prose surface judged by this guard. */
export interface DrainCapSubject {
  /** How a violation names this subject — a repo-relative path, normally. */
  label: string;
  text: string;
}

export interface DrainCapViolation {
  subject: string;
  /** 1-indexed line within that subject; 0 when the finding is about the whole file. */
  line: number;
  excerpt: string;
  reason: string;
}

export interface DrainCapVerdict {
  ok: boolean;
  violations: DrainCapViolation[];
  /** Subjects that actually discuss `max_drain_sec` — the non-vacuity denominator. */
  measured: number;
}

export interface DrainCapInput {
  subjects: DrainCapSubject[];
  /** MAX_LOCK_WAIT_SEC — the cap `locks:acquire_resource` enforces. */
  lockWaitCapSec: number;
  /** MAX_DRAIN_SEC — the cap the dev:restart / db:migrate wrappers enforce. */
  wrapperMaxDrainSec: number;
}

/** `max_drain_sec: 120` / `max_drain_sec = 120` / `max_drain_sec:120`. */
const DRAIN_ASSIGNMENT = /max_drain_sec\s*[:=]\s*(\d+)/g;

/**
 * A cap CLAIM about the argument in prose — "`max_drain_sec` caps at **300s**",
 * "max_drain_sec caps at 300". Deliberately narrow: it matches a statement that
 * the argument's ceiling IS this number, not an incidental mention of the number.
 */
const CAP_CLAIM = /max_drain_sec`?\s*(?:caps?|is capped)\s*(?:at|to)\s*\*{0,2}(\d+)/gi;

/** Does this line (or its immediate context) concern the named-resource tool? */
function nearAcquireResource(lines: string[], idx: number): boolean {
  const from = Math.max(0, idx - 2);
  const to = Math.min(lines.length, idx + 3);
  return lines.slice(from, to).join('\n').includes('acquire_resource');
}

function excerptOf(line: string): string {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

/**
 * Judge every subject against the two live constants.
 *
 * Pure by design: the caller supplies both the text and the constants, so the test
 * can hold a deliberately-wrong control permanently in-file and prove this guard
 * fails on it — no mutation of the shared working tree (CLAUDE.md's probe tiers).
 */
export function judgeDrainCapProse(input: DrainCapInput): DrainCapVerdict {
  const { subjects, lockWaitCapSec, wrapperMaxDrainSec } = input;
  const violations: DrainCapViolation[] = [];
  const capsDiffer = lockWaitCapSec !== wrapperMaxDrainSec;
  let measured = 0;

  for (const subject of subjects) {
    if (!subject.text.includes('max_drain_sec')) continue;
    measured += 1;

    const lines = subject.text.split('\n');
    let mentionsLockCap = false;

    lines.forEach((line, idx) => {
      // RULE 1 — an over-cap value handed to acquire_resource.
      DRAIN_ASSIGNMENT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DRAIN_ASSIGNMENT.exec(line)) !== null) {
        const value = Number(m[1]);
        if (Number.isNaN(value)) continue;
        if (value > lockWaitCapSec && nearAcquireResource(lines, idx)) {
          violations.push({
            subject: subject.label,
            line: idx + 1,
            excerpt: excerptOf(line),
            reason:
              `shows locks:acquire_resource with max_drain_sec: ${value}, above the ` +
              `${lockWaitCapSec}s cap it enforces — this call is REJECTED, not clamped. ` +
              `The ${wrapperMaxDrainSec}s ceiling belongs to the dev:restart / db:migrate ` +
              `wrappers, which take their own max_drain_sec.`,
          });
        }
      }

      // RULE 2 / RULE 3 — what the subject claims the cap IS.
      CAP_CLAIM.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = CAP_CLAIM.exec(line)) !== null) {
        const claimed = Number(c[1]);
        if (claimed === lockWaitCapSec) mentionsLockCap = true;
        if (capsDiffer && claimed === wrapperMaxDrainSec) {
          violations.push({
            subject: subject.label,
            line: idx + 1,
            excerpt: excerptOf(line),
            reason:
              `states the max_drain_sec cap as ${claimed}s. That is the dev:restart / ` +
              `db:migrate wrapper ceiling; locks:acquire_resource caps at ${lockWaitCapSec}s. ` +
              `Name which tool each ceiling belongs to — quoting only the larger one is ` +
              `what produced EI-21673430317554145.`,
          });
        }
      }

      if (line.includes(`${lockWaitCapSec}`) && line.includes('max_drain_sec')) {
        mentionsLockCap = true;
      }
    });

    // RULE 2, whole-subject form: an acquire_resource discussion that never states
    // the cap that tool actually enforces.
    if (capsDiffer && subject.text.includes('acquire_resource') && !mentionsLockCap) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '(whole subject)',
        reason:
          `discusses locks:acquire_resource and max_drain_sec but never states the ` +
          `${lockWaitCapSec}s cap that tool enforces, so a reader carries the wrapper's ` +
          `${wrapperMaxDrainSec}s over to a call that rejects it.`,
      });
    }

    // RULE 3 — the caps converged but the subject still warns they differ.
    if (!capsDiffer && /TWO DIFFERENT CAPS/i.test(subject.text)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '(whole subject)',
        reason:
          `warns that max_drain_sec has two different caps, but both constants are now ` +
          `${lockWaitCapSec}s. The warning has rotted — delete it with the divergence.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, measured };
}
