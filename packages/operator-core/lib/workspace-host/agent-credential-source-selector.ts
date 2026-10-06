/**
 * Resolve a SOURCE SELECTOR into agent-home bundle bytes, server-side (WI-10001686 item 1).
 *
 * WHY A SELECTOR AND NOT THE BYTES. `storeWorkspaceHostAgentCredentialMaterial` deliberately takes
 * `files` and reads nothing itself, which leaves every caller holding the same problem: a callable
 * surface cannot accept credential bytes as an argument, because tool invocations are persisted
 * (`tool_invocations.args_json`) and an endpoint body is logged. This module is the missing half:
 * the caller names WHICH source, and the bytes are read here, inside the operator, and handed
 * straight to the producer without ever crossing the request boundary.
 *
 * WHY THE SOURCE SET IS CLOSED. The obvious selector — a filesystem path — would turn this into an
 * arbitrary-file-read primitive wired directly to a credential store the caller can later read
 * back through the delivery pipeline. That is a privilege escalation with a credential-shaped exit,
 * not a convenience. So a source names a KIND, never a path, and the only local-file kind resolves
 * its path from `WORKSPACE_HOST_AGENT_HOME_FILES` — the same constant that decides where the file
 * lands on the host. There is no second copy of the layout to drift (derived-truth ladder), and no
 * expressible request for a file outside it.
 *
 * WHY THE SLOT PICKS THE PATH. `operator-home-file` takes no agent argument: the bundle slot being
 * filled selects the path. A selector that could put the codex home into the `claude` slot buys
 * nothing and makes a silent cross-wiring expressible — the claude slot would then carry a codex
 * token that is not projected (see below), and the JSON check would happily pass it.
 *
 * ⚠ WHAT A CALLER MUST KNOW. `encodeWorkspaceHostAgentHomeBundle` projects BOTH members: the codex
 * `refresh_token` (D-311) and, since WI-10001691, the claude `claudeAiOauth.refreshToken`, each
 * with the same shape-based walkers that also neutralize any api-key-shaped field (WI-10001688).
 * So `operator-home-file` on EITHER slot delivers a self-expiring access token that cannot mint
 * new ones, even though the file it reads contains live long-lived material.
 *
 * That bounds the DURATION and the MINTING — it does not make the choice free. `operator-home-file`
 * on the claude slot still puts a WORKING access token for this operator's own interactive account
 * on the host until it expires. The resolver reports that as a `notice` on the result rather than
 * refusing it, because it is a judgment about WHOSE credential a host should receive, not a
 * validity question — but no caller should learn it only by reading this comment.
 *
 * ⚠ This paragraph is a SECOND COPY of what the projection code knows (derived-truth ladder), and
 * it has already drifted once: it asserted "files.claude has NO equivalent projection" for the
 * whole window after WI-10001691 closed that gap, overstating the risk in the exact decision it
 * exists to inform. `claudeProjectionNoticeAccuracy` in the test file pins the notice against the
 * real encoder so the next such change fails a test instead of misinforming a caller.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  WORKSPACE_HOST_AGENT_HOME_FILES,
  type WorkspaceHostAgentHomeBundleFiles,
  type WorkspaceHostAgentHomeFile,
} from '@papercusp/deployment-driver';

import { readIntegrationKey } from '../integration-credentials';

/** Raised when a selector cannot be resolved. Never carries a byte of what it read. */
export class WorkspaceHostAgentCredentialSourceError extends Error {
  readonly slot: WorkspaceHostAgentHomeFile;

  constructor(slot: WorkspaceHostAgentHomeFile, message: string) {
    super(`agent credential source for '${slot}' ${message}`);
    this.name = 'WorkspaceHostAgentCredentialSourceError';
    this.slot = slot;
  }
}

/**
 * A credential file large enough to exceed this is not a credential file. The cap exists because a
 * mis-selected source is otherwise encoded, stored in a single Postgres row, and only discovered
 * when a host tries to bind it; failing at the read names the slot while the mistake is still free.
 */
