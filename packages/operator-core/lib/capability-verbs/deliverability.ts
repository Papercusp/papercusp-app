/**
 * Deliverability preflight — refuse a send the receiving server has ALREADY
 * told us will fail.
 *
 * ── Why this exists at all ──
 *
 * We send through the Gmail API, which returns `{ threadId, messageId }`. That
 * is a receipt for "Gmail accepted this for relay" — NOT for delivery. When the
 * recipient's server rejects the mailbox, the bounce arrives minutes later as a
 * separate INBOUND email. So `mail:send` has no error path on which a dead
 * mailbox could ever surface: the call succeeds, the caller reports success,
 * and the failure is discovered only by someone later reading the mailbox.
 *
 * Measured on a real run (2026-09-17, 125 outbound job applications): 5 bounced,
 * every one of them `550 5.1.1 user unknown` — the receiving server naming the
 * mailbox nonexistent. That is knowable before the send, deterministically, by
 * asking the same server the same question SMTP will ask it anyway.
 *
 * This is the same rule `readMailAttachments` already applies one precondition
 * over: a failure we can establish while the message is still un-sent must not
 * be discovered after it is gone.
 *
 * ── The design risk, and the rule that contains it ──
 *
 * An SMTP probe returns four kinds of answer and only TWO of them are evidence
 * about the mailbox:
 *
 *   - the server issued a 5xx on RCPT TO      → it named the mailbox dead. BLOCK.
 *   - the domain publishes no MX and no A     → nothing can receive mail. BLOCK.
 *   - 4xx / timeout / connection refused      → says nothing about the mailbox.
 *                                               Google and many hosts refuse
 *                                               probe connections outright, and
 *                                               a greylisted IP 4xx's everything.
 *                                               ALLOW.
 *   - catch-all (a decoy address also accepted) → acceptance is meaningless at
 *                                               this domain. ALLOW, and say so.
 *
 * Blocking on the third case would silently discard good mail every time our IP
 * is greylisted. The asymmetry is the whole point: a false positive costs a
 * message that is never sent and never missed; a false negative costs one bounce
 * notification. So we block ONLY on an affirmative statement by the server, and
 * treat every ambiguous answer as permission to proceed.
 *
 * ── What this is not ──
 *
 * It is evidence, not a warranty. A mailbox can be deleted between the probe and
 * the send, and a catch-all domain can accept at RCPT time and bounce afterwards
 * — which is exactly what the fifth un-caught bounce did. This reduces bounces;
 * it cannot promise zero.
 */

import * as dns from 'node:dns/promises';
import net from 'node:net';

/** Bound on the whole SMTP dialogue for one host, in ms. */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const SMTP_PORT = 25;

/**
 * How we identify ourselves in the probe. A receiving server may reject a HELO
 * that does not resolve, so this should be a real hostname under our control.
 * The probe never sends DATA, so its default MAIL FROM uses SMTP's null reverse
 * path: there is no message to bounce, and we do not claim a sender domain the
 * receiving server may reject before it evaluates RCPT TO.
 */
export interface ProbeIdentity {
  helo: string;
  mailFrom: string;
}

const DEFAULT_IDENTITY: ProbeIdentity = {
  helo: 'papercusp.local',
  mailFrom: '',
};

export type MailboxVerdict =
  /** RCPT accepted and the domain is not a catch-all — as good as this gets. */
  | { status: 'deliverable' }
  /**
   * RCPT accepted, but a decoy address that cannot exist was accepted too, so
   * acceptance carries no information at this domain. Not a block.
   */
  | { status: 'catch-all' }
  /** The server, or DNS, affirmatively established that this cannot be delivered. */
  | {
      status: 'undeliverable';
      reason: 'no-mail-exchanger' | 'mailbox-rejected';
      /** The server's own words, or the DNS failure — quoted back to the caller. */
      detail: string;
    }
  /** We learned nothing. Never a block. */
  | {
      status: 'unknown';
      reason: 'probe-refused' | 'timeout' | 'transient' | 'probe-error';
      detail: string;
    };

/** Injectable so callers (and tests) can supply their own probe. */
export type MailboxProbe = (address: string) => Promise<MailboxVerdict>;

/**
 * A probe that establishes nothing, for a test whose subject is not
 * deliverability.
 *
 * It answers `unknown` rather than `deliverable` on purpose: a test that is
 * really about drafting, threading or attachments should assert nothing about
 * the mailbox, and `unknown` is the branch that must never block — so injecting
 * this also exercises the rail's central guarantee for free.
 */
