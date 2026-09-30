/**
 * provisioner/unit-drift — detect a DEPLOYED systemd unit that no longer matches the config its
 * catalog entry claims (and, for a certified entry, the config that was actually certified).
 * Plan: on-demand-local-inference-lifecycle-2026-08-17 (P-010), decision D-007.
 *
 * WHY THIS EXISTS. `llama-ornith.service` ran `-np 3 -c 614400 --cache-type-k q4_0` for weeks
 * while its catalog entry said 2 / 180224 / q8_0 and carried a `status:'certified'` stamp earned
 * on the catalog's numbers. Nothing noticed, for two compounding reasons:
 *
 *   1. the unit is a hand-managed local file with NO repo source, so no diff ever showed it; and
 *   2. the one test that looked at unit rendering — `backend-config.test.ts` — asserted only
 *      host and port, and asserted them against `renderLlamaServerUnit`'s OWN output.
 *
 * Reason 2 is the trap worth naming, because it is the shape a guard naturally grows into: a
 * test that re-asserts the generator against a literal proves the GENERATOR IS STABLE. It cannot
 * observe the deployed file at all, so it stays green through exactly the failure it appears to
 * cover. This module therefore compares GENERATED against DEPLOYED, parsing both through the
 * same parser so a renderer bug and a hand-edit are both in range.
 *
 * WHAT IS DELIBERATELY NOT COMPARED: `-m <weightsPath>`, log paths, `Description`, ordering and
 * whitespace. Those are legitimately per-box (the catalog cannot know this machine's blob path),
 * and folding them in would make the guard cry wolf on every install until someone silenced it —
 * which is how a guard dies. The operative inference parameters are the ones that change what
 * the server actually does, and they are the ones that drifted.
 */
import { access as fsAccess } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { CERTIFIED_CATALOG, type CatalogEntry } from './catalog';
import { renderLlamaServerUnit } from './backend-config';

export interface LlamaServerUnitParams {
  host: string | null;
  port: number | null;
  parallelSlots: number | null;
  ctxTotal: number | null;
  kvCacheTypeK: string | null;
  kvCacheTypeV: string | null;
  flashAttn: boolean | null;
  alias: string | null;
  gpuLayers: number | null;
}

/**
 * Pull the operative llama-server flags out of a systemd unit's `ExecStart`.
 *
 * Handles systemd's backslash line-continuations, which is the whole reason this is a parser and
 * not a regex over the file: every real unit here spreads ExecStart across seven lines, so a
 * naive per-line match sees `-np 2 -c 180224` and `--cache-type-k q8_0` as unrelated fragments.
 *
 * A field is `null` when the flag is absent — never a default. A guard that silently substitutes
 * a default for a missing flag reports agreement between a unit that sets a value and one that
 * does not, which is a drift.
 */
/**
 * Tokenise a unit's `ExecStart`, re-joining systemd's backslash line-continuations first.
 *
 * Shared by the flag parser and the binary check so the two can never disagree about where the
 * command starts or ends — the continuation handling is the fiddly part, and having it twice is
 * how the two views drift apart.
 */
function execStartTokens(unitText: string): string[] {
  const lines = unitText.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('ExecStart='));
  if (start === -1) return [];
  const parts: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    const continued = raw.trimEnd().endsWith('\\');
    parts.push(continued ? raw.trimEnd().slice(0, -1) : raw);
    if (!continued) break;
  }
  return parts.join(' ').replace(/^\s*ExecStart=/, '').trim().split(/\s+/).filter(Boolean);
}

/**
 * The ExecStart BINARY — deliberately NOT a field on `LlamaServerUnitParams`.
 *
 * `diffUnitParams` compares every key of that object, and the engine path is legitimately per-box
 * (the catalog cannot know where this machine keeps its binary). Folding it in would make the
 * guard cry wolf on every install until someone silenced it — the death-by-noise this module's
 * header warns about. Existence is a DIFFERENT QUESTION from drift: not "does this unit match the
 * catalog" but "can this unit start at all".
 *
 * Strips systemd's ExecStart prefix modifiers (`-` ignore-failure, `@` argv0, `+` full-privilege,
 * `!`/`!!` no-setuid), which may be combined.
 */
