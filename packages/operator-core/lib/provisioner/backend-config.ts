/**
 * provisioner/backend-config — render a systemd user-unit for a llama-server backend
 * (local-concurrent-inference-2026-07-02 P-009, D-006's "install/configure backend" step).
 * Pure string rendering — this module never writes a file or touches systemd itself;
 * provision.ts's applyProvision() does the (injectable) write.
 *
 * The shape mirrors this box's real, currently-live `llama-ornith.service` unit
 * (verified via `systemctl --user cat llama-ornith.service`) so the wizard's own output is
 * consistent with the hand-tuned reference config it was designed from.
 */

export interface LlamaServerUnitOptions {
  /** Human-readable alias passed to llama-server's --alias (shows up in /v1/models). */
  alias: string;
  weightsPath: string;
  host: string;
  port: number;
  parallelSlots: number;
  ctxTotal: number;
  kvCacheType: string;
  flashAttn: boolean;
  /** Pass `--jinja` (use the model's/served template's jinja chat template — REQUIRED for
   *  structured tool-call parsing on models whose tool format llama-server doesn't
   *  auto-detect without it, e.g. Qwen3's hermes-style `<tool_call>`; WI-1596). */
  jinja?: boolean;
  /** Pass `--reasoning-budget N` (0 disables thinking-mode preambles on reasoning models —
   *  the qwen3 cert-battery config; WI-1596). Omit to leave the server default. */
  reasoningBudget?: number;
  /** llama-server `-ngl` (`--n-gpu-layers`) — an exact layer count (999 = all), `'all'`, or
   *  `'auto'` (sized by `--fit` at start). Omit to write no flag at all. */
  gpuLayers?: number | 'auto' | 'all';
  /** llama-server `--fit on|off` — fit unset arguments to the device memory free at start. */
  fit?: 'on' | 'off';
  /** llama-server `--fit-target MiB` — rendered only alongside `fit`. */
  fitTargetMiB?: number;
  /** Absolute path to append stdout/stderr to. */
  logPath: string;
  /** llama-server binary — defaults to relying on PATH. */
  binPath?: string;
  description?: string;
}

/** Render a systemd user-unit file (`[Unit]/[Service]/[Install]`) for a llama-server backend. */
export function renderLlamaServerUnit(opts: LlamaServerUnitOptions): string {
  const bin = opts.binPath ?? 'llama-server';
  const description = opts.description ?? `llama-server serving ${opts.alias} (provisioner wizard — local-concurrent-inference-2026-07-02 P-009)`;
  const extraFlags = [
    ...(opts.jinja ? ['--jinja'] : []),
    ...(opts.reasoningBudget !== undefined ? [`--reasoning-budget ${opts.reasoningBudget}`] : []),
  ];
  const extraLine = extraFlags.length ? `  ${extraFlags.join(' ')} \\\n` : '';
  // Its own continuation line, matching the real llama-ornith.service layout, so the deployed unit
  // and this renderer stay diffable line-for-line by the P-010 drift guard.
  const nglLine = opts.gpuLayers !== undefined ? `  -ngl ${opts.gpuLayers} \\\n` : '';
  // Same rule for `--fit`: one continuation line, so the deployed unit stays line-diffable.
  const fitLine =
    opts.fit !== undefined
      ? `  --fit ${opts.fit}${opts.fitTargetMiB !== undefined ? ` --fit-target ${opts.fitTargetMiB}` : ''} \\\n`
      : '';
  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
ExecStart=${bin} \\
  -m ${opts.weightsPath} \\
  --host ${opts.host} --port ${opts.port} \\
  --flash-attn ${opts.flashAttn ? 'on' : 'off'} \\
${nglLine}${fitLine}  -np ${opts.parallelSlots} -c ${opts.ctxTotal} \\
  --cache-type-k ${opts.kvCacheType} --cache-type-v ${opts.kvCacheType} \\
${extraLine}  --alias ${opts.alias}
Restart=on-failure
RestartSec=5
Nice=5
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}

[Install]
WantedBy=default.target
`;
}
