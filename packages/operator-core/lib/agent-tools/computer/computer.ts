/**
 * capability:computer — bee-operated desktop control.
 *
 * A THIN wrapper (parity with capability:bash — wraps real execution, no
 * reimplementation) over the pure `desktop-driver` planner: it executes the
 * planned `xdotool` input / `import` capture against the agent's LEASED SANDBOX
 * display and returns a screenshot as an MCP image content block (gate #1 — a
 * raw ToolResult `{ content:[{type:'image',…}] }` passes through the dispatcher
 * untouched, so the bee's model SEES the screen).
 *
 * The bee's own agent runtime is the loop (screenshot → reason → act → repeat);
 * this tool is only the eyes + hands + safety catch. The canonical Anthropic
 * `computer` action vocabulary is mirrored verbatim so Claude's trained grounding
 * priors fire.
 *
 * SAFETY: the target display is resolved SERVER-SIDE from the per-agent lease
 * env (`PAPERCUSP_COMPUTER_DISPLAY`), NEVER from the model's args, and the host
 * display `:0` is hard-refused. A bee with no leased desktop gets a loud error,
 * not a fallback — deny-by-default (the whole point of sandboxing computer use).
 *
 * Phase 1 of computer-tool-plan: the display lease is read from env; Phase 2
 * provisions the sandbox desktop + writes the lease. Not live until deployed.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import {
  assertSandboxDisplay,
  captureCommand,
  planAction,
  toCaptureCoord,
  xdotoolCommand,
  type ComputerActionInput,
  type DesktopTarget,
} from './desktop-driver';
import { hiveDesktop } from './desktop-lease';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  DEFAULT_CAPTURE_GEOMETRY,
  resolveDesktopForScope,
  resolveLocalDesktopByDisplay,
} from '../../desktop/desktop-session-registry';
import { scrubExecEnv } from '../capability/exec-sandbox';
import { snapshotA11yTree } from './a11y-snapshot';
import { recordAction, renderLedgerLine, type ActionLedgerEntry, type ObservedAs } from './action-ledger';
import { isRecording, noteRecordedAction } from './trajectory-recorder';
import { runGovernedOperation } from '../../resource-governor/execution';

/** The canonical computer-use resolution (best model grounding accuracy). */
const DEFAULT_W = 1024;
const DEFAULT_H = 768;
const EXEC_TIMEOUT_MS = 15_000;

export interface ComputerExecResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Injectable exec seam (overridden in tests so the handler runs with no live X). */
export type ComputerExec = (
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; signal?: AbortSignal },
) => Promise<ComputerExecResult>;

const realExec: ComputerExec = (bin, args, opts) =>
  runGovernedOperation(
    {
      workspaceId: activeWorkspaceId(),
      namespace: 'computer-command',
      owner: 'capability:computer',
      admissionClass: 'process',
      demand: { cpuWeight: 0.25, memoryBytes: 64 * 1024 * 1024, fileDescriptors: 3 },
      payloadRef: `computer-command:${bin}`,
      metadata: { binary: bin },
    },
    async () =>
      new Promise((resolveExec, reject) => {
        const child = spawn(bin, args, {
          // ISOLATION (2026-06-19 keystroke-leak fix + EI-1617 secrets-leak fix):
          // scrubExecEnv is an ALLOWLIST (strictly narrower than the old
          // stripHostX-only denylist) — it drops the operator's host X session
          // (DISPLAY=:0 / gdm XAUTHORITY, same as before: neither is allowlisted)
          // AND every operator secret (DB creds, webhook/JWT secrets, session
          // keys, …) that a desktop-driving xdotool/import call has no business
          // seeing. opts.env (the leased sandbox DISPLAY) is spread AFTER, so it
          // always wins regardless of the allowlist.
          env: { ...scrubExecEnv(process.env), ...(opts.env ?? {}) },
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), EXEC_TIMEOUT_MS);
        child.stdout?.on('data', (d: Buffer) => out.push(d));
        child.stderr?.on('data', (d: Buffer) => err.push(d));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', (status) => {
          clearTimeout(timer);
          resolveExec({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
        });
      }),
  );

