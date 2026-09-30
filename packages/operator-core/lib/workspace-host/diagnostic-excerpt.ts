import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Bounded excerpting for failure diagnostics from expensive workspace-host operations.
 *
 * Extracted from workspace-host-clean-room-executor so the GCP image-family adapter can use it
 * too. It could not simply be imported from there: that module already imports
 * gcp-image-family-adapter, so the dependency would have been a cycle. Both now depend on this
 * leaf instead, and there is exactly one implementation of the rule below rather than two that
 * can drift apart.
 */

/**
 * Bounded because this string is embedded in a release-gate issue and read in a terminal —
 * NOT because the rest is expendable. Callers that can afford to keep the whole thing should
 * spill it to a file and name the path in the message.
 */
export const DIAGNOSTIC_BUDGET_CHARS = 4_000;

/**
 * Fraction of the budget spent on the HEAD of the diagnostic. Weighted toward the head on
 * purpose — see {@link excerptDiagnostic} for why that is the load-bearing end.
 */
export const DIAGNOSTIC_HEAD_FRACTION = 0.6;

/**
 * Fraction of the budget re-allocated to the CAUSE band when the first failure signal falls in
 * the stretch that head+tail weighting would have elided. Paid for by shrinking head and tail
 * proportionally, so the total stays inside `budget`.
 */
export const DIAGNOSTIC_CAUSE_FRACTION = 0.3;

/**
 * Fraction of the cause band spent BEFORE the anchor line. Weighted heavily toward what came
 * BEFORE, because the signal a runner emits ("Provisioning step had errors", "Script exited with
 * non-zero exit status") is the CONSEQUENCE; the failing script's own message is printed just
 * above it. Anchoring on the consequence and then reading backwards is what actually recovers
 * the cause.
 */
const CAUSE_LEAD_FRACTION = 0.6;

/**
 * Lines that carry a failure SIGNAL. Deliberately matched against the EARLIEST such line: a
 * failing pipeline reports its root cause first and its consequences afterwards, so the first
 * match is the one worth spending budget on.
 *
 * Kept narrow on purpose. Broad words like "warning" or a bare "not" would match the routine
 * progress chatter that both packer and systemd emit constantly, and a cause band anchored on
 * chatter is worse than no cause band at all — it would evict real head/tail content to show
 * nothing.
 */
const CAUSE_SIGNAL =
  /(?:\bFAILED\b|did NOT match|\bERROR\b|\berrored\b|\bfatal\b|Traceback|Provisioning step had errors|non-zero exit|exit(?:ed)? with (?:non-zero|code)|command not found|No such file|Permission denied|\bcannot\b|\brefused\b|\bError:)/;

/**
 * Byte offset of the first line carrying a failure signal, or null when none does.
 */
function firstCauseOffset(text: string): number | null {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (CAUSE_SIGNAL.test(line)) return offset;
    offset += line.length + 1;
  }
  return null;
}

/** Start of the line containing `offset`. */
function lineStartAt(text: string, offset: number): number {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return start === -1 ? 0 : start + 1;
}

function elision(count: number): string {
  return `\n… [${String(count)} chars omitted from the middle of the output] …\n\n`;
}

/**
 * Write the COMPLETE diagnostic to a file and return its path, or null if the spill itself
 * fails — writing diagnostics must never mask the failure being described.
 *
 * This is the escape hatch that makes the excerpting above non-fatal. Every excerpt rule is a
 * guess about where the cause sits, and P-046 burned three billable builds proving that a
 * guess which held for the last failure need not hold for the next one. A spilled file needs no
 * guess: the excerpt goes in the message for the reader, the whole thing goes on disk for the
 * investigation. Name the returned path EARLY in the failure message — a path mentioned after
 * 4_000 chars of excerpt is a path nobody sees.
 *
 * @param label distinguishes one spill from another; sanitised into the filename.
 * @param prefix mkdtemp prefix, so different subsystems' spills stay recognisable.
 */
export function spillDiagnostic(
  label: string,
  text: string,
  prefix = 'papercusp-diagnostic-',
): string | null {
  try {
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'diagnostic';
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const path = join(dir, `${safeLabel}.log`);
    writeFileSync(path, text, 'utf8');
    return path;
  } catch {
    return null;
  }
}

