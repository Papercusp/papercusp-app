/**
 * Credential MATERIAL DELIVERY — the one host operation that carries authorization bytes
 * (P-046 / WI-40474, plan decision D-215 points 1-5).
 *
 * WHAT WAS MISSING. `ProductionWorkspaceHostCredentialMaterializer.bind()` verifies that
 * `<materialRoot>/<family>/<generation>/material` exists and throws when it does not. Nothing in
 * the tree ever wrote that path — `WORKSPACE_HOST_CREDENTIAL_MATERIAL_ROOT` had exactly one
 * reader and no writer — so on a real host the `git` and `agent` channels always threw at bind,
 * and the live canary could not pass by construction. This module is the writer.
 *
 * WHY IT IS NOT A STEP ON THE INITIALIZATION PROTOCOL (D-215 point 1). Every step and every
 * receipt on that protocol crosses `assertWorkspaceHostSecretIsolation`, and the GCP adapter
 * refuses credential bytes by name. Those two facts are what make the initialization contract
 * worth trusting: you can read any initialization receipt, from any provider, and know it cannot
 * contain material. Widening either to admit a delivery step would delete that property for every
 * OTHER step at the same time — the assertion would have to learn an exception, and an assertion
 * with an exception proves only that the exception was not taken. So delivery gets its own
 * protocol version, its own envelope, and its own entrypoint, and the initialization protocol
 * keeps its total ban.
 *
 * THE ASYMMETRY IS THE DESIGN. Isolation is asserted on the way OUT and deliberately NOT on the
 * way IN. Inbound is the single boundary in this system where material legitimately exists, so
 * asserting there would reject every real request; outbound is asserted because the receipt is
 * what gets persisted, replicated and read by people. One direction is the exception, the other
 * is the rule, and they are stated here together so neither can be mistaken for an oversight.
 *
 * NOTHING DERIVED FROM THE BYTES EVER LEAVES (D-215 point 3). Not the material, not a length, and
 * not a digest: these secrets are low-entropy enough that a digest is an oracle against a guessing
 * attacker. `workspaceHostCredentialReferenceDigest` deliberately digests the REFERENCE, which is
 * public, and this module keeps that line — the receipt is `{ family, generation, present: true }`
 * plus an observation timestamp, and a test pins that it never grows a size or digest field.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import {
  WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS,
  parseWorkspaceHostCredentialReference,
  type WorkspaceHostCredentialFamily,
} from "./workspace-host-credential-namespace";
import type { WorkspaceHostCredentialChannel } from "./workspace-host-initialization";
import { assertWorkspaceHostSecretIsolation } from "./workspace-host-test-harness";

/**
 * The delivery wire version. Distinct from the initialization protocol's version on purpose: the
 * two protocols carry different things under different rules, and a host that speaks one has said
 * nothing about whether it speaks the other.
 */
export const WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION =
  "papercusp-workspace-host-credential-delivery-v1";

/** Fixed argv the controller passes; the CLI refuses anything else. */
export const WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV = [
  "--protocol-version",
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  "--json-stdin",
] as const;

/**
 * Upper bound on one delivered artifact.
 *
 * Delivery is reachable by anything that can run the host entrypoint, so an unbounded write is a
 * way to fill the host's disk. Every real artifact in the four families is a token, a short-lived
 * delegation or a sealed reference — kilobytes at most.
 */
export const WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES = 256 * 1024;

/** File name under the generation directory. Single definition; every path helper uses it. */
const MATERIAL_FILE = "material";

/**
 * Per-family ledger recording the highest generation that `revoke()` has destroyed.
 *
 * This exists because D-215 point 5 requires delivery never to resurrect a revoked generation,
 * and revocation's only other trace is an ABSENCE — the material file is unlinked. Absence cannot
 * carry that meaning: a generation that was revoked and one that was never delivered look
 * identical on disk, so a delivery that keyed on "the file is missing" would happily re-create
 * material the controller had already destroyed. A monotonic high-water mark states the fact
 * positively instead of inferring it from a side effect.
 */
const REVOCATION_LEDGER_FILE = "revoked-through";

