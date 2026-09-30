'use client';

import { useEffect, useState } from 'react';

import { Checkbox } from '../../harness/Checkbox';

/* Mirrors provisioner/hardware-detect.ts + recommend.ts + provision.ts's ProvisionPlan shape
 * (local-concurrent-inference-2026-07-02 P-009, D-006). Kept as a small local shape rather than
 * importing operator-core types into a client component — this step only reads a handful of
 * fields off the JSON the route already serializes. */
interface GpuInfo {
  vendor: string;
  model?: string;
  vramGB?: number;
  unifiedMemory?: boolean;
}
interface DetectedHardware {
  platform: string;
  arch: string;
  ramGB: number;
  gpu: GpuInfo | null;
  notes: string[];
}
interface CatalogEntry {
  id: string;
  displayName: string;
  backend: string;
  status: 'provisional' | 'certified';
  model: { ollamaRef: string; quant: string; sizeGB: number };
}
interface Recommendation {
  entry: CatalogEntry | null;
  tier: string;
  reason: string;
}
interface WeightsPlan {
  needsDownload: boolean;
  weightsPath?: string;
  pullHint?: string;
  detail: string;
}
interface ProvisionPlan {
  hardware: DetectedHardware;
  recommendation: Recommendation;
  weights: WeightsPlan | null;
  backendId: string;
  unitFilePath: string;
  blocked: string | null;
}
interface ApplyResult {
  ok: boolean;
  wroteUnit: boolean;
  registered: boolean;
  started: boolean;
  error?: string;
}

export function StepLocalModel() {
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<ApplyResult | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [starting, setStarting] = useState(false);

  const refresh = async () => {
    try {
      const r = await fetch('/api/desktop/local-model-status', { cache: 'no-store' });
      const j = (await r.json()) as { ok: boolean; plan?: ProvisionPlan; error?: string };
      if (j.ok && j.plan) {
        setPlan(j.plan);
        setStatusError(null);
      } else {
        setStatusError(j.error ?? 'unknown error');
      }
    } catch (e: any) {
      setStatusError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Detection is read-only (nvidia-smi / blob-store stat) — cheap enough to poll while the
    // step is visible, same cadence as the other SetupWizard status steps.
    const id = setInterval(() => void refresh(), 10000);
    return () => clearInterval(id);
  }, []);

  const doInstall = async (start: boolean) => {
    if (start) setStarting(true);
    else setInstalling(true);
    setInstallError(null);
    try {
      // provisionBinary:true (WI-1617/D-009 #2) — resolve a real llama-server binary (a cached
      // hit is fast; a first-time prebuilt-asset download or from-source build genuinely takes
      // real minutes) instead of assuming one is already on the user's PATH. Safe to send on
      // every install/start call: resolveLlamaBinary re-verifies its cache via content hash
      // rather than re-fetching/rebuilding unconditionally.
      const r = await fetch('/api/desktop/local-model-install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ start, provisionBinary: true, pullWeights: true, pullVllmImage: entry?.backend === 'vllm' }),
      });
      const j = (await r.json()) as { ok: boolean; result?: ApplyResult; error?: string };
      if (!r.ok || !j.ok) {
        setInstallError(j.error ?? j.result?.error ?? `HTTP ${r.status}`);
      } else if (j.result) {
        setInstallResult(j.result);
        if (start) setConfirmStart(false);
      }
      await refresh();
    } catch (e: any) {
      setInstallError(e?.message ?? String(e));
    } finally {
      setInstalling(false);
      setStarting(false);
    }
  };

  const hw = plan?.hardware;
  const gpuDesc = hw?.gpu
    ? `${hw.gpu.vendor}${hw.gpu.model ? ` ${hw.gpu.model}` : ''}${hw.gpu.vramGB ? ` (${hw.gpu.vramGB}GB)` : ''}`
    : 'no GPU detected';
  const entry = plan?.recommendation.entry ?? null;
  const registeredNotStarted = installResult?.ok && installResult.registered && !installResult.started;
  const canOfferStart = !!plan && !plan.blocked && !!entry && (registeredNotStarted || installResult?.started === false);

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp can run inference <strong>locally</strong> instead of (or alongside) a cloud
        provider — detecting your GPU, recommending a certified model/backend combo, and
        registering it in the inference gateway&apos;s pool. This is optional; skip it if you only
        want cloud-backed inference.
      </p>

      {loading && (
        <div className="pc-step__progress" data-status="unknown">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <span>Detecting hardware…</span>
          </div>
        </div>
      )}

      {!loading && statusError && (
        <div className="pc-step__progress" data-status="missing">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Couldn&apos;t detect hardware.</strong>
            <span>{statusError}</span>
          </div>
        </div>
      )}

      {!loading && plan && (
        <>
          <div className="pc-step__progress" data-status={entry && !plan.blocked ? 'ok' : 'missing'}>
            <div className="pc-step__progress-dot" />
            <div className="pc-step__progress-text">
              {entry ? (
                <>
                  <strong>{entry.displayName}</strong>
                  <span>
                    {entry.status === 'provisional' && (
                      <em style={{ opacity: 0.7 }}>(provisional — not yet certified) </em>
                    )}
                    {plan.recommendation.reason}
                  </span>
                </>
              ) : (
                <>
                  <strong>No local combo fits this hardware.</strong>
                  <span>{plan.recommendation.reason}</span>
                </>
              )}
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
            <div>
              Detected: {hw?.platform}/{hw?.arch}, {hw?.ramGB}GB RAM, GPU: {gpuDesc}
            </div>
            {hw?.notes?.map((n) => (
              <div key={n} style={{ opacity: 0.7 }}>
                {n}
              </div>
            ))}
          </div>

          {entry && plan.blocked && (
            <p style={{ marginTop: 8, color: 'var(--bad, #d33)', fontSize: 13 }}>
              Blocked: {plan.blocked}
              {plan.weights?.pullHint && (
                <>
                  {' '}
                  Run <code>{plan.weights.pullHint}</code> first, then refresh this step.
                </>
              )}
            </p>
          )}

          {entry && !plan.blocked && (
            <div className="pc-step__actions" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                onClick={() => void doInstall(false)}
                disabled={installing || starting}
              >
                {installing
                  ? 'Installing…'
                  : installResult?.registered
                    ? 'Reconfigure'
                    : 'Install (config only, no GPU load)'}
              </button>
            </div>
          )}

          {installError && (
            <p style={{ marginTop: 8, color: 'var(--bad, #d33)', fontSize: 13 }}>{installError}</p>
          )}

          {installResult?.ok && (
            <p style={{ marginTop: 8, fontSize: 13 }}>
              Config written and registered in the gateway pool.{' '}
              {installResult.started ? 'Backend started.' : 'Backend not started yet.'}
            </p>
          )}

          {canOfferStart && (
            <div className="pc-agent-card" style={{ marginTop: 12 }}>
              <p className="pc-agent-card__install-label">
                ⚠️ Starting the backend loads the model onto the GPU. Make sure nothing else on this
                machine is currently GPU-resident before continuing.
              </p>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginTop: 6 }}>
                <Checkbox checked={confirmStart} onChange={setConfirmStart} />
                I&apos;ve confirmed the GPU is free — start the backend now.
              </label>
              <button
                type="button"
                className="pc-btn"
                style={{ marginTop: 8 }}
                onClick={() => void doInstall(true)}
                disabled={!confirmStart || starting}
              >
                {starting ? 'Starting…' : 'Start backend (loads model onto GPU)'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
