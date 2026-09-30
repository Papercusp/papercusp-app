#!/usr/bin/env node
/**
 * repair-codex-home-configs.mjs — WI-38706 one-time remediation.
 *
 * The session archiver was unlinking each per-session CODEX_HOME's shared
 * `config.toml` (it collected the home's directory-level state under whichever
 * thread ended first). Codex then re-created an 87-byte trust-only stub on the
 * next launch, so every `codex resume` in that home failed:
 *
 *   thread/resume failed: failed to load configuration:
 *   Model provider `papercusp-codex-gateway` not found (code -32600)
 *
 * The code fix (session-archive.ts + psu-launcher.mjs + /adv/sessions/ensure-codex-home)
 * stops it recurring and self-heals on the next resume; this restores the homes
 * that were already broken BEFORE that fix is deployed.
 *
 * A home is repaired only when its rollouts reference a provider its config does
 * not define, and only two ways:
 *   • RESTORE  — the pre-damage config recovered from the PG session archive
 *                (identical bytes, so the original account pin and the original
 *                `client=<sid>` survive). Preferred whenever available.
 *   • REBUILD  — for homes whose archived copy had already been overwritten by
 *                the 87-byte stub: a sibling's config as the template with THIS
 *                home's own identity substituted from its `.owner-sid`. The
 *                account pin is dropped (unpinned = the gateway auto-selects),
 *                which is what ensure-codex-home would write anyway.
 *
 * Idempotent, and refuses to touch a home that is already healthy.
 * Usage:  node scripts/repair-codex-home-configs.mjs [--write]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Reused, not re-implemented, on purpose: the repair and the launcher MUST agree
// on what "the gateway block" is, or a repair can write a config the launcher
// then strips (or vice versa). This is the launcher's own definition.
import { stripCodexGatewayConfig } from '../apps/operator/scripts/psu-launcher.mjs';

const HOMES = join(homedir(), '.papercusp', 'su-codex-homes');
const RESCUE = join(homedir(), '.papercusp', 'codex-config-rescue-2026-08-14');
const PROVIDER = 'papercusp-codex-gateway';
const WRITE = process.argv.includes('--write');
/** Print a redacted structural digest per home instead of just the one-liner.
 *  Never prints the config body — it carries the signed MCP url. */
const INSPECT = process.argv.includes('--inspect');

/** The provider a rollout is bound to (`session_meta.model_provider`). */
function rolloutProvider(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4096);
    const line = head.slice(0, head.indexOf('\n') === -1 ? head.length : head.indexOf('\n'));
    return JSON.parse(line)?.payload?.model_provider ?? null;
  } catch { return null; }
}

