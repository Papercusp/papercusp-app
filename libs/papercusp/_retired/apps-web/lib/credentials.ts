import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.papercusp');
const CREDS_PATH = join(ROOT, 'credentials.json');

export interface Credentials {
  anthropic_api_key?: string;
  openai_api_key?: string;
  github_pat?: string;
  updated_at?: string;
}

export async function readCredentials(): Promise<Credentials> {
  try {
    const raw = await fs.readFile(CREDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw e;
  }
}

export async function writeCredentials(creds: Credentials): Promise<Credentials> {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  const next: Credentials = { ...creds, updated_at: new Date().toISOString() };
  const body = JSON.stringify(next, null, 2);
  await fs.writeFile(CREDS_PATH, body, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(CREDS_PATH, 0o600);
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
    github_pat: maskSecret(creds.github_pat),
    updated_at: creds.updated_at ?? null,
    path: CREDS_PATH,
  };
}

export const CREDENTIALS_PATH = CREDS_PATH;
