/**
 * What the "Embedding device" settings section shows, derived from the
 * GET /api/user/embed-device envelope (plan memory-reduction-2026-09-24 P-008 /
 * D-008, WI-10002872). Pure, so the wording rules are testable without a DOM.
 *
 * The one rule that matters: "In use" comes from what the embedding process
 * REPORTS it constructed on, never from the stored choice. A GPU choice can
 * fall back to the CPU, and a host env override can outrank the choice.
 */

export type EmbedDeviceChoice = 'auto' | 'gpu' | 'cpu';

/** The subset of `EmbedExecutionHealth` (@papercusp/memory) this section reads. */
export type EmbedDeviceHealthView = {
  requested: {
    device: string;
    preference: string;
    source: 'env' | 'setting' | 'default' | 'env-invalid';
    invalidValue: string | null;
    setting: string | null;
    why: string;
  };
  active: { device: string; verified: boolean; why: string };
  pipelines: Record<string, string>;
  demotion: { from: string; to: string; model: string; stage: string; cause: string; at: string } | null;
  nvidiaDriverPresent: boolean | null;
  gpuProviderAvailable: boolean | null;
};

export type EmbedDeviceEnvelopeView = {
  setting: string | null;
  settingError: string | null;
  host: { kind: 'sidecar'; url: string } | { kind: 'in-process' };
  health: EmbedDeviceHealthView | null;
  healthError: string | null;
  reloadSupported: boolean | null;
};

export type EmbedDeviceView = {
  /** The select's value. A stored `cuda` is shown as GPU; nothing stored is Auto. */
  choice: EmbedDeviceChoice;
  /** e.g. "GPU", "CPU", or "not loaded yet — will use GPU". `null` when the host could not be read. */
  inUse: string | null;
  /** One line per model, e.g. "gemma-300m: GPU". */
  perModel: string[];
  /** Which process embeds for this host. */
  hostLine: string;
  /** Loud: the GPU failed and embeddings fell back. */
  demotionWarning: string | null;
  /** The choice cannot take effect on this host (env pin, missing driver/provider). */
  notices: string[];
  /** The embedding process's own explanation of its request. */
  why: string | null;
};

export const EMBED_DEVICE_OPTIONS: ReadonlyArray<{ value: EmbedDeviceChoice; label: string }> = [
  { value: 'auto', label: 'Auto (GPU when available)' },
  { value: 'gpu', label: 'GPU' },
  { value: 'cpu', label: 'CPU' },
];

export function deviceLabel(device: string): string {
  if (device === 'cuda') return 'GPU';
  if (device === 'cpu') return 'CPU';
  if (device === 'mixed') return 'mixed (GPU and CPU)';
  return device;
}

export function choiceOf(setting: string | null): EmbedDeviceChoice {
  if (setting === 'cuda' || setting === 'gpu') return 'gpu';
  if (setting === 'cpu') return 'cpu';
  return 'auto';
}

/** `Xenova/bge-small-en-v1.5` → `bge-small-en-v1.5`: the org prefix is noise here. */
function modelName(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function embedDeviceView(env: EmbedDeviceEnvelopeView): EmbedDeviceView {
  const choice = choiceOf(env.setting);
  const hostLine =
    env.host.kind === 'sidecar'
      ? `Embeddings run in the shared embedding sidecar (${env.host.url}).`
      : 'Embeddings run inside this app.';
  const h = env.health;
  if (!h) {
    return { choice, inUse: null, perModel: [], hostLine, demotionWarning: null, notices: [], why: null };
  }

  const inUse = h.active.verified
    ? deviceLabel(h.active.device)
    : `not loaded yet — will use ${deviceLabel(h.requested.device)}`;
  const perModel = Object.entries(h.pipelines)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, device]) => `${modelName(model)}: ${deviceLabel(device)}`);

  const demotionWarning = h.demotion
    ? `The GPU failed for ${modelName(h.demotion.model)} (${h.demotion.stage === 'construct' ? 'while loading' : 'during a run'}): ` +
      `${h.demotion.cause}. Embeddings fell back to the ${deviceLabel(h.demotion.to)}.`
    : null;

  const notices: string[] = [];
  if (h.requested.source === 'env' && (h.requested.preference === 'cuda' || h.requested.preference === 'cpu')) {
    notices.push(
      `This host sets PAPERCUSP_EMBED_DEVICE=${h.requested.preference === 'cuda' ? 'gpu' : 'cpu'}, which overrides this setting. ` +
        'Your choice is saved and applies once that variable is removed.',
    );
  }
  if (h.requested.invalidValue) {
    notices.push(`PAPERCUSP_EMBED_DEVICE="${h.requested.invalidValue}" is not a valid value (auto, gpu or cpu) and is ignored.`);
  }
  if (choice !== 'cpu' && h.requested.device === 'cpu' && !h.demotion) {
    if (h.nvidiaDriverPresent === false) notices.push('No NVIDIA GPU driver was found, so embeddings use the CPU.');
    else if (h.gpuProviderAvailable === false) notices.push('The GPU runtime library is not installed, so embeddings use the CPU.');
  }
  if (env.reloadSupported === false) {
    notices.push('The running embedding sidecar predates this setting. Changes apply after it restarts.');
  }

  return { choice, inUse, perModel, hostLine, demotionWarning, notices, why: h.requested.why || null };
}
