/**
 * Resolve the operator HTTP ORIGIN the llm-testing targets POST to.
 *
 * Two env vars, two meanings (memory-backend-benchmark P-009 found the
 * collision live):
 *   - `PAPERCUSP_LLM_TEST_OPERATOR_URL` — llm-testing-specific override;
 *     used verbatim (sans trailing slash).
 *   - `PAPERCUSP_OPERATOR_URL` — the FLEET-WIDE var, whose established
 *     meaning elsewhere (psu-launcher, coord hooks, console-launcher,
 *     dev .env.local) is the operator's *MCP endpoint*
 *     (`http://…:3070/api/mcp`). The targets need the bare origin, so a
 *     path-bearing value here used to produce
 *     `…/api/mcp/api/agent-mcp/operator-converse` → HTTP 404 on every
 *     scenario. We keep honoring it as a fallback but strip it to its
 *     origin.
 */

export function llmTestBaseUrl(): string | undefined {
  const specific = process.env.PAPERCUSP_LLM_TEST_OPERATOR_URL;
  if (specific && specific.trim()) return specific.trim().replace(/\/+$/, '');
  const fleet = process.env.PAPERCUSP_OPERATOR_URL;
  if (!fleet || !fleet.trim()) return undefined;
  try {
    return new URL(fleet.trim()).origin;
  } catch {
    return fleet.trim().replace(/\/+$/, '');
  }
}