export function parseUnitExecStartBinary(unitText: string): string | null {
  const first = execStartTokens(unitText)[0];
  if (first === undefined) return null;
  const stripped = first.replace(/^[-@+!:]+/, '');
  return stripped.length > 0 ? stripped : null;
}

export interface UnitBinaryCheck {
  binaryPath: string | null;
  ok: boolean;
  /** `ok` · `no-execstart` (nothing to run) · `missing` (path absent) · `not-executable` (present, no +x). */
  reason: 'ok' | 'no-execstart' | 'missing' | 'not-executable';
  detail: string;
}

/**
 * Assert the unit's ExecStart binary EXISTS and is executable.
 *
 * WHY THIS EXISTS (EI-20721621940954812, measured 2026-08-17). `llama-ornith.service` was 100%
 * unstartable — its ExecStart named a hand-built `~/llama.cpp/build/bin/llama-server` that had
 * been deleted along with the whole source tree — and it sat in an auto-restart loop with
 * NRestarts=182, `status=203/EXEC`. Every check in this module passed GREEN throughout: the unit
 * text still declared exactly the certified `-np`/`-c`/`--cache-type-*`/`--flash-attn` values, so
 * a parameter diff had nothing to say. The guard compared what the unit WOULD run with, and never
 * asked whether it could run.
 *
 * The cost of that gap is why it is worth a distinct check rather than a footnote: an immediate,
 * nameable failure (`the engine binary is gone`) instead presented as a 15-minute silent timeout
 * that read exactly like a slow 15.5GB model load. The one tell was GPU memory never moving —
 * i.e. the operator had to already suspect the answer to find it. This generalises to every
 * provisioned backend, not just this unit.
 *
 * `access` is injected so the check is testable without touching the filesystem.
 */
export async function checkUnitExecStartBinary(
  unitText: string,
  access: (path: string, mode: number) => Promise<void> = (path, mode) => fsAccess(path, mode),
): Promise<UnitBinaryCheck> {
  const binaryPath = parseUnitExecStartBinary(unitText);
  if (binaryPath === null) {
    return { binaryPath: null, ok: false, reason: 'no-execstart', detail: 'unit declares no ExecStart command' };
  }
  try {
    await access(binaryPath, fsConstants.X_OK);
    return { binaryPath, ok: true, reason: 'ok', detail: `${binaryPath} exists and is executable` };
  } catch {
    // Distinguish absent from present-but-not-executable: they are different operator fixes
    // (reinstall/repoint vs chmod), and systemd reports BOTH as a bare 203/EXEC.
    try {
      await access(binaryPath, fsConstants.F_OK);
      return {
        binaryPath,
        ok: false,
        reason: 'not-executable',
        detail: `${binaryPath} exists but is NOT executable — systemd will fail this unit with status=203/EXEC`,
      };
    } catch {
      return {
        binaryPath,
        ok: false,
        reason: 'missing',
        detail: `${binaryPath} does NOT exist — the unit cannot start (systemd reports status=203/EXEC and, with Restart=on-failure, retries forever)`,
      };
    }
  }
}

export function parseLlamaServerUnit(unitText: string): LlamaServerUnitParams {
  const lines = unitText.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('ExecStart='));
  const params: LlamaServerUnitParams = {
    host: null,
    port: null,
    parallelSlots: null,
    ctxTotal: null,
    kvCacheTypeK: null,
    kvCacheTypeV: null,
    flashAttn: null,
    alias: null,
    gpuLayers: null,
  };
  if (start === -1) return params;

  const tokens = execStartTokens(unitText);

  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    switch (tokens[i]) {
      case '--host':
        params.host = tokens[i + 1] ?? null;
        break;
      case '--port':
        params.port = num(tokens[i + 1]);
        break;
      case '-np':
      case '--parallel':
        params.parallelSlots = num(tokens[i + 1]);
        break;
      case '-c':
      case '--ctx-size':
        params.ctxTotal = num(tokens[i + 1]);
        break;
      case '--cache-type-k':
        params.kvCacheTypeK = tokens[i + 1] ?? null;
        break;
      case '--cache-type-v':
        params.kvCacheTypeV = tokens[i + 1] ?? null;
        break;
      case '--flash-attn':
        // llama-server takes `--flash-attn on|off`; treat a bare flag as enabled.
        params.flashAttn = tokens[i + 1] === 'off' ? false : true;
        break;
      case '-ngl':
      case '--gpu-layers':
      case '--n-gpu-layers':
        params.gpuLayers = num(tokens[i + 1]);
        break;
      case '--alias':
        params.alias = tokens[i + 1] ?? null;
        break;
      default:
        break;
    }
  }
  return params;
}

