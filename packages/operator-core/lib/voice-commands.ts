/**
 * Voice command parser (Phase 1a of voice-mode plan v4).
 *
 * Pure parser — no NLU. Strict literal prefix matching with ordinal
 * extraction. Same input both panel-open commands and chrome-resident
 * intents consume.
 *
 * Grammar (case-insensitive, post-trim):
 *   cancel                                  → { kind: 'cancel' }
 *   scan [...rest]                          → { kind: 'scan', query? }
 *   rescan | re-scan | scan again           → { kind: 'scan' }
 *   pause                                   → { kind: 'pause' }
 *   resume | unpause                        → { kind: 'resume' }
 *   approve <slug> [<capability>]           → handled by voice-intents (operator-prefixed)
 *   <anything else, ≥2 chars>               → { kind: 'freeform', text }
 *
 * (`dispatch`/`dismiss <ordinal>` were operator-card verbs — removed with
 * the card stream, unify-agent-launches D-005.)
 */

export type VoiceCommand =
  | { kind: 'cancel' }
  | { kind: 'scan'; query?: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'freeform'; text: string };

export function parseVoiceCommand(utterance: string): VoiceCommand {
  const norm = utterance.trim();
  if (norm.length < 2) return { kind: 'freeform', text: norm };

  const lower = norm.toLowerCase();

  // Compound forms first.
  if (lower === 'rescan' || lower === 're-scan' || lower === 'scan again' || lower === 'rerun scan') {
    return { kind: 'scan' };
  }

  // Single-word commands.
  if (lower === 'cancel') return { kind: 'cancel' };
  if (lower === 'pause') return { kind: 'pause' };
  if (lower === 'resume' || lower === 'unpause') return { kind: 'resume' };

  // scan <query>
  const scanMatch = lower.match(/^scan\s+(.+)$/);
  if (scanMatch) return { kind: 'scan', query: norm.slice(5).trim() };
  if (lower === 'scan') return { kind: 'scan' };

  // Anything else falls through to freeform.
  return { kind: 'freeform', text: norm };
}
