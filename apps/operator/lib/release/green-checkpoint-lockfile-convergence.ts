/**
 * P-008 (green-gate-zero-wait-convergence-2026-09-08) — lockfile-drift auto-convergence on the
 * frozen lineage. Fixes EI-22752586902645795 (R-1, R-2, R-7).
 *
 * The exact-input dependency generation the gate materialises is keyed on LOCKFILE blobs only
 * (`dependency-generation.sh` `dependency_generation_input_manifest_ref`: package-lock.json /
 * npm-shrinkwrap.json outside node_modules and .papercusp, recursing through gitlinks). Under
 * `--ensure-ref <repairHead>` the script publishes from the LIVE integration tree, indexes the
 * generation under the live fingerprint, then re-opens by the REF's fingerprint — so a frozen
 * repairHead whose lockfiles differ from the live tree is a PERMANENT `dependency-prewarm-missing`
 * (exit 74): no run can ever judge it, and the queue parks as an inconclusive forever.
 *
 * The convergence is deliberately narrow. When the ONLY manifest delta between repairHead and the
 * live tree is lockfile blobs the live tree already holds AND those blobs equal the integration
 * ref's committed ones, admitting the integration ref's entries for exactly those paths onto
 * repairHead (whole-blob, through the ordinary ledgered admission door, actor=gate) makes
 * repairHead's fingerprint equal the live fingerprint — the live generation is then reusable with
 * no publish. Every other delta (a live lockfile that is uncommitted, a submodule whose pinned
 * lockfiles differ from its live tree) is reported as a typed, NAMED miss so the caller can log it
 * loudly instead of parking silently.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  admitPathsOntoRepairHead,
  realAdmissionGit,
  type AdmissionGitRunner,
  type AdmissionOutcome,
  type AdmissionRefusal,
  type AdmitPathsInput,
} from "@papercusp/operator-core/lib/release/repair-head-admission";
import {
  markFrozenRepairAdmitted,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

/** The ledger actor every P-008 admission is recorded under. */
export const LOCKFILE_CONVERGENCE_ACTOR = "gate";

/** Mirrors the shell manifest's name filter — only these participate in the input fingerprint. */
export const DEPENDENCY_INPUT_LOCKFILE_NAMES: readonly string[] = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
]);

/** Mirrors `dependency_generation_input_manifest_ref`'s path filter exactly. */
export function isDependencyInputLockfilePath(rel: string): boolean {
  const segments = rel.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (!DEPENDENCY_INPUT_LOCKFILE_NAMES.includes(base)) return false;
  return !segments
    .slice(0, -1)
    .some((segment) => segment === ".papercusp" || segment === "node_modules");
}

/** Repo-relative path → blob sha; `null` records an ABSENT path (so a union walk can compare). */
export type LockfileBlobMap = ReadonlyMap<string, string | null>;

export interface LockfileManifestAtRef {
  /** Lockfile blobs at the ref, by repo-relative path. */
  blobs: Map<string, string>;
  /** Submodule gitlinks at the ref: path → pinned commit. */
  gitlinks: Map<string, string>;
}

/** Parse `git ls-tree -r -z <ref>` output into the lockfile manifest + gitlinks. */
export function parseLsTreeLockfileManifest(lsTreeZ: string): LockfileManifestAtRef {
  const blobs = new Map<string, string>();
  const gitlinks = new Map<string, string>();
  for (const record of lsTreeZ.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(/\s+/);
    const rel = record.slice(tab + 1);
    if (!mode || !type || !object || !rel) continue;
    if (type === "commit" && mode === "160000") {
      gitlinks.set(rel, object);
      continue;
    }
    if (type !== "blob" || !isDependencyInputLockfilePath(rel)) continue;
    blobs.set(rel, object);
  }
  return { blobs, gitlinks };
}

export function readLockfileManifestAtRef(
  root: string,
  ref: string,
  git: AdmissionGitRunner = realAdmissionGit,
): LockfileManifestAtRef {
  const r = git(["ls-tree", "-r", "-z", ref], { cwd: root });
  if (r.status !== 0) {
    throw new Error(
      `git ls-tree -r ${ref.slice(0, 12)} in ${root} failed (${r.status}): ${r.stderr.trim()}`,
    );
  }
  return parseLsTreeLockfileManifest(r.stdout);
}

