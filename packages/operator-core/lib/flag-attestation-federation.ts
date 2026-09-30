/**
 * Bounded same-box fan-out for flags:attest.
 *
 * Reuses schedule-federation's endpoint-ipc discovery registry instead of
 * inventing another service list. Every probe is fail-soft and individually
 * budgeted: a wedged sibling remains an explicit UNKNOWN row and cannot hang
 * the diagnostic process asking the question.
 */
import type { FlagKey } from '@papercusp/flags';
import {
  DEFAULT_SIBLING_FANOUT_BUDGET_MS,
  DEFAULT_SIBLING_PROBE_TIMEOUT_MS,
  listSiblingOperators,
  type SiblingOperator,
} from './schedule-federation';
import { GATEWAY_FLAG_ATTEST_PATH, OPERATOR_FLAG_ATTEST_PATH, type ProcessFlagAttestation } from './flag-attestation';
import { DEFAULT_GATEWAY_PORT } from './inference-gateway/launch';

export interface FlagAttestationTarget {
  label: string;
  url: string;
  expectedPid: number | null;
}

export interface RemoteFlagAttestationResult {
  target: FlagAttestationTarget;
  ok: boolean;
  attestation: ProcessFlagAttestation | null;
  error?: string;
  elapsedMs: number;
}

type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function targetUrl(base: string, path: string, key: FlagKey, distinctId: string): string {
  const url = new URL(path, base);
  url.searchParams.set('key', key);
  url.searchParams.set('distinctId', distinctId);
  return url.toString();
}

export function operatorFlagAttestationTarget(
  sibling: SiblingOperator,
  key: FlagKey,
  distinctId: string,
): FlagAttestationTarget {
  return {
    label: `operator:${sibling.port}`,
    url: targetUrl(`http://127.0.0.1:${sibling.port}`, OPERATOR_FLAG_ATTEST_PATH, key, distinctId),
    expectedPid: sibling.pid,
  };
}

export function gatewayFlagAttestationTarget(
  key: FlagKey,
  distinctId: string,
  port: number = Number(process.env.PAPERCUSP_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
): FlagAttestationTarget {
  return {
    label: `inference-gateway:${port}`,
    url: targetUrl(`http://127.0.0.1:${port}`, GATEWAY_FLAG_ATTEST_PATH, key, distinctId),
    expectedPid: null,
  };
}

function degraded(target: FlagAttestationTarget, error: string, elapsedMs: number): RemoteFlagAttestationResult {
  return { target, ok: false, attestation: null, error, elapsedMs };
}

function isProcessFlagAttestation(value: unknown, key: FlagKey): value is ProcessFlagAttestation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ProcessFlagAttestation>;
  return (
    row.ok === true &&
    row.key === key &&
    typeof row.resolvedValue === 'boolean' &&
    typeof row.compiledDefault === 'boolean' &&
    Boolean(row.process) &&
    typeof row.process?.label === 'string'
  );
}

/** Probe one target. Never rejects. */
export async function probeFlagAttestation(
  target: FlagAttestationTarget,
  key: FlagKey,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<RemoteFlagAttestationResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SIBLING_PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const response = await fetchImpl(target.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return degraded(target, `HTTP ${response.status}`, Date.now() - startedAt);
    }
    const body = await response.json();
    if (!isProcessFlagAttestation(body, key)) {
      const error =
        body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? String((body as { error: string }).error)
          : 'malformed flag attestation response';
      return degraded(target, error, Date.now() - startedAt);
    }
    if (target.expectedPid !== null && body.process.pid !== target.expectedPid) {
      return degraded(
        target,
        `discovery pid ${target.expectedPid} disagrees with responder pid ${body.process.pid}`,
        Date.now() - startedAt,
      );
    }
    return {
      target,
      ok: true,
      attestation: body,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return degraded(target, error instanceof Error ? error.message : String(error), Date.now() - startedAt);
  }
}

function budgetExpiry<T>(ms: number, value: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value()), ms);
    timer.unref?.();
  });
}

export async function collectRemoteFlagAttestations(
  key: FlagKey,
  distinctId: string,
  opts: {
    siblings?: SiblingOperator[];
    includeGateway?: boolean;
    gatewayPort?: number;
    timeoutMs?: number;
    budgetMs?: number;
    fetchImpl?: FetchLike;
  } = {},
): Promise<RemoteFlagAttestationResult[]> {
  const siblings = opts.siblings ?? (await listSiblingOperators().catch(() => []));
  const targets = siblings.map((sibling) => operatorFlagAttestationTarget(sibling, key, distinctId));
  if (opts.includeGateway !== false) {
    targets.push(gatewayFlagAttestationTarget(key, distinctId, opts.gatewayPort));
  }
  if (targets.length === 0) return [];

  const budgetMs = opts.budgetMs ?? DEFAULT_SIBLING_FANOUT_BUDGET_MS;
  return Promise.all(
    targets.map((target) =>
      Promise.race([
        probeFlagAttestation(target, key, {
          timeoutMs: opts.timeoutMs,
          fetchImpl: opts.fetchImpl,
        }),
        budgetExpiry(budgetMs, () => degraded(target, `probe budget ${budgetMs}ms exceeded`, budgetMs)),
      ]),
    ),
  );
}
