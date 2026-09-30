/**
 * Shell syntax detector — the pure half of a `bash -n` check, lifted into an
 * importable module for the git-sync content guard (EI-13192).
 *
 * EI-13192: a concurrent shared-tree edit interleave duplicated ~475 lines of
 * `papercusp-desktop/bin/build-windows-on-vm.sh` (plus truncated one variable
 * assignment) and git-sync auto-committed the corrupted 1584-line file before
 * the editing agent ran `bash -n` by hand to notice. `bash -n` catches this
 * class of damage IMMEDIATELY and for free — it is the real bash parser doing
 * a syntax-only pass (no execution), the exact same command a careful agent
 * runs after a suspicious edit. Wiring it into the SAME content-guard registry
 * `mdx`/`smart-quotes` already use (git-sync-content-guard-2026-06-13) means a
 * syntactically-broken `.sh` is quarantined — never silently committed — with
 * no new mechanism.
 *
 * Not fully pure (shells out to the real `bash` binary rather than parsing in
 * JS), but deterministic and read-only: same input text always yields the same
 * verdict, and nothing on disk is touched. Mirrors `findMdxCompileError`'s
 * shape: never throws on a syntax error (caught + returned); a failure to
 * SPAWN bash at all propagates so the caller can decide (the git-sync guard's
 * detector loop already fails open on a throwing detector).
 */
import { execFileSync } from 'node:child_process';

export interface ShellSyntaxError {
  line: number | null;
  reason: string;
}

/** Bound the check so a pathological input can never hang git-sync's tick. */
const BASH_SYNTAX_CHECK_TIMEOUT_MS = 5_000;

/**
 * Run `bash -n` over `text` via stdin (no temp file — the working-tree text is
 * already in memory). Returns `null` when it parses cleanly, or the parsed
 * `{ line, reason }` from bash's own stderr on a syntax error.
 */
export function findShellSyntaxError(text: string): ShellSyntaxError | null {
  try {
    execFileSync('bash', ['-n'], {
      input: text,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: BASH_SYNTAX_CHECK_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    const e = err as { stderr?: Buffer | string | null; message?: string };
    const stderrText = e.stderr != null ? String(e.stderr) : '';
    const raw = stderrText.trim() || (e.message ?? String(err));
    // `bash -n` reading from stdin reports errors like:
    //   bash: line 4: syntax error: unexpected end of file
    //   bash: line 12: syntax error near unexpected token `fi'
    const m = /line (\d+):\s*(.+)/.exec(raw);
    return { line: m ? Number(m[1]) : null, reason: (m ? m[2] : raw).split('\n')[0] };
  }
}
