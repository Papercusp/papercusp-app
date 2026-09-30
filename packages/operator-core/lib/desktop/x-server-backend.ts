/**
 * x-server-backend.ts — which X server a sandbox desktop is BOOTED on, as data.
 *
 * P-012 / D-020 / D-022. A sandbox desktop has always been "an X server, a window
 * manager, an a11y bus, and some apps". Until now the X server was always `Xvfb`.
 * D-020 adds a second one for the BYOC lane: KasmVNC's `Xkasmvnc`, which IS an X
 * server *and* a web-native pixel transport in one process, replacing the
 * Xvfb + VirtualGL + x11vnc chain the transport survey rejected.
 *
 * WHY THIS IS A PARAMETER AND NOT A SECOND PROVISIONER. D-021 keeps the entire
 * driver layer X-bound: xdotool input (including the D-014 1px nudge), `import`
 * capture, the AT_SPI_BUS property on the X root window (D-010c), and the
 * D-015/D-016 bwrap socket topology all address an X display and nothing else. So
 * the ONLY thing that differs between the local-dev desktop and the BYOC desktop is
 * which binary occupies the root of the process tree. Forking a second provisioner
 * would have turned "local-dev Xvfb parity" into a property maintained by hand and
 * verified by hope; making it one argument means the two substrates cannot drift,
 * because there is only one of them.
 *
 * Everything here is PURE — argv in, argv out, no spawning — which is what lets the
 * security properties below be asserted by a unit test rather than by an integration
 * test that needs a live server and therefore usually does not run.
 */

/** The X server implementation a desktop is booted on. */
export type DesktopXServer = 'xvfb' | 'kasmvnc';

/**
 * The loopback address every KasmVNC listener is pinned to.
 *
 * ⚠ THIS IS AN OVERRIDE OF A SHIPPED DEFAULT, NOT A RESTATEMENT OF ONE. Measured
 * from the 1.5.0 package (`usr/share/kasmvnc/kasmvnc_defaults.yaml`:
 * `network.interface: 0.0.0.0`, and `Xkasmvnc -help`: `interface - listen on the
 * specified network address (default=all)`). An install that merely "worked" would
 * therefore have published every agent's sandbox desktop on the VM's external
 * interface. D-020 requires the opposite: the listener is reachable only from the
 * host itself, and only P-013's ticket-gated proxy ever dials it.
 */
export const KASMVNC_LOOPBACK_INTERFACE = '127.0.0.1';

/**
 * Base of the per-desktop websocket port range. KasmVNC's own default is 6800; the
 * pool is offset well clear of it so a hand-started stock `kasmvncserver` on the
 * same host cannot collide with a pool member and silently steal its port.
 */
export const KASMVNC_WEBSOCKET_PORT_BASE = 6900;

/** Names of the two per-session credentials D-020's watch/takeover split maps onto. */
export const KASMVNC_VIEW_USER = 'papercusp-view';
export const KASMVNC_CONTROL_USER = 'papercusp-control';

export interface XServerCommandInput {
  xServer: DesktopXServer;
  /** X display string, e.g. ':110'. */
  display: string;
  width: number;
  height: number;
  /**
   * Loopback websocket port for the kasmvnc backend. Required for that backend and
   * meaningless for xvfb — passing it there is a caller bug, not a no-op, so it is
   * rejected rather than ignored.
   */
  websocketPort?: number;
  /**
   * kasmvncpasswd file holding this session's rotated view/control users. Required
   * for the kasmvnc backend: see the refusal below for why there is no default.
   */
  passwordFile?: string;
  /**
   * D-020's DRI3 rung: enable `-hw3d` against a render node. Only meaningful where a
   * GPU exists — on the GPU-less BYOC VMs this stays off and gl-strategy's
   * mesa-software rung is the measured answer.
   */
  hw3d?: { drinode: string };
  /** Absolute path to the server binary, when it is not on PATH (test harnesses). */
  binaryPath?: string;
}

export interface XServerCommand {
  binary: string;
  argv: string[];
  /**
   * Where this desktop's pixels can be dialled from, or null for a backend that
   * serves none. `Xvfb` is started `-nolisten tcp` and has no endpoint at all —
   * which is exactly why a KasmVNC desktop may not be registered as `xvfb-local`.
   */
  endpoint: { host: string; port: number } | null;
}

/** Deterministic websocket port for a display number, so the mapping is reproducible. */
export function kasmvncWebsocketPort(displayNumber: number): number {
  if (!Number.isInteger(displayNumber) || displayNumber <= 0) {
    throw new Error(`x-server-backend — invalid display number ${displayNumber}`);
  }
  return KASMVNC_WEBSOCKET_PORT_BASE + displayNumber;
}

