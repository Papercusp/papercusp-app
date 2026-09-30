import type { StepDef } from './types';

export const SETUP_STEPS: readonly StepDef[] = [
  {
    id: 'os-permissions',
    title: 'Permissions & devices',
    summary: 'Microphone, notifications, accessibility — and pick your audio devices.',
    required: false,
  },
  {
    id: 'embedded-pg',
    title: 'Local database',
    summary: 'Embedded Postgres bootstrap — bundled with the desktop app.',
    required: true,
  },
  {
    id: 'workspace',
    title: 'Workspace folder',
    summary: 'Where Papercusp stores your projects.',
    required: true,
  },
  {
    id: 'agents',
    title: 'Agent Runtime',
    summary: 'Claude Code, Codex, or oh-my-pi — install one agent backend (Install runs here).',
    required: true,
  },
  {
    id: 'local-model',
    title: 'Local inference (optional)',
    summary: 'Detect your GPU and provision a certified local model/backend combo.',
    required: false,
  },
  {
    id: 'logins',
    title: 'Sign in to your accounts',
    summary:
      'Uses your existing Claude or OpenAI plan. Optional here — sign in later from Settings or a terminal, or use API keys instead; agents need one credential path before they can run.',
    required: false,
  },
  {
    id: 'keys',
    title: 'Memory system',
    summary:
      'Choose how memories are embedded — defaults to Harrier-OSS-0.6b (best recall, local & private, no API key needed). Alternatives: EmbeddingGemma-300m (uses less resources — ~4× faster, ~1GB RAM), BGE-small (lightest local), or OpenAI text-embedding-3-small (cloud, needs a key). Provider/voice API keys are optional and set here too.',
    required: true,
  },
  {
    id: 'git',
    title: 'Git identity',
    summary: 'Name + email for commits, and optional GitHub sign-in.',
    required: false,
  },
  {
    id: 'mobile-pairing',
    title: 'Mobile pairing',
    summary: 'Pair the companion app via QR code.',
    required: false,
  },
  {
    id: 'own-tunnel',
    title: 'Remote access (optional)',
    summary:
      'Let outside apps like Claude.ai or ChatGPT reach this computer through a tunnel in your own account — Cloudflare in one click, or your own Tailscale Funnel/ngrok. No router changes.',
    required: false,
  },
  {
    id: 'backups',
    title: 'Backups',
    summary: 'Local snapshot layer that protects against agent mistakes.',
    required: false,
  },
  {
    id: 'auto-update',
    title: 'Update channel',
    summary: 'Choose alpha, beta, or stable releases.',
    required: false,
  },
  {
    id: 'telemetry',
    title: 'Telemetry & crash reports',
    summary: 'Help us find bugs by sending anonymized diagnostics.',
    required: false,
  },
] as const;

export function findStep(id: string | null | undefined): StepDef | undefined {
  if (!id) return undefined;
  return SETUP_STEPS.find((s) => s.id === id);
}
