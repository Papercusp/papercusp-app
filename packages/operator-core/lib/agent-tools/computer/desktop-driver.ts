/**
 * desktop-driver.ts — the pure I/O driver behind `capability:computer`
 * (bee-operated desktop control).
 *
 * It translates the CANONICAL Anthropic `computer` action vocabulary
 * (`computer_20250124`) into `xdotool` argv + a screen-capture command, against
 * a SANDBOX X display — NEVER the host `:0`. The model was post-trained on this
 * exact action set, so mirroring it (rather than inventing a vocabulary) keeps
 * Claude's grounding priors intact.
 *
 * This module is FRAMEWORK-INDEPENDENT on purpose: no MCP / tooldef imports, so
 * the action→argv planning unit-tests without a live display or the agent
 * runtime. The `defineTool` wrapper (computer.ts) executes the planned action
 * and adapts a screenshot into a `ToolResult` image content block (gate #1 —
 * `{ type:'image', data, mimeType }` passes through the dispatcher untouched).
 *
 * Mechanics proven on the box 2026-06-18: Xvfb :99 + xdotool input +
 * `import -window root` → PNG 1024×768 → base64 (the screenshot ToolResult payload).
 */

/** The canonical computer-use action set (Anthropic `computer_20250124`). */
export type ComputerAction =
  | 'screenshot'
  | 'cursor_position'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'left_click_drag'
  | 'left_mouse_down'
  | 'left_mouse_up'
  | 'type'
  | 'key'
  | 'hold_key'
  | 'scroll'
  | 'wait';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The argument bag for one action (mirrors the canonical tool's input shape). */
export interface ComputerActionInput {
  action: ComputerAction;
  /** [x, y] in the display's pixel space. Required for move/click-at/drag/scroll-at. */
  coordinate?: [number, number];
  /** For `type` (a string to type) and `key`/`hold_key` (an xdotool keysym/chord, e.g. "Return", "ctrl+s"). */
  text?: string;
  /** For `scroll`. */
  scroll_direction?: ScrollDirection;
  /** For `scroll` — number of wheel clicks (default 3). */
  scroll_amount?: number;
  /** For `wait`/`hold_key` — seconds. */
  duration?: number;
}

/** The sandbox display the actions run against. NEVER the host `:0`. */
export interface DesktopTarget {
  /** X display, e.g. ":99". */
  display: string;
  /**
   * DISPLAY width — what the X server actually runs at. This is `xdotool`'s
   * coordinate space, so every synthesized pointer event is expressed here.
   */
  width: number;
  /** DISPLAY height (the canonical computer-use default is 768). */
  height: number;
  /**
   * D-006 — the CAPTURE bounding box: what the MODEL is served, independent of
   * what the X server runs at. Omitted ⇒ the model sees the display 1:1.
   *
   * This is a BOUNDING BOX, not an output size: the capture preserves aspect
   * ratio and only ever SHRINKS, so a 1920x1080 display under a 1024x768 box is
   * served as 1024x576 (not 1024x768), and an 800x600 display is served
   * untouched rather than upscaled. `captureFit()` is the one place that math
   * lives; never re-derive it at a call site.
   */
  capture?: { width: number; height: number };
}

/**
 * D-006 — resolve what the model is actually served for `target`, and the scale
 * factor between capture space and display space.
 *
 * Two properties this function exists to guarantee, both measured on ImageMagick
 * 6.9.12 rather than assumed:
 *
 *  1. SHRINK-ONLY. `-resize 1024x768` UPSCALES an 800x600 display to 1024x768 —
 *     which would *increase* the token bill this decision exists to cut. The `>`
 *     suffix (see `captureCommand`) is what makes it shrink-only, and `scale` is
 *     clamped to 1 here for the same reason.
 *  2. UNIFORM SCALE. Aspect ratio is preserved, so one factor maps both axes.
 *     1920x1080 under a 1024x768 box → scale 0.5333 → 1024x576.
 *
 * The scale is what makes a downscaled capture SAFE: the model reads coordinates
 * off a 1024x576 image, and `coord()` maps them back into the 1920x1080 space
 * xdotool drives. Without that mapping every click lands at roughly half its
 * intended position.
 */
export function captureFit(target: DesktopTarget): { width: number; height: number; scale: number } {
  const box = target.capture;
  if (!box || !(box.width > 0) || !(box.height > 0) || !(target.width > 0) || !(target.height > 0)) {
    return { width: target.width, height: target.height, scale: 1 };
  }
  // min(1, …) is the shrink-only clamp — never magnify a small display.
  const scale = Math.min(1, box.width / target.width, box.height / target.height);
  if (scale >= 1) return { width: target.width, height: target.height, scale: 1 };
  return {
    // max(1, …) so an extreme box can never round an axis to a zero-pixel image.
    width: Math.max(1, Math.round(target.width * scale)),
    height: Math.max(1, Math.round(target.height * scale)),
    scale,
  };
}

/** xdotool wheel buttons: 4 up, 5 down, 6 left, 7 right. */
const SCROLL_BUTTON: Record<ScrollDirection, string> = { up: '4', down: '5', left: '6', right: '7' };

/**
 * Hard safety guard: refuse to drive the host display. A bee's desktop actions
 * must ALWAYS target its leased sandbox display — operating `:0` would let it
 * click around the operator's real machine (the live Papercusp fleet). This is
 * the load-bearing invariant of the whole capability (deny-by-default).
 */
export function assertSandboxDisplay(display: string): void {
  const d = (display ?? '').trim();
  if (!d || !/^:\d+(\.\d+)?$/.test(d)) {
    throw new Error(`capability:computer — invalid display ${JSON.stringify(display)} (expected ":<n>")`);
  }
  if (d === ':0' || d === ':0.0') {
    throw new Error('capability:computer — refusing to operate the HOST display :0 (sandbox display required)');
  }
  // Also refuse the operator's OWN live session display — it is NOT always :0 (a seat
  // can be :1, and the operator process here runs with DISPLAY=:0 inherited from gdm).
  // A sandbox display is one WE provisioned (≥ :99), never the seat the fleet's agent
  // TUIs run on. This is what stops keystrokes leaking into another agent's terminal.
  const hostDisplay = (process.env.DISPLAY ?? '').trim();
  if (hostDisplay && (d === hostDisplay || `${d}.0` === hostDisplay || d === hostDisplay.replace(/\.\d+$/, ''))) {
    throw new Error(
      `capability:computer — refusing to operate the operator's host display ${hostDisplay} (sandbox display required)`,
    );
  }
}

/**
 * X11 / Wayland env keys that bind a process to the operator's HOST session.
 * Agent-driven subprocesses (xdotool, `import`, every capability:bash shell) must
 * NEVER inherit these: doing so lets a sandbox action reach the operator's real
 * `:0` — the seat where the live fleet's agent TUIs run (the 2026-06-19 keystroke
 * -leak incident). Stripping them is the load-bearing isolation invariant.
 */
export const HOST_X_ENV_KEYS: readonly string[] = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY'];

/**
 * A copy of `env` with every host X-session key removed — the base env for ANY
 * agent-driven subprocess, so it can no longer inherit the operator's `:0` /
 * Xauthority. Callers that legitimately drive a sandbox add `DISPLAY=<sandbox>`
 * back explicitly (see `sandboxXEnv`).
 */
export function stripHostX(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (HOST_X_ENV_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The X env for driving a SANDBOX display: host-stripped base + `DISPLAY` bound to
 * the sandbox (+ its own `XAUTHORITY` when the sandbox is access-controlled).
 * Refuses `:0` / the host display via `assertSandboxDisplay`.
 */
export function sandboxXEnv(
  display: string,
  xauthority?: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  assertSandboxDisplay(display);
  const env = stripHostX(base);
  env.DISPLAY = display;
  if (xauthority) env.XAUTHORITY = xauthority;
  return env;
}

/**
 * Validate + normalize a coordinate, mapping CAPTURE space → DISPLAY space.
 *
 * D-006: the model reads coordinates off the image it was served, which under a
 * downscaled capture is SMALLER than the X display. Two things therefore have to
 * happen here, in this order:
 *
 *   1. CLAMP in capture space — the space the coordinate is actually expressed in.
 *      Clamping against the display instead would let a hallucinated coordinate
 *      past the edge of the image the model saw.
 *   2. SCALE into display space — xdotool drives the real X server, so a click the
 *      model placed at (1000, 500) on a 1024x576 capture belongs at (1875, 938) on
 *      the 1920x1080 display behind it.
 *
 * Skipping step 2 is the failure this mapping exists to prevent: every pointer
 * event would land at roughly half its intended position, and — because the
 * screenshot still looks correct — it would present as the model misreading the
 * screen rather than as a coordinate bug.
 *
 * With no capture box, `scale` is 1 and this is exactly the previous behaviour.
 */
function coord(input: ComputerActionInput, target: DesktopTarget): [number, number] {
  if (!input.coordinate) throw new Error(`capability:computer — action '${input.action}' requires a coordinate`);
  const [x, y] = input.coordinate;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('capability:computer — non-finite coordinate');
  const fit = captureFit(target);
  // 1. Clamp into the CAPTURE bounds — the image the model actually saw.
  const cx = Math.max(0, Math.min(Math.round(x), fit.width - 1));
  const cy = Math.max(0, Math.min(Math.round(y), fit.height - 1));
  if (fit.scale >= 1) return [cx, cy];
  // 2. Map into DISPLAY space, then clamp again: rounding at the far edge can land
  //    one pixel past the last addressable column/row.
  return [
    Math.max(0, Math.min(Math.round(cx / fit.scale), target.width - 1)),
    Math.max(0, Math.min(Math.round(cy / fit.scale), target.height - 1)),
  ];
}

/**
 * Map a DISPLAY-space point back into CAPTURE space — the inverse of `coord()`.
 *
 * `cursor_position` asks the X server where the pointer is, and the answer is in
 * display space. Returning that raw to the model under a downscaled capture would
 * report a position that does not exist on the image it is looking at (up to ~1.9x
 * off on a 1920x1080 frame), so the two directions have to stay symmetric.
 */
export function toCaptureCoord(x: number, y: number, target: DesktopTarget): [number, number] {
  const fit = captureFit(target);
  if (fit.scale >= 1) return [Math.round(x), Math.round(y)];
  return [
    Math.max(0, Math.min(Math.round(x * fit.scale), fit.width - 1)),
    Math.max(0, Math.min(Math.round(y * fit.scale), fit.height - 1)),
  ];
}

/** A planned action — what the executor must do. Pure output of `planAction`. */
export type PlannedAction =
  | { kind: 'xdotool'; args: string[] }
  | { kind: 'screenshot' }
  | { kind: 'cursor_position' }
  | { kind: 'wait'; ms: number };

/**
 * Translate one `ComputerActionInput` into a `PlannedAction` (pure). The returned
 * `xdotool` args do NOT include the `xdotool` binary or the `DISPLAY` env — the
 * executor supplies those (binding `DISPLAY` to the sandbox target).
 */
/**
 * The move prefix every coordinate action shares: a 1px NUDGE toward the interior,
 * then the real `mousemove --sync` (D-014, EI-21256574817493619).
 *
 * ⚠ THE NUDGE IS LOAD-BEARING — do not "simplify" it away. `xdotool mousemove --sync
 * X Y` takes ~15.1–15.4s when the pointer is ALREADY at (X,Y) and a window manager is
 * running (~195ms without one, which is why a bare-Xvfb probe cannot see this). Since
 * `EXEC_TIMEOUT_MS` is 15,000ms, we SIGKILL xdotool ~200ms into its own 15,196ms wait
 * — DURING the sync, before the chained `click` is sent — so a second click on the
 * same coordinate burns 15 seconds, reports FAILED, and never clicks. Repeated
 * scrolling at one point and clicking a button twice are the ordinary cases.
 *
 * Nudging first makes the pre-sync position differ from the target BY CONSTRUCTION,
 * so the sync always has a real transition to wait for: measured 5ms for the same
 * repeat that costs 15,196ms without it. Both commands ride ONE xdotool invocation,
 * hence one X connection, hence ordered.
 *
 * `--sync` itself is KEPT (dropping it also measures fast) because it is a real
 * guarantee — on return the pointer IS at the target — and the next action is a
 * separate xdotool process on a new connection, so without it the settle is a race.
 * 50/50 trials came back clean on an IDLE display; this box runs at load 190, which
 * is where that race would actually bite.
 */
export function movePrefixArgs(x: number, y: number): string[] {
  // Toward the interior, so the nudge can never land off-screen (and be clamped back
  // onto the target, which would reinstate the no-op sync it exists to prevent).
  const nudged = x > 0 ? x - 1 : x + 1;
  return ['mousemove', String(nudged), String(y), 'mousemove', '--sync', String(x), String(y)];
}

export function planAction(input: ComputerActionInput, target: DesktopTarget): PlannedAction {
  switch (input.action) {
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'cursor_position':
      return { kind: 'cursor_position' };
    case 'wait': {
      const secs = typeof input.duration === 'number' && input.duration > 0 ? input.duration : 1;
      return { kind: 'wait', ms: Math.min(secs, 30) * 1000 };
    }
    case 'mouse_move': {
      const [x, y] = coord(input, target);
      return { kind: 'xdotool', args: movePrefixArgs(x, y) };
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click': {
      const button = input.action === 'left_click' ? '1' : input.action === 'middle_click' ? '2' : '3';
      const args: string[] = [];
      if (input.coordinate) {
        const [x, y] = coord(input, target);
        args.push(...movePrefixArgs(x, y));
      }
      args.push('click', button);
      return { kind: 'xdotool', args };
    }
    case 'double_click':
    case 'triple_click': {
      const repeat = input.action === 'double_click' ? '2' : '3';
      const args: string[] = [];
      if (input.coordinate) {
        const [x, y] = coord(input, target);
        args.push(...movePrefixArgs(x, y));
      }
      args.push('click', '--repeat', repeat, '--delay', '120', '1');
      return { kind: 'xdotool', args };
    }
    case 'left_mouse_down':
      return { kind: 'xdotool', args: ['mousedown', '1'] };
    case 'left_mouse_up':
      return { kind: 'xdotool', args: ['mouseup', '1'] };
    case 'left_click_drag': {
      const [x, y] = coord(input, target);
      // Press at current position, drag to the target, release.
      return { kind: 'xdotool', args: ['mousedown', '1', ...movePrefixArgs(x, y), 'mouseup', '1'] };
    }
    case 'type': {
      if (typeof input.text !== 'string') throw new Error("capability:computer — 'type' requires text");
      return { kind: 'xdotool', args: ['type', '--clearmodifiers', '--', input.text] };
    }
    case 'key': {
      if (!input.text) throw new Error("capability:computer — 'key' requires text (an xdotool keysym/chord)");
      return { kind: 'xdotool', args: ['key', '--clearmodifiers', '--', input.text] };
    }
    case 'hold_key': {
      if (!input.text) throw new Error("capability:computer — 'hold_key' requires text");
      const secs = typeof input.duration === 'number' && input.duration > 0 ? Math.min(input.duration, 10) : 1;
      // keydown, (executor waits `duration`), keyup — encoded as a down+up pair the
      // executor sequences with the wait. We model it as keydown here; the wrapper
      // schedules the matching keyup after the hold.
      return { kind: 'xdotool', args: ['keydown', '--clearmodifiers', '--', input.text, 'sleep', String(secs), 'keyup', '--clearmodifiers', '--', input.text] };
    }
    case 'scroll': {
      const dir = input.scroll_direction ?? 'down';
      const button = SCROLL_BUTTON[dir];
      const amount = Math.max(1, Math.min(Math.round(input.scroll_amount ?? 3), 100));
      const args: string[] = [];
      if (input.coordinate) {
        const [x, y] = coord(input, target);
        args.push(...movePrefixArgs(x, y));
      }
      args.push('click', '--repeat', String(amount), button);
      return { kind: 'xdotool', args };
    }
    default: {
      const never: never = input.action;
      throw new Error(`capability:computer — unsupported action ${String(never)}`);
    }
  }
}

/**
 * The screen-capture command for a target display. ImageMagick `import -window
 * root` (proven on the box) → PNG on stdout. The executor runs this and
 * base64-encodes the bytes into the image `ToolResult`.
 */
export function captureCommand(target: DesktopTarget): { bin: string; args: string[] } {
  assertSandboxDisplay(target.display);
  // `-silent` suppresses the bell; `png:-` writes PNG to stdout.
  const args = ['-display', target.display, '-silent', '-window', 'root'];
  const fit = captureFit(target);
  if (fit.scale < 1) {
    // D-006: downscale AT CAPTURE, not provider-side. Sending full-size pixels and
    // letting the provider clamp them costs the same tokens (it meters the image it
    // receives) or loses accuracy at the clamp — so the shrink has to happen here.
    //
    // The `>` suffix is LOAD-BEARING, not decoration: `-resize 1024x768` magnifies an
    // 800x600 display up to 1024x768, which raises the token bill this exists to cut.
    // `1024x768>` means "only if larger". Verified on ImageMagick 6.9.12:
    //   1920x1080 -resize '1024x768>' -> 1024x576   (shrunk, aspect preserved)
    //    800x600  -resize '1024x768>' ->  800x600   (untouched)
    //    800x600  -resize '1024x768'  -> 1024x768   (magnified — the trap)
    //
    // Safe as a bare argv element: the executor uses spawn() WITHOUT `shell: true`,
    // so `>` is never interpreted as a redirection.
    args.push('-resize', `${target.capture!.width}x${target.capture!.height}>`);
  }
  args.push('png:-');
  return { bin: 'import', args };
}

/** The full `xdotool` invocation for a planned xdotool action, with DISPLAY bound. */
export function xdotoolCommand(plan: Extract<PlannedAction, { kind: 'xdotool' }>, target: DesktopTarget): {
  bin: string;
  args: string[];
  env: { DISPLAY: string };
} {
  assertSandboxDisplay(target.display);
  return { bin: 'xdotool', args: plan.args, env: { DISPLAY: target.display } };
}
