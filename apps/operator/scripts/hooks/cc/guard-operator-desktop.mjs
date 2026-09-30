#!/usr/bin/env node
/**
 * PreToolUse guard — keep agents on the Tauri DESKTOP app, not the retired
 * browser webapp.
 *
 * The papercusp operator's Next/Vite/Hono layer on :3055 / :3070 / :3170 is
 * the DESKTOP's internal content source, not a standalone site. Agents
 * repeatedly try to "see the app" by browsing those ports (verdict /
 * playwright / chrome / a browser-open in bash) instead of launching the
 * Tauri desktop shell. This hook blocks that and redirects. It does NOT block
 * `curl`/API checks (those are allowed while the desktop is up) or any
 * non-operator port.
 *
 * Registered in ~/.claude/settings.json PreToolUse with matcher:
 *   mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp|Skill
 * (Bash is deliberately NOT matched — see the branch-2 comment below: a
 * text-scanning Bash matcher would false-positive on anything that merely
 * MENTIONS these ports, e.g. a commit message, a grep, editing this file.)
 * Wired via mergeClaudeHookSettings (packages/operator-core/lib/desktop-
 * install/papercusp-files.ts) + the install-standalone-mcp.sh sibling
 * (merge_guard_operator_desktop_hook) — KEEP THE TWO IN SYNC (EI-16981: this
 * hook previously lived at repo-root scripts/cc-hooks/ and was NEVER wired
 * into either installer, so the block/redirect it documents never fired).
 *
 * Exit 0 = allow; exit 2 = block (stderr is shown to the agent).
 *
 * EI-13177: :3170 (the STAGING operator — same Hono/SPA host as :3070, per
 * the repo's two-port model) was missing from the port list, so an agent
 * pointing verdict/playwright at it got NO redirect and hit the exact
 * silent-hang symptom this guard exists to prevent (curl 200, but browser
 * navigation never reaches DOMContentLoaded — the SPA expects the Tauri
 * IPC bridge this raw browser view never provides). Added.
 *
 * Source of truth: papercup repo CLAUDE.md → "Running / testing this app".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The desktop dir of THE CHECKOUT THIS HOOK LIVES IN — not one box's path. */
function desktopDir() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  try {
    const root = execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    return join(root, 'papercusp-desktop');
  } catch {
    return join(here, '..', '..', 'papercusp-desktop');
  }
}

const DESKTOP_CMD = `cd ${desktopDir()} && npm run dev`;

const BLOCK_MSG = [
  '',
  '⛔ BLOCKED — this is the Tauri DESKTOP app, not a browser webapp.',
  '',
  '  Run / test it via the desktop shell:',
  `    ${DESKTOP_CMD}`,
  '  …then drive the Tauri window it opens.',
  '',
  "  Do NOT open :3055 / :3070 / :3170 in a browser — they are the desktop's",
  "  internal content source (the retired standalone-webapp path), so a browser",
  '  view is broken/misleading. A `curl` to a :3070/:3170 API endpoint is fine',
  '  while the desktop is running. See the papercup CLAUDE.md → "Running / testing',
  '  this app".',
  '',
].join('\n');

const allow = () => process.exit(0);
const block = (msg = BLOCK_MSG) => {
  process.stderr.write(msg + '\n');
  process.exit(2);
};

/* ── Loopback-deception guard (EI-20732462499061834) ───────────────────────
 * A REMOTE-looking hostname that resolves to LOOPBACK is the dangerous case,
 * and it is the opposite failure from the one above: there, a browser view of
 * an operator port is visibly broken. Here the check SUCCEEDS — whatever is
 * listening locally answers 200 with a well-formed body and there is no tell
 * in the response, so a "prod" verification silently reports on localhost.
 *
 * Measured on this box: `/etc/hosts` pins `sidestage.papercusp.com` to
 * 127.0.0.1, so `https://sidestage.papercusp.com/` returned 200 from
 * ip=127.0.0.1 in 0.3s while the real origin was unreachable. The filer had
 * already cited a sha read that way as prod evidence in two work-items.
 *
 * We block only the DECEPTIVE case — a name that looks remote but resolves
 * loopback. Navigating to `localhost` / `127.0.0.1` / `*.local` is a
 * deliberate local check and stays allowed. Every failure path here allows:
 * a guard that blocks on its own resolver error is worse than the bug.
 */
