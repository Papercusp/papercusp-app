/**
 * wake-text-budget.ts — build wake text TO the injection budget instead of cutting a
 * finished document (review-system-rework-reduction-2026-09-23 P-024 clause D; P-026).
 *
 * The injection door used to hand the whole composed wake to `capInjectionText`, which
 * slices at a character offset. A loop wake's carry-note then lost its middle, and
 * `## Next action` survived only by luck of position (observed on su-77b3a99d
 * 2026-09-23). The agent paid to assemble the text, received a cut, and paid another
 * read to recover it from the spill file.
 *
 * This packer never cuts inside a section. It splits the composed text into sections
 * (a paragraph; a heading stays attached to the paragraph that follows it), keeps them
 * by priority — the headline first, then anything that names the next action, the
 * owner, a blocker or a wall, then the rest in document order — and stops at the
 * budget. Every section that did not fit is left out WHOLE and named in a single
 * pointer footer; the full original stays in the spill file with a section index.
 *
 * Pure: no fs, no env. The caller (applyInjectionDoor) owns the spill write.
 */

export interface WakeSection {
  /** 0-based position in the original text. */
  index: number;
  /** Human-readable label used by the pointer footer and the spill index. */
  title: string;
  /** The section's exact original text (no separator). */
  text: string;
}

export interface PackedWakeText {
  /** The kept sections in original order joined by blank lines, plus the footer when
   *  anything was left out. Always `text.length <= budgetChars`. */
  text: string;
  kept: WakeSection[];
  omitted: WakeSection[];
  /** The pointer footer ('' when nothing was left out). */
  footer: string;
}

const SEPARATOR = '\n\n';
const HEADING = /^#{1,6}\s+\S/;
const HIGH_PRIORITY_TITLE = /next action|## now\b|blocker|blocked on|wall|owner|directive/i;
/** Max chars of one section title quoted in the footer. */
const TITLE_MAX = 60;

function isHeadingOnly(block: string): boolean {
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  return lines.length > 0 && lines.every((l) => HEADING.test(l.trim()));
}

