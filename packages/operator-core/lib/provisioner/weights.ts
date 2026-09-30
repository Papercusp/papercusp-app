/**
 * provisioner/weights — resolve a catalog entry's GGUF weights on disk before deciding whether
 * a download is needed (local-concurrent-inference-2026-07-02 P-009, D-006's "download weights"
 * step). The catalog references models by ollama-style ref (e.g. "maxwell1500/ornith-35b:IQ3_M")
 * because that's already the box's install mechanism (D-007: ollama pulls the GGUF, llama-server
 * then serves the SAME blob directly, bypassing the ollama daemon).
 *
 * ollama's on-disk layout (verified against this box's live /usr/share/ollama/.ollama/models):
 *   <root>/manifests/registry.ollama.ai/<namespace>/<name>/<tag>   — JSON manifest, `layers[]`
 *   <root>/blobs/sha256-<hex>                                     — the blob content (":" -> "-")
 * The manifest's layer with mediaType "application/vnd.ollama.image.model" is the GGUF weights;
 * its `digest` ("sha256:<hex>") maps to the blob filename above.
 *
 * Read side: `resolveOllamaWeights()` only probes the local store and returns a `pullHint`.
 * Write side: `pullOllamaWeights()` performs the actual `ollama pull` the UI/CLI can opt into.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WeightsPlan {
  needsDownload: boolean;
  /** Absolute path to the resolved GGUF blob, when already present locally. */
  weightsPath?: string;
  /** Suggested command to fetch the weights when not present. */
  pullHint?: string;
  detail: string;
}

export interface OllamaResolveDeps {
  /** ollama model-store roots to search, in order. Defaults to OLLAMA_MODELS env + the
   *  common per-user and system-service install locations. */
  candidateRoots?: string[];
  exists?: (path: string) => boolean | Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
}

export type PullWeightsExec = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface PullOllamaWeightsDeps {
  exec?: PullWeightsExec;
}

export interface PullOllamaWeightsResult {
  ok: boolean;
  ollamaRef: string;
  stdout?: string;
  stderr?: string;
  blocked?: string;
}

/** Parse an ollama-style ref ("ns/name:tag", "name:tag", or bare "name") into its parts.
 *  Pure — no I/O, no throw (defaults namespace to 'library' and tag to 'latest' like ollama itself). */
export function parseOllamaRef(ref: string): { namespace: string; name: string; tag: string } {
  const [repo, tag] = ref.split(':');
  const parts = repo.split('/').filter(Boolean);
  const namespace = parts.length > 1 ? parts[0] : 'library';
  const name = parts[parts.length - 1] ?? repo;
  return { namespace, name, tag: tag?.trim() || 'latest' };
}

function defaultOllamaRoots(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const roots: string[] = [];
  if (process.env.OLLAMA_MODELS) roots.push(process.env.OLLAMA_MODELS);
  if (home) roots.push(`${home}/.ollama/models`);
  // System-service install locations (ollama.service commonly runs as its own user with a
  // fixed HOME, e.g. this box's /usr/share/ollama — verified via `systemctl cat ollama`).
  roots.push('/usr/share/ollama/.ollama/models', '/var/lib/ollama/.ollama/models');
  return roots;
}

interface OllamaManifest {
  layers?: Array<{ mediaType?: string; digest?: string }>;
}

/**
 * Resolve an ollama-ref's GGUF weights against the local ollama blob store. Returns a plan
 * (present locally vs. needs a `pullHint` download) — never throws, never downloads.
 */
export async function resolveOllamaWeights(ollamaRef: string, deps: OllamaResolveDeps = {}): Promise<WeightsPlan> {
  const { namespace, name, tag } = parseOllamaRef(ollamaRef);
  const roots = deps.candidateRoots ?? defaultOllamaRoots();
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));

  for (const root of roots) {
    const manifestPath = `${root}/manifests/registry.ollama.ai/${namespace}/${name}/${tag}`;
    if (!(await exists(manifestPath))) continue;
    try {
      const raw = await read(manifestPath);
      const manifest = JSON.parse(raw) as OllamaManifest;
      const layer = (manifest.layers ?? []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
      if (!layer?.digest) continue;
      const blobPath = `${root}/blobs/${layer.digest.replace(':', '-')}`;
      if (await exists(blobPath)) {
        return { needsDownload: false, weightsPath: blobPath, detail: `resolved from the local ollama blob store (manifest: ${manifestPath})` };
      }
    } catch {
      // Malformed/partial manifest at this root — try the next candidate root rather than fail.
      continue;
    }
  }

  return {
    needsDownload: true,
    pullHint: `ollama pull ${ollamaRef}`,
    detail: `weights not found in any local ollama store (searched ${roots.length} root${roots.length === 1 ? '' : 's'}) — run the pull hint to download`,
  };
}

async function defaultPullExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync(cmd, args, { timeout: 0, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * Pull the requested ollama model into the local blob store. This is the write-side companion
 * to resolveOllamaWeights(): callers opt into the real download first, then re-run resolve/plan.
 */
export async function pullOllamaWeights(
  ollamaRef: string,
  deps: PullOllamaWeightsDeps = {},
): Promise<PullOllamaWeightsResult> {
  const exec = deps.exec ?? defaultPullExec;
  try {
    const { stdout, stderr } = await exec('ollama', ['pull', ollamaRef]);
    return { ok: true, ollamaRef, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ollamaRef,
      blocked: `ollama pull failed for ${ollamaRef}: ${message}`,
    };
  }
}
