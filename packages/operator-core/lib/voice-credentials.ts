/**
 * Voice credentials reader/writer.
 *
 * Persisted in `harness_shared.operator_voice_credentials` (PG, migration
 * 023). NOT in the zero_harness publication — credentials must not be
 * broadcast over WS. Read by 10 voice/STT/TTS bootstrap routes; written
 * by /api/agent-mcp/operator-credentials.
 *
 * Was previously `~/.papercusp/credentials.json`. The PG migration also
 * closes a bifurcation bug: `lib/credentials.ts` already moved to PG in
 * round 1 (operator_credentials), but voice-credentials.ts kept reading
 * the file. Both modules used the same physical file with different
 * shapes — after that round, writes split between PG and file. Both are
 * now PG-resident in their own tables.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';

interface CredentialsPayload {
  elevenlabs?: { apiKey: string };
  openai?: { apiKey: string };
  cartesia?: { apiKey: string };
  deepgram?: { apiKey: string };
  picovoice?: { apiKey: string };
}

export interface ElevenLabsApiKeyStatus {
  configured: boolean;
  healthy: boolean;
  error: string | null;
}

const INVALID_ELEVENLABS_KEY_ERROR = 'ElevenLabs API keys must begin with sk_; an API key ID cannot authenticate.';

/** Validate the local key shape before persisting or sending it to ElevenLabs. */
export function inspectElevenLabsApiKey(value: unknown): ElevenLabsApiKeyStatus {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { configured: false, healthy: false, error: null };
  }
  if (!value.trim().startsWith('sk_') || value.trim().length <= 3) {
    return { configured: true, healthy: false, error: INVALID_ELEVENLABS_KEY_ERROR };
  }
  return { configured: true, healthy: true, error: null };
}

export function isValidElevenLabsApiKey(value: unknown): boolean {
  return inspectElevenLabsApiKey(value).healthy;
}

async function readAll(): Promise<CredentialsPayload> {
  const raw = await readOperatorState<CredentialsPayload>('operator_voice_credentials');
  return raw && typeof raw === 'object' ? raw : {};
}

async function writeAll(creds: CredentialsPayload): Promise<void> {
  await writeOperatorState('operator_voice_credentials', creds);
}

/** Mask a key for client display. `sk_••••3c2a` style. */
export function maskKey(key: string | null): string | null {
  if (!key || key.length < 8) return null;
  const tail = key.slice(-4);
  return `${key.slice(0, 3)}_••••${tail}`;
}

export interface ReadElevenLabsKeyOptions {
  /**
   * Status/migration readers may opt into seeing a legacy invalid value so the
   * UI can explain and replace it. Network callers must keep the safe default.
   */
  allowInvalid?: boolean;
}

/**
 * Return a usable ElevenLabs secret (server-side only), or null when absent or
 * invalid. Legacy API-key IDs stay visible only to explicit status/migration
 * readers; the default makes it impossible for a normal outbound call site to
 * accidentally send one as an `xi-api-key`.
 */
export async function readElevenLabsKey(options: ReadElevenLabsKeyOptions = {}): Promise<string | null> {
  const key = (await readAll()).elevenlabs?.apiKey ?? null;
  if (key === null || options.allowInvalid) return key;
  return inspectElevenLabsApiKey(key).healthy ? key : null;
}

export async function writeElevenLabsKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.elevenlabs;
  else {
    const status = inspectElevenLabsApiKey(apiKey);
    if (!status.healthy) throw new Error(status.error ?? 'Invalid ElevenLabs API key.');
    all.elevenlabs = { ...all.elevenlabs, apiKey: apiKey.trim() };
  }
  await writeAll(all);
}

export async function readOpenAiKey(): Promise<string | null> {
  return (await readAll()).openai?.apiKey ?? null;
}

export async function writeOpenAiKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.openai;
  else all.openai = { ...all.openai, apiKey };
  await writeAll(all);
}

export async function readCartesiaKey(): Promise<string | null> {
  return (await readAll()).cartesia?.apiKey ?? null;
}

export async function writeCartesiaKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.cartesia;
  else all.cartesia = { ...all.cartesia, apiKey };
  await writeAll(all);
}

export async function readDeepgramKey(): Promise<string | null> {
  return (await readAll()).deepgram?.apiKey ?? null;
}

export async function writeDeepgramKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.deepgram;
  else all.deepgram = { ...all.deepgram, apiKey };
  await writeAll(all);
}

export async function readPicovoiceKey(): Promise<string | null> {
  return (await readAll()).picovoice?.apiKey ?? null;
}

export async function writePicovoiceKey(apiKey: string | null): Promise<void> {
  const all = await readAll();
  if (apiKey === null) delete all.picovoice;
  else all.picovoice = { ...all.picovoice, apiKey };
  await writeAll(all);
}