/* ------------------------------------------------------------------------------------------ */
/* On-host layout — one definition, shared by the writer and the materializer                   */
/* ------------------------------------------------------------------------------------------ */

/** The directory holding one generation's artifacts. Created `0700`. */
export function workspaceHostCredentialGenerationDirectory(
  root: string,
  family: WorkspaceHostCredentialFamily,
  generation: number,
): string {
  return join(root, family, `${generation}`);
}

/**
 * The single path delivery writes and `bind()` checks (D-215 point 2).
 *
 * Exported so `materialPathFor` in the remote-initializer host derives its path from HERE rather
 * than open-coding the same `join`. Two copies of a path layout is the classic silent divergence:
 * both sides keep working, against different files.
 */
export function workspaceHostCredentialMaterialPath(
  root: string,
  family: WorkspaceHostCredentialFamily,
  generation: number,
): string {
  return join(
    workspaceHostCredentialGenerationDirectory(root, family, generation),
    MATERIAL_FILE,
  );
}

/** The per-family revocation high-water mark. */
export function workspaceHostCredentialRevocationLedgerPath(
  root: string,
  family: WorkspaceHostCredentialFamily,
): string {
  return join(root, family, REVOCATION_LEDGER_FILE);
}

/* ------------------------------------------------------------------------------------------ */
/* The material box                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * A holder for authorization bytes that refuses to serialize itself.
 *
 * The realistic leak here is not someone deliberately emitting the material — it is a diagnostic:
 * a `JSON.stringify(request)` in an error path, a `console.error({ request })`, a structured log
 * that captures its whole input. Each is a one-line change that looks harmless at the call site
 * and is invisible in review. Overriding `toJSON`, `toString` and node's inspect symbol makes all
 * three render `[redacted]`, so the bytes leave only through `reveal()` — a name that cannot be
 * typed by accident and is greppable when auditing who touches material.
 */
export class WorkspaceHostCredentialMaterial {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  /** The only way out. Deliberately explicit at every call site. */
  reveal(): Buffer {
    return this.#bytes;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }

  get [Symbol.toStringTag](): string {
    return "WorkspaceHostCredentialMaterial";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "WorkspaceHostCredentialMaterial [redacted]";
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Errors                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export class WorkspaceHostCredentialDeliveryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceHostCredentialDeliveryProtocolError";
  }
}

/**
 * The family is answered ambiently and must never have a file (D-215 point 4).
 *
 * Typed separately because it is not a malformed request — it is a coherent request for something
 * that must not exist. Writing a file for `cloud-workload-identity` would make `bind()` succeed
 * against a path we created ourselves, which is precisely the self-confirming check that
 * `materialPathFor`'s null branch exists to prevent.
 */
export class WorkspaceHostAmbientCredentialDeliveryError extends Error {
  readonly family: WorkspaceHostCredentialFamily;

  constructor(family: WorkspaceHostCredentialFamily) {
    super(
      `Credential family '${family}' is answered ambiently by the host environment and must not ` +
        `receive delivered material. Writing a file for it would make bind() pass against a path ` +
        `delivery created itself.`,
    );
    this.name = "WorkspaceHostAmbientCredentialDeliveryError";
    this.family = family;
  }
}

/** A generation at or below the revocation high-water mark was offered again (D-215 point 5). */
export class WorkspaceHostRevokedCredentialGenerationError extends Error {
  readonly family: WorkspaceHostCredentialFamily;
  readonly generation: number;
  readonly revokedThrough: number;

  constructor(
    family: WorkspaceHostCredentialFamily,
    generation: number,
    revokedThrough: number,
  ) {
    super(
      `Generation ${generation} of family '${family}' cannot be delivered: generations through ` +
        `${revokedThrough} have been revoked on this host. Rotation must issue a strictly ` +
        `increasing generation with a new revocation reference.`,
    );
    this.name = "WorkspaceHostRevokedCredentialGenerationError";
    this.family = family;
    this.generation = generation;
    this.revokedThrough = revokedThrough;
  }
}

/**
 * The same generation was offered with different bytes.
 *
 * Silently keeping the first delivery would leave the host authenticating with material the
 * controller believes it replaced — a divergence that surfaces much later as an unexplained
 * authorization failure. A generation names its material; changing the material means rotating.
 */
export class WorkspaceHostCredentialGenerationConflictError extends Error {
  readonly family: WorkspaceHostCredentialFamily;
  readonly generation: number;

