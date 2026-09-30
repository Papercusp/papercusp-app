/**
 * Node-backed implementations of the ports. This is the only module that
 * touches node built-ins — the pure core never imports it, so the core stays
 * dom-safe + borrowable. A host (a bin/release CLI) wires these in.
 */
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import type {
  ExecOptions,
  ExecPort,
  ExecResult,
  FsPort,
  LogPort,
  ReleasePorts,
} from './types.js';

export interface NodeExecOptions {
  /** Also stream child stdout/stderr to this process (default true). */
  inheritStdio?: boolean;
}

export function nodeExec(opts: NodeExecOptions = {}): ExecPort {
  const inherit = opts.inheritStdio ?? true;
  return {
    run(cmd, args, o?: ExecOptions): Promise<ExecResult> {
      return new Promise((resolve) => {
        const child = spawn(cmd, args, {
          cwd: o?.cwd,
          env: { ...process.env, ...(o?.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => {
          const s = d.toString();
          stdout += s;
          if (inherit) process.stdout.write(s);
        });
        child.stderr?.on('data', (d: Buffer) => {
          const s = d.toString();
          stderr += s;
          if (inherit) process.stderr.write(s);
        });
        child.on('error', (e) =>
          resolve({ code: 127, stdout, stderr: `${stderr}${String(e)}` }),
        );
        child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
      });
    },
  };
}

export function nodeFs(): FsPort {
  return {
    readText: (p) => readFile(p, 'utf8'),
    writeText: async (p, d) => {
      await writeFile(p, d);
    },
    exists: async (p) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    },
    readDir: async (dir) => {
      try {
        return await readdir(dir);
      } catch {
        return [];
      }
    },
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
  };
}

export function nodeLog(): LogPort {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}

/** Assemble the full set of node-backed ports. */
export function nodePorts(opts: NodeExecOptions = {}): ReleasePorts {
  return {
    exec: nodeExec(opts),
    fs: nodeFs(),
    log: nodeLog(),
    env: (name) => process.env[name],
    now: () => new Date().toISOString(),
  };
}
