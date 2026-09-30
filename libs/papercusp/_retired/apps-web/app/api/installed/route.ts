import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');
const REGISTRY_PATH = join(PAPERCUSP_ROOT, 'registry.json');
const LEGACY_REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');

interface RegistryShape {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listInstalledHarnesses(): Promise<Array<{ slug: string; version: string | null; description: string | null }>> {
  try {
    const dirs = await fs.readdir(HARNESSES_DIR, { withFileTypes: true });
    const out: Array<{ slug: string; version: string | null; description: string | null }> = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const manifest = await readJson<{ name: string; version: string; description?: string }>(
        join(HARNESSES_DIR, d.name, 'papercusp.json'),
      );
      out.push({
        slug: d.name,
        version: manifest?.version ?? null,
        description: manifest?.description ?? null,
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
}

export async function GET() {
  const reg = (await readJson<RegistryShape>(REGISTRY_PATH))
    ?? (await readJson<RegistryShape>(LEGACY_REGISTRY_PATH))
    ?? { projects: [] };
  const harnesses = await listInstalledHarnesses();
  return NextResponse.json({
    projects: reg.projects,
    harnesses,
  });
}
