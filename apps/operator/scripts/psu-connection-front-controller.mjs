/**
 * Local psu connection front controller.
 *
 * This file owns only transport selection. Once a remote transport is ready it
 * forwards every non-transport argv cell to the remote `psu`; the remote
 * launcher remains authoritative for role, harness, plan, model, account,
 * resume, fork, and every future psu option.
 */
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";

import {
  buildOpenSshControlMasterCommand,
  buildOpenSshPtySessionCommand,
  reserveLoopbackPort,
} from "../../../packages/operator-core/lib/workspace-host/local-connection-manager.ts";

export const PSU_CONNECTION_STORE_VERSION = "psu-connection-profiles-v1";
export const DEFAULT_REMOTE_OPERATOR_PORT = 3070;
/** The Papercusp cloud portal a bare `psu --connect-login` signs in to. */
export const DEFAULT_HOSTED_PORTAL_ORIGIN = "https://app.papercusp.com";
/** Picker value for "sign in to Papercusp cloud". Not a legal profile name, so it cannot collide. */
export const HOSTED_LOGIN_CHOICE = ":login";

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GCP_RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/;
const GCP_ZONE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const HOSTED_TOKEN_RE = /^pct_[A-Za-z0-9_-]{43}$/;
const HOSTED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOSTED_TICKET_RE = /^ht_[A-Za-z0-9_-]{43}$/;
const HOSTED_SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Programs the controller may run on the chosen host. `pui --connect…` execs
 * `psu --connect-program=pui …` so PUI reuses these profiles and transports
 * (pui-first-party-public-release P-017 / D-025).
 */
const CONNECT_PROGRAMS = new Set(["psu", "pui"]);
const VALUE_FLAGS = new Map([
  ["--connect", "selection"],
  ["--connect-program", "program"],
  ["--connect-add-gcp-iap", "addName"],
  ["--connect-remove", "removeName"],
  ["--connect-project", "projectId"],
  ["--connect-zone", "zone"],
  ["--connect-instance", "instanceName"],
  ["--connect-user", "sshUser"],
  ["--connect-login", "loginOrigin"],
  ["--connect-logout", "logoutName"],
  ["--connect-session", "sessionKey"],
]);
/** Flags whose value is optional; the bare form sets the paired boolean. */
const OPTIONAL_VALUE_FLAGS = new Map([
  ["--connect", "explicitConnect"],
  ["--connect-login", "login"],
  ["--connect-logout", "logout"],
]);

function requiredValue(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function takeRequiredValue(argv, index, flag) {
  const next = argv[index + 1];
  if (next == null || next.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return next;
}

/**
 * Strip only the connection-front-controller namespace. A literal `--` closes
 * the namespace; everything at and after it is forwarded byte-for-byte.
 */
export function parsePsuConnectionArgs(argv) {
  const forwardedArgv = [];
  const transport = {
    explicitConnect: false,
    selection: null,
    list: false,
    addName: null,
    removeName: null,
    projectId: null,
    zone: null,
    instanceName: null,
    sshUser: null,
    login: false,
    loginOrigin: null,
    logout: false,
    logoutName: null,
    sessionKey: null,
    program: "psu",
  };
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const cell = argv[index];
    if (passthrough) {
      forwardedArgv.push(cell);
      continue;
    }
    if (cell === "--") {
      passthrough = true;
      forwardedArgv.push(cell);
      continue;
    }
    if (cell === "--connect-list") {
      transport.list = true;
      continue;
    }

    const equals = cell.indexOf("=");
    const key = equals === -1 ? cell : cell.slice(0, equals);
    const field = VALUE_FLAGS.get(key);
    if (!field) {
      forwardedArgv.push(cell);
      continue;
    }

    const flag = OPTIONAL_VALUE_FLAGS.get(key);
    if (flag) transport[flag] = true;
    if (equals !== -1) {
      const value = cell.slice(equals + 1);
      if (!value) throw new Error(`${key} requires a value after '='`);
      transport[field] = value;
      continue;
    }
    if (
      flag &&
      (argv[index + 1] == null || argv[index + 1].startsWith("--"))
    ) {
      continue;
    }
    transport[field] = takeRequiredValue(argv, index, key);
    index += 1;
  }

  const actions = [
    transport.list,
    Boolean(transport.addName),
    Boolean(transport.removeName),
    transport.login,
    transport.logout,
  ].filter(Boolean).length;
  if (actions > 1)
    throw new Error(
      "Choose only one of --connect-list, --connect-add-gcp-iap, --connect-remove, --connect-login, or --connect-logout",
    );
  // `--connect-login --connect` (bare) is the one maintenance+connect pairing:
  // sign in, then open the program on the new sign-in's workspace. PUI's
  // first-run "Sign in to Papercusp cloud" is exactly this command line.
  const signInThenConnect =
    transport.login && transport.explicitConnect && transport.selection == null;
  if (actions && (transport.explicitConnect || transport.sessionKey) && !signInThenConnect)
    throw new Error("Profile maintenance commands cannot also use --connect");
  if (
    transport.sessionKey != null &&
    !HOSTED_SESSION_KEY_RE.test(transport.sessionKey)
  ) {
    throw new Error(
      "--connect-session must be 1-64 letters, digits, '-' or '_'",
    );
  }
  if (!CONNECT_PROGRAMS.has(transport.program)) {
    throw new Error(
      `--connect-program must be one of ${[...CONNECT_PROGRAMS].join(", ")}`,
    );
  }
  if (
    !transport.addName &&
    [
      transport.projectId,
      transport.zone,
      transport.instanceName,
      transport.sshUser,
    ].some(Boolean)
  ) {
    throw new Error(
      "--connect-project/zone/instance/user require --connect-add-gcp-iap",
    );
  }

  return { transport, forwardedArgv };
}

/** Normalize the first supported remote profile. GCP deliberately defaults to IAP. */
export function normalizeGcpIapProfile(input) {
  const name = requiredValue(
    input.name,
    "Connection profile name",
    PROFILE_NAME_RE,
  );
  const projectId = requiredValue(
    input.projectId,
    "GCP project id",
    GCP_RESOURCE_RE,
  );
  const zone = requiredValue(input.zone, "GCP zone", GCP_ZONE_RE);
  const instanceName = requiredValue(
    input.instanceName,
    "GCP instance name",
    GCP_RESOURCE_RE,
  );
  const sshUser = requiredValue(
    input.sshUser,
    "OS Login SSH user",
    SSH_USER_RE,
  );
  const query = new URLSearchParams({
    project: projectId,
    zone,
    instance: instanceName,
  });

  return {
    name,
    kind: "gcp-iap-ssh",
    projectId,
    zone,
    instanceName,
    sshUser,
    endpoint: `gcp-iap-ssh://${instanceName}?${query.toString()}`,
    target: `${sshUser}@${instanceName}`,
    remoteOperatorPort: DEFAULT_REMOTE_OPERATOR_PORT,
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: {
      command: true,
      pty: true,
      tcpForward: true,
      fileTransfer: true,
    },
    prerequisites: [
      "OpenSSH client",
      "Google Cloud CLI",
      "IAP TCP forwarding permission",
      "OS Login permission",
    ],
    constraints: [
      "No public IP",
      "Interactive control transport; bulk transfer requires an explicit alternate path",
      "SSH host keys are verified by the local OpenSSH configuration",
    ],
    reconnect: "recreate",
    audited: true,
  };
}

/**
 * A Papercusp cloud portal origin. https only, except a loopback test server;
 * credentials in the URL are refused so a token can never be sent to a
 * look-alike host spelled inside the userinfo part.
 */
export function normalizeHostedPortalOrigin(value) {
  let url;
  try {
    url = new URL(value ?? DEFAULT_HOSTED_PORTAL_ORIGIN);
  } catch {
    throw new Error(
      `The Papercusp portal must be a URL like ${DEFAULT_HOSTED_PORTAL_ORIGIN}`,
    );
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "The Papercusp portal must use https:// (http:// is accepted only for a loopback test server)",
    );
  }
  if (url.username || url.password)
    throw new Error("The Papercusp portal URL must not carry credentials");
  return url.origin;
}

