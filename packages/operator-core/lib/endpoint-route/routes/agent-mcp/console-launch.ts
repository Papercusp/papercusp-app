/**
 * GET (?action=spawn) / POST / OPTIONS /api/agent-mcp/console/launch
 *
 * Server-side native-console launcher. Principal-gated; CORS-open
 * (the endpoint itself is gated, operator binds loopback-only).
 *
 * Ported from app/api/agent-mcp/console/launch/route.ts. `auth: 'public'` —
 * requirePrincipal() inline.
 *
 * The OS-native spawn primitive (terminal selection, the launcher one-liner,
 * the per-plan window appearance) lives in `lib/console-spawn.ts` so this route
 * and the `capability:terminal` agent tool share ONE spawner.
 */
import type { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeWorkspaceId } from '../../../workspace-registry';
import { papercuspPathForWorkspace } from '../../../papercusp-root';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { advSessionTitleTag, spawnConsole, spawnHeadless } from '../../../console-spawn';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';
import { recordAdvSession, markAdvSessionEnded, setAdvSessionPid, setAdvSessionWindowId } from '../../../adv-sessions';
import { resolveWindowIdForTitleFragment } from '../../../adv-session-windows';

// Fire-and-forget child-exit listener that ends the adv_sessions row
// when the spawned terminal closes. detached+unref'd children still
// emit 'exit' on the parent's ChildProcess handle as long as we keep
// the JS reference alive — we don't, because the parent process
// outlives any one terminal. So we attach the listener and let Node
// hold it via the closure; the row will close when the terminal exits
// if the operator process is still alive, otherwise the row stays
// "active" (acceptable — operator-restart is the recovery boundary
// anyway). A future reaper can sweep stale rows by querying live pids.
function attachExitWatcher(child: ChildProcess, sessionPromise: Promise<number | null>): void {
  // WI-38054: `signal` is the second argument Node has always passed here, and dropping
  // it recorded every killed terminal as a voluntary 'self' exit. Node gives it as a
  // NAME ('SIGHUP'), which is exactly what the column stores.
  child.on('exit', (code, signal) => {
    sessionPromise
      .then((id) => {
        if (id == null) return;
        void markAdvSessionEnded(id, code, signal ? 'signal' : 'self', { signal });
      })
      .catch(() => { /* best-effort */ });
  });
}

const DEBUG_LOG = '/tmp/console-launch.log';
function dlog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
};

function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

async function gatePrincipal(headers: Headers): Promise<Response | null> {
  try {
    await requirePrincipal(headers);
    return null;
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return jsonRes({ status: 'error', error: err.reason }, err.status);
    }
    throw err;
  }
}

