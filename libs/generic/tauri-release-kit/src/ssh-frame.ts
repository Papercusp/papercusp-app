/**
 * SSH "frame" for remote (Mac/Windows) builds — the generic transport the VM
 * target drivers compose. Arg construction matches bin/build-windows-on-vm.sh
 * exactly (IdentitiesOnly pin + ConnectTimeout + ServerAliveInterval; ssh -p,
 * scp -P). All execution goes through the injected Exec port, so the
 * choreography is unit-testable with a fake.
 */
import type { ExecOptions, ExecPort, ExecResult, VmConfig } from './types.js';

function target(vm: VmConfig): string {
  return `${vm.user}@${vm.host}`;
}

/** Shared -o options pinning auth to the one key (see WI-800 note in the script). */
function commonOpts(vm: VmConfig): string[] {
  return ['-i', vm.identityFile, '-o', 'IdentitiesOnly=yes'];
}

export function sshArgs(vm: VmConfig, remoteCommand: string): string[] {
  return [
    ...commonOpts(vm),
    '-p',
    String(vm.port),
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=30',
    target(vm),
    remoteCommand,
  ];
}

export function scpUploadArgs(vm: VmConfig, localPath: string, remotePath: string): string[] {
  return [
    ...commonOpts(vm),
    '-P',
    String(vm.port),
    '-o',
    'ConnectTimeout=10',
    localPath,
    `${target(vm)}:${remotePath}`,
  ];
}

export function scpDownloadArgs(vm: VmConfig, remotePath: string, localPath: string): string[] {
  return [
    ...commonOpts(vm),
    '-P',
    String(vm.port),
    '-o',
    'ConnectTimeout=10',
    `${target(vm)}:${remotePath}`,
    localPath,
  ];
}

/** A thin handle over the Exec port for one VM frame. */
export class SshFrame {
  constructor(
    private readonly vm: VmConfig,
    private readonly exec: ExecPort,
  ) {}

  run(remoteCommand: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.exec.run('ssh', sshArgs(this.vm, remoteCommand), opts);
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const r = await this.exec.run('scp', scpUploadArgs(this.vm, localPath, remotePath));
    if (r.code !== 0) {
      throw new Error(`scp upload ${localPath} → ${remotePath} failed: ${r.stderr || r.stdout}`);
    }
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const r = await this.exec.run('scp', scpDownloadArgs(this.vm, remotePath, localPath));
    if (r.code !== 0) {
      throw new Error(`scp download ${remotePath} → ${localPath} failed: ${r.stderr || r.stdout}`);
    }
  }

  /** Best-effort reachability probe; the caller decides how to react. */
  async reachable(probe = 'echo VM-OK'): Promise<boolean> {
    const r = await this.run(probe);
    return r.code === 0;
  }
}
