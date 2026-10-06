/**
 * Checks that a plan Decision records a same-run verdict for every variant a
 * plan built (jev-performance-improvements-2026-09-30, bar R-1 / P-007).
 *
 * The Decision is prose, so this reads it the way a reviewer would, one rule
 * per requirement:
 *   - every in-scope plan item is either a built variant or a dropped item,
 *     never both and never neither;
 *   - the Decision says its v1 baselines come from the same runs;
 *   - the admission and robustness run sentences each cite a report stamp for
 *     v1 and for every built variant;
 *   - every built variant has its own verdict paragraph (pass or fail);
 *   - every dropped item is named together with the Decision that dropped it;
 *   - the outcome names the adopted variant and its threshold ("adopts X at threshold N",
 *     X a built variant) or keeps the baseline ("keeps B at threshold N"), so a caller can
 *     compare them with what production runs.
 */

export interface BuiltVariant {
  readonly variant: string;
  readonly item: string;
}

export interface DroppedItem {
  readonly item: string;
  readonly decisionId: string;
}

export interface VerdictRecordInput {
  readonly body: string;
  readonly itemsInScope: readonly string[];
  readonly built: readonly BuiltVariant[];
  readonly dropped: readonly DroppedItem[];
  /**
   * The production variant the built variants were measured against, when it is not v1
   * (a later Decision measures against what an earlier one adopted, e.g. D-008 against
   * D-004's v2-content). Its reports must be cited like any variant's, and an Outcome may
   * then KEEP it ("production keeps <baseline> at threshold N") when no built variant wins.
   */
  readonly baseline?: string;
}

export interface VerdictRecordCheck {
  readonly pass: boolean;
  readonly reasons: readonly string[];
  /** The variant named in the Outcome paragraph, or null. */
  readonly adoptedVariant: string | null;
  /** The threshold named in the Outcome paragraph, or null. */
  readonly adoptedThreshold: number | null;
}

/** A bench report stamp, e.g. `T16-56-25-178Z` or `...2026-09-30T16-53-16-130Z`. */
const STAMP = String.raw`\S*T\d{2}-\d{2}-\d{2}-\d{3}Z`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function citesStamp(sentence: string, variant: string): boolean {
  return new RegExp(String.raw`(^|[\s(,])${escape(variant)}\s+${STAMP}`).test(sentence);
}

export function checkVerdictRecord(input: VerdictRecordInput): VerdictRecordCheck {
  const reasons: string[] = [];
  const builtItems = new Set(input.built.map((b) => b.item));
  const droppedItems = new Set(input.dropped.map((d) => d.item));

  for (const item of input.itemsInScope) {
    if (builtItems.has(item) && droppedItems.has(item)) reasons.push(`${item} is listed as both built and dropped`);
    else if (!builtItems.has(item) && !droppedItems.has(item)) reasons.push(`${item} is neither a built variant nor a dropped item`);
  }
  for (const item of [...builtItems, ...droppedItems]) {
    if (!input.itemsInScope.includes(item)) reasons.push(`${item} is outside the items in scope`);
  }

  if (!/same-run v1 baselines?/i.test(input.body)) reasons.push('the Decision does not say its v1 baselines come from the same runs');

  const paras = paragraphs(input.body);
  const runs = paras.find((p) => /^Runs:/.test(p)) ?? '';
  const sentences = runs.split(/(?<=\.)\s+(?=[A-Z])/);
  const admission = sentences.find((s) => /admission/i.test(s)) ?? '';
  const robustness = sentences.find((s) => /robustness/i.test(s)) ?? '';
  if (!runs) reasons.push('the Decision has no "Runs:" paragraph');
  const baseline = input.baseline && input.baseline !== 'v1' ? [input.baseline] : [];
  for (const variant of ['v1', ...baseline, ...input.built.map((b) => b.variant)]) {
    if (!citesStamp(admission, variant)) reasons.push(`no admission report cited for ${variant}`);
    if (!citesStamp(robustness, variant)) reasons.push(`no robustness report cited for ${variant}`);
  }

  for (const { variant } of input.built) {
    const own = paras.find((p) => p.startsWith(variant));
    if (!own) reasons.push(`no verdict paragraph for ${variant}`);
    else if (!/\b(pass(es)?|fails?)\b/i.test(own)) reasons.push(`the ${variant} paragraph states no pass/fail verdict`);
  }

  for (const { item, decisionId } of input.dropped) {
    const named = new RegExp(String.raw`\(${escape(item)}\)[^\n]*dropped[^\n]*\(${escape(decisionId)}\)|\(${escape(item)}\)[^\n]*\(${escape(decisionId)}\)`);
    if (!named.test(input.body)) reasons.push(`dropped ${item} is not named with ${decisionId}`);
  }

  const outcome = paras.find((p) => /^Outcome:/.test(p)) ?? '';
  const adopted = /\b(adopts|keeps)\s+(\S+)\s+at threshold\s+(\d+(?:\.\d+)?)/.exec(outcome);
  if (!adopted) reasons.push('the Outcome paragraph names no adopted variant and threshold');
  const verb = adopted?.[1] ?? null;
  const adoptedVariant = adopted?.[2] ?? null;
  if (verb === 'adopts' && adoptedVariant !== null && !input.built.some((b) => b.variant === adoptedVariant)) {
    reasons.push(`adopted variant ${adoptedVariant} is not one of the built variants`);
  }
  if (verb === 'keeps' && adoptedVariant !== null && adoptedVariant !== (input.baseline ?? 'v1')) {
    reasons.push(`kept variant ${adoptedVariant} is not the baseline ${input.baseline ?? 'v1'}`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    adoptedVariant,
    adoptedThreshold: adopted ? Number(adopted[3]) : null,
  };
}
