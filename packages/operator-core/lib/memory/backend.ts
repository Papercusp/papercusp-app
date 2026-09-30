/**
 * Operator deep-path shim for the neutral memory backend.
 *
 * Imports `./configure` for its side-effect (wiring the operator host
 * seams + the `PAPERCUSP_MEMORY_BACKEND` selector) and re-exports the
 * swappable-store surface from `@papercusp/memory`, so every operator
 * consumer of memory goes through `getMemoryBackend()` with the host
 * guaranteed configured — the same pattern as ./mem0-client.
 *
 * Consumers MUST NOT import mem0-shaped APIs for store access anymore;
 * `./mem0-client` remains only for mem0-internal diagnostics (the
 * memory suite, re-embed, getResolvedMode).
 *
 * Part of generalize-memory-backend-swappable-2026-06-05 (D-002/D-003).
 */

import './configure';

export {
  getMemoryBackend,
  registerMemoryBackend,
  registeredMemoryBackends,
  MemoryUnavailableError,
  scopesOf,
  type ListOptions,
  type MemoryAvailability,
  type MemoryBackend,
  type LegRunStats,
  type MemoryEntry,
  type RetrievalProvenance,
  type ScoreScale,
  type SearchLegStats,
  type RememberOptions,
  type SearchOptions,
  type UpdatePatch,
} from '@papercusp/memory';