const LOOPBACK_ADDR = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|0:0:0:0:0:0:0:1)$/;

/** Names that are SUPPOSED to resolve locally — pointing at them is intentional. */
function isExplicitlyLocal(host) {
  return (
    !host ||
    /^localhost$/i.test(host) ||
    /\.localhost$/i.test(host) ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /\.local$/i.test(host)
  );
}

/** Resolve via the SAME path the tools use (nsswitch → /etc/hosts, then DNS).
 *  Returns the addresses when EVERY address is loopback, else null. */
function loopbackAddrs(host) {
  let out;
  try {
    out = execFileSync('getent', ['hosts', host], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // no such host, getent missing, or timeout → fail OPEN
  }
  const addrs = out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
  // ALL addresses loopback ⇒ every connection to this name lands locally.
  return addrs.length > 0 && addrs.every((a) => LOOPBACK_ADDR.test(a)) ? addrs : null;
}

/* ── Tunnel-forward exemption (EI-21290819499876110) ───────────────────────
 * The premise above — "resolves to loopback ⇒ the connection lands on a LOCAL
 * server" — stopped being universally true on 2026-08-23. papercusp-sni-bypass
 * .service holds SSH `-L` forwards on 127.0.0.10-.17:443 whose far end is the
 * REAL origin, because the LAN gateway forges DNS for papercusp hostnames and
 * silently drops TLS by SNI (EI-18859147091614600). A probe through one of
 * those aliases reaches PROD with end-to-end TLS and a validating cert —
 * verified by comparing `server:` headers through the tunnel against the same
 * request run on the origin host (both nginx/1.27.5, matching timestamps).
 *
 * So loopback-ness alone can no longer decide this, and the block message was
 * asserting something FALSE about where the connection lands. We DERIVE the
 * answer rather than allowlisting addresses — an allowlist silently rots the
 * moment someone adds a hostname (derived-truth ladder, CLAUDE.md). The live
 * process's own argv is the source of truth for what it forwards, and since
 * the unit runs with ExitOnForwardFailure=yes, a LIVE main process still
 * holding that `-L` is proof the bind actually succeeded.
 *
 * DIRECTION OF FAILURE IS THE WHOLE DESIGN: this can only ever turn a BLOCK
 * into an ALLOW, and only on positive proof. Unit inactive or absent, no
 * systemctl, pid gone between the two reads, port not forwarded, anything
 * unexpected → fall through to the original block. The guard is preserved
 * intact; only the provably-safe case is carved out.
 */
const BYPASS_UNIT = 'papercusp-sni-bypass.service';

function systemctlValue(args) {
  return execFileSync('systemctl', args, {
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** MainPID of the bypass unit, but ONLY while it is actually active. */
function bypassMainPid() {
  try {
    if (systemctlValue(['is-active', BYPASS_UNIT]) !== 'active') return null;
    const pid = systemctlValue(['show', BYPASS_UNIT, '-p', 'MainPID', '--value']);
    return /^[1-9]\d*$/.test(pid) ? pid : null;
  } catch {
    return null; // no systemctl / unit unknown / inactive → not proven
  }
}

/** The "addr:port" binds the LIVE bypass process is actually forwarding. */
function bypassForwards() {
  const pid = bypassMainPid();
  if (!pid) return null;
  let argv;
  try {
    // Reading this also proves the process still exists right now.
    argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null; // died between the two reads → not proven
  }
  const binds = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const spec =
      argv[i] === '-L' ? argv[i + 1] : argv[i].startsWith('-L') ? argv[i].slice(2) : null;
    if (!spec) continue;
    // ssh's 4-field form: bind_address:port:host:hostport
    const parts = spec.split(':');
    if (parts.length === 4 && parts[0] && parts[1]) binds.add(`${parts[0]}:${parts[1]}`);
  }
  return binds.size ? binds : null;
}

/** True only when EVERY resolved address is a live forward on this port. */
function isTunnelForward(addrs, port) {
  if (!port) return false;
  const binds = bypassForwards();
  if (!binds) return false;
  return addrs.every((a) => binds.has(`${a}:${port}`));
}

const loopbackMsg = (host, url) =>
  [
    '',
    `⛔ BLOCKED — "${host}" resolves to LOOPBACK on this box.`,
    '',
    `  ${url}`,
    '',
    '  This looks like a remote/prod check, and nothing here proves the',
    '  connection leaves this machine. Whatever is listening locally answers',
    '  200 with a well-formed body and there is NO tell in the response — so',
    '  the run would pass and you would report localhost as prod.',
    '',
    `  Confirm the pin:   getent hosts ${host}`,
    '  (/etc/hosts deliberately pins some papercusp names — read the',
    '   papercusp-sni-bypass block there before changing any.)',
    '',
    '  NOT ALWAYS LOCALHOST — loopback alone no longer decides this.',
    '  papercusp-sni-bypass.service holds SSH :443 forwards on 127.0.0.10-.17',
    '  that genuinely reach the real origin, because the LAN gateway forges',
    '  DNS for papercusp names and drops TLS by SNI (EI-18859147091614600).',
    '  Those are detected and allowed automatically, so this fired because it',
    '  could NOT be proven: the unit is inactive, or this port is not one it',
    '  forwards (only :443 is — http:// is NOT). Check, and restart if down:',
    '    systemctl is-active papercusp-sni-bypass.service',
    '',
    '  To verify a REMOTE host, run the probe ON that host (ssh/docker exec)',
    '  rather than from here — the office LAN also drops TLS handshakes whose',
    '  SNI is *.papercusp.com, so --resolve to the origin IP times out too.',
    '  If you meant to check LOCAL behaviour, say so and target localhost',
    '  explicitly — then the evidence reads "localhost", which is honest.',
    '',
  ].join('\n');

/** Pull candidate URLs out of a raw string (a verdict args blob, etc.). */
function urlsIn(text) {
  return String(text).match(/https?:\/\/[^\s"'<>\\)]+/gi) ?? [];
}

/** Block if any URL in `text` names a remote host that resolves to loopback. */
function checkLoopbackDeception(text) {
  for (const url of urlsIn(text)) {
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isExplicitlyLocal(host)) continue;
    const addrs = loopbackAddrs(host);
    if (!addrs) continue;
    const port =
      u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
    // A PROVEN bypass forward reaches the real origin, so the premise behind
    // loopbackMsg does not hold and blocking here would be the wrong call.
    if (isTunnelForward(addrs, port)) continue;
    block(loopbackMsg(host, url));
  }
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow(); // can't parse the hook payload → never block legitimate work
}

const tool = String(payload.tool_name || '');
const input = payload.tool_input || {};

// A localhost/loopback URL on an operator dev port. EI-13177: 3170 (staging
// operator) added — same desktop-internal content source as 3070, just the
// staging checkout; it was silently missing from this list.
const URL_PORTS = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?:3055|3070|3170)\b/i;

// 1) Browser-navigation MCP tools → block when the target is an operator port.
if (/^mcp__/.test(tool) && /(browser_navigate|navigate|tabs_create_mcp)/i.test(tool)) {
  const url = String(input.url || input.URL || input.uri || '');
  if (URL_PORTS.test(url)) block();
  checkLoopbackDeception(url);
  allow();
}

// 2) verdict skill (the mandated browser tool) pointed at the operator ports.
//    Scoped to skill === 'verdict' so it can't false-positive on unrelated work.
//    NOTE: Bash is deliberately NOT matched — text-scanning bash commands blocks
//    anything that merely MENTIONS the ports (commit messages, greps, editing
//    these docs). The loud CLAUDE.md directive covers the rare `chromium :3055`
//    bash case; this hook only blocks the unambiguous browser-navigation vectors.
if (tool === 'Skill') {
  const skill = String(input.skill || input.name || '');
  if (/verdict/i.test(skill)) {
    const args = JSON.stringify(input.args ?? input.arguments ?? input ?? '');
    if (URL_PORTS.test(args)) block();
    checkLoopbackDeception(args);
  }
  allow();
}

allow();
