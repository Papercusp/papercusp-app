/**
 * Reconcile improvements:capture's two spellings of the same thing: the canonical
 * `scope` ('harness:<slug>') and the `harness` compatibility alias.
 *
 * EI-20309391070582534 (+ EI-20305153016484582 / EI-20304390675052167 /
 * EI-20304745402712144, four independent filings in one day): the handler compared
 * the raw `scope` string against the ALREADY-NORMALIZED `harness:<slug>` and threw on
 * any difference, so `scope:'papercusp' + harness:'papercusp'` — the same pot, named
 * twice — bounced the WHOLE capture and the finding was lost. The same guard also
 * bounced `scope:'coordination'`, `scope:'papercusp-su'`, `scope:'papercusp-workspace'`
 * — callers reading `scope` as a subject AREA, which is a spelling mistake, never an
 * ambiguity about where the item files.
 *
 * The guard exists for one real hazard: a caller naming TWO DIFFERENT POTS. Only a
 * `harness:<slug>` value names a pot (capture-core homes anything else to the platform
 * Pot), so that is the only case that can conflict, and the only case still refused.
 * Everything else resolves and warns — the EI-10943 discipline already applied to
 * `foundDuring` in this same tool: a capture is never lost to a validation bounce.
 */

const HARNESS_PREFIX = 'harness:';

export type CaptureScopeResolution = {
  /** The scope to file under; undefined means "let capture-core auto-home it". */
  scope?: string;
  /** Non-fatal: the caller's `scope` did not name a pot and was superseded. */
  warning?: string;
  /** Fatal: `scope` and `harness` name two different pots. */
  conflict?: string;
};

/** The pot a value NAMES, or null when it names no pot. */
function potSlugOf(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith(HARNESS_PREFIX)) return null;
  return trimmed.slice(HARNESS_PREFIX.length).trim() || null;
}

export function resolveCaptureScope(input: { scope?: string; harness?: string }): CaptureScopeResolution {
  const scope = input.scope?.trim() || undefined;
  // The `harness` alias is a harness name by definition, so accept it either bare or
  // already prefixed rather than producing a 'harness:harness:foo'.
  const harnessSlug = potSlugOf(input.harness) ?? input.harness?.trim() ?? undefined;
  const harnessScope = harnessSlug ? `${HARNESS_PREFIX}${harnessSlug}` : undefined;

  if (!harnessScope) return { scope };
  if (!scope) return { scope: harnessScope };

  const scopePot = potSlugOf(scope);
  if (scopePot && scopePot !== harnessSlug) {
    return {
      conflict:
        `conflicting capture scopes: scope '${scope}' and harness '${input.harness?.trim()}' name two different Pots ` +
        `('${scopePot}' vs '${harnessSlug}'). Pass the owning Pot once — either scope:'${harnessScope}' or harness:'${harnessSlug}'.`,
    };
  }
  // Same pot, named twice (scope:'harness:foo' + harness:'foo', or the unprefixed
  // scope:'foo' + harness:'foo' that four filings hit). No ambiguity — normalize.
  if (scopePot === harnessSlug || scope === harnessSlug) return { scope: harnessScope };

  return {
    scope: harnessScope,
    warning:
      `scope '${scope}' does not name a Pot (a Pot scope is spelled '${HARNESS_PREFIX}<slug>'), so it was ignored; ` +
      `the item filed under '${harnessScope}' from the \`harness\` alias. ` +
      `If you meant a different Pot, pass scope:'${HARNESS_PREFIX}${scope}'; if you meant a subject area, use \`subTopic\`.`,
  };
}