export const WORKSPACE_HOST_AGENT_CREDENTIAL_SOURCE_MAX_BYTES = 256 * 1024;

export type WorkspaceHostAgentCredentialSource =
  /** Read the operator's own native agent home for THIS slot (path derived from the slot). */
  | { readonly kind: 'operator-home-file' }
  /** Read a named secret from `operator_integration_credentials` (setup:save_integration_key). */
  | { readonly kind: 'integration-key'; readonly name: string }
  /** Deliver no file. Valid ONLY for `omp`, which is credential-free by contract. */
  | { readonly kind: 'absent' };

export type WorkspaceHostAgentCredentialSourceSelector = Readonly<
  Record<WorkspaceHostAgentHomeFile, WorkspaceHostAgentCredentialSource>
>;

/**
 * Per-slot public receipt. Never carries content — only where the slot came from, its size, and
 * when the access material it delivers stops working.
 */
export interface ResolvedWorkspaceHostAgentCredentialSlot {
  readonly source: string;
  readonly bytes: number;
  /**
   * When the delivered access token expires (ISO-8601), or `null` when the material carries no
   * readable expiry (an api-key-shaped or opaque credential, or the credential-free omp slot).
   *
   * WHY THIS IS A HARD DEADLINE (WI-10003706). `encodeWorkspaceHostAgentHomeBundle` neutralizes the
   * refresh token of BOTH members for EVERY source kind (D-311, WI-10001691), so nothing on the
   * host can mint a new access token: at this instant the agent on the host starts failing with
   * 401. It used to be invisible — a delivery read as a durable login and died ~13h later with no
   * prior signal (measured on avi-test 2026-09-26..27).
   */
  readonly accessExpiresAt: string | null;
}

export interface ResolvedWorkspaceHostAgentCredentialSources {
  readonly files: WorkspaceHostAgentHomeBundleFiles;
  /** Per-slot public receipt: where each slot came from, how many bytes, when it expires. */
  readonly resolved: Readonly<
    Record<WorkspaceHostAgentHomeFile, ResolvedWorkspaceHostAgentCredentialSlot>
  >;
  /**
   * Caller-facing warnings that are not errors: the claude personal-credential judgment call, and
   * one expiry notice per slot whose delivered access token has a readable expiry.
   */
  readonly notices: readonly string[];
}

/** Optional resolution knobs. `now` is injectable so expiry notices are testable without a clock. */
export interface ResolveWorkspaceHostAgentCredentialSourcesOptions {
  readonly now?: Date;
}

/** Seam so tests do no real I/O and no real store read; production binds the real pair. */
export interface WorkspaceHostAgentCredentialSourceReaders {
  readFileBytes(path: string): Promise<Buffer>;
  readIntegrationKey(name: string): Promise<string | undefined>;
}

const DEFAULT_READERS: WorkspaceHostAgentCredentialSourceReaders = {
  readFileBytes: (path) => readFile(path),
  readIntegrationKey,
};

/**
 * The operator's own path for one agent home file, derived from the host-side layout constant.
 *
 * Exported because a caller frequently needs to report WHICH file a selector would read — in a
 * confirmation, a dry run, or an error — without reading it.
 */
export function operatorAgentHomeFilePath(slot: WorkspaceHostAgentHomeFile): string {
  return join(homedir(), ...WORKSPACE_HOST_AGENT_HOME_FILES[slot]);
}

function describeSource(slot: WorkspaceHostAgentHomeFile, source: WorkspaceHostAgentCredentialSource): string {
  switch (source.kind) {
    case 'operator-home-file':
      return `operator-home-file:${operatorAgentHomeFilePath(slot)}`;
    case 'integration-key':
      return `integration-key:${source.name}`;
    case 'absent':
      return 'absent';
  }
}

