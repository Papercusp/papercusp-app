/**
 * Shared ephemeral-GCP-resource harness for the workspace-host release tools.
 *
 * Both `papercusp-image-scan` and `papercusp-gcp-clean-room` need the same primitives:
 * stand up a short-lived VM from a candidate image, reach it over IAP, collect a
 * structured result, and then destroy every resource that was created — reporting any
 * residue rather than silently leaking it.
 *
 * This module owns those primitives once so the two executables stay thin and cannot
 * drift apart in their teardown behaviour. It deliberately shells out to `gcloud`
 * rather than binding a Node SDK: the release path already requires gcloud on PATH for
 * credential resolution, and using one credential surface keeps the trust chain single.
 *
 * DESIGN RULE (D-105/D-107/D-108 trust chain): nothing here may invent, default, or
 * soften a result. Every helper either returns an observed value or throws. There is no
 * "assume success" branch anywhere in this file, by construction.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Immutable image references only — family aliases are forbidden by the release contract. */
const IMMUTABLE_IMAGE_ID =
  /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/global\/images\/([a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)$/;

export class ToolError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ToolError';
    if (details !== undefined) this.details = details;
  }
}

export function fail(message, details) {
  throw new ToolError(message, details);
}

/** Parse `projects/{project}/global/images/{name}`; anything else is a hard failure. */
export function parseImmutableImageId(value, path = 'imageId') {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  const match = value.trim().match(IMMUTABLE_IMAGE_ID);
  if (!match) {
    fail(
      `${path} must be an immutable projects/{project}/global/images/{name} reference; family aliases are forbidden`,
    );
  }
  return { projectId: match[1], imageName: match[2], imageId: `projects/${match[1]}/global/images/${match[2]}` };
}

export function requireText(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value.trim();
}

/**
 * Like `requireText`, but returns the string EXACTLY as received.
 *
 * Use this for any value that is CONTENT-ADDRESSED — a script, a document, a payload whose
 * sha256 is asserted elsewhere. `requireText` trims, and trimming mutates the bytes the digest
 * was computed over: a bootstrap script ending in the usual trailing newline hashes differently
 * once trimmed, so an integrity check comparing it against its own advertised digest fails on a
 * payload that was never actually corrupt. Worse, without that check the guest would execute a
 * script whose digest does not match the one attested — silently breaking the
 * exact-bootstrap-attestation property the release gate exists to verify.
 */
export function requireExactText(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}

/** A sha256 hex digest, optionally prefixed `sha256:`. Returns the bare 64-char hex, lowercased. */
export function requireDigest(value, path) {
  const text = requireText(value, path);
  const bare = text.startsWith('sha256:') ? text.slice('sha256:'.length) : text;
  if (!/^[0-9a-f]{64}$/i.test(bare)) fail(`${path} must be a sha256 hex digest`);
  return bare.toLowerCase();
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      // Guard against an unbounded producer; the release payloads are small.
      if (buffer.length > 1_000_000) reject(new ToolError('stdin payload exceeded 1MB'));
    });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
  });
}

export function parseJsonObject(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${label} did not receive valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${label} expected a JSON object`);
  }
  return parsed;
}

/**
 * Run a command, capturing stdout/stderr. Never shells out through `sh -c`, so no
 * argument can be interpreted as shell syntax.
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ToolError(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError(`${command} could not be executed: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** Run a command and throw unless it exits 0. Returns stdout. */
export async function runOrThrow(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    fail(`${command} ${args[0] ?? ''} failed with exit code ${result.exitCode}`, {
      stderr: result.stderr.slice(-4000),
    });
  }
  return result.stdout;
}

export async function gcloudJson(args, options = {}) {
  const stdout = await runOrThrow('gcloud', [...args, '--format=json'], options);
  const trimmed = stdout.trim();
  if (trimmed === '') fail(`gcloud ${args.join(' ')} returned no output where JSON was expected`);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    fail(`gcloud ${args.join(' ')} returned unparseable JSON: ${error.message}`);
  }
}

/** Short, collision-resistant suffix for ephemeral resource names. */
export function ephemeralSuffix() {
  return randomBytes(4).toString('hex');
}

/**
 * Describe an image and assert it is READY. Returns the raw resource so callers can
 * verify provenance themselves — this helper deliberately does not interpret it.
 */
export async function describeImage(projectId, imageName) {
  const image = await gcloudJson(['compute', 'images', 'describe', imageName, `--project=${projectId}`]);
  if (!image || typeof image !== 'object') fail(`image ${imageName} could not be described`);
  if (image.status !== 'READY') fail(`image ${imageName} is not READY (status=${String(image.status)})`);
  return image;
}

/**
 * Tracks every resource this process creates so teardown can be exhaustive and any
 * residue can be REPORTED rather than hidden. Order is reverse-creation.
 */
export class ResourceLedger {
  constructor(projectId) {
    this.projectId = projectId;
    this.entries = [];
  }

  track(kind, name, zone) {
    this.entries.push({ kind, name, zone });
  }

  /**
   * Best-effort destroy of everything tracked, newest first. Returns the ids that could
   * NOT be destroyed — the caller must surface these as residualResourceIds, never drop
   * them. A teardown failure is data, not an exception.
   */
  async destroyAll() {
    const residual = [];
    for (const entry of [...this.entries].reverse()) {
      const args =
        entry.kind === 'instance'
          ? ['compute', 'instances', 'delete', entry.name, `--zone=${entry.zone}`]
          : entry.kind === 'disk'
            ? ['compute', 'disks', 'delete', entry.name, `--zone=${entry.zone}`]
            : null;
      if (!args) {
        residual.push(`${entry.kind}:${entry.name}`);
        continue;
      }
      const result = await run('gcloud', [...args, `--project=${this.projectId}`, '--quiet'], {
        timeoutMs: 6 * 60 * 1000,
      }).catch((error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error) }));
      if (result.exitCode !== 0) {
        // Already-gone is a successful outcome, not residue.
        const gone = /was not found|notFound|already being deleted/i.test(result.stderr);
        if (!gone) residual.push(`${entry.kind}:${entry.name}`);
      }
    }
    return residual;
  }
}

/** Emit the structured result on stdout. */
export function emit(evidence) {
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

/**
 * Standard entrypoint wrapper: parse stdin, run the tool, emit evidence. Any thrown
 * error becomes a non-zero exit with a structured message on stderr — the adapters
 * treat a non-zero exit as a hard release failure, which is the intended behaviour.
 */
export async function main(toolName, handler) {
  try {
    const args = process.argv.slice(2);
    if (!args.includes('--json-stdin')) {
      fail(`${toolName} must be invoked with --json-stdin`);
    }
    const input = parseJsonObject(await readStdin(), toolName);
    const evidence = await handler(input);
    emit(evidence);
    process.exit(0);
  } catch (error) {
    const payload = {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
      ...(error && error.details ? { details: error.details } : {}),
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exit(1);
  }
}