/** Blob shas of the LIVE working-tree files for `paths` (`null` where the file is absent). */
export function readLiveLockfileBlobs(
  root: string,
  paths: Iterable<string>,
  git: AdmissionGitRunner = realAdmissionGit,
  exists: (abs: string) => boolean = existsSync,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const rel of paths) {
    if (!exists(path.join(root, rel))) {
      out.set(rel, null);
      continue;
    }
    const r = git(["hash-object", "--", rel], { cwd: root });
    if (r.status !== 0) {
      throw new Error(
        `git hash-object ${rel} in ${root} failed (${r.status}): ${r.stderr.trim()}`,
      );
    }
    out.set(rel, r.stdout.trim());
  }
  return out;
}

export type LockfileDriftReason =
  /** A drifting path's LIVE blob is not the integration ref's committed blob — admitting the
   *  ref's entry would not reproduce the live fingerprint (an uncommitted lockfile edit). */
  | "live-diverges-from-integration-ref"
  /** A submodule pinned by repairHead has lockfiles that differ from its live working tree; a
   *  gitlink bump is not a whole-blob lockfile admission and stays a typed miss. */
  | "submodule-lockfile-drift"
  /** The integration ref's lockfile changes a WORKSPACE entry whose manifest (`package.json`,
   *  resolved through gitlinks) at repairHead is not the integration ref's. A lockfile is a
   *  function of its manifests, so admitting the lock alone leaves repairHead internally
   *  inconsistent — `npm install` rewrites it and every consumer that installs sees a dirty
   *  tree (WI-10003229: f6bf2977 admitted the lock for a `libs/papercusp-shared` dependency
   *  whose manifest only existed behind a gitlink bump the lineage never received). */
  | "lockfile-manifest-diverges";

/**
 * One workspace entry the admitted lockfile would change whose manifest differs between
 * repairHead and the integration ref. `gitlink` names the submodule the manifest sits behind,
 * when it does — the gitlink bump is then what a fixer must admit together with the lockfile.
 */
export interface LockfileManifestDivergence {
  /** Repo-relative lockfile the divergent entry belongs to. */
  lockfile: string;
  /** The lock `packages` key, relative to the lockfile's directory ("" = its root package). */
  entry: string;
  /** Repo-relative manifest the entry is a function of. */
  manifest: string;
  /** Superproject-relative submodule path the manifest resolves through, else null. */
  gitlink: string | null;
}

export type LockfileDriftDecision =
  | { kind: "no-drift" }
  | { kind: "convergeable"; paths: string[] }
  | { kind: "not-convergeable"; reason: LockfileDriftReason; paths: string[] };

/**
 * Pure classification. `repairHead` / `integrationRef` are the committed lockfile blobs at each
 * ref; `live` is the working tree's; `submoduleLockfileDrift` names submodules whose pinned
 * lockfiles differ from their live trees (computed by the caller — see `convergeLockfileDrift`).
 */
export function classifyLockfileDrift(input: {
  repairHead: LockfileBlobMap;
  integrationRef: LockfileBlobMap;
  live: LockfileBlobMap;
  submoduleLockfileDrift?: readonly string[];
}): LockfileDriftDecision {
  if (input.submoduleLockfileDrift && input.submoduleLockfileDrift.length > 0) {
    return {
      kind: "not-convergeable",
      reason: "submodule-lockfile-drift",
      paths: [...input.submoduleLockfileDrift].sort(),
    };
  }
  const union = new Set<string>([
    ...input.repairHead.keys(),
    ...input.integrationRef.keys(),
    ...input.live.keys(),
  ]);
  const delta: string[] = [];
  const diverging: string[] = [];
  for (const rel of [...union].sort()) {
    const head = input.repairHead.get(rel) ?? null;
    const live = input.live.get(rel) ?? null;
    if (head === live) continue;
    delta.push(rel);
    if (live !== (input.integrationRef.get(rel) ?? null)) diverging.push(rel);
  }
  if (delta.length === 0) return { kind: "no-drift" };
  if (diverging.length > 0) {
    return {
      kind: "not-convergeable",
      reason: "live-diverges-from-integration-ref",
      paths: diverging,
    };
  }
  return { kind: "convergeable", paths: delta };
}

/** Key-order-insensitive JSON rendering, so two lock entries compare by content only. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The lock's `packages` map (lockfileVersion ≥ 2); `{}` for an absent lock or a v1 lock. */
export function parseLockPackages(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("lockfile is not a JSON object");
  }
  const packages = (parsed as { packages?: unknown }).packages;
  if (packages === undefined) return {};
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("lockfile `packages` is not an object");
  }
  return packages as Record<string, unknown>;
}