export interface UnitDrift {
  param: keyof LlamaServerUnitParams;
  generated: string;
  deployed: string;
}

/** Compare two units' operative parameters. Empty ⇒ no drift. */
export function diffUnitParams(generated: LlamaServerUnitParams, deployed: LlamaServerUnitParams): UnitDrift[] {
  const drift: UnitDrift[] = [];
  for (const key of Object.keys(generated) as Array<keyof LlamaServerUnitParams>) {
    const g = generated[key];
    const d = deployed[key];
    if (g !== d) drift.push({ param: key, generated: String(g), deployed: String(d) });
  }
  return drift;
}

/**
 * The guard's main entry point: render the unit this catalog entry DESCRIBES, then compare it to
 * the unit actually deployed.
 *
 * `weightsPath`/`binPath`/`logPath` are irrelevant to the comparison (see the header) but the
 * renderer requires them, so they are filled from the deployed unit where possible and are never
 * compared.
 */
export function diffCatalogAgainstDeployedUnit(entry: CatalogEntry, deployedUnitText: string): UnitDrift[] {
  const generatedText = renderLlamaServerUnit({
    alias: entry.model.ollamaRef,
    weightsPath: 'IRRELEVANT-NOT-COMPARED',
    host: entry.serve.host,
    port: entry.serve.portDefault,
    parallelSlots: entry.serve.parallelSlots,
    ctxTotal: entry.serve.ctxTotal,
    kvCacheType: entry.serve.kvCacheType,
    flashAttn: entry.serve.flashAttn,
    jinja: entry.serve.jinja,
    reasoningBudget: entry.serve.reasoningBudget,
    gpuLayers: entry.serve.gpuLayers,
    logPath: 'IRRELEVANT-NOT-COMPARED',
  });
  // Both sides go through the SAME parser on purpose: that is what puts a renderer regression in
  // range of this guard, instead of only a hand-edit to the deployed file.
  return diffUnitParams(parseLlamaServerUnit(generatedText), parseLlamaServerUnit(deployedUnitText));
}

/** One-line human summary for a log or a test failure message. */
export function describeUnitDrift(drift: readonly UnitDrift[]): string {
  if (drift.length === 0) return 'no drift';
  return drift.map((d) => `${d.param}: catalog=${d.generated} deployed=${d.deployed}`).join(' · ');
}

/**
 * Environment variables a unit DECLARES, as `KEY -> value`.
 *
 * Separate from `parseLlamaServerUnit` because these live outside `ExecStart` entirely, and because
 * they are CHECKED differently — see `checkRequiredEnvironment`.
 *
 * Later assignments win, which is systemd's own precedence for a repeated key. Handles both
 * `Environment=K=V` and the multi-assignment quoted form `Environment="K=V" "K2=V2"`.
 */
export function parseUnitEnvironment(unitText: string): Record<string, string> {
  const env: Record<string, string> = {};
  const assignment = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g;
  for (const raw of unitText.split('\n')) {
    const line = raw.trim();
    // `EnvironmentFile=` is a DIFFERENT directive naming a file we cannot read from here. Matching
    // it as if it were an assignment would invent a variable called `EnvironmentFile`, so require
    // the `=` immediately: startsWith('Environment=') excludes it.
    if (!line.startsWith('Environment=')) continue;
    const body = line.slice('Environment='.length).trim();
    assignment.lastIndex = 0;
    let m = assignment.exec(body);
    while (m !== null) {
      env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      m = assignment.exec(body);
    }
  }
  return env;
}

export interface UnitEnvIssue {
  key: string;
  /** `missing` (no such assignment) · `empty` (declared, assigned nothing — same net effect). */
  reason: 'missing' | 'empty';
  detail: string;
}

