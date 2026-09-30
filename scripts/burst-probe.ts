/**
 * scripts/burst-probe.ts — WI-650 / BRIEF G2: find the TRUE bare-burst trigger.
 *
 * An OPERATIONAL RUNNER (not a committed test — never globbed by CI; it makes REAL upstream calls on
 * a REAL Max account). It answers the question the fleet's bare-burst 429 storm raised: the gateway
 * 429s at only ~3.5 upstream-calls/min/account with util headers ABSENT, far under the 45/min floor —
 * so the binding limit is NOT per-minute request count. Is it per-SECOND rate? a CONCURRENCY cap? a
 * per-IP/edge (CDN) throttle? And is the 429 from Anthropic's app layer or a Cloudflare edge?
 *
 * HOW IT ISOLATES THE LIMIT (why direct-to-upstream, not through the gateway):
 *   The gateway runs its OWN governor — per-account RPM smoothing + a maxConcurrent≈3 admission cap —
 *   so hammering :8788 measures the GATEWAY'S shaping, not the upstream wall. This probe replicates the
 *   gateway's EXACT upstream request (same Bearer, anthropic-version, oauth-2025-04-20 beta, the
 *   account's dedicated egress PROXY → same source IP) and fires it DIRECT at api.anthropic.com,
 *   bypassing the governor, so the 429 it sees IS the raw upstream limit.
 *
 * CRITICAL — the request frames itself as Claude Code (first `system` block = the CC identity). The
 * gateway's own code warns: on a Max OAuth token a request whose first system block is NOT the Claude
 * Code identifier is shunted to a far stricter bucket and 429s. Probing without it would measure the
 * WRONG (stricter) limit, not the one the fleet hits.
 *
 * SAFETY: refuses to fire unless PAPERCUSP_BURST_PROBE=1 (or --yes). Defaults to a healthy account,
 * a cheap model, max_tokens:1, and small per-cell counts. --dry-run resolves the account + prints the
 * request it WOULD send, sending nothing. A burst can briefly trip the account's transient throttle
 * (short, x-should-retry:true) — that's the signal we're measuring; pick a budget-healthy account.
 *
 * USAGE (from repo root):
 *   tsx scripts/burst-probe.ts --dry-run                       # resolve + print, send nothing
 *   PAPERCUSP_BURST_PROBE=1 tsx scripts/burst-probe.ts --one   # one real request (shape check)
 *   PAPERCUSP_BURST_PROBE=1 tsx scripts/burst-probe.ts         # the full rate×concurrency sweep
 *
 * FLAGS:
 *   --account <id>     pool account to pin to            (default ownerhandle7)
 *   --model <id>       model to probe                    (default claude-haiku-4-5-20251001; --opus → claude-opus-4)
 *   --rates a,b,c      requests/sec axis                 (default 1,2,5,10)
 *   --conc  a,b,c      max-in-flight axis                (default 1,2,4,8,16)
 *   --per-cell N       requests per (rate,conc) cell     (default 12)
 *   --cred <ref>       override credentialRef (token:/path | file:/path)
 *   --proxy <url>      override egress proxy URL (http://host:port); --no-proxy to force default egress
 *   --dry-run          resolve + print the request, send nothing
 *   --one              send exactly one request then exit (shape check)
 *   --yes              bypass the PAPERCUSP_BURST_PROBE=1 guard
 */
import { resolveAccountPool } from '../packages/operator-core/lib/inference-gateway/account-resolver';
import { makeCredentialResolver, makeBearerCredentialResolver, withOAuthBeta } from '../packages/operator-core/lib/inference-gateway/credential-store';

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const UPSTREAM = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

// Headers that reveal WHO threw the 429 (Anthropic app layer vs a Cloudflare/CDN edge) + the limit shape.
const CAPTURE_HEADERS = [
  'server', 'cf-ray', 'cf-cache-status', 'via', 'x-should-retry', 'retry-after',
  'request-id', 'x-request-id', 'anthropic-organization-id',
  'anthropic-ratelimit-unified-5h-utilization', 'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-utilization', 'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-utilization', 'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-status',
  'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-input-tokens-limit', 'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-output-tokens-limit', 'anthropic-ratelimit-output-tokens-remaining',
];