function oneLine(s: string, max: number): string {
  // The footer must stay a single `[injection-door: …]` span: turn-provenance strips it
  // with /\[injection-door:[\s\S]*?\]/, so no `]` may appear inside it.
  const flat = s.replace(/\s+/g, ' ').replace(/[\]"]/g, "'").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Split composed wake text into packable sections. */
export function splitWakeSections(text: string): WakeSection[] {
  const blocks = text.split(/\n[ \t]*\n+/).filter((b) => b.trim() !== '');
  const sections: WakeSection[] = [];
  let pendingHeading: string | null = null;
  let currentHeading: string | null = null;
  let paragraphUnderHeading = 0;
  for (const block of blocks) {
    if (isHeadingOnly(block)) {
      // Attach a bare heading to the paragraph that follows it (or flush it alone at the end).
      pendingHeading = pendingHeading ? `${pendingHeading}\n${block}` : block;
      continue;
    }
    const firstLine = block.split('\n')[0]!.trim();
    let body = block;
    let title: string;
    if (pendingHeading) {
      body = `${pendingHeading}\n${block}`;
      currentHeading = pendingHeading.split('\n').pop()!.trim();
      paragraphUnderHeading = 1;
      title = currentHeading;
      pendingHeading = null;
    } else if (HEADING.test(firstLine)) {
      currentHeading = firstLine;
      paragraphUnderHeading = 1;
      title = firstLine;
    } else if (currentHeading) {
      paragraphUnderHeading += 1;
      title = `${currentHeading} ¶${paragraphUnderHeading}`;
    } else {
      title = firstLine;
    }
    sections.push({ index: sections.length, title: oneLine(title, TITLE_MAX) || `section ${sections.length + 1}`, text: body });
  }
  if (pendingHeading) {
    sections.push({ index: sections.length, title: oneLine(pendingHeading, TITLE_MAX), text: pendingHeading });
  }
  return sections;
}

function priorityOf(s: WakeSection): number {
  if (s.index === 0) return 0;
  return HIGH_PRIORITY_TITLE.test(s.title) ? 1 : 2;
}

/** The single pointer footer naming every omitted section. Fits `maxChars` or returns
 *  the tersest form that still names the count and the spill path. */
export function buildOmissionFooter(
  omitted: readonly WakeSection[],
  doorTokens: number,
  spillPath: string,
  maxChars: number,
): string {
  if (omitted.length === 0) return '';
  const head =
    `[injection-door: ${omitted.length} section(s) did not fit the ~${doorTokens}-token wake budget and were left out whole ` +
    `(nothing was cut mid-section): `;
  const tail = ` — each is in full at ${spillPath} (see its section index).]`;
  const names = omitted.map((s) => `"${s.title}" (${s.text.length} chars)`);
  let listed = names.join('; ');
  let footer = `${head}${listed}${tail}`;
  if (footer.length <= maxChars) return footer;
  // Name as many as fit, then count the rest (still individually named in the spill index).
  for (let n = names.length - 1; n >= 0; n--) {
    listed = `${names.slice(0, n).join('; ')}${n > 0 ? '; ' : ''}+${names.length - n} more`;
    footer = `${head}${listed}${tail}`;
    if (footer.length <= maxChars) return footer;
  }
  return footer;
}

/**
 * Pack sections into `budgetChars`, never cutting one. The headline and high-priority
 * sections are placed first; the rest fill in document order. Output keeps original order.
 */
export function packWakeText(
  text: string,
  budgetChars: number,
  doorTokens: number,
  spillPath: string,
): PackedWakeText {
  if (text.length <= budgetChars) {
    const all = splitWakeSections(text);
    return { text, kept: all, omitted: [], footer: '' };
  }
  const sections = splitWakeSections(text);
  const order = [...sections].sort((a, b) => priorityOf(a) - priorityOf(b) || a.index - b.index);
  // Reserve footer room up front, sized so the footer can always name the omitted set.
  const footerReserve = Math.min(Math.floor(budgetChars / 4), 1_500);
  const bodyBudget = Math.max(0, budgetChars - footerReserve - SEPARATOR.length);
  const keptIdx = new Set<number>();
  let used = 0;
  for (const s of order) {
    const cost = s.text.length + (keptIdx.size > 0 ? SEPARATOR.length : 0);
    if (used + cost <= bodyBudget) {
      keptIdx.add(s.index);
      used += cost;
    }
  }
  const compose = (): PackedWakeText => {
    const kept = sections.filter((s) => keptIdx.has(s.index));
    const omitted = sections.filter((s) => !keptIdx.has(s.index));
    const body = kept.map((s) => s.text).join(SEPARATOR);
    const room = budgetChars - body.length - (body ? SEPARATOR.length : 0);
    const footer = buildOmissionFooter(omitted, doorTokens, spillPath, Math.max(0, room));
    return { text: body ? `${body}${SEPARATOR}${footer}` : footer, kept, omitted, footer };
  };
  let packed = compose();
  // The footer is sized to its reserve, but a pathological omitted set can still overrun:
  // drop the lowest-priority kept section until the whole thing fits.
  while (packed.text.length > budgetChars && keptIdx.size > 0) {
    const victim = [...order].reverse().find((s) => keptIdx.has(s.index))!;
    keptIdx.delete(victim.index);
    packed = compose();
  }
  return packed;
}

/** The spill-file section index: every section, whether it was kept, and its size. */
export function renderSectionIndex(packed: Pick<PackedWakeText, 'kept' | 'omitted'>): string {
  const keptSet = new Set(packed.kept.map((s) => s.index));
  const all = [...packed.kept, ...packed.omitted].sort((a, b) => a.index - b.index);
  return all
    .map((s) => `${s.index + 1}. ${keptSet.has(s.index) ? 'delivered' : 'LEFT OUT'} — "${s.title}" (${s.text.length} chars)`)
    .join('\n');
}

/** Process-local counter for the door (P-026: "marker frequency is not in
 *  tool_invocations; a counter is part of this item"). Read by tests and logs. */
const counters = { packedWakes: 0, omittedSections: 0 };
export function recordWakePack(omittedCount: number): void {
  if (omittedCount <= 0) return;
  counters.packedWakes += 1;
  counters.omittedSections += omittedCount;
}
export function wakePackCounters(): Readonly<typeof counters> {
  return { ...counters };
}
