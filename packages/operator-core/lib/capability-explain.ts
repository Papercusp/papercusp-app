/**
 * Plain-English labels for capability strings used in the consent UI.
 *
 * Capabilities are namespace:action[:resource] with subdomain (`*.host`)
 * and suffix (`prefix:*`) wildcards. We return a one-line label suitable
 * for a checkbox row. Anything we don't have an explicit rule for falls
 * back to a humanised version of the cap string itself.
 */

import { lookupTier, type CapabilityTier } from '@papercusp/plugin-sdk';

export interface CapabilityExplanation {
  cap: string;
  label: string;
  tier: CapabilityTier;
}

const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^tasks:(read|list)$/i, () => 'Read your tasks'],
  [/^tasks:write$/i, () => 'Create, edit, or delete tasks'],
  [/^features:(read|list)$/i, () => 'Read your features'],
  [/^features:write$/i, () => 'Create, edit, or delete features'],
  [/^messages:(read|inbox|outbox)$/i, () => 'Read messages between harnesses'],
  [/^messages:(write|send)$/i, () => 'Send messages to other harnesses'],
  [/^projects:(read|list)$/i, () => 'List your harnesses / projects'],
  [/^harness:(list|get|status)$/i, () => 'Inspect harness state and status'],
  [/^harness:dispatch:(.+)$/i, (m) => `Run dispatch action "${m[1]}" on the harness`],
  [/^audit:list$/i, () => 'Read the plugin audit log'],
  [/^search:query$/i, () => 'Run searches across harness content'],
  [/^secrets:read:(.+)$/i, (m) => `Read secret "${m[1]}"`],
  [/^secrets:write:(.+)$/i, (m) => `Write secret "${m[1]}"`],
  [/^http:fetch:(.+)$/i, (m) => `Make HTTP requests to ${m[1] === '*' ? 'any host' : m[1]}`],
  [/^compute:exec:(.+)$/i, (m) => `Execute the binary "${m[1]}"`],
  [/^events:emit:(.+)$/i, (m) => `Emit "${m[1]}" events`],
  [/^events:on:(.+)$/i, (m) => `Listen for "${m[1]}" events`],
  [/^kv:read:(.+)$/i, (m) => `Read its own key-value store (namespace ${m[1]})`],
  [/^kv:write:(.+)$/i, (m) => `Write to its own key-value store (namespace ${m[1]})`],
  [/^data:read:(.+):(.+)$/i, (m) => `Read ${m[1]} data (${m[2]})`],
  [/^data:write:(.+):(.+)$/i, (m) => `Write ${m[1]} data (${m[2]})`],
  [/^routines:(read|list)$/i, () => 'Read your routines'],
  [/^routines:write$/i, () => 'Create, edit, or delete routines'],
];

function humanise(cap: string): string {
  // namespace:action[:resource] → "namespace action resource"
  return cap.split(':').filter(Boolean).join(' ');
}

function explainTier(cap: string): CapabilityTier {
  return lookupTier(cap) ?? 'low';
}

export function explainCapability(cap: string): CapabilityExplanation {
  for (const [re, fn] of RULES) {
    const m = cap.match(re);
    if (m) return { cap, label: fn(m), tier: explainTier(cap) };
  }
  return { cap, label: humanise(cap), tier: explainTier(cap) };
}

export function tierBadgeColor(tier: CapabilityTier): string {
  if (tier === 'high') return 'var(--bad, #dc2626)';
  if (tier === 'medium') return 'var(--warn, #d97706)';
  return 'var(--muted, #6b7280)';
}
