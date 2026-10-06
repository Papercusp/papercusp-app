/**
 * P-005 (green-gate-zero-wait-convergence-2026-09-08, R-5, D-001): `gen:*:check` legs
 * SELF-HEAL on the frozen lineage.
 *
 * A `gen:<x>:check` guard (`AFFECTED_GUARD` from scripts/affected-tests.mjs, reaching the
 * repair signature as a `<workspace> :: gen:<x>:check` workspace-task entry) fails only
 * when a generated artifact drifted from its source. The repair for that class is
 * MECHANICAL — run the paired writer `gen:<x>` — so a red made of these legs must never
 * wait for a fixer. On a repair-round red whose signature carries such entries the gate:
 *
 *   1. runs the paired writer INSIDE the frozen verification tree (the checkpoint tree
 *      materialized at repairHead — never canonical staging, D-001),
 *   2. re-runs the check in that same tree and stops here if it still fails,
 *   3. admits ONLY the writer's proved delta (paths the writer changed, measured as the
 *      dirty-set difference before/after the writer so pre-existing test debris never
 *      rides in) onto repairHead through the ordinary ledgered admission door, actor=gate,
 *      from a source commit built on repairHead in the integration root's object store —
 *      so the diff-tree proof is exact by construction (the base IS repairHead).
 *
 * R-5's contract: the leg fails only when regeneration itself fails. Every other
 * non-heal outcome is typed and logged LOUDLY (R-7) so a held red says why it held.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMISSION_GIT_DATE,
  admitPathsOntoRepairHead,
  realAdmissionGit,
  type AdmissionGitRunner,
  type AdmissionOutcome,
  type AdmissionRefusal,
  type AdmitPathsInput,
} from "@papercusp/operator-core/lib/release/repair-head-admission";
import {
  markFrozenRepairAdmitted,
  parseRepairTaskId,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

/** Admissions made by this path are recorded under the gate's own identity (same as P-008). */
export const GEN_CHECK_SELF_HEAL_ACTOR = "gate";

/** Bounded to one heal attempt per gate run: a writer that keeps drifting is a real bug. */
export const GEN_CHECK_SELF_HEAL_MAX_ATTEMPTS_PER_RUN = 1;

const GEN_CHECK_SHAPE = /^gen:([a-z0-9-]+):check$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** `gen:<x>:check` → `gen:<x>`; anything else → null. The pairing is the root package.json
 *  convention (every `gen:*:check` there is `<writer> --check`), not a registry to maintain. */
export function pairedGenWriter(script: string): string | null {
  const m = GEN_CHECK_SHAPE.exec(script.trim());
  return m ? `gen:${m[1]}` : null;
}

export interface GenCheckEntry {
  /** The signature entry id exactly as recorded (`<ws> :: gen:x:check` or bare `gen:x:check`). */
  id: string;
  check: string;
  writer: string;
}

/** The subset of a red signature this path can heal. Accepts the workspace-task shape
 *  affected-tests emits and a bare script id; every other entry is somebody else's. */
export function genCheckEntriesOf(
  signature: readonly { id: string }[],
): GenCheckEntry[] {
  const out: GenCheckEntry[] = [];
  const seen = new Set<string>();
  for (const entry of signature) {
    const id = entry.id.trim();
    const script = parseRepairTaskId(id)?.script ?? id;
    const writer = pairedGenWriter(script);
    if (!writer || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, check: script, writer });
  }
  return out;
}

export type GenCheckHealOutcome =
  | { kind: "nothing-to-heal" }
  | {
      kind: "healed";
      healedIds: string[];
      entry: FrozenRepairAdmission;
      fromRepairHead: string;
      toRepairHead: string;
      paths: string[];
      reason: string;
      /** Fresh queue used when another admission moved the lineage during verification. */
      refreshedQueue?: FrozenCandidateRepairQueue;
    }
  /** R-5's one legitimate failure: the paired writer itself exited non-zero / threw. */
  | { kind: "regeneration-failed"; id: string; writer: string; detail: string }
  /** The writer ran clean but changed nothing — the check red is not artifact drift. */
  | { kind: "no-delta"; ids: string[] }
  /** Regenerated, yet the check still fails in the same tree — nothing is admitted. */
  | { kind: "recheck-failed"; id: string; check: string; detail: string; paths: string[] }
  | { kind: "admission-refused"; refusal: AdmissionRefusal; paths: string[] }
  | { kind: "probe-failed"; detail: string };