  constructor(family: WorkspaceHostCredentialFamily, generation: number) {
    super(
      `Generation ${generation} of family '${family}' is already present on this host with ` +
        `different material. Delivery is idempotent per (family, generation); replacing material ` +
        `requires a new generation.`,
    );
    this.name = "WorkspaceHostCredentialGenerationConflictError";
    this.family = family;
    this.generation = generation;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Request / receipt                                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * One delivery.
 *
 * The FAMILY is not a field. It is derived from `credentialRef` through the namespace parser, so
 * a request cannot name one family while carrying another family's reference — a disagreement
 * that would otherwise be resolved silently, in favour of whichever field the reader happened to
 * consult.
 */
export interface WorkspaceHostCredentialDeliveryRequest {
  readonly protocolVersion: typeof WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION;
  readonly channel: WorkspaceHostCredentialChannel;
  readonly credentialRef: string;
  readonly family: WorkspaceHostCredentialFamily;
  readonly generation: number;
  readonly material: WorkspaceHostCredentialMaterial;
}

/**
 * What the controller persists (D-215 point 3).
 *
 * `family`, `generation` and `present` are the decision's exact three fields. `protocolVersion`
 * and `observedAt` are properties of the EXCHANGE, not of the bytes — the same two the
 * initialization protocol's receipts carry, and neither narrows the material's value. There is no
 * size and no digest here, and `workspace-host-credential-delivery.test.ts` asserts the receipt's
 * key set exactly so that adding one is a test failure rather than a code review someone has to
 * catch.
 */
export interface WorkspaceHostCredentialDeliveryReceipt {
  readonly protocolVersion: typeof WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION;
  readonly family: WorkspaceHostCredentialFamily;
  readonly generation: number;
  readonly present: true;
  readonly observedAt: string;
}

function requireObject(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `${label} must be an object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

/**
 * Decode the base64 material.
 *
 * The round-trip check matters: `Buffer.from` is lenient and silently drops characters it does not
 * recognise, so a corrupted payload would decode to plausible-looking garbage and be written as
 * the credential. The failure would then appear as an authentication error on the host, days from
 * here, with nothing pointing back at the transport. Re-encoding and comparing turns that into a
 * refusal at the boundary.
 */
function decodeMaterial(value: unknown): WorkspaceHostCredentialMaterial {
  const encoded = requireString(value, "request.material");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request.material decoded to zero bytes; delivery must carry material",
    );
  }
  if (bytes.toString("base64") !== encoded.replace(/\s+/g, "")) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request.material is not canonical base64",
    );
  }
  if (bytes.length > WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `request.material exceeds ${WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES} bytes`,
    );
  }
  return new WorkspaceHostCredentialMaterial(bytes);
}

/**
 * Validate an inbound delivery envelope.
 *
 * Note what is absent: `assertWorkspaceHostSecretIsolation` is NOT run over the request. That is
 * the deliberate asymmetry described at the top of this file — this is the one envelope in the
 * system that is SUPPOSED to contain material, and asserting here would reject every real
 * delivery. The receipt is asserted instead.
 */
export function parseWorkspaceHostCredentialDeliveryRequest(
  raw: unknown,
): WorkspaceHostCredentialDeliveryRequest {
  const body = requireObject(raw, "request");
  if (
    body.protocolVersion !== WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION
  ) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `unsupported protocol version '${String(body.protocolVersion)}'; this delivery endpoint ` +
        `speaks '${WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION}'`,
    );
  }

  const channel = requireString(body.channel, "request.channel");
  const credentialRef = requireString(
    body.credentialRef,
    "request.credentialRef",
  );
  // The namespace parser is the authority on which family a reference belongs to, and it also
  // enforces that the reference matches the declared channel. Deriving rather than trusting is
  // what makes a family/reference disagreement impossible instead of merely unlikely.
  const parsed = parseWorkspaceHostCredentialReference(
    credentialRef,
    channel as WorkspaceHostCredentialChannel,
  );

  const generation = body.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request.generation must be a positive safe integer",
    );
  }

  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    channel: parsed.channel,
    credentialRef,
    family: parsed.family,
    generation: generation as number,
    material: decodeMaterial(body.material),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The filesystem seam                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * The irreducible I/O, kept behind a seam for the same reason `WorkspaceHostSystem` is: everything
 * above it — the exemption, the monotonicity rule, the idempotency comparison — is decision logic
 * a unit test must be able to drive without a VM and without writing real credentials to a real
 * disk.
 */
export interface WorkspaceHostCredentialDeliveryFilesystem {
  /** Create a directory and every missing parent with mode `0700`. */
  ensureDirectory(path: string): Promise<void>;
  /** Write `bytes` at `path` with mode `0600`, replacing any existing file atomically. */
  writePrivateFile(path: string, bytes: Buffer): Promise<void>;
  /** Read a file, or `null` when it does not exist. */
  readFileIfPresent(path: string): Promise<Buffer | null>;
  /** Return the lstat kind without following symlinks when the implementation can provide it. */
  pathKind?(
    path: string,
  ): Promise<"missing" | "directory" | "file" | "symlink" | "other">;
  /** Optional cross-process critical section. Production provides it; hermetic doubles may not. */
  withExclusiveLock?<T>(path: string, task: () => Promise<T>): Promise<T>;
}

const WORKSPACE_HOST_FILESYSTEM_LOCK_TIMEOUT_MS = 360_000;
const WORKSPACE_HOST_FILESYSTEM_LOCK_ORPHAN_MS = 60_000;
const WORKSPACE_HOST_FILESYSTEM_LOCK_RETRY_MS = 25;

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a directory one component at a time and reject symlinks at every component.
 * `mkdir(..., { recursive:true })` follows an existing symlink, which is unsafe when a root-owned
 * consumer is writing into a user-selected home, credential root or customer-writable workspace
 * root. `kind` names the directory in errors; `mode` is applied to every created component and
 * to the leaf.
 */
async function ensureDirectoryWithoutFollowingSymlinks(
  path: string,
  mode: number,
  kind: string,
): Promise<void> {
  if (!isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path)) {
    throw new Error(
      `${kind} must be an absolute canonical path: '${path}'`,
    );
  }
  const components = path.split("/").filter(Boolean);
  let current = "/";
  for (const component of components) {
    current = join(current, component);
    let info;
    let created = false;
    try {
      info = await lstat(current);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode });
        created = true;
      } catch (mkdirError) {
        if (nodeErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `refusing non-directory or symlink at ${kind} '${current}'`,
      );
    }
    // Existing ancestors may be shared system directories (/var, /var/lib, …); only the newly
    // created components and the requested leaf receive the mode.
    if (created || current === path) await chmod(current, mode);
  }
}

/** A credential/home directory: mode `0700`, readable by its owner alone. */
async function ensurePrivateDirectory(path: string): Promise<void> {
  await ensureDirectoryWithoutFollowingSymlinks(path, 0o700, "private directory");
}

/**
 * A workspace directory under the ACL'd workspace root (`/srv/papercusp/workspaces`), mode `0770`.
 *
 * NOT `0700`. The bootstrap gives that root a default ACL naming the service, SSH and agent
 * accounts, and on a file with an ACL the mode's GROUP bits are the ACL MASK. A `0700`
 * mkdir/chmod therefore sets `mask::---`, which silently voids every named-user entry: the
 * operator service account could not traverse the customer's workspace root, so the portal's
 * "add a pot" answered "path does not exist" (WI-10004594). `0770` keeps the mask at `rwx` and
 * leaves "other" closed. Re-running on an existing directory repairs its mask, because the leaf
 * is always re-chmodded.
 */
export async function ensureSharedWorkspaceDirectory(path: string): Promise<void> {
  await ensureDirectoryWithoutFollowingSymlinks(path, 0o770, "workspace directory");
}

const fallbackFilesystemLocks = new WeakMap<
  WorkspaceHostCredentialDeliveryFilesystem,
  Map<string, Promise<void>>
>();

/**
 * Serialize a host credential mutation.
 *
 * Node production uses an atomic on-disk mutex below, so independent initializer/delivery
 * processes agree. A WeakMap queue is the deterministic fallback for hermetic filesystem doubles;
 * fresh dependency graphs sharing the same double still exercise the ordering contract.
 */
export async function withWorkspaceHostCredentialFilesystemLock<T>(
  filesystem: WorkspaceHostCredentialDeliveryFilesystem,
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  if (filesystem.withExclusiveLock) {
    return await filesystem.withExclusiveLock(path, task);
  }
  let locks = fallbackFilesystemLocks.get(filesystem);
  if (!locks) {
    locks = new Map();
    fallbackFilesystemLocks.set(filesystem, locks);
  }
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => own);
  locks.set(path, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(path) === tail) locks.delete(path);
  }
}

export function workspaceHostCredentialFamilyLockPath(
  root: string,
  family: WorkspaceHostCredentialFamily,
): string {
  // Both agent families install the same three native files and active marker. A shared lock keeps
  // a forwarded/sealed rotation from interleaving even though their delivered artifacts are stored
  // under different family directories.
  if (
    family === "agent-forwarded-reference" ||
    family === "agent-encrypted-reference"
  ) {
    return join(root, "active", ".agent-home.lifecycle.lock");
  }
  return join(root, family, ".lifecycle.lock");
}

/**
 * The real implementation, used by the packaged host entrypoint.
 *
 * `WorkspaceHostSystem` in the remote-initializer host EXTENDS the interface above rather than
 * declaring a parallel one, so a caller that stubs the host seam stubs this too. That is not
 * tidiness: `revoke()` writes the revocation ledger through this seam, and when it was a SECOND
 * seam defaulting to the real filesystem, a test that had carefully faked every host operation
 * still tried to `mkdir /credentials` on the machine running it.
 */
export class NodeWorkspaceHostCredentialDeliveryFilesystem implements WorkspaceHostCredentialDeliveryFilesystem {
  async ensureDirectory(path: string): Promise<void> {
    await ensurePrivateDirectory(path);
  }

  async writePrivateFile(path: string, bytes: Buffer): Promise<void> {
    // Written to a sibling temp path and renamed so a reader never observes a partial credential:
    // `bind()` checks presence, and a half-written file is present. The temp file is created 0600
    // from the start, so the material is never briefly world-readable.
    await ensurePrivateDirectory(dirname(path));
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async readFileIfPresent(path: string): Promise<Buffer | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`refusing to read non-regular private file '${path}'`);
      }
      return await readFile(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async pathKind(
    path: string,
  ): Promise<"missing" | "directory" | "file" | "symlink" | "other"> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return "symlink";
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return "other";
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return "missing";
      throw error;
    }
  }

  async withExclusiveLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    await this.ensureDirectory(dirname(path));
    const token = randomUUID();
    const ownerPath = join(path, "owner.json");
    const startedAt = Date.now();
    let acquired = false;
    while (!acquired) {
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(
          ownerPath,
          JSON.stringify({
            token,
            pid: process.pid,
            host: hostname(),
            startedAt,
          }),
          { mode: 0o600, flag: "wx" },
        );
        acquired = true;
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        let reclaim = false;
        try {
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error(`refusing unsafe credential lock path '${path}'`);
          }
          try {
            const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
              pid?: unknown;
              host?: unknown;
            };
            if (
              owner.host === hostname() &&
              Number.isSafeInteger(owner.pid) &&
              (owner.pid as number) > 0
            ) {
              try {
                process.kill(owner.pid as number, 0);
              } catch (probeError) {
                reclaim = nodeErrorCode(probeError) === "ESRCH";
              }
            }
          } catch (ownerError) {
            if (nodeErrorCode(ownerError) !== "ENOENT") {
              // A malformed owner record is never proof the holder is dead; age is the fallback.
            }
            reclaim =
              Date.now() - info.mtimeMs >
              WORKSPACE_HOST_FILESYSTEM_LOCK_ORPHAN_MS;
          }
        } catch (inspectError) {
          if (nodeErrorCode(inspectError) === "ENOENT") continue;
          throw inspectError;
        }
        if (reclaim) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (
          Date.now() - startedAt >
          WORKSPACE_HOST_FILESYSTEM_LOCK_TIMEOUT_MS
        ) {
          throw new Error(
            `timed out waiting for credential filesystem lock '${path}'`,
          );
        }
        await delay(WORKSPACE_HOST_FILESYSTEM_LOCK_RETRY_MS);
      }
    }
    try {
      return await task();
    } finally {
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
          token?: unknown;
        };
        if (owner.token === token)
          await rm(path, { recursive: true, force: true });
      } catch {
        // Never remove a lock whose token cannot be proven to be ours.
      }
    }
  }
}

export interface WorkspaceHostCredentialDeliveryDeps {
  readonly filesystem: WorkspaceHostCredentialDeliveryFilesystem;
  readonly materialRoot: string;
  readonly now?: () => Date;
}

/* ------------------------------------------------------------------------------------------ */
/* Revocation ledger                                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * Read the highest revoked generation for a family; `0` when nothing has been revoked.
 *
 * An unreadable or malformed ledger is treated as a REFUSAL to answer, not as zero. Zero means
 * "nothing revoked", which would re-open every generation the ledger was written to close — the
 * failure mode where corrupting one small file silently disables the protection.
 */
export async function readWorkspaceHostCredentialRevokedThrough(
  filesystem: WorkspaceHostCredentialDeliveryFilesystem,
  root: string,
  family: WorkspaceHostCredentialFamily,
): Promise<number> {
  const raw = await filesystem.readFileIfPresent(
    workspaceHostCredentialRevocationLedgerPath(root, family),
  );
  if (raw === null) return 0;
  const text = raw.toString("utf8").trim();
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `revocation ledger for family '${family}' is malformed ('${text.slice(0, 32)}'); refusing ` +
        `to deliver rather than assume nothing was revoked`,
    );
  }
  return value;
}

/**
 * Raise the family's revocation high-water mark to at least `generation`.
 *
 * Monotonic by construction: revoking an OLD generation after a newer one has already been
 * revoked must not lower the mark and re-open the newer one. Called by the materializer's
 * `revoke()`, which is the only thing that destroys material.
 */
export async function recordWorkspaceHostCredentialRevocation(
  filesystem: WorkspaceHostCredentialDeliveryFilesystem,
  root: string,
  family: WorkspaceHostCredentialFamily,
  generation: number,
  options: { readonly lockHeld?: boolean } = {},
): Promise<void> {
  const apply = async (): Promise<void> => {
    const current = await readWorkspaceHostCredentialRevokedThrough(
      filesystem,
      root,
      family,
    );
    if (generation <= current) return;
    await filesystem.ensureDirectory(join(root, family));
    await filesystem.writePrivateFile(
      workspaceHostCredentialRevocationLedgerPath(root, family),
      Buffer.from(`${generation}\n`, "utf8"),
    );
  };
  if (options.lockHeld) return await apply();
  await withWorkspaceHostCredentialFilesystemLock(
    filesystem,
    workspaceHostCredentialFamilyLockPath(root, family),
    apply,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The operation                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** Constant-time equality that tolerates different lengths without leaking via an early return. */
function sameMaterial(a: Buffer, b: Buffer): boolean {
  // `timingSafeEqual` throws on a length mismatch, so lengths are compared through fixed-size
  // digests instead. Hashing here is safe in a way that hashing into the RECEIPT would not be:
  // the digest never leaves this process.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Execute one delivery.
 *
 * The order of checks is the contract's order of severity, and it matters. The ambient exemption
 * is first because that request must never touch the filesystem at all. The revocation ledger is
 * second because a revoked generation must be refused whether or not material happens to be on
 * disk. Only then does presence decide between a no-op and a write.
 */
export async function executeWorkspaceHostCredentialDelivery(
  request: WorkspaceHostCredentialDeliveryRequest,
  deps: WorkspaceHostCredentialDeliveryDeps,
): Promise<WorkspaceHostCredentialDeliveryReceipt> {
  const { family, generation } = request;
  const now = deps.now ?? (() => new Date());

  // D-215 point 4 — derived from the family spec, never from a hard-coded family name, so a fifth
  // family has to declare which side it is on instead of inheriting a branch.
  if (
    !WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial
  ) {
    throw new WorkspaceHostAmbientCredentialDeliveryError(family);
  }

  return await withWorkspaceHostCredentialFilesystemLock(
    deps.filesystem,
    workspaceHostCredentialFamilyLockPath(deps.materialRoot, family),
    async () => {
      // D-215 point 5 — never resurrect a generation revoke() destroyed.
      const revokedThrough = await readWorkspaceHostCredentialRevokedThrough(
        deps.filesystem,
        deps.materialRoot,
        family,
      );
      if (generation <= revokedThrough) {
        throw new WorkspaceHostRevokedCredentialGenerationError(
          family,
          generation,
          revokedThrough,
        );
      }

      const path = workspaceHostCredentialMaterialPath(
        deps.materialRoot,
        family,
        generation,
      );
      const existing = await deps.filesystem.readFileIfPresent(path);
      const bytes = request.material.reveal();

      if (existing !== null) {
        // Idempotent per (family, generation): the same material is a no-op, different material is
        // a conflict rather than a silent overwrite.
        if (!sameMaterial(existing, bytes)) {
          throw new WorkspaceHostCredentialGenerationConflictError(
            family,
            generation,
          );
        }
      } else {
        await deps.filesystem.ensureDirectory(
          workspaceHostCredentialGenerationDirectory(
            deps.materialRoot,
            family,
            generation,
          ),
        );
        await deps.filesystem.writePrivateFile(path, bytes);
      }

      const receipt: WorkspaceHostCredentialDeliveryReceipt = {
        protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
        family,
        generation,
        present: true,
        observedAt: now().toISOString(),
      };
      assertWorkspaceHostSecretIsolation(
        receipt,
        "workspaceHost.credentialDelivery.receipt",
      );
      return receipt;
    },
  );
}

/**
 * Handle one raw stdin payload and return the exact bytes to write to stdout.
 *
 * Mirrors `handleWorkspaceHostRemoteInitializerPayload` so the two entrypoints behave identically
 * where they can: one JSON object in, one JSON object out, failure by non-zero exit.
 */
export async function handleWorkspaceHostCredentialDeliveryPayload(
  payload: string,
  deps: WorkspaceHostCredentialDeliveryDeps,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request body is not valid JSON",
    );
  }
  const request = parseWorkspaceHostCredentialDeliveryRequest(parsed);
  const receipt = await executeWorkspaceHostCredentialDelivery(request, deps);
  return `${JSON.stringify(receipt)}\n`;
}

/** Reject argv that is not exactly what the controller's command builder emits. */
export function assertWorkspaceHostCredentialDeliveryArgv(
  argv: readonly string[],
): void {
  const expected = WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV;
  const matches =
    argv.length === expected.length &&
    expected.every((value, index) => argv[index] === value);
  if (!matches) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `credential delivery expects argv ${expected.join(" ")}, got ${argv.join(" ") || "(none)"}`,
    );
  }
}

/**
 * Encode a delivery request for the wire.
 *
 * Lives beside the parser that reads it back, for the reason
 * `encodeWorkspaceHostCredentialLifecycleStep` gives: the encoding is a property of the protocol,
 * and a controller that open-coded it would be a second definition of the wire format sitting
 * where nobody would look when the format changed.
 *
 * Returns a plain object because it is about to be `JSON.stringify`-ed onto a pipe. That is the
 * one place the material is deliberately unboxed, so it is the one function whose callers must be
 * audited — which is why it is a named export rather than an inline literal at the call site.
 */
export function encodeWorkspaceHostCredentialDeliveryRequest(input: {
  readonly channel: WorkspaceHostCredentialChannel;
  readonly credentialRef: string;
  readonly generation: number;
  readonly material: WorkspaceHostCredentialMaterial;
}): Readonly<Record<string, unknown>> {
  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    channel: input.channel,
    credentialRef: input.credentialRef,
    generation: input.generation,
    material: input.material.reveal().toString("base64"),
  };
}
