/**
 * The refusal hint a work_items door returns for a row that is not agent work by CATEGORY
 * (nature 'work' AND audience 'agent' — enterprise-data-sources-2026-10-01 D-024, D-035).
 *
 * Spelled once so the by-id claim, the set_state / complete doors, and the S36 scenario
 * world that mirrors them (D-039) return the same words and cannot drift apart. The module
 * imports nothing, so an LLM-scenario world can use it without loading the DB layer.
 */

function notAgentWorkHint(nature: string, audience: string | null, refused: string): string {
  return (
    `This row is nature '${nature}'${audience ? `, audience '${audience}'` : ''}, ` +
    `not agent work (nature 'work', audience 'agent'), so no agent ${refused}. ` +
    'Do not retry. A human-audience item is acted on by its owner; a record, document or event is data to read, not work.'
  );
}

/** The by-id claim's refusal hint (D-024). */
export function notAgentWorkClaimHint(nature: string, audience: string | null): string {
  return notAgentWorkHint(nature, audience, 'can claim it, by id or otherwise');
}

/** The set_state / complete door's refusal hint (D-035). `door` is the refusing tool's name. */
export function notAgentWorkDoorHint(door: string, nature: string, audience: string | null): string {
  return notAgentWorkHint(
    nature,
    audience,
    `may change its state or complete it through ${door} — the same rule that refuses it at the by-id claim`,
  );
}
