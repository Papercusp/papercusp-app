/**
 * potHomeLabel — strip the `-hive` home suffix for DISPLAY
 * (workspace-hive-ui-2026-06-17).
 *
 * A pot HOME's slug is canonically `<base>-hive`: repo-less coordinator
 * plumbing that owns the Queen + the federation identity. Its MEMBERS (the
 * repos) never carry the suffix. The `-hive` machinery is a backend concept —
 * the user should see the friendly `<base>` everywhere in the UI.
 *
 * KEEP the trailing `-hive` suffix and the `/-hive$/` regex EXACTLY as-is —
 * `-hive` is a PERSISTED slug convention (Slice H territory), not display-only
 * lexicon residue from the hive→pot rename. This helper strips it for DISPLAY
 * only; the raw `-hive`-suffixed slug remains the real id/value everywhere else.
 *
 * This strips ONLY a trailing `-hive` (members never end in it, so a member
 * slug passes through untouched). The raw slug stays the id/value for every
 * backend call — ONLY the rendered label is stripped.
 */
export function potHomeLabel(slug: string | null | undefined): string {
  if (!slug) return '';
  return slug.replace(/-hive$/, '');
}
