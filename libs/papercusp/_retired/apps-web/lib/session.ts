/**
 * Session + profile helpers — Stage 7 scaffold.
 *
 * Without a real auth backend, profile preferences (model defaults, default
 * project location, theme) live in `~/.papercusp/profile.json` mode 0600.
 * When NextAuth lands, this module switches to reading from the cookie
 * session + Postgres user table, with the local file as a cache.
 *
 * API keys remain LOCAL-ONLY in `~/.papercusp/credentials.json` regardless
 * of auth state — see `lib/credentials.ts`.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.papercusp');
const PROFILE_PATH = join(ROOT, 'profile.json');

export interface Profile {
  email?: string;
  display_name?: string;
  default_project_dir?: string;
  preferred_models?: {
    scoper?: string;
    worker?: string;
    validator?: string;
    reviewer?: string;
    orchestrator?: string;
  };
  theme?: 'dark' | 'light' | 'auto';
  updated_at?: string;
}

export async function readProfile(): Promise<Profile> {
  try {
    const raw = await fs.readFile(PROFILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw e;
  }
}

export async function writeProfile(profile: Profile): Promise<Profile> {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  const next: Profile = { ...profile, updated_at: new Date().toISOString() };
  await fs.writeFile(PROFILE_PATH, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(PROFILE_PATH, 0o600);
  return next;
}

export const PROFILE_PATH_CONST = PROFILE_PATH;
