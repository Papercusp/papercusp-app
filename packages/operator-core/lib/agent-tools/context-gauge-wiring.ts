/**
 * Wire tooldef's result-annotator seam to Papercusp's banded context-usage gauge
 * (agent-managed-compaction-2026-07-01 P-013 / D-009 — the L1 ambient-awareness layer).
 *
 * `@papercusp/tooldef`'s dispatch invoke-step calls the host-registered annotator on
 * EVERY settled result; the default is a no-op (the library can't see host presence /
 * identity). The HOST owns the policy, so the annotator is registered HERE — imported as
 * a side-effect at startup (see `agent-tools/index.ts`), the same shape as
 * `delta-flag-wiring.ts`. The annotator LOGIC lives in context-gauge-annotator.ts (pure,
 * unit-testable without this registration).
 *
 * Runtime kill-switch: FLAGS.CONTEXT_GAUGE (default ON). The annotator is on a SYNC hot
 * path, so it reads a mirror the watchdog refreshes from the flag each 2-min pass rather
 * than paying an async flag read per call (see context-usage-cache.ts).
 */

import { setResultAnnotator } from '@papercusp/agent-mcp';
import { contextGaugeAnnotator } from './context-gauge-annotator';

setResultAnnotator(contextGaugeAnnotator);