async function resolveOne(
  slot: WorkspaceHostAgentHomeFile,
  source: WorkspaceHostAgentCredentialSource,
  readers: WorkspaceHostAgentCredentialSourceReaders,
): Promise<Buffer | null> {
  if (source.kind === 'absent') {
    // Only omp's slot is nullable in the bundle. Refusing this for claude/codex here — rather than
    // letting the encoder reject a null it was never typed to receive — keeps the failure at the
    // selector, where the message can name the slot and say why the slot is different.
    if (slot !== 'omp') {
      throw new WorkspaceHostAgentCredentialSourceError(
        slot,
        "cannot be 'absent': only the omp slot is credential-free by contract, and a missing " +
          'claude or codex member leaves that agent unable to authenticate on the host.',
      );
    }
    return null;
  }

  if (source.kind === 'integration-key') {
    const name = source.name.trim();
    if (name.length === 0) {
      throw new WorkspaceHostAgentCredentialSourceError(slot, 'named an empty integration key.');
    }
    const value = await readers.readIntegrationKey(name);
    if (value === undefined || value.length === 0) {
      throw new WorkspaceHostAgentCredentialSourceError(
        slot,
        `named integration key '${name}', which holds no value. Write it with ` +
          `setup:save_integration_key { name: '${name}' } first.`,
      );
    }
    return Buffer.from(value, 'utf8');
  }

  // FAIL CLOSED on an unrecognized kind. Reaching the home-file read by FALLTHROUGH would make a
  // typo'd, hand-written, or future source kind silently resolve to "read this operator's own
  // credentials" — the one default this module exists to refuse, arrived at by omission rather
  // than by choice. An unknown kind is a request nobody wrote a meaning for, so it has none.
  if (source.kind !== 'operator-home-file') {
    throw new WorkspaceHostAgentCredentialSourceError(
      slot,
      `named source kind '${String((source as { kind?: unknown }).kind)}', which is not one of ` +
        "'operator-home-file' | 'integration-key' | 'absent'. A source names a KIND, never bytes " +
        'and never a path.',
    );
  }

  const path = operatorAgentHomeFilePath(slot);
  let bytes: Buffer;
  try {
    bytes = await readers.readFileBytes(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new WorkspaceHostAgentCredentialSourceError(
      slot,
      `could not read the operator's own agent home at ${path}` +
        (code === 'ENOENT'
          ? ' — the file does not exist, so this operator has no credential to forward for that agent.'
          : ` (${code ?? 'unknown error'}).`),
    );
  }
  if (bytes.byteLength === 0) {
    throw new WorkspaceHostAgentCredentialSourceError(slot, `read 0 bytes from ${path}.`);
  }
  return bytes;
}

/** Epoch → ISO, or null for anything that is not a plausible instant. */
function epochToIso(value: unknown, unit: 'ms' | 's'): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = unit === 's' ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonRecord(bytes: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The `exp` claim (seconds) of a JWT, read without verifying it — we report, we do not trust. */
function jwtExpiry(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1].length === 0) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return null;
    return epochToIso((payload as { exp?: unknown }).exp, 's');
  } catch {
    return null;
  }
}

/**
 * When the access material a slot delivers stops working, read from the SAME fields the encoder's
 * projection preserves: claude `claudeAiOauth.expiresAt` (epoch ms, as the Claude CLI writes it)
 * and the codex `tokens.access_token` JWT `exp` (epoch seconds). Returns null when unreadable —
 * never throws, because validity is the encoder's job and it refuses malformed material itself.
 * Reads only the timestamp: no token byte ever leaves this function.
 */
export function deliveredAccessExpiry(
  slot: WorkspaceHostAgentHomeFile,
  bytes: Buffer | null,
): string | null {
  if (bytes === null || slot === 'omp') return null;
  const body = parseJsonRecord(bytes);
  if (body === null) return null;
  if (slot === 'claude') {
    const oauth = body.claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) return null;
    return epochToIso((oauth as { expiresAt?: unknown }).expiresAt, 'ms');
  }
  const tokens = body.tokens;
  if (typeof tokens !== 'object' || tokens === null) return null;
  return jwtExpiry((tokens as { access_token?: unknown }).access_token);
}

const SLOT_AGENT_NAME: Readonly<Record<WorkspaceHostAgentHomeFile, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  omp: 'omp',
};

