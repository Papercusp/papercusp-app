/**
 * GET  /api/desktop/telemetry-report — read the stored report ring.
 * POST /api/desktop/telemetry-report — accept an anonymized crash /
 *   diagnostic report (rejected with 403 when telemetry is disabled).
 *
 * Ported from app/api/desktop/telemetry-report/route.ts. `auth: {}`.
 */
import { readOperatorState } from '../../../operator-state-pg';
import { recordTelemetryReport, type StoredTelemetryReport } from '../../../record-telemetry';
import { defineTool } from '@papercusp/agent-mcp';

const REPORTS_KEY = 'telemetry_reports';
const WIZARD_KEY = 'setup_wizard_state';

interface ReportsState {
  reports: StoredTelemetryReport[];
}

/** Ingress allows this one local crash signal without telemetry opt-in.
 * Rebuild the object from a strict allowlist so raw messages/stacks/URLs
 * cannot be smuggled through extra JSON fields or a supplied fingerprint. */
export function normalizeRenderCrashPayload(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.source !== 'render-boundary') return null;
  const boundary = input.boundary;
  if (boundary !== 'route' && boundary !== 'adv-tab') return null;
  const errorType = input.errorType;
  if (!['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError'].includes(String(errorType))) return null;
  const component = input.component;
  if (typeof component !== 'string' || !/^(?:unknown|[A-Za-z][A-Za-z0-9_.$-]{0,79})$/.test(component)) return null;
  const tab = input.tab;
  if (typeof tab !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(tab)) return null;
  const safeTab = boundary === 'route' ? 'other' : tab;
  return {
    source: 'render-boundary', boundary, errorType: String(errorType),
    component, tab: safeTab,
    fingerprint: `${boundary}:${errorType}:${component}:${safeTab}`,
  };
}

function defaults(): ReportsState {
  return { reports: [] };
}

const get = defineTool({
  method: 'GET',
  path: '/desktop/telemetry-report',
  auth: {},
  async handler() {
    const state = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? defaults();
    return Response.json(state);
  },
});

const post = defineTool({
  method: 'POST',
  path: '/desktop/telemetry-report',
  auth: {},
  async handler(req) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'invalid body' }, { status: 400 });
    }
    const kind = typeof body.kind === 'string' ? body.kind : 'unknown';
    if (kind.length > 64) return Response.json({ error: 'kind too long' }, { status: 400 });
    const claimsRenderCrash = kind === 'crash' &&
      body.payload !== null && typeof body.payload === 'object' &&
      !Array.isArray(body.payload) &&
      (body.payload as Record<string, unknown>).source === 'render-boundary';
    const renderCrash = kind === 'crash' ? normalizeRenderCrashPayload(body.payload) : null;
    if (claimsRenderCrash && !renderCrash) {
      return Response.json({ error: 'invalid render crash payload' }, { status: 400 });
    }
    const wizard = await readOperatorState<{ telemetry_enabled?: boolean }>(WIZARD_KEY);
    if (!wizard?.telemetry_enabled && !renderCrash) {
      return Response.json({ error: 'telemetry disabled' }, { status: 403 });
    }
    if (renderCrash) {
      const current = await readOperatorState<ReportsState>(REPORTS_KEY);
      const duplicate = current?.reports.some((report) => {
        if (report.kind !== 'crash' || !report.payload || typeof report.payload !== 'object') return false;
        const prior = report.payload as Record<string, unknown>;
        return prior.fingerprint === renderCrash.fingerprint &&
          Date.now() - Date.parse(report.received_at) < 5 * 60_000;
      });
      if (duplicate) return Response.json({ ok: true, deduped: true });
    }
    // Soft-validate against the known taxonomy. Unknown kinds are stored
    // but flagged so analysis can spot wire drift.
    let knownKind = false;
    try {
      const { isTelemetryKind } = await import('../../../telemetry-kinds');
      knownKind = isTelemetryKind(kind);
    } catch { /* taxonomy module unavailable — fail-open */ }

    // Enqueue via the shared server-side helper (single ring-buffer impl,
    // reused by operator-internal emitters like the substrate admission path).
    const stored = await recordTelemetryReport({
      kind,
      app_version: typeof body.app_version === 'string' ? body.app_version : undefined,
      os: typeof body.os === 'string' ? body.os : undefined,
      payload: renderCrash ?? (knownKind
        ? (body.payload ?? null)
        : { _wireDrift: true, kind, original: body.payload ?? null }),
    });
    return Response.json({ ok: true, stored });
  },
});

export default [get, post];
