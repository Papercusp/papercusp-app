/**
 * cert-battery — the model certification battery (local-concurrent-inference-2026-07-02
 * P-006, D-005). Codifies the four behavior probes (behavior · trimmed-shape · comms ·
 * mangling-rate) as a repeatable, DETERMINISTIC harness any (model, quant, num_ctx,
 * parallel, backend) combo runs through. A run certifies a locked config, whose verdict +
 * evidence flip a provisioner/catalog.ts CERTIFIED_CATALOG entry provisional → certified.
 */
export * from './types';
export * from './probes';
export * from './battery';
export * from './chat-client';