let execImpl: ComputerExec = realExec;
/** The live executor, shared with the accessibility tools so both honour the same
 *  env scrubbing, timeout and test seam rather than growing a second spawn path. */
export const computerExec: ComputerExec = (bin, args, opts) => execImpl(bin, args, opts);
/** Test seam — swap the executor. Call `__resetComputerExec()` in afterEach. */
export function __setComputerExecForTests(next: ComputerExec): void {
  execImpl = next;
}
export function __resetComputerExec(): void {
  execImpl = realExec;
}

/** The per-caller identity the resolver needs (a slice of the MCP ToolContext). */
export interface ComputerCtx {
  signal?: AbortSignal;
  /** The caller's harness slug == the hive home-harness slug for a fleet bee. */
  harnessSlug?: string | null;
}

/**
 * Resolve the agent's leased SANDBOX display — SERVER-SIDE only. NEVER from the
 * model's args (a model must not be able to name `:0`), and `:0` is always refused.
 *
 * Resolution order (computer-tool-plan open-Q#2 — "where the per-bee display binding
 * lives in ctx"):
 *   1. PRIMARY — the CALLER'S HIVE in-process desktop lease, keyed by `ctx.harnessSlug`.
 *      This is the operative path for a fleet bee: its capability:computer call lands at
 *      the operator's `/api/mcp`, so the handler runs in the OPERATOR process and the
 *      bee's spawn-env never reaches it — but `ensureHiveDesktop` stores the lease in
 *      THIS process's Map, and `ctx.harnessSlug` identifies the caller's hive. So the
 *      right display is found here regardless of which bee called.
 *   2. FALLBACK — a display in THIS process's env, for the direct / SU / dev path and a
 *      single-tenant (per-frame) operator. `PAPERCUSP_COMPUTER_DISPLAY` is the explicit
 *      provisioner marker; `PAPERCUSP_AGENT_DISPLAY` is the frame per-slot lease marker
 *      (`acquireAgentDisplay`). BOTH are deliberate capability markers — never raw
 *      `DISPLAY`, which can leak a dev box's own `:0` session.
 */