export interface GenCheckHealIo {
  /** Run one ROOT npm script in the frozen verification tree (checkpoint root at repairHead). */
  runScript(script: string): Promise<{ code: number; tail: string }>;
  /** Repo-relative paths currently dirty (modified + untracked) in the verification tree. */
  dirtyPaths(): Promise<string[]>;
  /** Build an unreferenced commit on `repairHead` in the integration root carrying the
   *  verification tree's current content for `paths`. Returns the sha. */
  buildSourceCommit(repairHead: string, paths: readonly string[]): Promise<string>;
  admit(input: AdmitPathsInput): AdmissionOutcome;
  /** Re-read the queue and rematerialize its current head after a lineage CAS loss. */
  refreshAfterRefMove?(
    previous: Pick<FrozenCandidateRepairQueue, "candidate" | "repairHead">,
  ): Promise<FrozenCandidateRepairQueue | null>;
  log(line: string): void;
  now?: () => number;
}

export interface GenCheckHealInput {
  /** Superproject root holding the frozen lineage (cfg.integrationRoot). */
  root: string;
  queue: Pick<FrozenCandidateRepairQueue, "candidate" | "repairHead">;
  /** The fresh red signature verifyRepairHead measured at queue.repairHead. */
  signature: readonly { id: string }[];
}

function buildReason(healed: GenCheckEntry[], paths: string[], from: string): string {
  return (
    `P-005 gen:*:check self-heal: ${healed.map((h) => h.check).join(", ")} failed at repairHead ` +
    `${from.slice(0, 12)}; ran paired writer(s) ${[...new Set(healed.map((h) => h.writer))].join(", ")} ` +
    `in the frozen verification tree, re-check passed, admitted only the writer delta ` +
    `(${paths.join(", ")}) hunk-exact from a source commit built on repairHead`
  );
}

/**
 * Heal the `gen:*:check` members of a red signature. Never throws for plumbing: that is
 * `probe-failed`. Nothing is published unless the re-check PASSED in the regenerated tree.
 */
export async function healGenCheckLegs(
  io: GenCheckHealIo,
  input: GenCheckHealInput,
): Promise<GenCheckHealOutcome> {
  const now = io.now ?? Date.now;
  const entries = genCheckEntriesOf(input.signature);
  if (entries.length === 0) return { kind: "nothing-to-heal" };
  let queue = input.queue;
  let refreshedQueue: FrozenCandidateRepairQueue | undefined;
  // The selective verification can take long enough for a human fixer to admit a
  // second change. Re-run the generator against that NEW head: replaying the old
  // artifact would be wrong if the admitted change touched generator inputs.
  for (let attempt = 0; attempt < 3; attempt++) {
  const from = queue.repairHead;
  let before: Set<string>;
  try {
    before = new Set(await io.dirtyPaths());
  } catch (e) {
    return { kind: "probe-failed", detail: `dirty-set probe before writer: ${errMsg(e)}` };
  }
  for (const writer of [...new Set(entries.map((e) => e.writer))]) {
    const owner = entries.find((e) => e.writer === writer)!;
    let r: { code: number; tail: string };
    try {
      r = await io.runScript(writer);
    } catch (e) {
      return { kind: "regeneration-failed", id: owner.id, writer, detail: errMsg(e) };
    }
    if (r.code !== 0) {
      return {
        kind: "regeneration-failed",
        id: owner.id,
        writer,
        detail: `exit ${r.code}${r.tail ? ` — ${r.tail.slice(-400)}` : ""}`,
      };
    }
  }
  let paths: string[];
  try {
    const after = await io.dirtyPaths();
    paths = [...new Set(after.filter((p) => !before.has(p)))].sort();
  } catch (e) {
    return { kind: "probe-failed", detail: `dirty-set probe after writer: ${errMsg(e)}` };
  }
  if (paths.length === 0) return { kind: "no-delta", ids: entries.map((e) => e.id) };
  for (const entry of entries) {
    let r: { code: number; tail: string };
    try {
      r = await io.runScript(entry.check);
    } catch (e) {
      return { kind: "recheck-failed", id: entry.id, check: entry.check, detail: errMsg(e), paths };
    }
    if (r.code !== 0) {
      return {
        kind: "recheck-failed",
        id: entry.id,
        check: entry.check,
        detail: `exit ${r.code}${r.tail ? ` — ${r.tail.slice(-400)}` : ""}`,
        paths,
      };
    }
  }
  let sourceCommit: string;
  try {
    sourceCommit = await io.buildSourceCommit(from, paths);
  } catch (e) {
    return { kind: "probe-failed", detail: `source commit build: ${errMsg(e)}` };
  }
  const reason = buildReason(entries, paths, from);
  const outcome = io.admit({
    root: input.root,
    candidate: queue.candidate,
    repairHead: from,
    paths,
    source: { ref: sourceCommit },
    actor: GEN_CHECK_SELF_HEAL_ACTOR,
    reason,
    nowMs: now(),
  });
  if (!outcome.ok) {
    if (outcome.code !== "lineage-ref-moved" || !io.refreshAfterRefMove || attempt === 2) {
      return { kind: "admission-refused", refusal: outcome, paths };
    }
    let fresh: FrozenCandidateRepairQueue | null;
    try {
      fresh = await io.refreshAfterRefMove(queue);
    } catch (e) {
      return { kind: "probe-failed", detail: `refresh after lineage move: ${errMsg(e)}` };
    }
    if (!fresh || fresh.candidate !== input.queue.candidate || fresh.repairHead === from) {
      return { kind: "admission-refused", refusal: outcome, paths };
    }
    queue = fresh;
    refreshedQueue = fresh;
    continue;
  }
  return {
    kind: "healed",
    healedIds: entries.map((e) => e.id),
    entry: outcome.entry,
    fromRepairHead: from,
    toRepairHead: outcome.commit,
    paths,
    reason,
    ...(refreshedQueue ? { refreshedQueue } : {}),
  };
  }
  throw new Error("gen-check self-heal retry bound was not respected");
}

