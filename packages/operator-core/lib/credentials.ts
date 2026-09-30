/**
 * Operator credentials storage — PG-backed (migration 020).
 *
 * Persisted in `harness_shared.operator_credentials` (NOT in zero_harness
 * publication — credentials must not be broadcast over WS). Was previously
 * `<papercuspRoot>/credentials.json` with 0600 chmod. PG gives us atomic
 * upsert and central backup; encryption-at-rest can layer on later via
 * pgcrypto if desired.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface Credentials {
  anthropic_api_key?: string;
  openai_api_key?: string;
  /** ZeroEntropy cross-encoder rerank key (@papercusp/rerank). Absent → search reranking is a no-op RRF passthrough. */
  zeroentropy_api_key?: string;
  github_pat?: string;
  updated_at?: string;
}

export async function readCredentials(): Promise<Credentials> {
  const raw = await readOperatorState<Credentials>('operator_credentials');
  return raw ?? {};
}

export async function writeCredentials(creds: Credentials): Promise<Credentials> {
  const next: Credentials = { ...creds, updated_at: new Date().toISOString() };
  await writeOperatorState('operator_credentials', next);

  // Fire the `secret_change` backup trigger — /settings/backups renders it as
  // "After secret change" and it is ON by default (event_triggers_json), but
  // NOTHING emitted it, so the checkbox was inert (settings-audit 2026-07-09).
  // Emitted here rather than at the two call sites (the credentials route and
  // the setup:save_key tool) so every credential write is covered by one
  // chokepoint. Best-effort + errors swallowed, mirroring branch-actions:
  // backup unavailability must never fail a credential save. Fires AFTER the
  // write so the snapshot captures the new secret (cf. `pre_destructive`,
  // which deliberately snapshots BEFORE its op).
  try {
    const [{ triggerSnapshotEvent }, { activeWorkspaceId }] = await Promise.all([
      import('./backup'),
      import('./workspace-registry'),
    ]);
    await triggerSnapshotEvent(activeWorkspaceId(), 'secret_change', {
      op: 'credentials_write',
      keys: Object.keys(creds).filter((k) => k !== 'updated_at'), // names only — never values
    }).catch(() => { /* ignore */ });
  } catch { /* backup module not loaded — fine */ }

  return next;
}

/**
 * Mask a secret to last-4 form: "sk-ant-...AbCd".
 * Returns null if the input is empty/missing.
 */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value || value.length < 8) return null;
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

export function maskCredentials(creds: Credentials) {
  return {
    anthropic_api_key: maskSecret(creds.anthropic_api_key),
    openai_api_key: maskSecret(creds.openai_api_key),
    zeroentropy_api_key: maskSecret(creds.zeroentropy_api_key),
    github_pat: maskSecret(creds.github_pat),
    updated_at: creds.updated_at ?? null,
    path: 'harness_shared.operator_credentials',
  };
}

/** @deprecated returns table name now — kept for legacy callers that want a display path */
export function CREDENTIALS_PATH() { return 'harness_shared.operator_credentials'; }
