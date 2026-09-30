'use client';

/**
 * ProvisionStream — read-only view of a (harness, plugin) provision audit-log
 * stream.
 *
 * Subscribes to `/api/provision/stream?harness=&plugin=&runId=` (SSE) and
 * renders it as STRUCTURE via the shared <StructuredStreamView>: a typed step
 * list (setup/teardown/verify phases with ✓/✗/running + duration + latest
 * progress), with the raw stdout/stderr one click away in a drawer (the xterm
 * escape hatch). It used to flatten the same typed event stream into opaque
 * xterm bytes — structure thrown away on purpose; this restores it.
 *
 * Plan: structured-streams-not-terminals-2026-06-05 (D-003). The step
 * projection + raw-line ANSI renderer live in `provision-stream-steps.ts`
 * (pure, unit-tested); this component is now just the wiring.
 *
 * Currently has no mounted caller: its last consumer (the snapshot-fork
 * ForkProvisioningProgress flow) was retired with the snapshot system
 * (_retired/snapshot-system/). Kept as the canonical viewer for the live
 * /api/provision/stream feed. Calls onDone(outcome) when the server emits a
 * terminal event.
 */

import { StructuredStreamView } from './StructuredStreamView';
import {
  PROVISION_EVENT_KINDS,
  classifyProvisionTerminal,
  deriveProvisionSteps,
  renderProvisionRawLine,
} from './provision-stream-steps';

export interface ProvisionStreamProps {
  /** Harness slug. */
  harness: string;
  /** Plugin slug (e.g. "@papercupai/cloudflare-stack"). */
  plugin: string;
  /** Optional runId to scope the stream to a specific run. */
  runId?: string;
  /** Called once on terminal event with the outcome. */
  onDone?: (outcome: { kind: 'success' | 'failed' | 'closed'; finalKind?: string }) => void;
  /** ISO timestamp; only events strictly after this time are streamed. */
  since?: string;
  /** Approximate raw-drawer terminal height in rows. Default 24. */
  rows?: number;
}

export function ProvisionStream({
  harness,
  plugin,
  runId,
  onDone,
  since,
  rows = 24,
}: ProvisionStreamProps) {
  if (!harness || !plugin) return null;
  const params = new URLSearchParams({ harness, plugin });
  if (runId) params.set('runId', runId);
  if (since) params.set('since', since);
  const url = `/api/provision/stream?${params}`;

  return (
    <StructuredStreamView
      url={url}
      eventKinds={PROVISION_EVENT_KINDS}
      deriveSteps={deriveProvisionSteps}
      formatRawLine={renderProvisionRawLine}
      classifyTerminal={classifyProvisionTerminal}
      controlKinds={{ attached: 'attached', done: 'done' }}
      onDone={onDone}
      caption={`provision: ${plugin} @ ${harness}${runId ? ` · ${runId}` : ''}`}
      rawRows={rows}
    />
  );
}