export function hostedProfileName(origin) {
  return requiredValue(
    new URL(origin).host.replace(/[^A-Za-z0-9._-]/g, "-"),
    "Connection profile name",
    PROFILE_NAME_RE,
  );
}

/**
 * A name for a new cloud sign-in that no saved profile uses. The first sign-in
 * at a portal is named for its host (so existing `--connect=<host>` keeps
 * working); another account or organization at the same portal gets the host
 * plus its organization's name, then the user id if that is still taken.
 */
export function freeHostedProfileName(origin, identity, profiles) {
  const taken = new Set(profiles.map((profile) => profile.name));
  const host = hostedProfileName(origin);
  const fit = (value) =>
    value.slice(0, 64).replace(/[^A-Za-z0-9]+$/, "") || host.slice(0, 64);
  const slug = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
  const org = slug(identity.organizationName) || slug(identity.organizationId).slice(0, 8);
  const candidates = [
    host,
    fit(`${host}-${org}`),
    fit(`${host}-${org}-${slug(identity.userId).slice(0, 8)}`),
  ];
  for (const candidate of candidates) if (!taken.has(candidate)) return candidate;
  for (let n = 2; ; n += 1) {
    const candidate = fit(`${host}-${org}`.slice(0, 60)) + `-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Same portal, organization and user: the one sign-in a re-login may replace. */
function sameHostedIdentity(profile, { origin, organizationId, userId }) {
  return (
    profile.kind === "papercusp-hosted" &&
    profile.origin === origin &&
    profile.organizationId === organizationId &&
    profile.userId === userId
  );
}

function hostedOrganizationName(value) {
  if (typeof value !== "string") return null;
  // A display label only; control characters could rewrite the terminal.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  return name || null;
}

/**
 * A Papercusp cloud sign-in (WI-10002874, byoc D-412). One profile per portal
 * + organization + user (WI-10003910), so several accounts or organizations
 * can be signed in side by side; each reaches every hosted workspace that
 * person's organization role allows, through the workspace machine's own
 * outbound connector — the machine accepts no inbound connection, so there is
 * no SSH or IAP leg to configure.
 */
export function normalizeHostedProfile(input) {
  const origin = normalizeHostedPortalOrigin(input.origin);
  const name = requiredValue(
    input.name ?? hostedProfileName(origin),
    "Connection profile name",
    PROFILE_NAME_RE,
  );
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()))
    throw new Error("Papercusp CLI token expiry has an invalid value");
  const organizationName = hostedOrganizationName(input.organizationName);
  return {
    name,
    kind: "papercusp-hosted",
    origin,
    ...(organizationName ? { organizationName } : {}),
    accessToken: requiredValue(
      input.accessToken,
      "Papercusp CLI token",
      HOSTED_TOKEN_RE,
    ),
    tokenId: requiredValue(input.tokenId, "Papercusp CLI token id", HOSTED_ID_RE),
    organizationId: requiredValue(
      input.organizationId,
      "Papercusp organization id",
      HOSTED_ID_RE,
    ),
    userId: requiredValue(input.userId, "Papercusp user id", HOSTED_ID_RE),
    expiresAt: expiresAt.toISOString(),
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: {
      command: true,
      pty: true,
      tcpForward: false,
      fileTransfer: false,
    },
    prerequisites: ["A Papercusp cloud sign-in (psu --connect-login)"],
    constraints: [
      "Terminal only: no port forwarding or bulk file transfer",
      "Your organization role decides which workspaces you can open",
    ],
    reconnect: "resume",
    audited: true,
  };
}

function validateStoredProfile(value) {
  if (value?.kind === "gcp-iap-ssh") return normalizeGcpIapProfile(value);
  if (value?.kind === "papercusp-hosted") return normalizeHostedProfile(value);
  throw new Error(
    `Unsupported saved psu connection kind '${value?.kind ?? "missing"}'`,
  );
}

export function defaultPsuConnectionStorePath(home = homedir()) {
  return join(home, ".papercusp", "psu-connections.json");
}

export function loadPsuConnectionStore(path = defaultPsuConnectionStorePath()) {
  if (!existsSync(path))
    return { version: PSU_CONNECTION_STORE_VERSION, profiles: [] };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`psu connection store must be a regular file: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`psu connection store permissions must be 0600: ${path}`);
  }
  if (stat.size > 1024 * 1024)
    throw new Error("psu connection store exceeds the 1 MiB safety limit");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse psu connection store ${path}: ${error?.message ?? error}`,
    );
  }
  if (
    parsed?.version !== PSU_CONNECTION_STORE_VERSION ||
    !Array.isArray(parsed.profiles)
  ) {
    throw new Error(`Unsupported psu connection store version in ${path}`);
  }
  const profiles = parsed.profiles.map(validateStoredProfile);
  if (
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length
  ) {
    throw new Error(`Duplicate profile names in psu connection store ${path}`);
  }
  return { version: PSU_CONNECTION_STORE_VERSION, profiles };
}

export function savePsuConnectionStore(
  store,
  path = defaultPsuConnectionStorePath(),
) {
  const profiles = store.profiles.map(validateStoredProfile);
  if (
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length
  ) {
    throw new Error("Cannot save duplicate psu connection profile names");
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ version: PSU_CONNECTION_STORE_VERSION, profiles }, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    renameSync(temp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

function platformName(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

function gcpIapExtraArgs(profile) {
  return [
    "-o",
    `ProxyCommand=gcloud compute start-iap-tunnel ${profile.instanceName} 22 --listen-on-stdin --project=${profile.projectId} --zone=${profile.zone}`,
  ];
}

export function describePsuConnectionProfile(profile) {
  if (profile.kind === "papercusp-hosted")
    return `${profile.name} — Papercusp cloud workspaces at ${profile.origin}${profile.organizationName ? ` for ${profile.organizationName}` : ""}`;
  return `${profile.name} — GCP IAP ${profile.projectId}/${profile.zone}/${profile.instanceName} as ${profile.sshUser}`;
}

export function describeHostedWorkspace(profile, workspace, now = Date.now()) {
  const label =
    workspace.displayName && workspace.displayName !== workspace.id
      ? `${workspace.displayName} (${workspace.id})`
      : workspace.id;
  const state = workspace.reachable ? "" : ` — ${hostedUnreachableState(workspace, now)}`;
  const organization = workspace.organizationName ?? profile.organizationName;
  return `${profile.name}/${workspace.id} — Papercusp cloud workspace ${label}${organization ? ` in ${organization}` : ""}${state}`;
}

/**
 * A running workspace (`state: 'active'`) that is not reachable is a machine
 * whose link to Papercusp cloud dropped; it normally reconnects on its own.
 * Anything else is a machine that is not running.
 */
function hostedLinkDown(workspace) {
  return workspace.state === "active" && !workspace.reachable;
}

function formatHostedAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

function hostedLastHeard(workspace, now) {
  const at = Date.parse(workspace.connectorHeartbeatAt ?? "");
  return Number.isFinite(at) ? `, last heard ${formatHostedAge(now - at)} ago` : "";
}

function hostedUnreachableState(workspace, now) {
  return hostedLinkDown(workspace)
    ? `running, but its link to Papercusp cloud is down${hostedLastHeard(workspace, now)}`
    : `not connected (${workspace.state})`;
}

function defaultCommandAvailable(command) {
  const probe = nodeSpawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  return !probe.error && probe.status === 0;
}

function defaultRunCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: options.stdio ?? "inherit",
      shell: false,
      env: options.env ?? process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function defaultRunInteractive(command, args) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    const handlers = new Map();
    for (const signal of ["SIGWINCH", "SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        if (!child.killed) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

async function defaultPickConnection(choices, { program = "psu" } = {}) {
  const { select } = await import("@inquirer/prompts");
  return select({ message: `Where should ${program} run?`, choices });
}

/** Best effort: the URL is always printed too, so a headless box loses nothing. */
function defaultOpenBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    const child = nodeSpawn(command, args, { stdio: "ignore", shell: false });
    child.once("error", () => {});
    child.unref();
  } catch {
    // No opener on this machine; the printed URL is the fallback.
  }
}

/**
 * Bridge this terminal to a hosted workspace PTY over the connector relay —
 * the same `papercusp-hosted-workspace.v1` socket the portal's Terminal tab
 * uses (apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol.ts).
 * Resolves when the socket closes; `exit` is set only if the remote shell ended,
 * and `bound` only once the relay bound this socket to a shell on the machine —
 * without it there is no shell to resume.
 */
function defaultOpenHostedTerminal({ socketUrl, initialInput, notice }) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const socket = new WebSocket(socketUrl);
  return new Promise((resolve) => {
    let role = null;
    let exit = null;
    let resumed = false;
    let bound = false;
    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const size = () => ({
      cols: stdout.columns || 120,
      rows: stdout.rows || 32,
    });
    const onInput = (chunk) => {
      if (role === "controller")
        send({ type: "pty.input", data: Buffer.from(chunk).toString("base64") });
    };
    const onResize = () => {
      if (role === "controller") send({ type: "pty.resize", ...size() });
    };
    const onLocalHangup = () => {
      send({ type: "session.detach" });
      socket.close(1000, "psu_detached");
    };
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    let attached = false;
    const cleanup = () => {
      if (!attached) return;
      attached = false;
      stdin.off("data", onInput);
      process.off("SIGWINCH", onResize);
      process.off("SIGTERM", onLocalHangup);
      process.off("SIGHUP", onLocalHangup);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    socket.addEventListener("open", () => {
      attached = true;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onInput);
      process.on("SIGWINCH", onResize);
      process.on("SIGTERM", onLocalHangup);
      process.on("SIGHUP", onLocalHangup);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (message?.type) {
        case "session.bound":
          role = message.role;
          bound = true;
          return;
        case "session.role":
          role = message.role;
          if (role === "observer")
            notice(
              "psu: another viewer took control of this shell; output stays live here",
            );
          return;
        case "pty.ready":
          role = message.role;
          bound = true;
          resumed = message.resumed === true;
          onResize();
          if (resumed) notice("psu: resumed your detached shell");
          else if (initialInput)
            send({
              type: "pty.input",
              data: Buffer.from(initialInput, "utf8").toString("base64"),
            });
          return;
        case "pty.output":
        case "pty.snapshot":
          if (typeof message.data === "string")
            stdout.write(Buffer.from(message.data, "base64"));
          return;
        case "pty.exit":
          exit = { code: message.code, signal: message.signal };
          socket.close(1000, "pty_exited");
          return;
        case "session.denied":
          notice(
            `psu: the workspace refused ${message.requestType ?? "a request"}: ${message.reason}`,
          );
          return;
        default:
          return;
      }
    });
    // An error is always followed by close, which is where this settles.
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", (event) => {
      cleanup();
      resolve({ exit, resumed, bound, closeCode: event.code, closeReason: event.reason });
    });
  });
}

async function defaultProbeOperator(origin, attempts = 8) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Remote Papercusp operator health probe failed through ${origin}: ${lastError?.message ?? lastError}`,
  );
}