export async function resolveBoundDisplay(ctx: ComputerCtx): Promise<DesktopTarget> {
  // 1. The caller's hive lease (operator-process Map). Route the ctx slug through
  //    the fail-loud resolver (workspace-data-isolation-leaks P-004) so the
  //    operator/superuser `'*'` auto-default (and an unset ctx) resolve to "no
  //    concrete hive" → fall through to the env path, instead of consulting a
  //    nonsense `'*'`-keyed lease. `(ctx.harnessSlug ?? '').trim()` left `'*'`
  //    truthy, so an operator-scope call would have looked up `hiveDesktop('*')`
  //    (`'*'` is the operator wildcard, never a real hive slug).
  const hive = resolveConcreteHarnessSlug(undefined, ctx);
  if (hive) {
    const leased = hiveDesktop(hive);
    if (leased) {
      assertSandboxDisplay(leased.display); // belt-and-suspenders: a lease is never :0
      // D-006: the lease carries the DISPLAY geometry; the model is served the
      // capture box. A 1024x768 sandbox (the provisioner default) fits inside the
      // box, so `captureFit` makes this a no-op there — the resize only engages on
      // a deliberately larger desktop.
      return {
        display: leased.display,
        width: leased.width,
        height: leased.height,
        capture: leased.capture ? { ...leased.capture } : { ...DEFAULT_CAPTURE_GEOMETRY },
      };
    }
  }
  // 2. Process-env fallback (direct/SU/dev + frame per-slot marker).
  //    An explicit marker is the current caller binding and must win over a
  //    stale nonterminal scope row. Resolve its registry row by display only
  //    for geometry enrichment; never let scope inventory choose another display.
  const display = (process.env.PAPERCUSP_COMPUTER_DISPLAY ?? process.env.PAPERCUSP_AGENT_DISPLAY ?? '').trim();
  if (display) {
    assertSandboxDisplay(display); // throws on :0 / malformed

    // D-006 / P-006 — "resolution rides the DesktopSession lease". The frame path
    // (`PAPERCUSP_AGENT_DISPLAY`, set by orchestrator-runner) exports a display and
    // NO geometry, so the DEFAULT_W/H below is an ASSUMPTION — and on a frame it is
    // the wrong one: frame slots run 1920x1080 (deployment config default, mirrored
    // by display-allocator's registration). Believing 1024x768 there made the model
    // unable to address the bottom-right ~72% of its own screen.
    //
    // The registry already knows the truth for exactly these displays, so ask it
    // before falling back to a guess. Best-effort: missing inventory must not take
    // capability:computer down when the explicit marker still identifies the target.
    try {
      const byDisplay = await resolveLocalDesktopByDisplay({
        workspaceId: activeWorkspaceId(),
        display,
      });
      if (byDisplay) {
        return {
          display,
          width: byDisplay.displayGeometry.width,
          height: byDisplay.displayGeometry.height,
          capture: {
            width: byDisplay.captureGeometry.width,
            height: byDisplay.captureGeometry.height,
          },
        };
      }
    } catch {
      /* fall through to the env geometry — a missing inventory is not a missing desktop */
    }

    const w = Number(process.env.PAPERCUSP_COMPUTER_WIDTH) || DEFAULT_W;
    const h = Number(process.env.PAPERCUSP_COMPUTER_HEIGHT) || DEFAULT_H;
    return { display, width: w, height: h, capture: { ...DEFAULT_CAPTURE_GEOMETRY } };
  }

  // 3. P-003 (D-004): the REGISTRY. Finds a session this process does not hold in
  //    its Map — a frame slot or a VM guest — which step 1 structurally cannot see.
  //    Ordered AFTER the in-process lease and explicit env marker on purpose: the
  //    Map holds the actual child process and the marker is the caller's current
  //    binding, while a row is only a CLAIM about a process. This step is therefore
  //    purely ADDITIVE — it resolves where there was previously nothing, and never
  //    overrides a live local lease or explicit display marker.
  if (hive) {
    try {
      const session = await resolveDesktopForScope({
        workspaceId: activeWorkspaceId(),
        scope: 'pot',
        scopeRef: hive,
      });
      if (session) {
        assertSandboxDisplay(session.display); // same rail as every other path: never :0
        // D-006: BOTH geometries ride the session. `width`/`height` are the DISPLAY
        // (xdotool's space); `capture` is the bounding box the model is served.
        //
        // ⚠ These were previously collapsed onto captureGeometry alone, which was
        // wrong in a way no test caught: `import -window root` ignores the target's
        // width/height, so the model received a FULL-SIZE 1920x1080 image while
        // coord() clamped every click to 1023x767 — the bottom-right ~72% of the
        // screen was unaddressable, and the agent was still billed for every pixel.
        // Reachable today via computer:provision_desktop { width: 1920, height: 1080 },
        // which registers scope='pot' with the 1024x768 capture default.
        return {
          display: session.display,
          width: session.displayGeometry.width,
          height: session.displayGeometry.height,
          capture: {
            width: session.captureGeometry.width,
            height: session.captureGeometry.height,
          },
        };
      }
    } catch {
      /* fall through to the no-lease error — a missing inventory is not a desktop */
    }
  }

  throw new Error(
    'capability:computer — no sandbox desktop is leased to this agent. A desktop must be ' +
      'provisioned (a leased Xvfb/VNC display) for this hive before the agent can operate it. ' +
      '(Refusing to default to any display — the host :0 is never operable.) ' +
      'To fix: call computer:provision_desktop { pot: <your hive slug> } first, then retry — ' +
      'do NOT re-call capability:computer until a desktop is leased (computer:list_desktops shows the leases).',
  );
}

/**
 * Rewrite `xdotool getmouselocation --shell` output from DISPLAY space into
 * CAPTURE space (D-006).
 *
 * The output is `X=..\nY=..\nSCREEN=..\nWINDOW=..`; only X and Y are positions, so
 * SCREEN/WINDOW are passed through untouched — rewriting them would corrupt an id.
 * An unparseable line is left exactly as-is: this is a reporting convenience, and
 * mangling xdotool's output would be worse than reporting it unscaled.
 */