export const allowAllMailboxProbe: MailboxProbe = async () => ({
  status: 'unknown',
  reason: 'probe-refused',
  detail: 'deliverability not exercised by this test (allowAllMailboxProbe)',
});

/**
 * Select the probe to use when the caller injected none.
 *
 * ── Why this refuses under test ──
 *
 * The live probe does DNS and opens an outbound SMTP connection. Any caller
 * that forgets to inject one silently acquires that dependency, and in a test
 * suite the failure is NOT reliably loud: a fixture addressed at a reserved TLD
 * (`company.example`) fails immediately and visibly, but one addressed at a
 * real-looking domain resolves, connects, and returns `unknown` after the 8s
 * timeout — so the test PASSES while making a real network call and costing
 * eight seconds. The loud case is luck, not a guarantee.
 *
 * So the omission is converted into an error that names its own fix, at probe
 * SELECTION time — deliberately outside the per-address try/catch below, which
 * swallows a throwing probe into `unknown` (correct for production, and exactly
 * what would hide this).
 */
function selectDefaultProbe(): MailboxProbe {
  const underTest = process.env.VITEST || process.env.NODE_ENV === 'test';
  if (underTest && process.env.PAPERCUSP_ALLOW_LIVE_MAILBOX_PROBE !== '1') {
    throw new Error(
      'deliverability_probe_not_injected: the deliverability rail fell through to the LIVE SMTP ' +
        'probe inside a test, which would do real DNS and open an outbound connection to the ' +
        "recipient's mail server. Inject one: pass `probe: allowAllMailboxProbe` here, or " +
        '`probeMailbox: allowAllMailboxProbe` in a mail verb\'s deps, when deliverability is not ' +
        'this test\'s subject; inject a stub returning the verdict you mean when it is. ' +
        'Set PAPERCUSP_ALLOW_LIVE_MAILBOX_PROBE=1 for a test that probes the network on purpose.',
    );
  }
  return (address: string) => probeMailbox(address);
}

export class UndeliverableAddressee extends Error {
  readonly address: string;
  readonly reason: 'no-mail-exchanger' | 'mailbox-rejected';
  readonly detail: string;
  readonly code = 'mail_send_undeliverable_recipient';
  constructor(address: string, reason: 'no-mail-exchanger' | 'mailbox-rejected', detail: string) {
    super(
      `mail_send_undeliverable_recipient: ${address} — ${detail}. ` +
        `This was established before sending, by the receiving server itself; sending would bounce. ` +
        `Correct the address, or pass allowUndeliverable: true to send anyway.`,
    );
    this.name = 'UndeliverableAddressee';
    this.address = address;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Classify an SMTP reply code for RCPT TO.
 *
 * PURE — this is the whole block/allow decision for the SMTP leg, kept free of
 * I/O so every branch is exhaustively testable without a network.
 */
export function classifyRcptReply(code: number, text: string): MailboxVerdict {
  const detail = `${code} ${text}`.trim();
  if (code >= 200 && code < 300) return { status: 'deliverable' };
  // 5xx on RCPT is the server naming this mailbox. The one case we act on.
  if (code >= 500 && code < 600) {
    return { status: 'undeliverable', reason: 'mailbox-rejected', detail };
  }
  // 4xx is "not now" — greylisting, rate limiting, policy. Says nothing about
  // whether the mailbox exists.
  if (code >= 400 && code < 500) {
    return { status: 'unknown', reason: 'transient', detail };
  }
  return { status: 'unknown', reason: 'probe-error', detail };
}

/**
 * Decide the fate of one already-probed address.
 *
 * PURE. Separated from the probe so the rule "only a server-stated failure
 * blocks" is a property of a function, not of a network call's accidents.
 */
export function verdictBlocks(verdict: MailboxVerdict): verdict is Extract<
  MailboxVerdict,
  { status: 'undeliverable' }
> {
  return verdict.status === 'undeliverable';
}

/** Read one complete SMTP reply, honouring multi-line continuations. */
function readReply(socket: net.Socket, timeoutMs: number): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('smtp_timeout'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // A reply ends on a line shaped `NNN <text>`; `NNN-<text>` continues it.
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3}(?: |$)/.test(last)) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      const text = lines.map((line) => line.slice(4)).join(' ').trim();
      resolve({ code, text });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('smtp_closed'));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Resolve the mail exchangers for a domain, honouring RFC 5321's implicit-MX
 * rule: a domain with no MX but with an address record accepts mail at that
 * address. Only when BOTH are absent can nothing receive mail.
 */
