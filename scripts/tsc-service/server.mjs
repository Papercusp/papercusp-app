#!/usr/bin/env node
// WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service.
//
// One tsgo API server keeps each requested project's program loaded and answers the gate's scoped
// `lint:tsc --files` requests (protocol and scoping live in scripts/lib/tsc-service.mjs). Run by
// the socket-activated user unit apps/operator/scripts/systemd/papercup-tsc-service.{socket,service}:
// systemd holds the socket, starts this on the first connection, and this exits after
// PAPERCUSP_TSC_SERVICE_IDLE_SEC without a request so the memory goes back to the host.
//
// Freshness is by construction, not by watching: requests are served in batches, and every batch
// first takes a new snapshot with `invalidateAll` (re-reads and re-resolves every file, ~1 s), so
// every answer reflects the tree as it stood after the request arrived.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportedTypeNames } from '../lib/tsc-baseline-gate.mjs';
import {
  TSC_SERVICE_MAX_CHECKED_FILES,
  checkedSetFor,
  refreshProjectRootFiles,
  renderDiagnostics,
  tscServiceSocketPath,
} from '../lib/tsc-service.mjs';

const ROOT = resolve(process.env.PAPERCUSP_TSC_SERVICE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
const IDLE_MS = (Number(process.env.PAPERCUSP_TSC_SERVICE_IDLE_SEC) || 20 * 60) * 1000;
// Two operator-sized programs fit the unit's 16 GB; a third project evicts the least recently used.
const MAX_OPEN_PROJECTS = Number(process.env.PAPERCUSP_TSC_SERVICE_MAX_PROJECTS) || 2;
// Past this the tsgo child is restarted between batches (the next request reloads, ~2.5 s).
const RSS_RESET_BYTES = (Number(process.env.PAPERCUSP_TSC_SERVICE_RSS_RESET_GIB) || 12) * 1024 ** 3;
const MAX_REQUEST_FILES = 500;

// The compiler comes from THIS checkout (the gate pins the same package), the files from ROOT.
const nativeDir = dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json'));
const { API } = await import(pathToFileURL(join(nativeDir, 'dist/api/async/api.js')).href);

const log = (line) => console.log(`[tsc-service] ${line}`);

/** @type {{ api: any, snapshot: any, snapshotAt: number, open: string[] }} */
const state = { api: null, snapshot: null, snapshotAt: 0, open: [] };
/** @type {{ request: any, reply: (response: object) => void, arrivedAt: number, cancelled: boolean }[]} */
const queue = [];
let draining = false;

// mtime-keyed text cache: the checked-set scan reads every in-repo program file per request, and
// almost none of them change between requests.
/** @type {Map<string, { mtimeMs: number, size: number, text: string }>} */
const textCache = new Map();
function cachedText(absFile) {
  let stat;
  try {
    stat = statSync(absFile);
  } catch {
    textCache.delete(absFile);
    return null;
  }
  const hit = textCache.get(absFile);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  try {
    const text = readFileSync(absFile, 'utf8');
    textCache.set(absFile, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text;
  } catch {
    return null;
  }
}

function tsgoRssBytes() {
  let total = 0;
  try {
    for (const tid of readdirSync(`/proc/${process.pid}/task`)) {
      const kids = readFileSync(`/proc/${process.pid}/task/${tid}/children`, 'utf8').trim();
      for (const pid of kids ? kids.split(/\s+/) : []) {
        const rss = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
        if (rss) total += Number(rss[1]) * 1024;
      }
    }
  } catch {
    // A child that exited mid-read is simply not counted.
  }
  return total;
}

async function resetApi(why) {
  log(`resetting tsgo (${why})`);
  const { api } = state;
  state.api = null;
  state.snapshot = null;
  state.open = [];
  try {
    await api?.close();
  } catch {
    // Already dead is the usual reason we are here.
  }
}

/** Take a fresh snapshot covering `projects`, opening and evicting projects as needed. */
async function refresh(projects) {
  if (!state.api) state.api = new API({ cwd: ROOT });
  const toOpen = projects.filter((p) => !state.open.includes(p));
  state.open = [...state.open.filter((p) => !projects.includes(p)), ...projects];
  const toClose = state.open.length > MAX_OPEN_PROJECTS
    ? state.open.slice(0, state.open.length - MAX_OPEN_PROJECTS).filter((p) => !projects.includes(p))
    : [];
  state.open = state.open.filter((p) => !toClose.includes(p));

  const previous = state.snapshot;
  let snapshot = await state.api.updateSnapshot({
    ...(toOpen.length > 0 ? { openProjects: toOpen } : {}),
    ...(toClose.length > 0 ? { closeProjects: toClose } : {}),
    ...(previous ? { fileChanges: { invalidateAll: true } } : {}),
  });
  // invalidateAll does not re-evaluate a tsconfig's include globs. Re-parse each config and tell
  // the API about both added and removed roots; otherwise deleted roots remain in the loaded program
  // and tsc reports TS6053 for a path that no longer exists.
  snapshot = await refreshProjectRootFiles({ api: state.api, snapshot, projects });
  previous?.dispose();
  state.snapshot = snapshot;
  state.snapshotAt = Date.now();
}

async function serve({ request, arrivedAt }) {
  const started = Date.now();
  const project = state.snapshot.getProject(request.project);
  if (!project) return { ok: false, reason: 'project-not-loaded', detail: request.project };
  const options = project.compilerOptions ?? {};
  // Under --noEmit the CLI's handling of declaration diagnostics is not verified against the API,
  // so a declaration-emitting project (agent-mcp today) keeps the CLI rather than risk a diff.
  if (options.declaration || options.composite) {
    return { ok: false, reason: 'declaration-emit-project', detail: 'service parity unverified for declaration diagnostics' };
  }
  const program = project.program;
  const scope = checkedSetFor({
    root: ROOT,
    named: request.files,
    programFiles: await program.getSourceFileNames(),
    typeNames: exportedTypeNames(ROOT, request.files),
    readText: cachedText,
  });
  if (scope.files.length > TSC_SERVICE_MAX_CHECKED_FILES) {
    return {
      ok: false,
      reason: 'scope-too-wide',
      detail: `${scope.files.length} files (limit ${TSC_SERVICE_MAX_CHECKED_FILES}); a full compile is cheaper`,
    };
  }

  const diagnostics = [...(await program.getConfigFileParsingDiagnostics()), ...(await program.getProgramDiagnostics())];
  for (const file of scope.files) {
    diagnostics.push(...(await program.getSyntacticDiagnostics(file)), ...(await program.getSemanticDiagnostics(file)));
  }
  // Deliberately NO getGlobalDiagnostics(): it checks the WHOLE program first (measured on
  // operator-core: 75 s and 3.7 -> 10 GB, against 30 ms for one file). Global diagnostics are
  // file-less and project-wide, not a scoped verdict; the bare run reports them.

  const seen = new Set();
  const errors = diagnostics
    .filter((d) => d.category === 1)
    .filter((d) => {
      const key = `${d.fileName ?? ''}\0${d.pos}\0${d.code}\0${d.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.fileName ?? '').localeCompare(b.fileName ?? '') || a.pos - b.pos);

  // Line/column come from the snapshot's own text, so a peer's edit since the refresh cannot
  // shift them.
  const texts = new Map();
  for (const fileName of new Set(errors.map((d) => d.fileName).filter(Boolean))) {
    const sourceFile = await program.getSourceFile(fileName);
    texts.set(fileName, typeof sourceFile?.text === 'string' ? sourceFile.text : cachedText(fileName));
  }
  const output = renderDiagnostics(errors, { root: ROOT, textFor: (fileName) => texts.get(fileName) ?? null });

  const judged = new Set(scope.files.map((abs) => relative(ROOT, abs)));
  for (const d of errors) if (d.fileName) judged.add(relative(ROOT, d.fileName));
  const now = Date.now();
  return {
    ok: true,
    output,
    errorCount: errors.length,
    checked: [...judged].sort(),
    counts: { named: scope.named, typeReferencing: scope.typeReferencing, importers: scope.importers },
    namedNotInProgram: scope.namedNotInProgram,
    snapshotAgeMs: now - state.snapshotAt,
    queuedMs: started - arrivedAt,
    checkMs: now - started,
  };
}

function validate(request) {
  if (!request || request.v !== 1) return 'unsupported protocol version';
  if (typeof request.root !== 'string' || resolve(request.root) !== ROOT) return `this service serves ${ROOT}`;
  if (typeof request.project !== 'string' || !isAbsolute(request.project) || !request.project.endsWith('.json')) {
    return 'project must be an absolute tsconfig path';
  }
  if (!request.project.startsWith(`${ROOT}/`)) return 'project is outside the served checkout';
  if (!Array.isArray(request.files) || request.files.length === 0 || request.files.length > MAX_REQUEST_FILES) {
    return `files must be 1..${MAX_REQUEST_FILES} paths`;
  }
  if (!request.files.every((f) => typeof f === 'string')) return 'files must be strings';
  return null;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      // Everything queued now arrived before the refresh below starts, so one snapshot is fresh
      // for the whole batch.
      const batch = queue.splice(0).filter((item) => !item.cancelled);
      if (batch.length === 0) continue;
      const projects = [...new Set(batch.map((item) => item.request.project))];
      try {
        await refresh(projects);
      } catch (error) {
        for (const item of batch) item.reply({ ok: false, reason: 'refresh-failed', detail: String(error?.message ?? error) });
        await resetApi(`refresh failed: ${error?.message ?? error}`);
        continue;
      }
      for (let i = 0; i < batch.length; i += 1) {
        const item = batch[i];
        if (item.cancelled) continue;
        try {
          const response = await serve(item);
          item.reply(response);
          log(
            response.ok
              ? `served ${relative(ROOT, item.request.project)} named=${item.request.files.length} checked=${response.checked.length} ` +
                  `errors=${response.errorCount} queuedMs=${response.queuedMs} checkMs=${response.checkMs} ` +
                  `tsgoRssGiB=${(tsgoRssBytes() / 1024 ** 3).toFixed(2)}`
              : `declined ${relative(ROOT, item.request.project)}: ${response.reason} ${response.detail ?? ''}`,
          );
        } catch (error) {
          item.reply({ ok: false, reason: 'check-failed', detail: String(error?.message ?? error) });
          await resetApi(`check failed: ${error?.message ?? error}`);
          // The rest of this batch goes back to the front of the queue for a fresh tsgo.
          queue.unshift(...batch.slice(i + 1));
          break;
        }
      }
      const rss = tsgoRssBytes();
      if (rss > RSS_RESET_BYTES) await resetApi(`tsgo RSS ${(rss / 1024 ** 3).toFixed(1)} GiB`);
    }
  } finally {
    draining = false;
    armIdleExit();
  }
}

let idleTimer = null;
function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (draining || queue.length > 0) return armIdleExit();
    void shutdown(`idle ${IDLE_MS / 1000}s`);
  }, IDLE_MS);
}

async function shutdown(why) {
  log(`exiting (${why})`);
  server.close();
  await resetApi(why);
  process.exit(0);
}

const server = createServer((socket) => {
  let buffer = '';
  let item = null;
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('close', () => {
    if (item) item.cancelled = true;
  });
  socket.on('data', (chunk) => {
    if (item) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > 1024 * 1024) socket.destroy();
      return;
    }
    const reply = (response) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };
    let request;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      reply({ ok: false, reason: 'bad-request', detail: 'not JSON' });
      return;
    }
    const invalid = validate(request);
    if (invalid) {
      reply({ ok: false, reason: 'bad-request', detail: invalid });
      return;
    }
    item = { request, reply, arrivedAt: Date.now(), cancelled: false };
    queue.push(item);
    armIdleExit();
    void drain();
  });
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// systemd socket activation passes the bound socket as fd 3; run by hand, bind the path ourselves.
if (process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid) {
  server.listen({ fd: 3 }, () => log(`listening on the systemd socket for ${ROOT}`));
} else {
  const socketPath = tscServiceSocketPath();
  mkdirSync(dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => log(`listening on ${socketPath} for ${ROOT}`));
}
armIdleExit();