interface Args {
  account: string; model: string; rates: number[]; conc: number[]; perCell: number;
  cred?: string; proxy?: string; noProxy: boolean; dryRun: boolean; one: boolean; yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    account: 'ownerhandle7', model: 'claude-haiku-4-5-20251001',
    rates: [1, 2, 5, 10], conc: [1, 2, 4, 8, 16], perCell: 12,
    noProxy: false, dryRun: false, one: false, yes: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--account') a.account = next();
    else if (k === '--model') a.model = next();
    else if (k === '--opus') a.model = 'claude-opus-4';
    else if (k === '--rates') a.rates = next().split(',').map(Number).filter((n) => n > 0);
    else if (k === '--conc') a.conc = next().split(',').map(Number).filter((n) => n > 0);
    else if (k === '--per-cell') a.perCell = Math.max(1, Number(next()));
    else if (k === '--cred') a.cred = next();
    else if (k === '--proxy') a.proxy = next();
    else if (k === '--no-proxy') a.noProxy = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--one') a.one = true;
    else if (k === '--yes') a.yes = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pickHeaders(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of CAPTURE_HEADERS) { const v = h.get(k); if (v !== null) o[k] = v; }
  // Also sweep up ANY anthropic-ratelimit-* / cf-* we didn't enumerate, so nothing is missed.
  h.forEach((v, k) => { const lk = k.toLowerCase(); if ((lk.startsWith('anthropic-ratelimit') || lk.startsWith('cf-')) && !(lk in o)) o[lk] = v; });
  return o;
}

interface Outcome { status: number; ms: number; headers?: Record<string, string>; bodyHead?: string; err?: string }

