/**
 * Shared substrate rules for the mug/kettle recurrence guard.
 *
 * `SUBSTRATE_SYMBOLS` is consulted only for the census's function-call detector;
 * `SUBSTRATE_UI` is the separately keyed, reason-carrying file-level lane for live
 * pot-named UI that does not offer the retired tier. Keeping the validation and
 * remediation wording here makes those scopes executable instead of leaving them
 * as an implicit convention in two scripts.
 */

/**
 * Return entries that the census cannot consult because they are not in the detector's
 * function vocabulary. A name-keyed system action must never be added to this set:
 * it would look exempt while changing no census result.
 */
export function findDanglingSubstrateSymbols(symbols, detectorFunctionNames) {
  const known = new Set(detectorFunctionNames);
  return [...symbols].filter((symbol) => !known.has(symbol));
}

/**
 * Build the remediation lines for new ungated findings.
 *
 * `wake` findings use the function-name-keyed SUBSTRATE_SYMBOLS exemption. `ui`
 * findings have their own basename-keyed SUBSTRATE_UI lane. Other categories,
 * especially `system-action`, use a different identity and must be kept in the
 * reviewed baseline when intentionally ungated (or gated when not).
 */
export function substrateRemediationLines(findings) {
  const categories = [...new Set(findings.map((finding) => finding.category))];
  const lines = [];

  if (categories.includes('wake')) {
    lines.push(
      "For wake/function-call findings, a genuine shared-substrate site belongs in the census's SUBSTRATE_SYMBOLS — not in this baseline.",
    );
  }

  const hasSubstrateUi = findings.some(
    (finding) => finding.category === 'ui' && finding.substrate === true,
  );
  const hasUngatedUi = findings.some(
    (finding) => finding.category === 'ui' && finding.substrate !== true,
  );
  if (hasSubstrateUi) {
    lines.push(
      "For ui findings, read the component: a live pot-named surface that does NOT offer Mug/Kettle/Cup belongs in the census's reason-carrying SUBSTRATE_UI map — not in this baseline; otherwise gate it.",
    );
  }

  const nameKeyedCategories = categories.filter(
    (category) =>
      category !== 'wake' && (category !== 'ui' || hasUngatedUi),
  );
  if (nameKeyedCategories.length > 0) {
    lines.push(
      `For ${nameKeyedCategories.join(', ')} findings, SUBSTRATE_SYMBOLS is function-name keyed and cannot express those names. If the site is intentionally ungated, keep its category/subject/path identity in the reviewed baseline; otherwise gate it. Do not add a name-keyed finding to SUBSTRATE_SYMBOLS.`,
    );
  }

  return lines;
}