function expiryNotice(slot: WorkspaceHostAgentHomeFile, expiresAt: string, now: Date): string {
  const agent = SLOT_AGENT_NAME[slot];
  const remainingMs = Date.parse(expiresAt) - now.getTime();
  if (remainingMs <= 0) {
    return (
      `files.${slot} delivers an access token that ALREADY EXPIRED at ${expiresAt}, and its refresh ` +
      `token is neutralized on delivery, so the ${agent} CLI on this host will fail with 401 from its ` +
      'first call. Renew the source first (use the agent locally so it refreshes, or re-mint the ' +
      'integration key), or have the customer sign in on the host.'
    );
  }
  const hours = Math.round((remainingMs / 3_600_000) * 10) / 10;
  return (
    `files.${slot} delivers an access token that EXPIRES at ${expiresAt} (in ~${hours}h) and cannot ` +
    'be renewed on the host — its refresh token is neutralized on delivery. After that the ' +
    `${agent} CLI on this host fails with 401 until the customer signs in on the host, or fresh ` +
    'material is delivered at a new generation. This is a short-lived delivery, not a durable login.'
  );
}

/**
 * Resolve every slot, then hand the bytes to the producer's `files` shape.
 *
 * Resolution is SEQUENTIAL and fails on the first bad slot on purpose: the error names one slot,
 * and a caller fixing a selector wants the first thing wrong with it, not a set of errors from
 * reads that were attempted anyway.
 */
export async function resolveWorkspaceHostAgentCredentialSources(
  selector: WorkspaceHostAgentCredentialSourceSelector,
  readers: WorkspaceHostAgentCredentialSourceReaders = DEFAULT_READERS,
  options: ResolveWorkspaceHostAgentCredentialSourcesOptions = {},
): Promise<ResolvedWorkspaceHostAgentCredentialSources> {
  const now = options.now ?? new Date();
  const slots = Object.keys(WORKSPACE_HOST_AGENT_HOME_FILES) as WorkspaceHostAgentHomeFile[];
  const files: Partial<Record<WorkspaceHostAgentHomeFile, Buffer | null>> = {};
  const resolved = {} as Record<WorkspaceHostAgentHomeFile, ResolvedWorkspaceHostAgentCredentialSlot>;
  const notices: string[] = [];

  for (const slot of slots) {
    const source = selector[slot];
    if (!source) {
      throw new WorkspaceHostAgentCredentialSourceError(
        slot,
        'was not supplied. Every slot must name a source explicitly — there is no default, ' +
          "because the default would silently answer 'whose credentials does this host get?'.",
      );
    }
    const bytes = await resolveOne(slot, source, readers);
    if (bytes !== null && bytes.byteLength > WORKSPACE_HOST_AGENT_CREDENTIAL_SOURCE_MAX_BYTES) {
      throw new WorkspaceHostAgentCredentialSourceError(
        slot,
        `resolved ${bytes.byteLength} bytes, over the ${WORKSPACE_HOST_AGENT_CREDENTIAL_SOURCE_MAX_BYTES}-byte ` +
          'ceiling for a credential file — this is almost certainly the wrong source.',
      );
    }
    files[slot] = bytes;
    resolved[slot] = {
      source: describeSource(slot, source),
      bytes: bytes?.byteLength ?? 0,
      accessExpiresAt: deliveredAccessExpiry(slot, bytes),
    };
  }

  if (selector.claude.kind === 'operator-home-file') {
    notices.push(
      'files.claude is PROJECTED before it reaches the host (WI-10001691) — its refresh token and ' +
        'any api-key-shaped field are neutralized, so it cannot mint new access — but a WORKING ' +
        "access token for this operator's own interactive Claude account still lands on the host " +
        'until it expires. Prefer a purpose-minted token supplied via integration-key.',
    );
  }

  for (const slot of slots) {
    const expiresAt = resolved[slot].accessExpiresAt;
    if (expiresAt !== null) notices.push(expiryNotice(slot, expiresAt, now));
  }

  return {
    files: {
      claude: files.claude as Buffer,
      codex: files.codex as Buffer,
      omp: files.omp ?? null,
    },
    resolved,
    notices,
  };
}
