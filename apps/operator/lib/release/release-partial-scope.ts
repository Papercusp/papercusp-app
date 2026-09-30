/**
 * The registry's record that a release shipped an owner-approved PARTIAL desktop
 * scope (e.g. Windows 0.0.23 alone, owner #832).
 *
 * record-release writes it into `releases.notes` when an owner directive approves
 * the missing platforms; finalize-release requires it before publishing a partial
 * row, and the releases page uses it to fold the release into the card of the full
 * release it patches (WI-10003687). One writer and its readers share this module so
 * the format cannot drift between them.
 *
 * Dependency-free on purpose: the page renderer imports it, and that renderer is
 * reached from modules that must not load operator-core.
 */
const PARTIAL_SCOPE_NOTE = /\bowner-approved partial desktop scope by directive #(\d+)\b/u;

/** The `releases.notes` text recording an owner-approved partial desktop scope. */
export function partialScopeApprovalNote(directiveId: number): string {
  return `owner-approved partial desktop scope by directive #${directiveId}`;
}

/** The approving owner directive id, or null when the row records no partial scope. */
export function partialScopeApprovalDirectiveId(notes: string | null): number | null {
  const match = notes?.match(PARTIAL_SCOPE_NOTE);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