async function resolveAndStoreWindowIdForAdvSession(id: number): Promise<void> {
  const tag = advSessionTitleTag(id);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const wid = await resolveWindowIdForTitleFragment(tag);
    if (wid) {
      await setAdvSessionWindowId(id, wid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Safety floor for INTERACTIVE launches (P-012 / D-013 residual 3): the shared
// helper lives in lib/interactive-safety-floor.ts so EVERY interactive launch
// route (this console launch + adv/launch-su's psu web launch) passes the same
// floor — admission waived (human-initiated), ceiling still enforced, fail-open
// on a read error. Re-exported for compat (console-launch-floor.test.ts + any
// existing importer).
export { checkInteractiveSafetyFloor } from '../../../interactive-safety-floor';
import { checkInteractiveSafetyFloor } from '../../../interactive-safety-floor';

async function doSpawn(opts: { slug: string | null; operatorBaseUrl: string }): Promise<void> {
  // Safety floor (admission waived, human-initiated) — refuse over-ceiling. The
  // GET ?action=spawn handler catches + dlogs this throw, so no terminal launches.
  const floor = await checkInteractiveSafetyFloor(dlog);
  if (!floor.ok) throw new Error(floor.reason);
  const envelope = await buildConsoleEnvelope({
    workspaceId: activeWorkspaceId(),
    slug: opts.slug,
    operatorBaseUrl: opts.operatorBaseUrl,
  });
  const result = await spawnConsole({ envelope, writeMcpJson: true });
  if (result.status === 'error') throw new Error(result.error);
  dlog(`doSpawn launched ${result.terminal} pid=${result.pid}`);
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/launch',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/launch',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const slug = url.searchParams.get('slug');
    const origin = req.headers.get('origin') ?? '(no-origin)';
    const ua = req.headers.get('user-agent') ?? '(no-ua)';

    if (action !== 'spawn') {
      dlog(`GET probe origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
      return jsonRes(
        { status: 'probe-ok', note: 'use ?action=spawn or POST to actually spawn a terminal' },
      );
    }

    dlog(`GET spawn origin=${origin} host=${req.headers.get('host')} slug=${slug ?? '(null)'} ua=${ua.slice(0, 60)}`);

    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    try {
      await doSpawn({ slug: slug || null, operatorBaseUrl: new URL(req.url).origin });
    } catch (e: any) {
      dlog(`GET spawn failed: ${e?.message}`);
    }
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    return new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/launch',
  auth: 'loopback',
  async handler(req) {
    const origin = req.headers.get('origin') ?? '(no-origin)';
    const ua = req.headers.get('user-agent') ?? '(no-ua)';
    dlog(`POST hit origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
    console.log(`[console-launch] POST hit from origin=${origin} host=${req.headers.get('host')}`);

    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    // Safety floor (P-012 / D-013): interactive launches waive brain admission
    // but still pass the deterministic floor (the absolute concurrency ceiling).
    // Over-ceiling → 429 with an actionable message; admission itself is waived.
    const floorCheck = await checkInteractiveSafetyFloor(dlog);
    if (!floorCheck.ok) return jsonRes({ status: 'error', error: floorCheck.reason }, 429);
    let body: {
      slug?: string | null;
      // plan-agent-launch P-023: when set, the new terminal resumes an
      // existing session (`<agent-cli> -r <sessionId>`) instead of opening fresh.
      resumeSessionId?: string | null;
      // WI-3882: FORK the resumed session (claude `--fork-session`) instead of
      // resuming it in place — used when the source session is still LIVE so the
      // fork branches into a fresh session id and doesn't collide with the
      // still-running original. Only meaningful with resumeSessionId.
      fork?: boolean;
      // "Resume in GUI" (resume-in-gui-button-2026-08-09, owner ask 2026-08-09):
      // spawn this resume with NO terminal window. The human is going to talk to it
      // through the HUD conversation popup (`SessionChatModal`, keyed on the session's
      // coord owner id) instead of a terminal, and `psu --resume` is
      // identity-preserving — it re-registers under the SAME coord owner id — so the
      // popup the caller opens afterwards lands on this very agent.
      //
      // NOT just "hide the window": the envelope appends psu's `--headless`, which is
      // what keeps the managed pty alive under non-TTY stdio. That pty is what the GUI
      // composer's `coord:send { wake:'required' }` injects into. Only meaningful with
      // resumeSessionId, and claude-only — the envelope refuses the rest (codex/omp
      // resumes exec the bare CLI, so headless they would be unreachable).
      headless?: boolean;
      // WI-6510 (hud-chat-owner-controls-2026-08-11 P-002): resume this session
      // on a DIFFERENT model/effort spec. Only meaningful with resumeSessionId,
      // and claude-only — the envelope throws for the rest, because codex/omp
      // resumes exec the bare CLI and would silently drop the flag (D-002's
      // silent no-op, which is the failure this whole control exists to avoid).
      //
      // The value is the COMPOSED `<model>[:<effort>]` spec, never a separate
      // effort field: psu has no `--effort` flag, so effort rides the model spec
      // and psu's own resume path splits the tail per backend
      // (psu-launcher.mjs:1197 → modelArgsFor). Composing at that seam is the one
      // form every backend honours; re-emitting our own flags here would drop
      // effort silently AND pass every test (D-007).
      resumeModel?: string | null;
      // /adv plumbing: tag this session with the plan it was
      // launched from so /adv/sessions can group + display.
      planSlug?: string | null;
      label?: string | null;
      // psu-in-desktop-builds B: launch straight into a psu superuser session
      // (flag-gated server-side on PSU_END_USER in buildConsoleEnvelope).
      runPsu?: boolean;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — empty body is fine */ }

    // This route is the SHELL superuser-console launcher. The omp launch
    // flavour was retired in P-032 — omp now rides launch-su → psu like
    // every other backend, so there is no longer a mode/kickoff/model branch
    // here. (resumeSessionId stays: shell consoles can resume `<cli> -r`.)
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: activeWorkspaceId(),
        slug: body.slug ?? null,
        operatorBaseUrl: new URL(req.url).origin,
        resumeSessionId: body.resumeSessionId ?? undefined,
        fork: body.fork ?? false,
        // resume-in-gui-button-2026-08-09. Only ever true alongside resumeSessionId
        // (the GUI button is the sole caller); the envelope throws for a non-claude
        // backend, which the catch below turns into a 400 with that reason.
        headless: body.headless ?? false,
        // WI-6510. Same shape as `headless` above: only ever set alongside
        // resumeSessionId (the footer MODEL pill is the sole caller), and the
        // envelope throws for a non-claude backend — which the catch below turns
        // into a 400 carrying that reason, so a refused model change SAYS SO
        // instead of launching a session that quietly kept the old model.
        resumeModel: body.resumeModel ?? undefined,
        runPsu: body.runPsu ?? false,
      });
    } catch (e: any) {
      console.warn(`[console-launch] envelope build failed: ${e?.message}`);
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    // Spawn (writes/back-ups .mcp.json, picks a terminal, opens a new window).
    // Linux-only at this tier; non-Linux operators get code 501 and the
    // renderer falls back to the Tauri console_launch command.
    //
    // resume-in-gui-button-2026-08-09: `headless` swaps the WINDOW, nothing else —
    // same envelope, same greeting, same adv_sessions bookkeeping below. It routes
    // through `spawnHeadless` deliberately rather than a hand-rolled detached spawn:
    // that helper enrols the child in the task ledger and, on a systemd host, puts it
    // in a transient `systemd-run --user --scope` sibling of the operator's own
    // service, so an operator restart cannot reap the session the human is chatting to
    // (EI-9748). It also probes for a boot-time death and returns the log tail, so a
    // GUI resume that dies on launch says so instead of leaving the popup waiting on
    // an agent that never existed.
    const result = body.headless
      ? await spawnHeadless({
          envelope,
          label: body.label ?? 'resume in GUI',
          // The workspace's fleet-logs dir — NON-repo, so git-sync never tries to
          // commit a session log into the staging tree (same choice launch-su's
          // headless leg makes, and the same reason).
          logDir: join(papercuspPathForWorkspace(activeWorkspaceId()), 'fleet-logs'),
          coordOwnerId: envelope.coordOwnerId,
        })
      : await spawnConsole({
          envelope,
          planSlug: body.planSlug ?? null,
          label: body.label ?? null,
          writeMcpJson: true,
        });
    if (result.status === 'error') {
      console.warn(`[console-launch] spawn failed (${result.code}): ${result.error}`);
      return jsonRes({ status: 'error', error: result.error }, result.code);
    }

    const sessionPromise = recordAdvSession({
      planSlug: body.planSlug ?? null,
      mode: 'console',
      terminalBin: result.terminal,
      pid: result.pid,
      label: body.label ?? null,
      cwd: envelope.cwd,
      // WI-1343: record the actual command run in the spawned terminal — the terminal
      // binary + the envelope's greeting command (a resume `<cli> -r <id>`, `psu`, or
      // the shell greeting). Before this, launch_argv was NULL for every console
      // launch, so a spawned session could not be reconstructed after the fact.
      launchArgv: [result.terminal, envelope.greetingCmd].filter((s): s is string => !!s),
    });
    // `child` is always present here — this route never opts into the WI-3289
    // desktop bridge (the only child-less ok path); the guard is type-narrowing.
    // (spawnHeadless returns one too, so a GUI resume closes its row the same way.)
    if (result.child) attachExitWatcher(result.child, sessionPromise);
    console.log(`[console-launch] spawned ${result.terminal} pid=${result.pid} cwd=${envelope.cwd}`);
    return jsonRes({
      status: 'ok',
      pid: result.pid,
      // For a headless launch this already reads "headless (log: <path>)", so the
      // caller is told where to tail without a second field.
      terminal: result.terminal,
      // resume-in-gui-button-2026-08-09: state the posture explicitly rather than
      // making the caller pattern-match `terminal` prose. The GUI button uses it to
      // distinguish "no window opened, as intended" from a headed launch.
      ...(body.headless ? { headless: true } : {}),
    });
  },
});

export default [options, get, post];