function connectionControlPath(profile, home) {
  const digest = createHash("sha256")
    .update(`${profile.kind}\0${profile.name}\0${profile.endpoint}`)
    .digest("hex")
    .slice(0, 24);
  return join(home, ".papercusp", "ssh", `cm-${digest}`);
}

/** The program is in the name, so `pui` never reattaches a `psu` shell with the same argv. */
function tmuxSessionName(profile, argv, program = "psu") {
  const digest = createHash("sha256")
    .update(profile.name)
    .update("\0")
    .update(argv.join("\0"))
    .digest("hex")
    .slice(0, 16);
  return `papercusp-${program}-${digest}`;
}

function assertProfileUsable(profile, deps) {
  const clientPlatform = platformName(deps.platform);
  if (!profile.supportedClientPlatforms.includes(clientPlatform)) {
    throw new Error(
      `Connection '${profile.name}' does not support this ${clientPlatform} client`,
    );
  }
  if (profile.kind === "papercusp-hosted") return;
  for (const command of ["ssh", "gcloud"]) {
    if (!deps.commandAvailable(command)) {
      throw new Error(
        `Connection '${profile.name}' requires '${command}' on the local PATH`,
      );
    }
  }
  if (
    !profile.features.command ||
    !profile.features.pty ||
    !profile.features.tcpForward
  ) {
    throw new Error(
      `Connection '${profile.name}' does not expose the command, PTY, and TCP-forward capabilities psu requires`,
    );
  }
}

