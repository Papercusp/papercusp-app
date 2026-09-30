/**
 * content-op-egress-guard — EGRESS secrets-guard for federated CONTENT ops
 * (federated-scout-gym-learning-2026-07-02 P-015 / F2-4, D-006 privacy).
 *
 * "Egress redaction on anything we publish": a shareable fact or a federatable
 * QD-elite carries FREE TEXT (a fact `body`, an elite `rationale`) authored by
 * an agent — which can accidentally embed a credential. This guard is the ONE
 * choke where every such op passes through in PLAINTEXT: the outbox drain, right
 * BEFORE the payload is epoch-encrypted and appended to the peer-log. Redacting
 * here (not at the writer) keeps the LOCAL PG row intact — only the wire copy is
 * scrubbed — and covers every content table from a single place.
 *
 * It REUSES the repo secrets-guard (`scanTextForSecrets`) rather than
 * re-implementing secret matching, and redacts secret-bearing LINES wholesale
 * (a credential rarely stands alone — dropping the whole line is the safe grain).
 *
 * FAIL-SOFT by contract: the federation drain must NEVER break on a redaction
 * fault, so every entry point returns the value UNCHANGED on any error and is a
 * no-op for tags without a redactable field or values with no secret.
 */
import { scanTextForSecrets, type SecretFinding } from '../pot-git/secrets-guard';

export const REDACTED_CONTENT_LINE = '[REDACTED secret-bearing content]';

/**
 * Projection `tableTag` → the op-value free-text field the egress guard scans.
 * Keep in sync with the content projections' wire rows:
 *   - 'agent-facts-by-key'     → AgentFactWireRow.body       (projections/agent-facts.ts)
 *   - 'gym-qd-elites-by-niche' → GymQdEliteWireRow.rationale (projections/gym-qd-elites.ts)
 * A tag absent here is not redacted (structured admission/key/policy ops carry
 * no agent-authored prose — REKEY_PLAINTEXT_TAGS — and the other content tables
 * federate machine-generated rows, not free text).
 */
export const CONTENT_OP_REDACT_FIELD: Readonly<Record<string, string>> = {
  'agent-facts-by-key': 'body',
  'gym-qd-elites-by-niche': 'rationale',
};

export interface RedactLinesResult {
  content: string;
  findings: SecretFinding[];
  redacted: boolean;
}

/**
 * Redact secret-bearing LINES of `content` wholesale, replacing each with a
 * marker that names the matched rule(s). A no-op (redacted:false, ORIGINAL
 * content returned unchanged) when nothing matches.
 */
export function redactSecretBearingLines(content: string, path: string): RedactLinesResult {
  const normalized = content.replace(/\r\n?/g, '\n');
  const findings = scanTextForSecrets(path, normalized);
  if (findings.length === 0) return { content, findings, redacted: false };

  const rulesByLine = new Map<number, Set<string>>();
  for (const f of findings) {
    const idx = Math.max(0, f.line - 1);
    const set = rulesByLine.get(idx) ?? new Set<string>();
    set.add(f.rule);
    rulesByLine.set(idx, set);
  }

  const lines = normalized.split('\n');
  for (const [idx, rules] of rulesByLine) {
    if (idx >= lines.length) continue;
    const suffix = [...rules].sort().join(', ');
    lines[idx] = `${REDACTED_CONTENT_LINE}${suffix ? ` (${suffix})` : ''}`;
  }
  return { content: lines.join('\n'), findings, redacted: true };
}

export interface ContentOpEgressResult {
  value: unknown;
  redacted: boolean;
}

/**
 * EGRESS secrets-guard for a federated content op value. Scans the value's
 * free-text field (per {@link CONTENT_OP_REDACT_FIELD}); if a secret is present
 * returns a COPY of the value with the secret-bearing lines redacted, else the
 * value unchanged. Never mutates the caller's object and never touches the local
 * PG row (only the wire copy the drain is about to encrypt).
 *
 * NOTE: the redacted marker can, in the rare case of a secret embedded in a
 * near-max-length fact `body`, push the field past its wire length cap — the
 * receiver validator then drops that op. That is the SAFE failure (a
 * secret-bearing fact that does not federate at all beats leaking the secret);
 * it is not silent to the sender (the caller logs a redaction occurred).
 *
 * FAIL-SOFT: any error returns { value, redacted:false }.
 */
export function redactContentOpValueForEgress(tableTag: string, value: unknown): ContentOpEgressResult {
  try {
    const field = CONTENT_OP_REDACT_FIELD[tableTag];
    if (!field || !value || typeof value !== 'object' || Array.isArray(value)) {
      return { value, redacted: false };
    }
    const rec = value as Record<string, unknown>;
    const text = rec[field];
    if (typeof text !== 'string' || text.length === 0) return { value, redacted: false };
    const res = redactSecretBearingLines(text, `${tableTag}.${field}`);
    if (!res.redacted) return { value, redacted: false };
    return { value: { ...rec, [field]: res.content }, redacted: true };
  } catch {
    return { value, redacted: false };
  }
}