/**
 * Build the argv for a sandbox desktop's X server.
 *
 * The kasmvnc branch encodes five security properties, each of which is a DEPARTURE
 * from what the package does if left alone:
 *
 *   1. `-interface 127.0.0.1` — the shipped default is `all`.
 *   2. `-UseIPv6 0` — the default is 1. Pinning only the v4 loopback while leaving
 *      IPv6 enabled is the classic way a "loopback-only" service ends up with a
 *      second, unpinned listener; refusing IPv6 outright removes that whole branch.
 *   3. `-rfbport 0` — disables the classic RFB port. It is already the default, and
 *      it is still passed explicitly, because a config file is read AFTER these
 *      defaults and could turn it back on; a CLI parameter is the layer the caller
 *      actually controls.
 *   4. `-KasmPasswordFile <file>` with BasicAuth left ON. There is deliberately no
 *      default password file and no `-DisableBasicAuth` escape: a desktop with no
 *      credential is one whose only protection is the proxy in front of it, and
 *      D-020 specifies the per-session credential as defence-in-depth precisely so
 *      that a proxy bug is not a total compromise.
 *   5. `-SecurityTypes None` — the RFB layer performs no second authentication,
 *      because property 4 already authenticated the connection at the HTTP layer.
 *
 *      ⚠ READ THIS BEFORE "TIGHTENING" IT. `None` here does NOT mean the desktop is
 *      unauthenticated, and removing it does not make anything safer — it makes the
 *      desktop unreachable. Measured against a real KasmVNC (WI-1250866):
 *
 *        - WITHOUT this flag KasmVNC falls back to its default RFB security type,
 *          VncAuth, and `-KasmPasswordFile` does NOT populate a VncAuth password —
 *          that store is the Kasm/BasicAuth one, not the classic `-rfbauth` file. So
 *          the server offers exactly one security type it cannot itself satisfy, and
 *          EVERY client fails with `Authentication failure: No password configured
 *          for VNC Auth`. No credential a viewer could present would work.
 *        - WITH it, the websocket upgrade still 401s on a missing OR wrong
 *          credential — property 4 is untouched and remains the only gate.
 *        - KasmVNC then derives the RFB session's identity from that BasicAuth user
 *          (`Generated username: papercusp-view` / `Authentication successful for
 *          user: papercusp-view` in its own log), which is what preserves the D-020
 *          view-only vs control split. Authenticating a SECOND time inside RFB would
 *          not add a factor; it would just be the same secret spent twice.
 *
 *      Every desktop this repo has ever started carried the pre-fix argv, and it was
 *      never caught because no build box has a KasmVNC to exercise it against.
 */
export function buildXServerCommand(input: XServerCommandInput): XServerCommand {
  const { xServer, display, width, height } = input;
  if (!/^:\d+$/.test(display)) {
    throw new Error(`x-server-backend — malformed display ${JSON.stringify(display)}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`x-server-backend — invalid geometry ${width}x${height}`);
  }

  if (xServer === 'xvfb') {
    if (input.websocketPort !== undefined || input.passwordFile !== undefined) {
      throw new Error(
        'x-server-backend — websocketPort/passwordFile were passed for the xvfb backend, which serves ' +
          'no listener. Silently dropping them would hide a caller that believes it configured a ' +
          'reachable desktop and did not.',
      );
    }
    return {
      binary: input.binaryPath ?? 'Xvfb',
      argv: [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
      endpoint: null,
    };
  }

  const { websocketPort, passwordFile } = input;
  if (websocketPort === undefined || !Number.isInteger(websocketPort) || websocketPort <= 0) {
    throw new Error('x-server-backend — the kasmvnc backend requires an integer websocketPort');
  }
  if (!passwordFile) {
    throw new Error(
      'x-server-backend — the kasmvnc backend requires a passwordFile. There is no unauthenticated ' +
        'mode by design (D-020): the per-session credential is what keeps a proxy bug from being a ' +
        'total compromise of every desktop on the host.',
    );
  }

  const argv = [
    display,
    '-geometry',
    `${width}x${height}`,
    '-depth',
    '24',
    // (1) loopback only — overrides the shipped `interface: all`.
    '-interface',
    KASMVNC_LOOPBACK_INTERFACE,
    // (2) no second, unpinned IPv6 listener.
    '-UseIPv6',
    '0',
    // (3) websocket is the only transport; classic RFB stays off.
    '-websocketPort',
    String(websocketPort),
    '-rfbport',
    '0',
    // (4) per-session credential, BasicAuth left enabled.
    '-KasmPasswordFile',
    passwordFile,
    // (5) the HTTP upgrade is the authenticator; the RFB layer inherits that identity.
    // Omitting this makes the desktop unreachable, not safer — see property 5 above.
    '-SecurityTypes',
    'None',
    // D-020: clients may renegotiate size (`allow_resize`), which is what lets a
    // viewer window drive the desktop geometry instead of a fixed guess.
    '-AcceptSetDesktopSize',
    '1',
    // Watch AND takeover can be attached at once — that pairing IS the feature, so a
    // second connection must never evict the first.
    '-AlwaysShared',
    '1',
  ];
  if (input.hw3d) {
    argv.push('-hw3d', '-drinode', input.hw3d.drinode);
  }

  return {
    binary: input.binaryPath ?? 'Xkasmvnc',
    argv,
    endpoint: { host: KASMVNC_LOOPBACK_INTERFACE, port: websocketPort },
  };
}

/**
 * argv for minting one per-session credential with `kasmvncpasswd`.
 *
 * Measured flags (1.5.0 man page + binary strings): `-u <name>`, `-r` read, `-w`
 * write (mouse and keyboard), `-o` owner (user management), `-n` change permissions
 * without changing the password, `-d` delete.
 *
 * D-020's split maps exactly onto them, and the mapping is the whole security model
 * of the watch/takeover feature:
 *   - watch    → `-r`      : pixels, no input.
 *   - takeover → `-r -w`   : pixels and input.
 *   - `-o` is NEVER granted. An owner credential can create and delete users, so
 *     handing one to a viewer session would let a watcher mint itself a takeover
 *     credential and make the audited takeover path optional.
 */
export function kasmvncPasswordArgv(input: {
  user: string;
  passwordFile: string;
  mode: 'view' | 'control';
}): string[] {
  const argv = ['-u', input.user, '-r'];
  if (input.mode === 'control') argv.push('-w');
  argv.push(input.passwordFile);
  return argv;
}
