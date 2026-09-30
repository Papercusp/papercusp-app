/**
 * Operator-bus event posters previously implemented as bash helpers in
 * run.sh — closes parity gaps G4 (archive), G5 (curator outputs / identity
 * + skills snapshot), G6 (test snapshot).
 *
 * All POSTs:
 *   - read harness_token from <stateDir>/config.json
 *   - silently no-op when token missing or operator unreachable
 *   - have a short timeout so they never gate the main loop
 *
 * Mirrors the bash one-shot semantics: best-effort, no retries.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

interface PostJsonOpts {
  url: string;
  body: unknown;
  bearerToken: string;
  timeoutMs: number;
}

async function postJsonAuth(opts: PostJsonOpts): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.bearerToken}`,
      },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function readHarnessToken(stateDir: string): string | null {
  const cfgPath = join(stateDir, 'config.json');
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { harness_token?: string };
    return typeof cfg.harness_token === 'string' && cfg.harness_token.length > 0
      ? cfg.harness_token
      : null;
  } catch {
    return null;
  }
}

function operatorBase(): string {
  return process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
}

/**
 * Read up to `maxBytes` bytes from a file as UTF-8. Returns null on
 * any read error so callers can skip without aborting the snapshot.
 */
async function readBounded(path: string, maxBytes: number): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return buf.subarray(0, maxBytes).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * G4 — POST /api/internal/archive-event after `archiveOnDone` writes
 * a tar.gz to `<stateDir>/archives/`. No-op when token missing.
 */
export async function postArchiveEvent(input: {
  stateDir: string;
  archivePath: string;
  phase?: string;
}): Promise<boolean> {
  if (!existsSync(input.archivePath)) return false;
  const token = readHarnessToken(input.stateDir);
  if (!token) return false;
  let sizeBytes = 0;
  let tsMs = Date.now();
  try {
    const st = statSync(input.archivePath);
    sizeBytes = st.size;
    tsMs = Math.floor(st.mtimeMs);
  } catch { /* fall through with defaults */ }
  return postJsonAuth({
    url: `${operatorBase()}/api/internal/archive-event`,
    body: {
      id: basename(input.archivePath),
      sizeBytes,
      ts: tsMs,
      phase: input.phase ?? 'staging',
    },
    bearerToken: token,
    timeoutMs: 2000,
  });
}

/**
 * G5 — POST /api/internal/identity-snapshot + /api/internal/skill-snapshot
 * after curator runs. Each markdown file is read up to 256 KiB.
 */
export async function postCuratorOutputs(input: {
  stateDir: string;
  harnessDir: string;
  identityFallbackDir?: string;
}): Promise<{ identity: boolean; skills: boolean }> {
  const token = readHarnessToken(input.stateDir);
  if (!token) return { identity: false, skills: false };

  // Identity directory: harnessDir/identity → fallback dir (autonomous-harness).
  const identityCandidates = [
    join(input.harnessDir, 'identity'),
    input.identityFallbackDir ??
      join(process.env.HOME ?? '', 'autonomous-harness', 'identity'),
  ];
  const identityDir = identityCandidates.find((d) => d && existsSync(d));
  let identityOk = false;
  if (identityDir) {
    const files: Array<{ role: string; content: string }> = [];
    try {
      const entries = (await readdir(identityDir)).filter((n) => n.endsWith('.md')).sort();
      for (const name of entries) {
        const content = await readBounded(join(identityDir, name), 262144);
        if (content === null) continue;
        files.push({ role: name.slice(0, -3), content });
      }
    } catch { /* best-effort */ }
    identityOk = await postJsonAuth({
      url: `${operatorBase()}/api/internal/identity-snapshot`,
      body: { files },
      bearerToken: token,
      timeoutMs: 10_000,
    });
  }

  // Skills (per-harness).
  const skillsDir = join(input.stateDir, 'skills');
  let skillsOk = false;
  if (existsSync(skillsDir)) {
    const files: Array<{ name: string; content: string }> = [];
    try {
      const entries = (await readdir(skillsDir)).filter((n) => n.endsWith('.md')).sort();
      for (const name of entries) {
        const content = await readBounded(join(skillsDir, name), 262144);
        if (content === null) continue;
        files.push({ name, content });
      }
    } catch { /* best-effort */ }
    skillsOk = await postJsonAuth({
      url: `${operatorBase()}/api/internal/skill-snapshot`,
      body: { files },
      bearerToken: token,
      timeoutMs: 10_000,
    });
  } else {
    // Skills dir gone → POST empty list to clear the PG mirror.
    skillsOk = await postJsonAuth({
      url: `${operatorBase()}/api/internal/skill-snapshot`,
      body: { files: [] },
      bearerToken: token,
      timeoutMs: 5_000,
    });
  }

  return { identity: identityOk, skills: skillsOk };
}

/**
 * G6 — POST /api/internal/test-snapshot after RUN_TESTS / tester
 * finishes. Reads <stateDir>/tests/*.json, each up to 256 KiB.
 */
export async function postTestSnapshot(input: {
  stateDir: string;
  phase?: string;
}): Promise<boolean> {
  const testsDir = join(input.stateDir, 'tests');
  if (!existsSync(testsDir)) return false;
  const token = readHarnessToken(input.stateDir);
  if (!token) return false;

  const files: Array<{ testId: string; payload: unknown }> = [];
  try {
    const entries = (await readdir(testsDir)).filter((n) => n.endsWith('.json')).sort();
    for (const name of entries) {
      const content = await readBounded(join(testsDir, name), 262144);
      if (content === null) continue;
      let payload: unknown;
      try { payload = JSON.parse(content); } catch { continue; }
      if (typeof payload !== 'object' || payload === null) continue;
      files.push({ testId: name.slice(0, -extname(name).length), payload });
    }
  } catch { /* best-effort */ }
  if (files.length === 0) return false;

  return postJsonAuth({
    url: `${operatorBase()}/api/internal/test-snapshot`,
    body: { files, phase: input.phase ?? 'staging' },
    bearerToken: token,
    timeoutMs: 10_000,
  });
}