export async function resolveMailExchangers(domain: string): Promise<string[]> {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) {
      return mx.sort((a, b) => a.priority - b.priority).map((record) => record.exchange);
    }
  } catch {
    // fall through to the implicit-MX check
  }
  for (const lookup of [dns.resolve4, dns.resolve6]) {
    try {
      const records = await lookup(domain);
      if (records.length) return [domain];
    } catch {
      // try the next family
    }
  }
  return [];
}

/**
 * The live probe. Network I/O only — every decision it reaches comes from the
 * pure helpers above.
 */
export async function probeMailbox(
  address: string,
  opts: { identity?: ProbeIdentity; timeoutMs?: number } = {},
): Promise<MailboxVerdict> {
  const identity = opts.identity ?? DEFAULT_IDENTITY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const domain = address.split('@')[1]?.trim().toLowerCase();
  if (!domain) {
    return { status: 'undeliverable', reason: 'mailbox-rejected', detail: 'address has no domain' };
  }

  const exchangers = await resolveMailExchangers(domain);
  if (!exchangers.length) {
    return {
      status: 'undeliverable',
      reason: 'no-mail-exchanger',
      detail: `${domain} publishes no MX and no address record, so no host can receive mail for it`,
    };
  }

  const host = exchangers[0]!;
  const socket = net.createConnection({ host, port: SMTP_PORT });
  socket.setTimeout(timeoutMs);
  const say = async (line: string) => {
    socket.write(`${line}\r\n`);
    return readReply(socket, timeoutMs);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('connect_timeout')));
    });

    const greeting = await readReply(socket, timeoutMs);
    if (greeting.code !== 220) {
      return { status: 'unknown', reason: 'probe-refused', detail: `${greeting.code} ${greeting.text}` };
    }

    const ehlo = await say(`EHLO ${identity.helo}`);
    if (ehlo.code >= 400) {
      return { status: 'unknown', reason: 'probe-refused', detail: `EHLO ${ehlo.code} ${ehlo.text}` };
    }

    const from = await say(`MAIL FROM:<${identity.mailFrom}>`);
    if (from.code >= 400) {
      return { status: 'unknown', reason: 'probe-refused', detail: `MAIL FROM ${from.code} ${from.text}` };
    }

    const rcpt = await say(`RCPT TO:<${address}>`);
    const verdict = classifyRcptReply(rcpt.code, rcpt.text);
    if (verdict.status !== 'deliverable') return verdict;

    // Accepted — but is acceptance meaningful here? Ask for an address that
    // cannot exist. If that is accepted too, the domain accepts everything and
    // this acceptance told us nothing.
    const decoy = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}@${domain}`;
    const decoyReply = await say(`RCPT TO:<${decoy}>`);
    if (decoyReply.code >= 200 && decoyReply.code < 300) return { status: 'catch-all' };
    return { status: 'deliverable' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = /timeout/i.test(message) ? 'timeout' : 'probe-refused';
    return { status: 'unknown', reason, detail: message };
  } finally {
    try {
      socket.write('QUIT\r\n');
    } catch {
      // best effort
    }
    socket.destroy();
  }
}

export interface DeliverabilityReport {
  address: string;
  verdict: MailboxVerdict;
}

/**
 * Rail 3 for a recipient list: refuse the send if the receiving server has
 * already established that any recipient cannot be delivered to.
 *
 * MUST run AFTER the trust rail (`assertTrustedAddressees`). The probe opens an
 * outbound connection to a host the recipient's domain controls, so probing an
 * unvalidated address would turn an addressee injected by a hostile inbound
 * message into a beacon confirming we process injections. Trust first, then
 * deliverability.
 */
export async function assertDeliverableAddressees(
  addresses: readonly string[],
  opts: {
    probe?: MailboxProbe;
    /** Send even to a recipient the server named dead. */
    allowUndeliverable?: boolean;
  } = {},
): Promise<DeliverabilityReport[]> {
  const probe = opts.probe ?? selectDefaultProbe();
  const reports: DeliverabilityReport[] = [];
  for (const address of addresses) {
    let verdict: MailboxVerdict;
    try {
      verdict = await probe(address);
    } catch (err) {
      // A probe that throws has told us nothing. It must never block a send —
      // the failure of our own instrument is not evidence about the mailbox.
      verdict = {
        status: 'unknown',
        reason: 'probe-error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    reports.push({ address, verdict });
    if (verdictBlocks(verdict) && !opts.allowUndeliverable) {
      throw new UndeliverableAddressee(address, verdict.reason, verdict.detail);
    }
  }
  return reports;
}