export function rewriteCursorPosition(raw: string, target: DesktopTarget): string {
  let x: number | undefined;
  let y: number | undefined;
  for (const line of raw.split('\n')) {
    const m = /^(X|Y)=(-?\d+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'X') x = Number(m[2]);
    else y = Number(m[2]);
  }
  if (x === undefined || y === undefined) return raw;
  const [cx, cy] = toCaptureCoord(x, y, target);
  return raw
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^X=-?\d+$/.test(t)) return `X=${cx}`;
      if (/^Y=-?\d+$/.test(t)) return `Y=${cy}`;
      return line;
    })
    .join('\n');
}

/**
 * Capture the sandbox screen as raw PNG bytes.
 *
 * Split out from `screenshot()` for P-009: a trajectory recording writes the PNG
 * to disk, so making it round-trip through base64 and back would cost ~33% extra
 * allocation per recorded step for nothing.
 */
export async function captureScreenshotPng(target: DesktopTarget, signal?: AbortSignal): Promise<Buffer> {
  const cap = captureCommand(target);
  const r = await execImpl(cap.bin, cap.args, { signal });
  if (!r.stdout || r.stdout.length < 8 || r.stdout.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`capability:computer — screenshot capture failed (exit ${r.status}): ${r.stderr.slice(0, 200)}`);
  }
  return r.stdout;
}

/** Capture the sandbox screen → an MCP image content block (base64 PNG). */
async function screenshot(
  target: DesktopTarget,
  signal?: AbortSignal,
): Promise<{ type: 'image'; data: string; mimeType: string }> {
  const png = await captureScreenshotPng(target, signal);
  return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
}