function rollouts(home) {
  const out = [];
  const root = join(home, 'sessions');
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Biggest rescued copy for this home (the archive keyed several session ids). */
function rescuedFor(dirName) {
  let best = null;
  for (const f of readdirSync(RESCUE)) {
    if (!f.startsWith(`${dirName}__`)) continue;
    const p = join(RESCUE, f);
    const size = statSync(p).size;
    if (!best || size > best.size) best = { path: p, size };
  }
  return best;
}

/** A full sibling config to use as a REBUILD template: has the MCP block and the
 *  provider table, so only the identity needs substituting. */
function templateConfig() {
  let best = null;
  for (const f of readdirSync(RESCUE)) {
    const p = join(RESCUE, f);
    const text = readFileSync(p, 'utf8');
    if (!text.includes('[mcp_servers.papercusp-su]')) continue;
    if (!text.includes(`[model_providers.${PROVIDER}]`)) continue;
    const size = statSync(p).size;
    if (!best || size > best.size) best = { path: p, text, size };
  }
  return best;
}

function rebuildFrom(templateText, sid) {
  return templateText
    // This home's own coordination identity — the ONLY per-session token in the file.
    .replace(/client=su-[0-9a-f-]+/g, `client=${sid}`)
    // Drop the template's account pin: it names a DIFFERENT session's account.
    // Header omitted (never emitted empty) ⇒ the gateway auto-selects, which is
    // exactly what ensure-codex-home writes for an unpinned repair.
    .replace(/^http_headers = \{ "x-papercusp-account".*\n/m, '');
}

const template = templateConfig();
const report = [];
for (const dirName of readdirSync(HOMES).sort()) {
  if (!dirName.startsWith('session-')) continue;
  const home = join(HOMES, dirName);
  if (!statSync(home).isDirectory()) continue;

  const rolloutFiles = rollouts(home);
  // A home with no rollouts has nothing to resume, and may be one bootstrap-su is
  // mid-way through materializing — never touch it.
  if (!rolloutFiles.length) continue;
  const providers = new Set(rolloutFiles.map(rolloutProvider).filter(Boolean));
  const gatewayBound = providers.has(PROVIDER);

  const cfgPath = join(home, 'config.toml');
  const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;

  // WI-38706 — the criterion is LAUNCH-READINESS, not gateway-boundness.
  //
  // This used to be `if (!providers.has(PROVIDER)) continue;` — "nothing here
  // needs the gateway table". That is true of the -32600 provider error, and it
  // is why this script reported "0 broken" while 16 homes (1,342 rollouts, all
  // active within 24h) were still damaged: their threads are bound to plain
  // `openai`, so they never resolve the missing provider and never fail LOUDLY.
  // They just come up with no `[mcp_servers.papercusp-su]` — no coord, no locks,
  // no work-items — and nothing reports it. The archiver deleted config.toml
  // regardless of which provider a thread used, so the damaged population was
  // always wider than the noisy one.
  //
  // So: the MCP block is required of EVERY home, and the gateway table is
  // required only of homes whose threads actually reference it.
  const hasMcp = Boolean(cfg?.includes('[mcp_servers.papercusp-su]'));
  const hasGateway = Boolean(cfg?.includes(`[model_providers.${PROVIDER}]`));
  if (hasMcp && (!gatewayBound || hasGateway)) continue; // healthy

  const rescued = rescuedFor(dirName);
  const usable = rescued && readFileSync(rescued.path, 'utf8').includes('[mcp_servers.papercusp-su]')
    ? readFileSync(rescued.path, 'utf8')
    : null;

  let action, text;
  if (usable) {
    action = 'RESTORE';
    text = usable;
  } else {
    const sid = existsSync(join(home, '.owner-sid')) ? readFileSync(join(home, '.owner-sid'), 'utf8').trim() : null;
    if (!sid || !template) { report.push({ dirName, action: 'SKIP (no rescue, no .owner-sid)' }); continue; }
    action = 'REBUILD';
    text = rebuildFrom(template.text, sid);
  }

  // ── Applied to RESTORE *and* REBUILD alike ──────────────────────────────────
  // Originally these guards sat only on the REBUILD branch, on the assumption
  // that a restored archive copy is by definition correct for its own home.
  // `--inspect` falsified that: session-15405's archived config carries the
  // gateway blocks while all 65 of its rollouts are bound to `openai`, so a
  // verbatim RESTORE would have set that home's default provider to the gateway.
  // The invariant belongs to the WRITE, not to one branch of it.

  // Never introduce gateway routing into a home whose threads never used it — a
  // repair that silently changes where resumed inference goes is not a repair.
  // (Dropping it is safe in the other direction too: if a later launch pins the
  // gateway, psu's applyCodexGatewayRoute writes the blocks back. keepExisting-
  // WhenUnrouted only PRESERVES an existing binding, it never invents one.)
  if (!gatewayBound) text = stripCodexGatewayConfig(text);

  // Keep this home's OWN model selection rather than inheriting the template
  // home's. codex writes these into the stub it re-creates, so they are the
  // best surviving record of what the session was actually running.
  for (const key of ['model', 'model_reasoning_effort']) {
    const own = cfg?.match(new RegExp(`^${key} = .*$`, 'm'))?.[0];
    if (!own) continue;
    text = new RegExp(`^${key} = .*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key} = .*$`, 'm'), own)
      : `${own}\n${text}`;
  }

  // Refuse to write a config that is not launch-ready — the whole point of the
  // repair. A template that silently lost its MCP block would otherwise be
  // written into all 16 homes at once.
  if (!text.includes('[mcp_servers.papercusp-su]')) {
    report.push({ dirName, action: 'ABORT (result lacks the papercusp-su MCP block)' });
    continue;
  }
  if (WRITE) writeFileSync(cfgPath, text, { mode: 0o600 });
  report.push({
    dirName,
    action,
    bytes: text.length,
    was: cfg === null ? 'missing' : `${cfg.length}B stub`,
    // Structural digest of what WOULD be / WAS written. Deliberately never the
    // config body: it carries the signed MCP url. This is what --inspect prints,
    // and it is the only pre-write evidence that the result is correct.
    digest: {
      gatewayBound,
      mcp: text.includes('[mcp_servers.papercusp-su]'),
      gwRoot: text.includes('PAPERCUSP_CODEX_GATEWAY_ROOT'),
      gwProvider: text.includes(`[model_providers.${PROVIDER}]`),
      model: text.match(/^model = .*$/m)?.[0]?.slice(8) ?? '(none)',
      effort: text.match(/^model_reasoning_effort = .*$/m)?.[0]?.slice(25) ?? '(none)',
      identityOk:
        !existsSync(join(home, '.owner-sid')) ||
        text.includes(readFileSync(join(home, '.owner-sid'), 'utf8').trim()),
    },
  });
}

for (const r of report) {
  console.log(`${r.action.padEnd(8)} ${r.dirName}  ${r.was ?? ''} -> ${r.bytes ?? '-'}B`);
  if (!INSPECT || !r.digest) continue;
  const d = r.digest;
  console.log(
    `         route=${d.gatewayBound ? 'GATEWAY' : 'openai'}` +
      ` mcp=${d.mcp ? 'YES' : 'NO ⚠'}` +
      ` gwRoot=${d.gwRoot} gwProvider=${d.gwProvider}` +
      `${!d.gatewayBound && (d.gwRoot || d.gwProvider) ? ' ⚠ WOULD RE-ROUTE AN openai THREAD' : ''}` +
      ` model=${d.model} effort=${d.effort}` +
      ` identity=${d.identityOk ? 'ok' : 'MISMATCH ⚠'}`,
  );
}
console.log(`\n${WRITE ? 'WROTE' : 'DRY RUN'}: ${report.length} home(s). Template: ${template ? template.path.split('/').pop() : 'none'}`);