async function main() {
  const args = parseArgs(process.argv);

  // Resolve credentialRef + egress for the pinned account (live pool), unless overridden.
  let credRef = args.cred;
  let proxyUrl = args.noProxy ? undefined : args.proxy;
  let source = 'flags';
  if (!credRef || (proxyUrl === undefined && !args.noProxy)) {
    try {
      const pool = await resolveAccountPool();
      const acct = pool.find((p) => p.accountId === args.account);
      if (!acct) {
        const ids = pool.map((p) => p.accountId).join(', ');
        throw new Error(`account '${args.account}' not in pool. Available: ${ids}`);
      }
      credRef ??= acct.credentialRef;
      if (proxyUrl === undefined && !args.noProxy) proxyUrl = acct.egress?.proxyUrl;
      source = `pool(${acct.source})`;
    } catch (e) {
      if (!credRef) throw new Error(`could not resolve account from pool (${(e as Error).message}); pass --cred and --proxy explicitly`);
    }
  }

  // Resolve the bearer the same way the gateway does (token: setup-token, or file: refreshing bundle).
  const resolver = credRef!.startsWith('token:') || credRef!.startsWith('file:')
    ? makeCredentialResolver(credRef!, args.account)
    : makeBearerCredentialResolver(credRef!);
  const token = await resolver.current();

  // Per-account egress: route through the account's dedicated proxy → SAME source IP the gateway uses,
  // so a per-IP/edge throttle is measured against the real IP (undici ProxyAgent = HTTP-CONNECT only).
  let dispatcher: unknown;
  if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
    const { ProxyAgent } = await import('undici');
    dispatcher = new ProxyAgent(proxyUrl);
  }

  const body = JSON.stringify({
    model: args.model,
    max_tokens: 1,
    system: [{ type: 'text', text: CLAUDE_CODE_IDENTITY }],
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': withOAuthBeta(undefined),
    'content-type': 'application/json',
    'accept-encoding': 'identity',
  };

  const banner = (msg: string) => console.log(`\n\x1b[1m${msg}\x1b[0m`);
  banner('burst-probe — WI-650 G2 (find the TRUE bare-burst trigger)');
  console.log(`  account   : ${args.account}  (cred ${source}, kind ${resolver.kind})`);
  console.log(`  egress    : ${dispatcher ? proxyUrl : 'DEFAULT (box IP — NOT the per-account proxy)'}`);
  console.log(`  model     : ${args.model}`);
  console.log(`  upstream  : ${UPSTREAM}/v1/messages  (max_tokens:1, system=Claude-Code-identity)`);
  console.log(`  token     : ${token.slice(0, 10)}…${token.slice(-4)} (${token.length} chars)`);

  const fire = async (): Promise<Outcome> => {
    const t0 = Date.now();
    try {
      const res = await fetch(`${UPSTREAM}/v1/messages`, { method: 'POST', headers, body, ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
      const ms = Date.now() - t0;
      if (res.status === 200) { try { await res.body?.cancel(); } catch { /* drain */ } return { status: 200, ms }; }
      const text = (await res.text().catch(() => '')).slice(0, 240);
      return { status: res.status, ms, headers: pickHeaders(res.headers), bodyHead: text };
    } catch (e) {
      return { status: 0, ms: Date.now() - t0, err: (e as Error).message };
    }
  };

  if (args.dryRun) {
    banner('DRY RUN — request that WOULD be sent (no network call):');
    console.log(JSON.stringify({ url: `${UPSTREAM}/v1/messages`, method: 'POST', headers: { ...headers, authorization: 'Bearer <redacted>' }, dispatcher: dispatcher ? proxyUrl : null, body: JSON.parse(body) }, null, 2));
    return;
  }
  if (!args.yes && process.env.PAPERCUSP_BURST_PROBE !== '1') {
    console.error('\n\x1b[31mREFUSING to send real upstream calls.\x1b[0m Set PAPERCUSP_BURST_PROBE=1 (or pass --yes) to confirm. Use --dry-run to preview.');
    process.exit(2);
  }

  if (args.one) {
    banner('Single request (shape check):');
    const o = await fire();
    console.log(`  → status ${o.status}  ${o.ms}ms${o.err ? `  ERR ${o.err}` : ''}`);
    if (o.headers) console.log('  headers:', JSON.stringify(o.headers, null, 2));
    if (o.bodyHead) console.log('  body  :', o.bodyHead);
    return;
  }

  // The grid sweep. For each (rate, conc) cell: release perCell requests at `rate`/sec, capping
  // in-flight at `conc`; record the first non-200 + tallies. A cell that already 429s tells us the
  // wall is at/below that (rate, conc).
  banner(`SWEEP — rates {${args.rates.join(',')}}/s × conc {${args.conc.join(',')}}, ${args.perCell} req/cell`);
  const captured: Array<{ cell: string; status: number; headers: Record<string, string>; bodyHead?: string }> = [];
  const rows: string[] = [];
  for (const rate of args.rates) {
    for (const conc of args.conc) {
      const cell = `rate=${rate}/s conc=${conc}`;
      const intervalMs = 1000 / rate;
      const results: Outcome[] = [];
      let inFlight = 0;
      const pending: Promise<void>[] = [];
      const startedAt = Date.now();
      for (let n = 0; n < args.perCell; n++) {
        while (inFlight >= conc) await sleep(2);
        inFlight++;
        pending.push(fire().then((o) => { results.push(o); inFlight--; }));
        const due = startedAt + (n + 1) * intervalMs;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
      await Promise.all(pending);
      const by = (s: number) => results.filter((r) => r.status === s).length;
      const ok = by(200), c429 = by(429), c529 = by(529), errs = results.filter((r) => r.status === 0).length;
      const other = results.length - ok - c429 - c529 - errs;
      const lat = results.map((r) => r.ms).sort((x, y) => x - y);
      const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
      const first429 = results.find((r) => r.status === 429 && r.headers);
      // Classify the 429 shape from headers (mirrors the gateway's bare429 logic).
      let shape = '';
      if (first429?.headers) {
        const h = first429.headers;
        const hasWindow = h['retry-after'] !== undefined || h['anthropic-ratelimit-unified-5h-reset'] !== undefined || h['anthropic-ratelimit-requests-reset'] !== undefined;
        const sr = (h['x-should-retry'] ?? '').toLowerCase() === 'true';
        const cdn = (h['server'] ?? '').toLowerCase().includes('cloudflare') || h['cf-ray'] !== undefined;
        shape = `${hasWindow ? 'window' : 'BARE'}${sr ? '/retry' : ''}${cdn ? '/CDN-edge' : '/anthropic'}`;
        captured.push({ cell, status: 429, headers: h, bodyHead: first429.bodyHead });
      }
      const row = `  ${cell.padEnd(22)} ok=${ok} 429=${c429} 529=${c529} other=${other} err=${errs}  p50=${p50}ms  ${c429 ? `[first-429: ${shape}]` : ''}`;
      console.log(row);
      rows.push(row.trim());
      await sleep(500); // brief gap between cells so a tripped transient throttle relaxes
    }
  }

  banner('CAPTURED 429 HEADERS (Anthropic app-layer vs Cloudflare edge?):');
  if (!captured.length) console.log('  (no 429 in any cell — the limit is ABOVE the swept grid; widen --rates/--conc)');
  for (const c of captured.slice(0, 6)) {
    console.log(`\n  --- ${c.cell} ---`);
    console.log('  ' + JSON.stringify(c.headers, null, 2).replace(/\n/g, '\n  '));
    if (c.bodyHead) console.log('  body:', c.bodyHead);
  }
  banner('VERDICT (fill into the plan + insight doc):');
  console.log('  the bare-burst limit is: <read the table — lowest (rate,conc) cell with 429=…>');
}

main().catch((e) => { console.error('\x1b[31mburst-probe failed:\x1b[0m', e); process.exit(1); });