/**
 * Lock `packages` keys that name a WORKSPACE (no `node_modules` segment — "" is the lock's own
 * root package) whose entry differs between the two locks, sorted. Hoisted/installed entries are
 * resolution consequences; a manifest's dependency fields are mirrored on its workspace entry,
 * so every manifest-driven change shows up here.
 */
export function changedWorkspaceLockEntries(
  repairHead: Record<string, unknown>,
  integrationRef: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(repairHead), ...Object.keys(integrationRef)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key.split("/").includes("node_modules")) continue;
    const a = key in repairHead ? canonicalJson(repairHead[key]) : null;
    const b = key in integrationRef ? canonicalJson(integrationRef[key]) : null;
    if (a !== b) changed.push(key);
  }
  return changed.sort();
}

/** Repo-relative `package.json` a lock entry is a function of. Throws if it escapes the repo. */
export function manifestPathForLockEntry(lockfile: string, entry: string): string {
  const dir = path.posix.dirname(lockfile);
  const manifest = path.posix.normalize(path.posix.join(dir, entry, "package.json"));
  if (manifest.startsWith("../") || path.posix.isAbsolute(manifest)) {
    throw new Error(`lock entry "${entry}" of ${lockfile} resolves outside the repository`);
  }
  return manifest;
}

interface LsTreeEntry {
  type: string;
  object: string;
}

function lsTreePath(
  repoRoot: string,
  ref: string,
  rel: string,
  git: AdmissionGitRunner,
): LsTreeEntry | null {
  const r = git(["ls-tree", "-z", ref, "--", rel], { cwd: repoRoot });
  if (r.status !== 0) {
    throw new Error(
      `git ls-tree ${ref.slice(0, 12)} -- ${rel} in ${repoRoot} failed (${r.status}): ${r.stderr.trim()}`,
    );
  }
  for (const record of r.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0 || record.slice(tab + 1) !== rel) continue;
    const [, type, object] = record.slice(0, tab).split(/\s+/);
    if (type && object) return { type, object };
  }
  return null;
}

/**
 * The blob at `rel` in `ref`, descending through submodule gitlinks (a superproject `ls-tree`
 * answers EMPTY for a path under a gitlink, which would otherwise read as "absent" on both refs
 * and hide exactly the WI-10003229 divergence). `gitlink` is the innermost submodule crossed,
 * superproject-relative. A pin missing from the submodule's object store throws — unverifiable,
 * never silently equal.
 */
export function resolveBlobThroughGitlinks(
  repoRoot: string,
  ref: string,
  rel: string,
  git: AdmissionGitRunner,
  depth = 0,
): { blob: string | null; gitlink: string | null } {
  if (depth > 8) throw new Error(`gitlink nesting too deep resolving ${rel} in ${repoRoot}`);
  const direct = lsTreePath(repoRoot, ref, rel, git);
  if (direct) return { blob: direct.type === "blob" ? direct.object : null, gitlink: null };
  const segments = rel.split("/");
  for (let i = 1; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i).join("/");
    const entry = lsTreePath(repoRoot, ref, prefix, git);
    if (!entry) return { blob: null, gitlink: null };
    if (entry.type === "commit") {
      const inner = resolveBlobThroughGitlinks(
        path.join(repoRoot, prefix),
        entry.object,
        segments.slice(i).join("/"),
        git,
        depth + 1,
      );
      return { blob: inner.blob, gitlink: inner.gitlink ? `${prefix}/${inner.gitlink}` : prefix };
    }
    if (entry.type !== "tree") return { blob: null, gitlink: null };
  }
  return { blob: null, gitlink: null };
}