const computerArgs = z.object({
  action: z
    .enum([
      'screenshot',
      'cursor_position',
      'mouse_move',
      'left_click',
      'right_click',
      'middle_click',
      'double_click',
      'triple_click',
      'left_click_drag',
      'left_mouse_down',
      'left_mouse_up',
      'type',
      'key',
      'hold_key',
      'scroll',
      'wait',
    ])
    .describe('The computer-use action (canonical Anthropic vocabulary).'),
  coordinate: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe("[x, y] in the screenshot's pixel space — for move/click-at/drag/scroll-at."),
  text: z
    .string()
    .optional()
    .describe('For `type` (text to type) and `key`/`hold_key` (an xdotool keysym/chord, e.g. "Return", "ctrl+s").'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('For `scroll`.'),
  scroll_amount: z.number().int().positive().optional().describe('For `scroll` — wheel clicks (default 3).'),
  duration: z.number().positive().optional().describe('For `wait`/`hold_key` — seconds.'),
  observe: z
    .enum(['auto', 'image', 'tree', 'none'])
    .optional()
    .describe(
      'How you want to SEE the result of this action. auto (default) = the accessibility tree when this desktop exposes one, else a screenshot. image = always a screenshot (~1049 tokens). tree = the tree or a loud refusal, never a silent screenshot. none = the one-line result only. The `screenshot` action always returns pixels regardless.',
    ),
});

export type ComputerArgs = z.infer<typeof computerArgs>;

/** How the caller wants to see an action's effect (P-008, D-012). */
export type ObserveMode = 'auto' | 'image' | 'tree' | 'none';

interface ObservationResult {
  observed: ObservedAs;
  /** Short tag for the ledger line when `auto` had to fall back, e.g. `no-apps`. */
  note?: string;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
}

/**
 * Decide what a post-action observation costs (D-012).
 *
 * The whole point of P-008: `capability:computer` used to end EVERY input action
 * with a full screenshot — 1049 tokens at 1024x768, most of them near-duplicates
 * of the previous step's. P-007 measured the a11y tree at 89 tokens on the same
 * screen, 11.79x cheaper, so `auto` prefers it.
 *
 * The fallback to pixels is load-bearing, not a nicety: the tree sees only what the
 * toolkit EXPORTS, so a canvas app, a video, or a plain X11 client like `xterm` is
 * invisible to it. Degrading to a screenshot is correct; degrading to blindness is
 * the bug this branch exists to prevent — which is why `snapshotA11yTree` returns a
 * reason rather than throwing, and why `tree` refuses out loud instead of quietly
 * handing back an image the caller asked not to receive.
 */
async function observeAfterAction(
  target: DesktopTarget,
  mode: ObserveMode,
  signal?: AbortSignal,
): Promise<ObservationResult> {
  if (mode === 'none') return { observed: 'none', content: [] };
  if (mode === 'image') return { observed: 'image', content: [await screenshot(target, signal)] };

  const snap = await snapshotA11yTree(target, computerExec, { ...(signal ? { signal } : {}) });
  if (snap.ok) {
    return {
      observed: 'tree',
      // A repeated full sentence would cost more over a long task than the warning
      // is worth, so the untrustworthy-bounds case rides the ledger line as a tag;
      // `computer:observe` still spells it out in full.
      ...(snap.boundsTrustworthy ? {} : { note: 'refs-only' }),
      content: [{ type: 'text' as const, text: snap.tree }],
    };
  }

  if (mode === 'tree') {
    return {
      observed: 'none',
      note: snap.reason,
      content: [
        {
          type: 'text' as const,
          text: `observe:'tree' asked for the accessibility tree and there is none — ${snap.detail} Re-run with observe:'image' if you need pixels.`,
        },
      ],
    };
  }

  return { observed: 'image', note: snap.reason, content: [await screenshot(target, signal)] };
}

interface ComputerToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * P-009: park this action's frame on any OPEN recording — out of band (D-013 §2).
 *
 * Two properties matter here and are both load-bearing:
 *   - it adds NOTHING to `content`, so a recording is invisible in the agent's
 *     context and cannot re-introduce the per-step screenshot P-008 removed; and
 *   - when the observation already produced pixels it hands the recorder THOSE
 *     bytes, so a recorded step costs one capture, not two — and the recorded
 *     frame is provably the image the model reasoned about.
 * `isRecording` is a Map lookup, so the not-recording path (the overwhelming
 * majority) costs nothing measurable.
 */
async function noteFrame(
  target: DesktopTarget,
  entry: ActionLedgerEntry,
  content: ComputerToolResult['content'],
  signal?: AbortSignal,
): Promise<void> {
  if (!isRecording(target.display)) return;
  const shot = content.find((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image');
  await noteRecordedAction(target.display, entry, {
    ...(shot ? { pngBase64: shot.data } : {}),
    capture: () => captureScreenshotPng(target, signal),
  });
}

/**
 * The capability:computer handler — extracted + exported so it unit-tests
 * directly (with an injected exec seam) without the dispatch layer or a live X.
 */
export async function runComputerAction(args: ComputerArgs, ctx: ComputerCtx = {}): Promise<ComputerToolResult> {
  const target = await resolveBoundDisplay(ctx); // throws loudly if no lease / refuses :0
  const signal = ctx.signal;
  const input = args as ComputerActionInput;
  const plan = planAction(input, target);

  if (plan.kind === 'screenshot') {
    return { content: [await screenshot(target, signal)] };
  }

  if (plan.kind === 'cursor_position') {
    const r = await execImpl('xdotool', ['getmouselocation', '--shell'], { env: { DISPLAY: target.display }, signal });
    const raw = r.stdout.toString().trim();
    if (!raw) return { content: [{ type: 'text', text: `exit ${r.status}` }] };
    // D-006: xdotool answers in DISPLAY space. The model is looking at a capture that
    // may be smaller, so report the position in the space it can actually see —
    // otherwise `cursor_position` and the screenshot disagree by the scale factor
    // (~1.9x on a frame), and the inverse of coord() would not round-trip.
    return { content: [{ type: 'text', text: rewriteCursorPosition(raw, target) }] };
  }

  const mode: ObserveMode = args.observe ?? 'auto';

  if (plan.kind === 'wait') {
    await new Promise((r) => setTimeout(r, plan.ms));
    const obs = await observeAfterAction(target, mode, signal);
    const entry = recordAction(target.display, {
      action: `wait ${plan.ms}ms`,
      ok: true,
      observed: obs.observed,
      ...(obs.note ? { note: obs.note } : {}),
    });
    await noteFrame(target, entry, obs.content, signal);
    return { content: [{ type: 'text', text: renderLedgerLine(entry) }, ...obs.content] };
  }

  // xdotool input action → execute, then observe the effect (D-012: the observation
  // is chosen at EMIT time; nothing already returned is ever rewritten).
  const cmd = xdotoolCommand(plan, target);
  const r = await execImpl(cmd.bin, cmd.args, { env: cmd.env, signal });

  // The ledger records the coordinate the MODEL used (capture space), not the
  // display-space coordinate the driver translated it to — otherwise a later read
  // of the ledger disagrees with the screen the model was looking at (D-006).
  const ledgerInput = {
    action: input.action,
    ...(input.coordinate ? { coordinate: [input.coordinate[0], input.coordinate[1]] as const } : {}),
    // Typed text is recorded by LENGTH only — never echoed (see action-ledger.ts).
    ...(input.action === 'type' && typeof input.text === 'string' ? { typedChars: input.text.length } : {}),
    ...((input.action === 'key' || input.action === 'hold_key') && input.text ? { keys: input.text } : {}),
  };

  if (r.status !== 0) {
    const entry = recordAction(target.display, {
      ...ledgerInput,
      ok: false,
      observed: 'none',
      note: `exit ${r.status}`,
    });
    // A FAILED step is exactly the frame a human reviewing the trajectory wants,
    // so record it too — there are no pixels in this result, so this one captures.
    await noteFrame(target, entry, [], signal);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${renderLedgerLine(entry)}\ncapability:computer — ${input.action} failed (exit ${r.status}): ${r.stderr.slice(0, 300)}`,
        },
      ],
    };
  }

  const obs = await observeAfterAction(target, mode, signal);
  const entry = recordAction(target.display, {
    ...ledgerInput,
    ok: true,
    observed: obs.observed,
    ...(obs.note ? { note: obs.note } : {}),
  });
  await noteFrame(target, entry, obs.content, signal);
  return { content: [{ type: 'text', text: renderLedgerLine(entry) }, ...obs.content] };
}

export default defineTool({
  name: 'capability:computer',
  description:
    'Operate a sandboxed desktop (GUI) — screenshot, click, type, key, scroll — using the canonical computer-use action vocabulary. ONLY for genuinely visual/GUI steps: for anything scriptable (files, CLIs, APIs) prefer capability:bash, and for web pages prefer a browser tool — both are faster and more reliable than pixel-clicking.',
  guidance: {
    when: 'A task needs a GUI app that has no CLI/API — clicking buttons, reading what is on screen, operating a desktop program. Call `screenshot` (or computer:observe) first to see, then act on what you see.',
    notWhen:
      "Anything scriptable (create files, run a program, hit an API) → capability:bash. A web page → a browser tool (DOM automation is more reliable + cheaper than pixel-clicking). Never use this to operate the host machine — it only drives the agent's leased sandbox desktop.",
    chaining:
      'screenshot once to orient → then act, reading the tree that comes back with each action → screenshot again only when the tree cannot answer (a canvas, a video, a plain X11 client like xterm, or anything about pixels/layout/colour). Set `observe` per action: "image" when you must see pixels, "none" when you do not need to check the effect.',
    returns:
      "A one-line result (`#7 left_click (412,388) ok · tree`) plus, by default, this desktop's compressed accessibility tree. The line is the action ledger: one line per step, never re-emitted, so your transcript accumulates the trajectory for free. `observe` picks what follows it — auto (tree when the desktop exposes one, else a screenshot), image (~1049 tokens at 1024x768), tree (the tree or a loud refusal, never a silent image), none (the line only). The tree costs ~89 tokens on the same screen — 11.79x cheaper, measured — and every observation stays in your context for the rest of the task, so a 40-step job is roughly 4k tokens of trees against 42k of screenshots. The `screenshot` action always returns pixels regardless of `observe`. A trailing `· refs-only` tag means this toolkit reports unusable screen coordinates: activate via computer:click_element by #ref, not by pixel.",
    seeAlso: [
      'computer:observe (read the tree without acting — same cheap view, on demand)',
      'computer:click_element (activate by #ref from the tree; no coordinates, no pixels)',
      'capability:bash (anything scriptable — files / CLIs / APIs)',
      'computer:provision_desktop (stand up the sandbox desktop first)',
      'computer:list_desktops (which desktops are leased)',
    ],
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  // EI-18803497769946984: shells out to drive the desktop and never reads ctx.tx —
  // holding the ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s), surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 30,
  args: computerArgs,
  handler: (args, ctx) => runComputerAction(args, ctx as ComputerCtx),
});