/**
 * Assert the environment variables a catalog entry declares it CANNOT SERVE CORRECTLY WITHOUT.
 *
 * WHY THIS IS PRESENCE-ONLY, AND NOT A FIELD ON `diffUnitParams`. The values are per-box install
 * paths — the catalog cannot know where this machine keeps its CUDA runtime — so comparing them
 * would report drift on every install until someone silenced the guard, the death-by-noise this
 * module's header warns about. Their PRESENCE is not per-box at all: it is the whole difference
 * between using the GPU and not. So this asks the half that has a machine-independent answer.
 *
 * WHY IT EXISTS (WI-39735 / D-012, measured 2026-08-17). `llama-ornith.service` needs
 * `LD_LIBRARY_PATH` and `GGML_BACKEND_PATH` because ollama ships its CUDA backend as
 * `cuda_v13/libggml-cuda.so`, inside a subdirectory ggml's backend loader does not scan. Delete
 * either line and the engine finds no CUDA device, silently falls back to CPU, loads the model into
 * ~10GB of system RAM, and returns HTTP 200 on `/health` exactly as if all were well — matching the
 * catalog on every parameter `diffUnitParams` compares. The one outward tell was GPU memory never
 * moving, i.e. you had to already suspect the answer to find it.
 *
 * Same shape as `checkUnitExecStartBinary`: not "does this unit match the catalog" but "can this
 * unit do the job the catalog says it does".
 */
export function checkRequiredEnvironment(entry: CatalogEntry, deployedUnitText: string): UnitEnvIssue[] {
  const required = entry.serve.requiredEnv ?? [];
  if (required.length === 0) return [];
  const env = parseUnitEnvironment(deployedUnitText);
  const issues: UnitEnvIssue[] = [];
  for (const key of required) {
    const value = env[key];
    if (value === undefined) {
      issues.push({
        key,
        reason: 'missing',
        detail: `${key} is not set by the deployed unit, and catalog '${entry.id}' declares it REQUIRED — the backend will start, report active and answer /health while serving degraded (D-012)`,
      });
    } else if (value.trim() === '') {
      issues.push({
        key,
        reason: 'empty',
        detail: `${key} is declared but assigned an empty value — the same net effect as omitting it`,
      });
    }
  }
  return issues;
}

/** One-line human summary for a log or a test failure message. */
export function describeEnvIssues(issues: readonly UnitEnvIssue[]): string {
  if (issues.length === 0) return 'no missing required environment';
  return issues.map((i) => `${i.key}: ${i.reason}`).join(' · ');
}

export interface CatalogResolution {
  entry: CatalogEntry | null;
  /** `ok` · `no-model-refs` (caller passed none) · `no-match` · `ambiguous` (>1 entry matched). */
  reason: 'ok' | 'no-model-refs' | 'no-match' | 'ambiguous';
  detail: string;
}

/**
 * Resolve the catalog entry a REGISTERED backend was provisioned from.
 *
 * ⚠ THE OBVIOUS IMPLEMENTATION IS WRONG AND FAILS SILENTLY. `findCatalogEntry(backend.id)` looks
 * like the way to do this and returns `undefined` for the one backend on this box: the registry id
 * is `ornith-llamaserver` while the catalog id is `ornith-35b-iq3m-llama-server` (measured
 * 2026-08-18). They are independent namespaces — `planProvision` only derives one from the other
 * when it invents an id (`provisioner-<entryId>`), and a hand-registered backend (which is every
 * on-demand backend here) never went through it. An id-keyed lookup therefore reports "nothing to
 * audit" on exactly the units that need auditing, and reports it as SUCCESS.
 *
 * The join that does hold is the MODEL REF: `local_backends.models` contains the alias set the
 * gateway routes on, and the entry's `model.ollamaRef` is one of them. `kind` disambiguates the
 * same model served by two backends (llama-server vs vLLM), which is a real catalog shape.
 *
 * Returns a REASON rather than a bare null on failure, because "no entry" and "several entries"
 * are different bugs, and because a caller that cannot tell them apart from "audited, all clear"
 * will report a broken audit as a green one — the exact failure this module exists to prevent.
 */