function readBlobText(root: string, blob: string | undefined, git: AdmissionGitRunner): string | null {
  if (!blob) return null;
  const r = git(["cat-file", "blob", blob], { cwd: root });
  if (r.status !== 0) {
    throw new Error(`git cat-file blob ${blob.slice(0, 12)} in ${root} failed (${r.status}): ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/**
 * For each lockfile about to be admitted, every changed workspace entry whose manifest differs
 * between repairHead and the integration ref (WI-10003229). Empty ⇒ the integration ref's lock is
 * a function of manifests repairHead already holds, so admitting it whole-blob is consistent.
 */
export function findLockfileManifestDivergence(input: {
  root: string;
  repairHead: string;
  integrationRef: string;
  lockfiles: readonly string[];
  repairHeadBlobs: ReadonlyMap<string, string>;
  integrationBlobs: ReadonlyMap<string, string>;
  git: AdmissionGitRunner;
}): LockfileManifestDivergence[] {
  const out: LockfileManifestDivergence[] = [];
  for (const lockfile of input.lockfiles) {
    const headLock = parseLockPackages(readBlobText(input.root, input.repairHeadBlobs.get(lockfile), input.git));
    const integrationLock = parseLockPackages(
      readBlobText(input.root, input.integrationBlobs.get(lockfile), input.git),
    );
    for (const entry of changedWorkspaceLockEntries(headLock, integrationLock)) {
      const manifest = manifestPathForLockEntry(lockfile, entry);
      const atHead = resolveBlobThroughGitlinks(input.root, input.repairHead, manifest, input.git);
      const atIntegration = resolveBlobThroughGitlinks(input.root, input.integrationRef, manifest, input.git);
      if (atHead.blob === atIntegration.blob) continue;
      out.push({ lockfile, entry, manifest, gitlink: atIntegration.gitlink ?? atHead.gitlink });
    }
  }
  return out;
}

function describeManifestDivergence(divergence: readonly LockfileManifestDivergence[]): string {
  return divergence
    .map((d) => `${d.manifest}${d.gitlink ? ` (behind gitlink ${d.gitlink})` : ""} for ${d.lockfile}`)
    .join(", ");
}

export type LockfileConvergenceOutcome =
  | { kind: "no-drift" }
  | {
      kind: "converged";
      entry: FrozenRepairAdmission;
      fromRepairHead: string;
      toRepairHead: string;
      paths: string[];
      reason: string;
    }
  | {
      kind: "not-convergeable";
      reason: LockfileDriftReason;
      paths: string[];
      detail: string;
      /** Present for `lockfile-manifest-diverges`: every entry that blocked the admission. */
      manifestDivergence?: LockfileManifestDivergence[];
    }
  | { kind: "admission-refused"; refusal: AdmissionRefusal; paths: string[] }
  /** The probe itself failed (git plumbing) — nothing was decided; the caller keeps the typed miss. */
  | { kind: "probe-failed"; detail: string };

export interface LockfileConvergenceInput {
  /** Superproject root holding the frozen lineage and the integration ref. */
  root: string;
  queue: Pick<FrozenCandidateRepairQueue, "candidate" | "repairHead">;
  /** The live integration ref (normally `cfg.integrationBranch`, i.e. `staging`). */
  integrationRef: string;
  nowMs: number;
  git?: AdmissionGitRunner;
  exists?: (abs: string) => boolean;
  /** Seam for tests; defaults to the real ledgered admission door. */
  admit?: (input: AdmitPathsInput) => AdmissionOutcome;
}

function buildAdmissionReason(paths: string[], from: string, integrationRef: string): string {
  return (
    `P-008 lockfile-drift auto-convergence: ${paths.length} lockfile(s) at repairHead ` +
    `${from.slice(0, 12)} differ from the live integration tree only by blobs equal to ` +
    `${integrationRef}'s committed ones (${paths.join(", ")}); admitted whole-blob so the exact-input ` +
    `dependency fingerprint matches the live generation instead of missing with exit 74`
  );
}

/**
 * Detect lockfile drift between `queue.repairHead` and the live tree and, when it is exactly the
 * convergeable shape, admit the integration ref's blobs for those paths onto repairHead under
 * actor=gate. Never throws for a plumbing failure — that is `probe-failed`.
 */
export function convergeLockfileDrift(input: LockfileConvergenceInput): LockfileConvergenceOutcome {
  const git = input.git ?? realAdmissionGit;
  const exists = input.exists ?? existsSync;
  const admit = input.admit ?? admitPathsOntoRepairHead;
  let decision: LockfileDriftDecision;
  let manifestDivergence: LockfileManifestDivergence[] = [];
  try {
    const head = readLockfileManifestAtRef(input.root, input.queue.repairHead, git);
    const integration = readLockfileManifestAtRef(input.root, input.integrationRef, git);
    const live = readLiveLockfileBlobs(
      input.root,
      new Set([...head.blobs.keys(), ...integration.blobs.keys()]),
      git,
      exists,
    );
    const submoduleLockfileDrift: string[] = [];
    for (const [sub, pin] of head.gitlinks) {
      if (integration.gitlinks.get(sub) === pin) continue;
      const subRoot = path.join(input.root, sub);
      if (!exists(subRoot)) {
        submoduleLockfileDrift.push(sub);
        continue;
      }
      const pinned = readLockfileManifestAtRef(subRoot, pin, git);
      const subLive = readLiveLockfileBlobs(subRoot, pinned.blobs.keys(), git, exists);
      for (const [rel, sha] of pinned.blobs) {
        if (subLive.get(rel) !== sha) {
          submoduleLockfileDrift.push(sub);
          break;
        }
      }
    }
    decision = classifyLockfileDrift({
      repairHead: head.blobs,
      integrationRef: integration.blobs,
      live,
      submoduleLockfileDrift,
    });
    // WI-10003229: blob equality with the integration ref proves the LOCK matches staging, not
    // that repairHead's MANIFESTS produce it. Refuse when an entry the lock changes belongs to a
    // manifest (possibly behind a gitlink) that repairHead does not hold at the ref's version.
    if (decision.kind === "convergeable") {
      manifestDivergence = findLockfileManifestDivergence({
        root: input.root,
        repairHead: input.queue.repairHead,
        integrationRef: input.integrationRef,
        lockfiles: decision.paths,
        repairHeadBlobs: head.blobs,
        integrationBlobs: integration.blobs,
        git,
      });
    }
  } catch (error) {
    return {
      kind: "probe-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (decision.kind === "no-drift") return { kind: "no-drift" };
  if (decision.kind === "not-convergeable") {
    return {
      kind: "not-convergeable",
      reason: decision.reason,
      paths: decision.paths,
      detail:
        decision.reason === "live-diverges-from-integration-ref"
          ? `live lockfile(s) are not ${input.integrationRef}'s committed blobs: ${decision.paths.join(", ")}`
          : `submodule(s) pinned by repairHead ${input.queue.repairHead.slice(0, 12)} carry lockfiles that differ from their live trees: ${decision.paths.join(", ")}`,
    };
  }
  if (manifestDivergence.length > 0) {
    return {
      kind: "not-convergeable",
      reason: "lockfile-manifest-diverges",
      paths: [...new Set(manifestDivergence.map((d) => d.manifest))].sort(),
      detail:
        `${input.integrationRef}'s lockfile(s) change workspace entries whose manifest at repairHead ` +
        `${input.queue.repairHead.slice(0, 12)} is not ${input.integrationRef}'s: ` +
        `${describeManifestDivergence(manifestDivergence)} — admitting the lock alone would leave ` +
        `repairHead's lock inconsistent with its manifests; admit the manifest change (or gitlink) with it`,
      manifestDivergence,
    };
  }
  const reason = buildAdmissionReason(decision.paths, input.queue.repairHead, input.integrationRef);
  const outcome = admit({
    root: input.root,
    candidate: input.queue.candidate,
    repairHead: input.queue.repairHead,
    paths: decision.paths,
    source: { ref: input.integrationRef },
    actor: LOCKFILE_CONVERGENCE_ACTOR,
    reason,
    nowMs: input.nowMs,
    git,
  });
  if (!outcome.ok) return { kind: "admission-refused", refusal: outcome, paths: decision.paths };
  return {
    kind: "converged",
    entry: outcome.entry,
    fromRepairHead: input.queue.repairHead,
    toRepairHead: outcome.commit,
    paths: decision.paths,
    reason,
  };
}

/** Fold a `converged` outcome into the queue row (advances repairHead; P-001 retest marker set). */
export function applyLockfileConvergence(
  queue: FrozenCandidateRepairQueue,
  outcome: Extract<LockfileConvergenceOutcome, { kind: "converged" }>,
): FrozenCandidateRepairQueue {
  return markFrozenRepairAdmitted(queue, outcome.entry);
}

/** One log line per outcome; the not-convergeable/refused shapes are LOUD by design (R-7). */
export function describeLockfileConvergence(outcome: LockfileConvergenceOutcome): string {
  switch (outcome.kind) {
    case "no-drift":
      return "no lockfile drift against the live integration tree";
    case "converged":
      return (
        `CONVERGED: admitted ${outcome.paths.length} lockfile(s) whole-blob onto ` +
        `${outcome.fromRepairHead.slice(0, 8)} → ${outcome.toRepairHead.slice(0, 8)} (actor=${LOCKFILE_CONVERGENCE_ACTOR}): ${outcome.paths.join(", ")}`
      );
    case "not-convergeable":
      return `⚠ LOCKFILE_DRIFT_NOT_CONVERGEABLE reason=${outcome.reason} — ${outcome.detail}; the repair head stays a typed dependency-prewarm miss until a fixer admits the dependency change`;
    case "admission-refused":
      return `⚠ LOCKFILE_DRIFT_ADMISSION_REFUSED code=${outcome.refusal.code} paths=${outcome.paths.join(", ")} — ${outcome.refusal.detail}`;
    case "probe-failed":
      return `⚠ LOCKFILE_DRIFT_PROBE_FAILED — ${outcome.detail}; nothing decided`;
  }
}
