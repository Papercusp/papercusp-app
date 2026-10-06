/**
 * The production wiring for `lsp-apply.ts` — the only place its injected seams
 * are bound to real effects.
 *
 * `lsp-apply.ts` is deliberately effect-free so its six invariants can be
 * proven at a race and a fault (see its header). This file is the other half of
 * that bargain: it is thin enough to read in one sitting, and every line is a
 * binding rather than a decision, so the tested module stays the whole of the
 * behaviour.
 *
 * ⚠ It is NOT part of `lsp-facade.ts`. That module's contract is that turning
 * it on cannot change a byte, and importing a writer into it would make that
 * claim untrue by inspection even if no facade op ever called it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import { guardFileLock, type FileLockCtx } from '../agent-tools/locks/file-lock-guard';
import { computeLspDaemonRename, countLspDaemonDiagnostics, resyncLspDaemonDocument } from './lsp-daemon-client.ts';
import { activeWorkspaceId } from '../workspace-registry.ts';
import { readIdentity } from '../agent-tools/locks/identity.ts';
import type { ApplyDeps, LockOutcome } from './lsp-apply.ts';

/**
 * BOTH gates, checked here rather than at the call site so there is no path
 * into the writer that skips one.
 *
 * The read flag is load-bearing and not redundant: `lsp.apply` computes its
 * edit through the same pinned servers the read facade governs, so honouring
 * only the write flag would let `CODE_INTEL_LSP=off` still spawn a language
 * server and still write files — the opposite of what an operator turning the
 * subsystem off means by it.
 */
async function bothFlagsEnabled(): Promise<{ ok: true } | { ok: false; message: string }> {
  // `.catch(() => false)` matches the read facade, and matters more here: if the
  // flag service cannot be reached we do not know whether an operator has turned
  // this capability off, and the safe reading of "unknown" for a WRITER is off.
  if (!(await getFlag(FLAGS.CODE_INTEL_LSP, 'system').catch(() => false))) {
    return {
      ok: false,
      message:
        `code intelligence is disabled (${FLAGS.CODE_INTEL_LSP} is off), so no language server ` +
        `may be consulted and nothing can be applied`,
    };
  }
  if (!(await getFlag(FLAGS.CODE_INTEL_LSP_APPLY, 'system').catch(() => false))) {
    return {
      ok: false,
      message:
        `lsp.apply is disabled (${FLAGS.CODE_INTEL_LSP_APPLY} is off); the code-intelligence ` +
        `subsystem is read-only. Use lsp:query op:"refactor_preview" to see what a rename would touch.`,
    };
  }
  return { ok: true };
}

/**
 * Diagnostics as a COUNT, or `null` when the answer is not evidence.
 *
 * `isTrustworthyEmpty` is the predicate that separates "this file is clean"
 * from "the server could not tell us" — the same distinction the read facade
 * turns on. Collapsing them here would make every unmeasurable delta report as
 * an improvement, which is the most flattering possible way to be wrong about
 * a write that just landed.
 */
async function diagnosticCount(absPath: string, rootPath: string, workspaceId: string, actorId: string): Promise<number | null> {
  try {
    return await countLspDaemonDiagnostics({ file: absPath, rootPath, workspaceId, actorId });
  } catch {
    return null;
  }
}

/**
 * Bind the writer to the real lock authority, filesystem, flags and adapter.
 *
 * `ctx` is the dispatching tool's context; it carries the identity and project
 * dir the lock authority keys on, and passing it through is what makes an
 * `lsp.apply` lock contend with a peer's PreToolUse hook lock on the same file
 * rather than sitting in a private namespace nobody else takes.
 */
export function defaultApplyDeps(ctx: FileLockCtx): ApplyDeps {
  const workspaceId = ctx.workspaceId ?? activeWorkspaceId();
  const actorId = readIdentity(ctx).ownerId;
  return {
    flagsEnabled: bothFlagsEnabled,
    computeEdit: async (req) => {
      try {
        const r = await computeLspDaemonRename({
          file: req.file,
          line1: req.line1,
          character: req.character,
          rootPath: req.rootPath,
          newName: req.newName,
          workspaceId,
          actorId,
        });
        return r.ok
          ? {
              ok: true,
              edit: r.edit,
              projectRoot: r.projectRoot,
              completenessProven: r.completenessProven,
              completenessWarning: r.completenessWarning,
            }
          : { ok: false, error: r.error };
      } catch (error) {
        return { ok: false, error: `LSP daemon unavailable: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    realpath: realpathSync,
    readText: (p) => readFile(p, 'utf8'),
    writeText: (p, t) => writeFile(p, t, 'utf8'),
    withLock: async <T,>(absPaths: string[], run: () => Promise<T>): Promise<LockOutcome<T>> => {
      // INVARIANT 2. `failClosed` inverts guardFileLock's default: a wide,
      // offset-based, multi-file rewrite would rather not happen than happen
      // during a lock-authority outage.
      const outcome = await guardFileLock(
        ctx,
        absPaths,
        { intent: 'lsp:apply rename', failClosed: true },
        run,
      );
      if (outcome.acquired) {
        return { acquired: true, result: outcome.result, coordinated: outcome.coordinated };
      }
      return {
        acquired: false,
        lockUnavailable: 'lockUnavailable' in outcome ? outcome.lockUnavailable : undefined,
        error: 'error' in outcome ? outcome.error : undefined,
        busy: outcome.busy,
      };
    },
    resync: async (absPath, rootPath, newText) => {
      try { return await resyncLspDaemonDocument({ file: absPath, rootPath, newText, workspaceId, actorId }); }
      catch { return false; }
    },
    diagnosticCount: (absPath, rootPath) => diagnosticCount(absPath, rootPath, workspaceId, actorId),
    now: () => Date.now(),
  };
}