export function resolveCatalogEntryForBackend(
  backend: { models?: readonly string[]; kind?: string },
  catalog: readonly CatalogEntry[] = CERTIFIED_CATALOG,
): CatalogResolution {
  const models = backend.models ?? [];
  if (models.length === 0) {
    return { entry: null, reason: 'no-model-refs', detail: 'backend declares no model refs — nothing to join the catalog on' };
  }
  const matches = catalog.filter(
    (e) => models.includes(e.model.ollamaRef) && (backend.kind === undefined || e.backend === backend.kind),
  );
  if (matches.length === 1) {
    return { entry: matches[0], reason: 'ok', detail: `catalog entry '${matches[0].id}' matched on model ref` };
  }
  if (matches.length === 0) {
    return {
      entry: null,
      reason: 'no-match',
      detail: `no catalog entry serves any of [${models.join(', ')}]${backend.kind ? ` on backend '${backend.kind}'` : ''}`,
    };
  }
  return {
    entry: null,
    reason: 'ambiguous',
    detail: `${matches.length} catalog entries matched (${matches.map((m) => m.id).join(', ')}) — refusing to guess which one this unit implements`,
  };
}

export interface DeployedUnitAudit {
  /** `ok` · `degraded` (something the catalog requires is wrong) · `unauditable` (could not check). */
  verdict: 'ok' | 'degraded' | 'unauditable';
  catalogEntryId: string | null;
  drift: UnitDrift[];
  envIssues: UnitEnvIssue[];
  binary: UnitBinaryCheck | null;
  summary: string;
}

/**
 * Run EVERY check in this module against one deployed unit, and return a single verdict.
 *
 * The three checks answer three different questions and a caller needs all three — "does this unit
 * match the catalog" (`diffCatalogAgainstDeployedUnit`), "can it start at all"
 * (`checkUnitExecStartBinary`, D-011), and "can it do the job the catalog claims"
 * (`checkRequiredEnvironment`, D-012). Both historical incidents passed two of the three, so a
 * caller wiring up only its favourite would reproduce the original blindness.
 *
 * `unauditable` is a FIRST-CLASS verdict, never folded into `ok`: an audit that could not run and
 * an audit that found nothing wrong are opposite facts, and collapsing them is how a guard reports
 * green while looking at nothing.
 */
export async function auditDeployedUnit(
  entry: CatalogEntry,
  deployedUnitText: string,
  opts: { access?: (path: string, mode: number) => Promise<void> } = {},
): Promise<DeployedUnitAudit> {
  const drift = diffCatalogAgainstDeployedUnit(entry, deployedUnitText);
  const envIssues = checkRequiredEnvironment(entry, deployedUnitText);
  const binary = await checkUnitExecStartBinary(deployedUnitText, opts.access);
  const degraded = drift.length > 0 || envIssues.length > 0 || !binary.ok;
  const parts = [
    drift.length > 0 ? `drift[${describeUnitDrift(drift)}]` : null,
    envIssues.length > 0 ? `env[${describeEnvIssues(envIssues)}]` : null,
    binary.ok ? null : `binary[${binary.reason}: ${binary.detail}]`,
  ].filter((p): p is string => p !== null);
  return {
    verdict: degraded ? 'degraded' : 'ok',
    catalogEntryId: entry.id,
    drift,
    envIssues,
    binary,
    summary: degraded
      ? `unit does not match catalog '${entry.id}' — ${parts.join(' · ')}`
      : `unit matches catalog '${entry.id}' (params, required env, engine binary)`,
  };
}

/**
 * `auditDeployedUnit` for a backend as the GATEWAY knows it — resolve the catalog entry first,
 * and report an honest `unauditable` when it cannot be resolved.
 */
export async function auditDeployedUnitForBackend(
  backend: { models?: readonly string[]; kind?: string },
  deployedUnitText: string,
  opts: { access?: (path: string, mode: number) => Promise<void>; catalog?: readonly CatalogEntry[] } = {},
): Promise<DeployedUnitAudit> {
  const resolution = resolveCatalogEntryForBackend(backend, opts.catalog);
  if (resolution.entry === null) {
    return {
      verdict: 'unauditable',
      catalogEntryId: null,
      drift: [],
      envIssues: [],
      binary: null,
      summary: `cannot audit deployed unit: ${resolution.detail}`,
    };
  }
  return auditDeployedUnit(resolution.entry, deployedUnitText, { access: opts.access });
}
