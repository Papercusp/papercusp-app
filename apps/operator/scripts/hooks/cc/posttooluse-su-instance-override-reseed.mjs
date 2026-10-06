#!/usr/bin/env node
// posttooluse-su-instance-override-reseed.mjs
//
// PostToolUse (Edit / Write / MultiEdit / capability:edit|write) recurrence guard
// for WI-10004556 / WI-10004699.
//
// apps/operator/prompts/pot-instances/papercup-pot.su.md is the version-controlled
// SOURCE of the papercusp su instance override; the launch path compares it against
// the stored hive setting `promptOverride.su` (verifyPapercuspSuInstanceOverride in
// packages/operator-core/lib/role-launch-spec.ts) and deliberately FAILS CLOSED on any
// difference. The :3070 operator reads prompts from PAPERCUSP_INTEGRATION_ROOT (the
// canonical tree), so an edit to this file refused EVERY fresh papercusp su launch
// until someone remembered to re-seed by hand. This hook re-seeds at edit time, so
// the source and the stored copy never diverge for longer than one tool call.
//
// CONTRACT
//   - Fires only for the canonical source path; every other edit is a no-op.
//   - Re-seeds via the loopback owner route POST /api/agent-mcp/pot-override-set
//     { potSlug:'papercusp', kind:'prompt', name:'su', value:<file contents> }.
//   - Never weakens the launch check: if the re-seed fails, it says so LOUDLY via
//     additionalContext (with the manual command), and launches stay refused until
//     the source and the store agree.
//   - Fails open on malformed input; exits 0 always (PostToolUse cannot undo an edit).
//   - PAPERCUSP_SU_RESEED_URL overrides the operator base URL (tests, other hosts).
//
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

export const SOURCE_SUFFIX = 'apps/operator/prompts/pot-instances/papercup-pot.su.md';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3070';

// Copied verbatim to ~/.papercusp/hooks/cc, so it cannot import operator-core's
// isCliEntry; pin our own basename (the sanctioned standalone form).
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])posttooluse-su-instance-override-reseed\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) main();

/** Native Edit/Write/MultiEdit and the MCP-projected capability edit/write tools. */
export function isEditTool(tool) {
  if (typeof tool !== 'string') return false;
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return true;
  return /(?:^|__)capability_(?:edit|write|multi_?edit)$/i.test(tool);
}

/**
 * Return the absolute path of the edited source file when this payload edited the
 * papercusp su instance override source, else null. Relative paths resolve against
 * `cwd` (the client's project dir, which is also the hook's cwd).
 */
export function targetPath(hook, cwd = process.cwd()) {
  if (!isEditTool(hook?.tool_name)) return null;
  const raw = hook?.tool_input?.file_path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const abs = resolve(cwd, raw).replace(/\\/g, '/');
  // Only the canonical source — never a projection copy (e.g. the desktop sidecar's
  // env-sidecars/staging/prompts/... or a release tree's copy).
  if (!abs.endsWith(`/${SOURCE_SUFFIX}`)) return null;
  if (/\/(?:papercup-release|papercusp-checkpoint|papercup-checkpoint|sidecar|env-sidecars)\//.test(abs)) {
    return null;
  }
  return abs;
}

/** The exact request the re-seed sends (pure, for tests). */
export function buildReseedRequest(value, baseUrl = DEFAULT_BASE_URL) {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}/api/agent-mcp/pot-override-set`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ potSlug: 'papercusp', kind: 'prompt', name: 'su', value }),
    },
  };
}

/**
 * Inspect one PostToolUse payload and re-seed when it touched the source.
 * Returns null for unrelated edits, else { ok, filePath, detail }.
 */
export async function reseedIfTarget(hook, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const filePath = targetPath(hook, cwd);
  if (!filePath) return null;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const doFetch = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? process.env.PAPERCUSP_SU_RESEED_URL ?? DEFAULT_BASE_URL;
  let value;
  try {
    value = readFile(filePath);
  } catch (error) {
    return { ok: false, filePath, detail: `could not read source: ${String(error?.message ?? error)}` };
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    // An empty value would CLEAR the override; never do that implicitly from an edit.
    return { ok: false, filePath, detail: 'source is empty; refusing to clear promptOverride.su from a hook' };
  }
  const { url, init } = buildReseedRequest(value, baseUrl);
  try {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 8000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.ok && body?.ok !== false) {
      return { ok: true, filePath, detail: `re-seeded promptOverride.su (${value.length} chars) via ${url}` };
    }
    return { ok: false, filePath, detail: `HTTP ${res.status}: ${JSON.stringify(body)?.slice(0, 300)}` };
  } catch (error) {
    return { ok: false, filePath, detail: `request to ${url} failed: ${String(error?.message ?? error)}` };
  }
}

export function formatResult(result) {
  if (result.ok) {
    return `✓ su-instance-override-reseed (WI-10004699): ${result.detail}. Fresh papercusp su launches stay valid.`;
  }
  return (
    `⚠ su-instance-override-reseed (WI-10004699): you edited ${result.filePath}, but the automatic ` +
    `re-seed of promptOverride.su FAILED — ${result.detail}.\n` +
    `Until the stored override matches this file, EVERY fresh papercusp su launch is refused ` +
    `(verifyPapercuspSuInstanceOverride is fail-closed by design). Re-seed now: ` +
    `curl -s -X POST http://127.0.0.1:3070/api/agent-mcp/pot-override-set -H 'content-type: application/json' ` +
    `--data "$(jq -Rs '{potSlug:"papercusp",kind:"prompt",name:"su",value:.}' < ${result.filePath})"`
  );
}

async function main() {
  try {
    const hook = JSON.parse(await readStdin(250));
    const result = await reseedIfTarget(hook);
    if (result) {
      const message = formatResult(result);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
        }) + '\n',
      );
      if (!result.ok) process.stderr.write(message + '\n');
    }
  } catch {
    // Fail open: never disturb an edit that already completed.
  }
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}