/**
 * Excerpt a diagnostic so BOTH ends survive.
 *
 * ⛔ NEVER go back to a tail-only `slice(-N)` here. It is the intuitive way to bound this
 * string and it is exactly backwards: a failing process prints its message and stack FIRST and
 * its process/systemd/teardown epilogue LAST, so keeping only the tail keeps the CONSEQUENCE
 * and discards the CAUSE.
 *
 * Measured on P-046 (2026-08-29), twice, in two different subsystems:
 *
 *  - A clean-room boot failed because the guest could not load `rocksdb-native.node`. The
 *    2_000-char tail preserved six lines of `systemctl` summary — "Main process exited",
 *    "start-post operation timed out", "Consumed 8.465s CPU time" — every one of which
 *    describes systemd reacting to the failure, and none of which names it. The
 *    `require.addon` error headline and the candidate paths it searched, i.e. the only part of
 *    the output identifying what was actually missing, fell off the FRONT. Diagnosing it cost
 *    an extra billable boot.
 *
 *  - A production `packer build` failed and reported nothing at all, because the adapter's
 *    excerpt read only stderr while packer's `-machine-readable` mode writes its entire event
 *    stream — errors included — to stdout (EI-21762126059344308).
 *
 *  - The r18 production release build failed on a `sha256sum --check` inside the release
 *    verification provisioner. Head+tail weighting preserved packer's instance-creation preamble
 *    and its teardown epilogue, and elided 6_055 chars from the middle — which is where the
 *    provisioner's own output lives, including the `<file>: FAILED` line naming WHICH artifact
 *    mismatched. The surviving text proved only that a script somewhere exited 1.
 *
 * The lesson generalises past any of the three: bound a diagnostic by excerpting it, never by
 * truncating it; be sure you are excerpting the stream the failure was actually written to; and
 * do not assume the failure sits at either END of that stream. Position is a proxy for salience,
 * and packer is the case where the proxy breaks: its output is framed by boilerplate at BOTH
 * ends, so the cause is structurally in the middle. Hence the third band below — anchored on the
 * EARLIEST failure signal, because a failing pipeline reports its cause first and the
 * consequences after it.
 */
export function excerptDiagnostic(
  text: string,
  budget: number = DIAGNOSTIC_BUDGET_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;

  const headChars = Math.ceil(budget * DIAGNOSTIC_HEAD_FRACTION);
  const tailChars = budget - headChars;

  const cause = firstCauseOffset(trimmed);
  const middleStart = headChars;
  const middleEnd = trimmed.length - tailChars;

  // The cause is already inside a band we keep (or there is no recognisable one). Two bands,
  // exactly as before — this is the clean-room shape, where the cause is the very first line.
  if (cause === null || cause < middleStart || cause >= middleEnd) {
    return (
      `${trimmed.slice(0, headChars)}\n` +
      elision(trimmed.length - budget) +
      `${trimmed.slice(-tailChars)}`
    );
  }

  // The cause is in the stretch head+tail weighting would have thrown away. Buy a third band
  // around it by shrinking the other two, and keep the total inside `budget`.
  const causeChars = Math.max(1, Math.floor(budget * DIAGNOSTIC_CAUSE_FRACTION));
  const remaining = budget - causeChars;
  const newHeadChars = Math.ceil(remaining * DIAGNOSTIC_HEAD_FRACTION);
  const newTailChars = remaining - newHeadChars;

  // The anchor LINE must survive whole — a band that ends mid-line can cut off the very words
  // that identified it. Reserve it first, then spend what is left on the lines before it.
  const anchorStart = lineStartAt(trimmed, cause);
  const newlineAfter = trimmed.indexOf('\n', cause);
  const anchorEnd = newlineAfter === -1 ? trimmed.length : newlineAfter;

  const slack = Math.max(0, causeChars - (anchorEnd - anchorStart));
  const lead = Math.floor(slack * CAUSE_LEAD_FRACTION);
  const causeStart = Math.max(newHeadChars, lineStartAt(trimmed, Math.max(0, anchorStart - lead)));
  const causeEnd = Math.min(
    trimmed.length - newTailChars,
    Math.max(anchorEnd, causeStart + causeChars),
  );

  return (
    `${trimmed.slice(0, newHeadChars)}\n` +
    elision(causeStart - newHeadChars) +
    `${trimmed.slice(causeStart, causeEnd)}\n` +
    elision(trimmed.length - newTailChars - causeEnd) +
    `${trimmed.slice(-newTailChars)}`
  );
}
