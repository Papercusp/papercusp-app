/**
 * Coarse write-origin of a memory row, derived from the stamps that already
 * exist (EI-10363):
 *  - settings-page writes stamp `source: 'settings-page'` (routes/user/memory.ts
 *    stamps it on both the create and the patch-journal path) — authorship
 *    outranks the `recovered_from` delivery detail when both are present;
 *  - the write-ahead journal drain / transcript miner stamp `recovered_from`;
 *  - the dominant agent path (memory:remember) stamps `source: 'agent'` PLUS
 *    (when available) `source_role` / `source_session` — real per-session
 *    attribution, landed EI-10358. `ctx.role`/`ctx.uiClientId` were already
 *    threaded onto every tool ctx by the MCP dispatch layer; the fix was
 *    reading them in the handler, not new plumbing. A row written before
 *    this landed (or via a transport that never set uiClientId/role) still
 *    falls back to the bare 'agent' bucket below with no per-session detail.
 */
export type MemoryOrigin = 'you' | 'recovered' | 'agent';

export function originOf(row: { metadata?: Record<string, unknown> }): MemoryOrigin {
  const meta = row.metadata ?? {};
  if (meta.source === 'settings-page') return 'you';
  if (typeof meta.recovered_from === 'string') return 'recovered';
  return 'agent';
}

/**
 * Per-session detail for an 'agent'-origin row (EI-10358) — the role and
 * session id the write was stamped with, when present. Rows written before
 * this landed (or via a transport that never set uiClientId/role) carry
 * neither field; callers should fall back to the generic "agent" label.
 */
export interface AgentSourceDetail {
  role: string | null;
  session: string | null;
}

export function agentSourceDetailOf(row: { metadata?: Record<string, unknown> }): AgentSourceDetail {
  const meta = row.metadata ?? {};
  return {
    role: typeof meta.source_role === 'string' ? meta.source_role : null,
    session: typeof meta.source_session === 'string' ? meta.source_session : null,
  };
}