async function establishForward(profile, deps) {
  const controlPath = connectionControlPath(profile, deps.home);
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(controlPath), 0o700);
  const lease = await deps.reservePort();
  const localPort = lease.port;
  await lease.release();
  const forward = `127.0.0.1:${localPort}:127.0.0.1:${profile.remoteOperatorPort}`;

  const check = await deps.runCommand(
    "ssh",
    ["-S", controlPath, "-O", "check", "--", profile.target],
    { stdio: "ignore" },
  );
  let reused = check.code === 0;
  if (reused) {
    const added = await deps.runCommand(
      "ssh",
      ["-S", controlPath, "-O", "forward", "-L", forward, "--", profile.target],
      { stdio: "inherit" },
    );
    if (added.code !== 0) {
      throw new Error(
        `Could not add the operator forward to the live ControlMaster for '${profile.name}'`,
      );
    }
  }
  if (!reused) {
    rmSync(controlPath, { force: true });
    const master = buildOpenSshControlMasterCommand({
      target: profile.target,
      controlPath,
      localPort,
      remoteOperatorPort: profile.remoteOperatorPort,
      controlPersistSeconds: 60,
      extraArgs: gcpIapExtraArgs(profile),
    });
    const result = await deps.runCommand(
      master.command,
      ["-f", ...master.args],
      { stdio: "inherit" },
    );
    if (result.code !== 0) {
      throw new Error(
        `Could not establish '${profile.name}'. OpenSSH host-key and authentication policy is authoritative; inspect the error above and verify known_hosts, OS Login, and IAP permission.`,
      );
    }
  }

  const cancel = async () => {
    await deps.runCommand(
      "ssh",
      ["-S", controlPath, "-O", "cancel", "-L", forward, "--", profile.target],
      {
        stdio: "ignore",
      },
    );
  };
  return { controlPath, localPort, cancel };
}

/** Single-quote one argv cell for the remote POSIX shell. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Same key for the same profile, workspace and argv — so re-running an
 * interrupted command reattaches to the shell still alive on the machine, the
 * way `tmux new-session -A` does for the SSH transport.
 */
function hostedSessionKey(profile, workspaceId, argv, program = "psu") {
  const hash = createHash("sha256").update(`${profile.name}\0${workspaceId}\0`);
  // psu keys predate other programs; folding only the others in keeps every
  // existing psu shell reattachable.
  if (program !== "psu") hash.update(`program=${program}\0`);
  return hash.update(argv.join("\0")).digest("base64url").slice(0, 22);
}

/**
 * Relay close codes for a lost machine link (hosted-workspace-session.ts):
 * 4411 = no live connector when this socket attached, 4412 = the connector
 * dropped while this socket was open.
 */
const HOSTED_CLOSE_CONNECTOR_UNAVAILABLE = 4411;
const HOSTED_CLOSE_CONNECTOR_DISCONNECTED = 4412;

const HOSTED_ERROR_GUIDANCE = {
  cli_token_required: "psu is not signed in",
  cli_token_invalid: "this psu sign-in has expired or was signed out",
  membership_not_active:
    "your account is no longer an active member of that organization",
  workspace_not_found: "that workspace is not in your organization",
  workspace_not_reachable:
    "the workspace machine's link to Papercusp cloud is down (it may be stopped, still starting, or reconnecting)",
  authority_unavailable: "the Papercusp cloud could not check your access; try again",
  ticket_unavailable: "the Papercusp cloud could not open a session; try again",
};