/** Fold a `healed` outcome into the queue row (advances repairHead; P-001 retest marker set). */
export function applyGenCheckHeal(
  queue: FrozenCandidateRepairQueue,
  outcome: Extract<GenCheckHealOutcome, { kind: "healed" }>,
): FrozenCandidateRepairQueue {
  return markFrozenRepairAdmitted(queue, outcome.entry);
}

/** The red signature with the healed entries removed — what remains is somebody else's red. */
export function signatureWithoutHealed<T extends { id: string }>(
  signature: readonly T[],
  outcome: Extract<GenCheckHealOutcome, { kind: "healed" }>,
): T[] {
  const healed = new Set(outcome.healedIds);
  return signature.filter((entry) => !healed.has(entry.id.trim()));
}

/** One log line per outcome; the non-heal shapes are LOUD by design (R-7). */
export function describeGenCheckHeal(outcome: GenCheckHealOutcome): string {
  switch (outcome.kind) {
    case "nothing-to-heal":
      return "no gen:*:check entries in the red signature";
    case "healed":
      return (
        `HEALED ${outcome.healedIds.join(", ")}: paired writer delta admitted onto ` +
        `${outcome.fromRepairHead.slice(0, 8)} → ${outcome.toRepairHead.slice(0, 8)} (actor=${GEN_CHECK_SELF_HEAL_ACTOR}): ${outcome.paths.join(", ")}`
      );
    case "regeneration-failed":
      return `⚠ GEN_CHECK_REGENERATION_FAILED ${outcome.writer} for ${outcome.id} — ${outcome.detail}; the leg stays red (R-5: regeneration itself failed)`;
    case "no-delta":
      return `⚠ GEN_CHECK_NO_DELTA ${outcome.ids.join(", ")} — the paired writer changed nothing in the verification tree, so this red is not artifact drift; a fixer must look`;
    case "recheck-failed":
      return `⚠ GEN_CHECK_RECHECK_FAILED ${outcome.check} for ${outcome.id} after regeneration (delta ${outcome.paths.join(", ")} NOT admitted) — ${outcome.detail}`;
    case "admission-refused":
      return `⚠ GEN_CHECK_ADMISSION_REFUSED code=${outcome.refusal.code} paths=${outcome.paths.join(", ")} — ${outcome.refusal.detail}`;
    case "probe-failed":
      return `⚠ GEN_CHECK_HEAL_PROBE_FAILED — ${outcome.detail}; nothing decided`;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ── real io ─────────────────────────────────────────────────────────────────────────── */

export interface RealGenCheckHealIoInput {
  /** The frozen verification tree, already materialized at repairHead. */
  checkpointRoot: string;
  /** The superproject root holding the lineage ref (cfg.integrationRoot). */
  integrationRoot: string;
  /** Run one root npm script in `checkpointRoot` (the gate's own exec, so pc-heavy / env apply). */
  runScript(script: string): Promise<{ code: number; tail: string }>;
  log(line: string): void;
  refreshAfterRefMove?: GenCheckHealIo["refreshAfterRefMove"];
  git?: AdmissionGitRunner;
}

/** Parse `git status --porcelain=v1 -z` into repo-relative paths (renames report the new name). */
export function parsePorcelainZ(out: string): string[] {
  const paths: string[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    const p = f.slice(3);
    paths.push(p);
    // A rename/copy record is followed by the ORIGINAL path as its own NUL field — skip it.
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return paths;
}

export function makeRealGenCheckHealIo(input: RealGenCheckHealIoInput): GenCheckHealIo {
  const git = input.git ?? realAdmissionGit;
  const gitOk = (argv: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string => {
    const r = git(argv, { cwd, env: env ? { ...process.env, ...env } : undefined });
    if (r.status !== 0) {
      throw new Error(`git ${argv.join(" ")} (cwd ${cwd}) exited ${r.status}: ${(r.stderr ?? "").trim().slice(-300)}`);
    }
    return r.stdout ?? "";
  };
  return {
    runScript: input.runScript,
    log: input.log,
    ...(input.refreshAfterRefMove ? { refreshAfterRefMove: input.refreshAfterRefMove } : {}),
    async dirtyPaths() {
      return parsePorcelainZ(
        gitOk(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], input.checkpointRoot),
      );
    },
    async buildSourceCommit(repairHead, paths) {
      if (!SHA_RE.test(repairHead)) throw new Error(`repairHead is not a full sha: ${repairHead}`);
      const scratch = mkdtempSync(join(tmpdir(), "papercusp-gen-check-heal-"));
      // Fixed dates make every heal commit a pure function of tree, parent and message, so a
      // submodule commit can be published (gate-pin tag) before the gate builds it again.
      const identity = {
        GIT_AUTHOR_NAME: "papercusp-gate",
        GIT_AUTHOR_EMAIL: "gate@papercusp.invalid",
        GIT_AUTHOR_DATE: ADMISSION_GIT_DATE,
        GIT_COMMITTER_NAME: "papercusp-gate",
        GIT_COMMITTER_EMAIL: "gate@papercusp.invalid",
        GIT_COMMITTER_DATE: ADMISSION_GIT_DATE,
      };
      let indexes = 0;
      const commitTree = (repo: string, tree: string, parent: string, title: string, staged: readonly string[]): string => {
        const message = `${title} ${parent.slice(0, 12)}\n\npaths:\n` + staged.map((p) => `- ${p}`).join("\n") + "\n";
        const commit = gitOk(["commit-tree", tree, "-p", parent, "-m", message], repo, identity).trim();
        if (!SHA_RE.test(commit)) throw new Error(`commit-tree in ${repo} produced no sha`);
        return commit;
      };
      // `repo` is the integration-side repository whose object store receives the commit;
      // `checkout` is the matching verification-tree directory the writer ran in.
      const stageTree = (repo: string, checkout: string, base: string, staged: readonly string[]): string => {
        const indexEnv = { GIT_INDEX_FILE: join(scratch, `index-${indexes++}`) };
        gitOk(["read-tree", base], repo, indexEnv);
        for (const p of staged) {
          const abs = join(checkout, p);
          // A writer may DELETE a stale artifact; that is a removal in the source commit.
          const exists = existsSync(abs);
          if (!exists) {
            gitOk(["update-index", "--force-remove", "--", p], repo, indexEnv);
            continue;
          }
          // git status reports a writer delta INSIDE a submodule as the gitlink path itself,
          // and hash-object cannot hash a directory. Commit the submodule's own delta on its
          // pin and stage that commit as the gitlink.
          const pin = /^160000 commit ([0-9a-f]{40})\t/.exec(gitOk(["ls-tree", base, "--", p], repo))?.[1];
          if (pin) {
            const sub = submoduleCommit(join(repo, p), abs, pin);
            gitOk(["update-index", "--add", "--replace", "--cacheinfo", `160000,${sub},${p}`], repo, indexEnv);
            continue;
          }
          // The only consumer is the 100755-vs-100644 cacheinfo mode below, which git
          // derives from the file's EXECUTE BITS — so read them directly rather than
          // spawning `test -x` per path (a start outside admission, and one subprocess
          // per artifact). `lint:resource-governor-enforcement` requires every start to
          // route through Governor.admit; the cheapest compliance is not to start.
          const isExec = (statSync(abs).mode & 0o111) !== 0;
          const blob = gitOk(["hash-object", "-w", "--path", p, "--", abs], repo).trim();
          if (!SHA_RE.test(blob)) throw new Error(`hash-object ${p} produced no sha`);
          gitOk(
            ["update-index", "--add", "--replace", "--cacheinfo", `${isExec ? "100755" : "100644"},${blob},${p}`],
            repo,
            indexEnv,
          );
        }
        const tree = gitOk(["write-tree"], repo, indexEnv).trim();
        if (!SHA_RE.test(tree)) throw new Error(`write-tree in ${repo} produced no sha`);
        return tree;
      };
      const submoduleCommit = (repo: string, checkout: string, pin: string): string => {
        // Only the writer's delta may ride on the pin; a moved submodule HEAD is not one.
        const head = gitOk(["rev-parse", "HEAD"], checkout).trim();
        if (head !== pin) {
          throw new Error(`submodule ${checkout} is at ${head.slice(0, 12)}, not its pin ${pin.slice(0, 12)}`);
        }
        const inner = parsePorcelainZ(
          gitOk(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], checkout),
        ).sort();
        if (inner.length === 0) throw new Error(`submodule ${checkout} reported dirty but has no changed paths`);
        const commit = commitTree(repo, stageTree(repo, checkout, pin, inner), pin, "gen:*:check self-heal submodule source on", inner);
        // The verification checkout clones each submodule from this repository, and gc
        // would prune an unreferenced commit before the lineage is promoted. Promotion
        // publishes it by this ref (publishGenHealGitlinks).
        gitOk(["update-ref", genHealRef(commit), commit], repo);
        return commit;
      };
      try {
        const tree = stageTree(input.integrationRoot, input.checkpointRoot, repairHead, paths);
        return commitTree(input.integrationRoot, tree, repairHead, "gen:*:check self-heal source on", paths);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    admit: admitPathsOntoRepairHead,
  };
}

/** The local ref that marks (and keeps from gc) a heal-built submodule commit. */
export function genHealRef(sha: string): string {
  return `refs/papercusp/gen-heal/${sha}`;
}

/** The tag promotion publishes on the submodule's origin for a heal-built commit. */
export function genHealPinTag(sha: string): string {
  return `refs/tags/gate-pin/${sha}`;
}

/**
 * Promotion pushes the superproject with a plain `git push`, which never checks that a
 * gitlink's commit exists on the submodule's origin. A heal-built submodule commit exists
 * only in the integration tree, so a promoted main pinning one would not resolve for a
 * fresh clone. Push a gate-pin tag for every gitlink in `candidateSha` that carries a
 * gen-heal ref (recursing into heal-built commits for nested submodules). Throws on any
 * failed publication, which holds promotion before main moves.
 */
export async function publishGenHealGitlinks(input: {
  integrationRoot: string;
  candidateSha: string;
  /** Runs `git <argv>` in `cwd` without throwing on a non-zero exit. */
  git?: (argv: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}): Promise<{ path: string; sha: string }[]> {
  const git =
    input.git ??
    (async (argv: string[], cwd: string) => {
      const r = realAdmissionGit(argv, { cwd });
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    });
  const published: { path: string; sha: string }[] = [];
  const visit = async (repo: string, commit: string, prefix: string): Promise<void> => {
    const listed = await git(["ls-tree", "-r", "-z", commit], repo);
    if (listed.code !== 0) {
      throw new Error(`git ls-tree -r ${commit.slice(0, 12)} (cwd ${repo}) exited ${listed.code}: ${listed.stderr.trim().slice(-300)}`);
    }
    for (const record of listed.stdout.split("\0")) {
      const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(record);
      if (!m) continue;
      const [, sha, path] = m as unknown as [string, string, string];
      // An uninitialized or absent submodule cannot hold the ref, so it is skipped here too.
      const subRepo = join(repo, path);
      if ((await git(["rev-parse", "--verify", "--quiet", genHealRef(sha)], subRepo)).code !== 0) continue;
      const pushed = await git(["push", "origin", `${sha}:${genHealPinTag(sha)}`], subRepo);
      if (pushed.code !== 0) {
        throw new Error(
          `gate-pin publication for ${prefix}${path}@${sha.slice(0, 12)} failed (exit ${pushed.code}): ` +
            pushed.stderr.trim().slice(-300),
        );
      }
      published.push({ path: `${prefix}${path}`, sha });
      await visit(subRepo, sha, `${prefix}${path}/`);
    }
  };
  await visit(input.integrationRoot, input.candidateSha, "");
  return published;
}