async function hostedRequest(
  deps,
  profileOrOrigin,
  path,
  { method = "GET", body, timeoutMs = 20_000 } = {},
) {
  const origin =
    typeof profileOrOrigin === "string" ? profileOrOrigin : profileOrOrigin.origin;
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (typeof profileOrOrigin !== "string")
    headers.authorization = `Bearer ${profileOrOrigin.accessToken}`;
  let response;
  try {
    response = await deps.fetch(`${origin}/api${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Cannot reach the Papercusp cloud at ${origin}: ${error?.message ?? error}`,
    );
  }
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function hostedFailure(profile, action, { status, payload }) {
  const error = payload?.error;
  const code = typeof error === "string" ? error : error?.code;
  if (code === "forbidden" && error?.missingPermission) {
    return new Error(
      `Cannot ${action}: your organization role does not include ${error.missingPermission}`,
    );
  }
  const reason = HOSTED_ERROR_GUIDANCE[code] ?? `HTTP ${status}${code ? ` ${code}` : ""}`;
  const relogin =
    code === "cli_token_invalid" || code === "cli_token_required"
      ? ` Run psu --connect-login=${profile.origin} to sign in again.`
      : "";
  return new Error(`Cannot ${action}: ${reason}.${relogin}`);
}

async function listHostedWorkspaces(profile, deps, timeoutMs) {
  const result = await hostedRequest(deps, profile, "/hosted/cli/workspaces", {
    timeoutMs,
  });
  if (result.status !== 200 || result.payload?.ok !== true)
    throw hostedFailure(profile, `list workspaces at ${profile.origin}`, result);
  // The cloud's current organization name labels each entry (a rename shows up
  // at once); the name saved at sign-in covers an older cloud that sends none.
  const organizationName = hostedOrganizationName(result.payload.organizationName);
  return (Array.isArray(result.payload.workspaces) ? result.payload.workspaces : []).map(
    (workspace) => (organizationName ? { ...workspace, organizationName } : workspace),
  );
}

/** RFC 8628 device sign-in: print a code, let the person approve it in a browser, poll once per interval. */
async function hostedLogin(originInput, store, deps) {
  const origin = normalizeHostedPortalOrigin(originInput ?? deps.cloudOrigin);
  const started = await hostedRequest(deps, origin, "/hosted/cli/device/code", {
    method: "POST",
    body: { clientLabel: deps.hostname },
  });
  const grant = started.payload;
  if (started.status !== 200 || grant?.ok !== true || typeof grant.deviceCode !== "string") {
    // Starting a device grant needs no credentials, so a refusal here is never
    // the user's sign-in state: name the server's own code and say where the
    // fault is, instead of a bare status that reads like a local mistake
    // (WI-10003292: the cloud answered 401 portal_auth_required for weeks).
    const error = grant?.error;
    const code = typeof error === "string" ? error : error?.code;
    const detail = `HTTP ${started.status}${typeof code === "string" && code ? ` ${code}` : ""}`;
    throw new Error(
      `Cannot start a Papercusp cloud sign-in at ${origin} (${detail}). ` +
        "The cloud refused to start the sign-in; nothing on this machine caused it. " +
        "Try again in a few minutes, and report it if it keeps happening.",
    );
  }
  deps.notice(`psu: to sign in, open ${grant.verificationUriComplete}`);
  deps.notice(`psu: and check that the page shows the code ${grant.userCode}`);
  if (deps.interactive) deps.openBrowser(grant.verificationUriComplete);

  let intervalMs = Math.max(1, Number(grant.interval) || 5) * 1000;
  const deadline = deps.now() + Math.max(1, Number(grant.expiresIn) || 600) * 1000;
  let issued = null;
  while (!issued) {
    if (deps.now() >= deadline)
      throw new Error("The sign-in code expired. Run psu --connect-login again.");
    await deps.sleep(intervalMs);
    const polled = await hostedRequest(deps, origin, "/hosted/cli/device/token", {
      method: "POST",
      body: { deviceCode: grant.deviceCode },
    });
    if (polled.status === 200 && polled.payload?.ok === true) {
      issued = polled.payload;
      break;
    }
    const error = polled.payload?.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (error === "access_denied")
      throw new Error("Sign-in was denied in the browser; psu is not signed in.");
    if (error === "expired_token")
      throw new Error("The sign-in code expired. Run psu --connect-login again.");
    throw new Error(
      `Papercusp cloud sign-in failed (HTTP ${polled.status}${typeof error === "string" ? ` ${error}` : ""})`,
    );
  }

  const identity = {
    origin,
    organizationId: issued.organizationId,
    userId: issued.userId,
    organizationName: issued.organizationName,
  };
  // A re-login replaces only the sign-in for the SAME portal + organization +
  // user; any other account or organization is kept alongside (WI-10003910).
  const replaced = store.profiles.find((saved) => sameHostedIdentity(saved, identity)) ?? null;
  const profile = normalizeHostedProfile({
    name: replaced?.name ?? freeHostedProfileName(origin, identity, store.profiles),
    origin,
    accessToken: issued.accessToken,
    tokenId: issued.tokenId,
    organizationId: issued.organizationId,
    organizationName: issued.organizationName ?? replaced?.organizationName,
    userId: issued.userId,
    expiresAt: issued.expiresAt,
  });
  savePsuConnectionStore(
    {
      ...store,
      profiles: [
        ...store.profiles.filter((saved) => saved !== replaced),
        profile,
      ],
    },
    deps.storePath,
  );
  // Only after the new token is saved: a failed re-login must not sign you out.
  if (replaced)
    await hostedRequest(deps, replaced, "/hosted/cli/logout", { method: "POST" }).catch(
      () => null,
    );
  return profile;
}

/** `name` or `name/workspaceId`; profile names cannot contain '/'. */
function parseSelection(selection) {
  const slash = selection.indexOf("/");
  return slash === -1
    ? { name: selection, workspaceId: null }
    : { name: selection.slice(0, slash), workspaceId: selection.slice(slash + 1) || null };
}

/**
 * How long psu waits for a running workspace's machine to re-establish its
 * link to Papercusp cloud before giving up. The machine's connector reconnects
 * with a 1s-floor jittered backoff, and the relay drops a dead link within one
 * 30s ping round, so a brief blip normally clears well inside this budget.
 * One budget covers the whole attach, however many times the link drops.
 */
export const HOSTED_RECONNECT_POLL_MS = 3_000;
export const HOSTED_RECONNECT_POLLS = 15;

function hostedNotRunningError(workspace) {
  return new Error(
    `Workspace '${workspace.id}' is not connected right now (${workspace.state}). Start it in the portal, then retry.`,
  );
}

/**
 * Wait (within `budget`) for a running workspace whose link to Papercusp cloud
 * is down to reconnect. Resolves with the reachable workspace; otherwise throws
 * an error that says what is actually wrong.
 */
async function awaitHostedLink(profile, workspace, budget, deps) {
  let current = workspace;
  if (budget.polls > 0)
    deps.notice(
      `psu: ${current.id} is ${hostedUnreachableState(current, deps.now())}; waiting up to ${Math.round((budget.polls * HOSTED_RECONNECT_POLL_MS) / 1000)}s for it to reconnect`,
    );
  while (budget.polls > 0) {
    budget.polls -= 1;
    await deps.sleep(HOSTED_RECONNECT_POLL_MS);
    const listed = (await listHostedWorkspaces(profile, deps)).find(
      (candidate) => candidate.id === current.id,
    );
    if (!listed)
      throw new Error(
        `Workspace '${current.id}' is no longer in your organization at ${profile.origin}.`,
      );
    if (listed.reachable) {
      deps.notice(`psu: ${listed.id} reconnected to Papercusp cloud`);
      return listed;
    }
    if (!hostedLinkDown(listed)) throw hostedNotRunningError(listed);
    current = listed;
  }
  throw new Error(
    `Workspace '${current.id}' is ${hostedUnreachableState(current, deps.now())}, and it did not reconnect while psu waited. ` +
      "The machine normally reconnects on its own: retry in a minute, and report it if it stays down.",
  );
}

async function runHostedConnection(profile, workspaceId, forwardedArgv, transport, pickerAllowed, deps) {
  const budget = { polls: HOSTED_RECONNECT_POLLS };
  const workspaces = await listHostedWorkspaces(profile, deps);
  let workspace = null;
  if (workspaceId) {
    workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
    if (!workspace)
      throw new Error(
        `Workspace '${workspaceId}' is not in your organization at ${profile.origin}. Run psu --connect-list to see yours.`,
      );
    if (!workspace.reachable) {
      if (!hostedLinkDown(workspace)) throw hostedNotRunningError(workspace);
      workspace = await awaitHostedLink(profile, workspace, budget, deps);
    }
  } else {
    const reachable = workspaces.filter((candidate) => candidate.reachable);
    if (reachable.length === 1) workspace = reachable[0];
    else if (reachable.length > 1 && pickerAllowed) {
      const chosen = await deps.pickConnection(
        reachable.map((candidate) => ({
          name: describeHostedWorkspace(profile, candidate),
          value: `${profile.name}/${candidate.id}`,
        })),
        { program: transport.program },
      );
      workspace = reachable.find((candidate) => `${profile.name}/${candidate.id}` === chosen) ?? null;
    }
    if (!workspace) {
      const listed = workspaces.map((candidate) => candidate.id).join(", ") || "none";
      const linkDown = workspaces.filter(hostedLinkDown);
      throw new Error(
        reachable.length > 0
          ? `Choose a workspace with --connect=${profile.name}/<workspace> (connected: ${reachable.map((candidate) => candidate.id).join(", ")})`
          : linkDown.length > 0
            ? `None of your workspaces at ${profile.origin} is reachable right now: ${linkDown
                .map((candidate) => `${candidate.id} is ${hostedUnreachableState(candidate, deps.now())}`)
                .join("; ")}. A running machine normally reconnects on its own; run psu --connect=${profile.name}/<workspace> to wait for it.`
            : `None of your workspaces at ${profile.origin} is connected right now (yours: ${listed}). Start one in the portal, then retry.`,
      );
    }
  }

  const { program } = transport;
  const session =
    transport.sessionKey ??
    hostedSessionKey(profile, workspace.id, forwardedArgv, program);
  const initialInput = `exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 ${program}${forwardedArgv
    .map((cell) => ` ${shellQuote(cell)}`)
    .join("")}\r`;
  // Each pass mints a fresh single-use ticket; the same session key means a
  // retry lands on the same shell if one was already started.
  for (;;) {
    const opened = await hostedRequest(
      deps,
      profile,
      `/hosted/cli/workspaces/${encodeURIComponent(workspace.id)}/terminal`,
      { method: "POST", body: { session } },
    );
    const openError = opened.payload?.error;
    const openCode = typeof openError === "string" ? openError : openError?.code;
    if (opened.status === 409 && openCode === "workspace_not_reachable") {
      // The link dropped between the listing and the ticket.
      workspace = await awaitHostedLink(
        profile,
        {
          ...workspace,
          reachable: false,
          connectorHeartbeatAt: openError?.connectorHeartbeatAt ?? workspace.connectorHeartbeatAt,
        },
        budget,
        deps,
      );
      continue;
    }
    if (opened.status !== 200 || opened.payload?.ok !== true)
      throw hostedFailure(profile, `open a terminal on ${workspace.id}`, opened);
    // Take only the single-use ticket from the reply and address the relay at
    // the portal psu already trusts with its token — never at a host the reply names.
    let ticket = null;
    try {
      ticket = new URL(opened.payload.socketUrl).searchParams.get("ticket");
    } catch {
      ticket = null;
    }
    if (!ticket || !HOSTED_TICKET_RE.test(ticket))
      throw new Error(`The Papercusp cloud returned an unusable session for ${workspace.id}`);
    const socketUrl = new URL("/api/hosted/connectors/socket", profile.origin);
    socketUrl.protocol = socketUrl.protocol === "http:" ? "ws:" : "wss:";
    socketUrl.searchParams.set("ticket", ticket);

    deps.notice(`psu: connected to ${describeHostedWorkspace(profile, workspace, deps.now())}`);
    const result = await deps.openHostedTerminal({
      socketUrl: socketUrl.toString(),
      initialInput,
      notice: deps.notice,
    });
    if (result.exit) return { handled: true, argv: forwardedArgv, exitCode: result.exit.code ?? 1 };
    const reason = result.closeReason ? ` (${result.closeReason})` : "";
    const linkLost =
      result.closeCode === HOSTED_CLOSE_CONNECTOR_UNAVAILABLE ||
      result.closeCode === HOSTED_CLOSE_CONNECTOR_DISCONNECTED;
    if (result.bound) {
      const resume = `${program} --connect=${profile.name}/${workspace.id} --connect-session=${opened.payload.session ?? session}`;
      throw new Error(
        linkLost
          ? `The workspace machine's link to Papercusp cloud dropped${reason}. Your shell stays alive on the machine for a while: once it reconnects, run ${resume} to resume it.`
          : `The connection to ${workspace.id} closed${reason}. Your shell stays alive on the machine for a while: run ${resume} to resume it.`,
      );
    }
    // No shell was started, so there is nothing to resume. A lost link before
    // the shell bound is the machine reconnecting: wait for it and try again.
    if (linkLost) {
      workspace = await awaitHostedLink(profile, { ...workspace, reachable: false }, budget, deps);
      continue;
    }
    throw new Error(
      `The connection to ${workspace.id} closed before a shell started${reason}. Nothing was started there; retry ${program} --connect=${profile.name}/${workspace.id}.`,
    );
  }
}

/**
 * Every place psu can run. A Papercusp cloud sign-in expands to its workspaces
 * (a stopped one is shown but not selectable); with no sign-in yet, the picker
 * offers one, so the remote option is discoverable from a plain `psu`.
 * `pui --connect` always means a remote host, so it gets no local entry.
 */
async function pickerChoices(store, deps, program = "psu") {
  const choices =
    program === "psu" ? [{ name: "Local — this computer", value: "local" }] : [];
  let signedIn = false;
  for (const profile of store.profiles) {
    if (profile.kind !== "papercusp-hosted") {
      choices.push({ name: describePsuConnectionProfile(profile), value: profile.name });
      continue;
    }
    signedIn = true;
    try {
      // Short: this runs before every interactive launch, including local ones.
      for (const workspace of await listHostedWorkspaces(profile, deps, 5_000)) {
        choices.push({
          name: describeHostedWorkspace(profile, workspace),
          value: `${profile.name}/${workspace.id}`,
          ...(workspace.reachable
            ? {}
            : { disabled: hostedLinkDown(workspace) ? "link to Papercusp cloud down" : "not connected" }),
        });
      }
    } catch (error) {
      choices.push({
        name: describePsuConnectionProfile(profile),
        value: profile.name,
        disabled: error?.message ?? String(error),
      });
    }
  }
  // Always offered: a second account or organization is one more sign-in,
  // kept beside the others (WI-10003910).
  choices.push({
    name: signedIn
      ? "Sign in to another Papercusp cloud account or organization"
      : "Papercusp cloud — sign in to use a hosted workspace",
    value: HOSTED_LOGIN_CHOICE,
  });
  return choices;
}

function connectionDeps(overrides) {
  const home = overrides.home ?? homedir();
  return {
    home,
    storePath: overrides.storePath ?? defaultPsuConnectionStorePath(home),
    platform: overrides.platform ?? process.platform,
    interactive:
      overrides.interactive ??
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
    pickConnection: overrides.pickConnection ?? defaultPickConnection,
    commandAvailable: overrides.commandAvailable ?? defaultCommandAvailable,
    runCommand: overrides.runCommand ?? defaultRunCommand,
    runInteractive: overrides.runInteractive ?? defaultRunInteractive,
    reservePort: overrides.reservePort ?? reserveLoopbackPort,
    probeOperator: overrides.probeOperator ?? defaultProbeOperator,
    fetch: overrides.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? (() => Date.now()),
    hostname: overrides.hostname ?? osHostname(),
    // The portal a sign-in without an explicit origin uses: a self-hosted
    // Papercusp portal (or a test server) sets PAPERCUSP_CLOUD_ORIGIN.
    cloudOrigin:
      overrides.cloudOrigin ?? (process.env.PAPERCUSP_CLOUD_ORIGIN || undefined),
    openBrowser: overrides.openBrowser ?? defaultOpenBrowser,
    openHostedTerminal: overrides.openHostedTerminal ?? defaultOpenHostedTerminal,
    output: overrides.output ?? ((line) => console.log(line)),
    notice: overrides.notice ?? ((line) => console.error(line)),
    transportForwarded:
      overrides.transportForwarded ??
      process.env.PAPERCUSP_PSU_CONNECTION_FORWARDED === "1",
  };
}

function savedProfile(name, deps) {
  const profile = loadPsuConnectionStore(deps.storePath).profiles.find(
    (candidate) => candidate.name === name,
  );
  if (!profile)
    throw new Error(
      `Unknown psu connection profile '${name}'. Run psu --connect-list to inspect saved profiles.`,
    );
  return profile;
}

/**
 * @returns {Promise<{ handled: boolean, argv: string[], exitCode?: number }>}
 */
export async function runPsuConnectionFrontController(argv, overrides = {}) {
  const deps = connectionDeps(overrides);
  // Set only by the local controller for its remote psu child: prevent a
  // recursive transport picker while preserving every remote launch picker.
  if (deps.transportForwarded) return { handled: false, argv: [...argv] };
  const { transport, forwardedArgv } = parsePsuConnectionArgs(argv);
  const store = loadPsuConnectionStore(deps.storePath);

  if (transport.list) {
    deps.output("local — this computer");
    for (const profile of store.profiles) {
      deps.output(describePsuConnectionProfile(profile));
      if (profile.kind !== "papercusp-hosted") continue;
      try {
        const workspaces = await listHostedWorkspaces(profile, deps);
        if (workspaces.length === 0)
          deps.output("  (no workspaces in this organization yet)");
        for (const workspace of workspaces)
          deps.output(`  ${describeHostedWorkspace(profile, workspace)}`);
      } catch (error) {
        deps.output(`  ${error?.message ?? error}`);
      }
    }
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }
  let signedIn = null;
  if (transport.login) {
    signedIn = await hostedLogin(transport.loginOrigin, store, deps);
    if (!transport.explicitConnect) {
      deps.output(
        `Signed in to ${signedIn.origin}${signedIn.organizationName ? ` for ${signedIn.organizationName}` : ""} as '${signedIn.name}'. Run ${transport.program} --connect=${signedIn.name} to open ${transport.program} on one of your workspaces.`,
      );
      return { handled: true, argv: forwardedArgv, exitCode: 0 };
    }
    deps.notice(`psu: signed in to ${signedIn.origin}`);
  }
  if (transport.logout) {
    const hosted = store.profiles.filter(
      (profile) => profile.kind === "papercusp-hosted",
    );
    const profile = transport.logoutName
      ? hosted.find((candidate) => candidate.name === transport.logoutName)
      : hosted.length === 1
        ? hosted[0]
        : null;
    if (!profile) {
      throw new Error(
        transport.logoutName
          ? `No Papercusp cloud sign-in named '${transport.logoutName}'`
          : `Name the sign-in to remove: psu --connect-logout=<${hosted.map((candidate) => candidate.name).join("|") || "name"}>`,
      );
    }
    const revoked = await hostedRequest(deps, profile, "/hosted/cli/logout", {
      method: "POST",
    }).catch((error) => ({ status: 0, error }));
    savePsuConnectionStore(
      {
        ...store,
        profiles: store.profiles.filter((saved) => saved.name !== profile.name),
      },
      deps.storePath,
    );
    if (revoked.status !== 200)
      deps.notice(
        `psu: could not reach ${profile.origin} to revoke the token; it was forgotten locally and expires on its own at ${profile.expiresAt}`,
      );
    deps.output(`Signed out of ${describePsuConnectionProfile(profile)}`);
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }
  if (transport.addName) {
    const profile = normalizeGcpIapProfile({
      name: transport.addName,
      projectId: transport.projectId,
      zone: transport.zone,
      instanceName: transport.instanceName,
      sshUser: transport.sshUser,
    });
    if (store.profiles.some((saved) => saved.name === profile.name)) {
      throw new Error(
        `Connection profile '${profile.name}' already exists; remove it before replacing it`,
      );
    }
    savePsuConnectionStore(
      { ...store, profiles: [...store.profiles, profile] },
      deps.storePath,
    );
    deps.output(`Saved ${describePsuConnectionProfile(profile)}`);
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }
  if (transport.removeName) {
    const profiles = store.profiles.filter(
      (profile) => profile.name !== transport.removeName,
    );
    if (profiles.length === store.profiles.length)
      throw new Error(`Unknown connection profile '${transport.removeName}'`);
    savePsuConnectionStore({ ...store, profiles }, deps.storePath);
    deps.output(`Removed psu connection profile '${transport.removeName}'`);
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }

  const passthroughBoundary = forwardedArgv.indexOf("--");
  const launcherArgv =
    passthroughBoundary === -1
      ? forwardedArgv
      : forwardedArgv.slice(0, passthroughBoundary);
  const requestsLocalHelp = launcherArgv.some(
    (cell) => cell === "--help" || cell === "-h",
  );
  const pickerAllowed =
    deps.interactive &&
    !requestsLocalHelp &&
    !forwardedArgv.includes("--no-picker") &&
    !forwardedArgv.includes("--headless");
  let selection = signedIn?.name ?? transport.selection;
  if (
    (transport.explicitConnect || transport.sessionKey) &&
    selection == null &&
    !pickerAllowed
  ) {
    throw new Error(
      `--connect needs a saved profile name when ${transport.program} is non-interactive`,
    );
  }
  if (selection == null && pickerAllowed)
    selection = await deps.pickConnection(
      await pickerChoices(store, deps, transport.program),
      { program: transport.program },
    );
  if (selection === HOSTED_LOGIN_CHOICE) {
    const profile = await hostedLogin(undefined, store, deps);
    selection = profile.name;
  }
  // Only psu itself continues on this computer. Returning unhandled for any
  // other program would make the launcher start a local psu in its place.
  if (transport.program !== "psu" && (selection == null || selection === "local"))
    throw new Error(
      `${transport.program} --connect runs ${transport.program} on a saved remote host; run ${transport.program} without --connect to stay on this computer`,
    );
  if (selection == null || selection === "local")
    return { handled: false, argv: forwardedArgv };

  const { name, workspaceId } = parseSelection(selection);
  const profile = savedProfile(name, deps);
  assertProfileUsable(profile, deps);
  if (profile.kind === "papercusp-hosted")
    return runHostedConnection(
      profile,
      workspaceId,
      forwardedArgv,
      transport,
      pickerAllowed,
      deps,
    );
  if (workspaceId || transport.sessionKey)
    throw new Error(
      `'${profile.name}' is a single machine; --connect=<name>/<workspace> and --connect-session apply only to Papercusp cloud sign-ins`,
    );
  deps.notice(
    `psu: connecting through ${describePsuConnectionProfile(profile)}`,
  );
  for (const constraint of profile.constraints)
    deps.notice(`psu: transport constraint — ${constraint}`);

  const forward = await establishForward(profile, deps);
  try {
    await deps.probeOperator(`http://127.0.0.1:${forward.localPort}`);
    const remoteArgv = [
      "tmux",
      "new-session",
      "-A",
      "-s",
      tmuxSessionName(profile, forwardedArgv, transport.program),
      "--",
      "env",
      "PAPERCUSP_PSU_CONNECTION_FORWARDED=1",
      transport.program,
      ...forwardedArgv,
    ];
    const session = buildOpenSshPtySessionCommand({
      target: profile.target,
      controlPath: forward.controlPath,
      remoteArgv,
    });
    const result = await deps.runInteractive(session.command, session.args);
    if (result.signal)
      throw new Error(`Remote psu transport ended on ${result.signal}`);
    if (result.code === 255) {
      throw new Error(
        `Remote psu transport failed. The tmux session remains reattachable; retry ${transport.program} --connect=${profile.name} after correcting the OpenSSH/IAP error above.`,
      );
    }
    return { handled: true, argv: forwardedArgv, exitCode: result.code ?? 1 };
  } finally {
    await forward.cancel();
  }
}
