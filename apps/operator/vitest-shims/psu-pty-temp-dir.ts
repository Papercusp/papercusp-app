/**
 * Integration-test isolation for the managed-pty host/discovery seam.
 *
 * Real hostThroughPty tests intentionally emit lifecycle rows, sockets, and
 * discovery metadata. Redirect both writer and reader before their modules are
 * evaluated so those rows cannot masquerade as live fleet evidence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

if (!process.env.PAPERCUSP_PSU_PTY_DIR) {
  process.env.PAPERCUSP_PSU_PTY_DIR = mkdtempSync(join(tmpdir(), 'papercusp-psu-pty-itest-'));
  process.env.PAPERCUSP_PSU_PTY_DIR_AUTOCLEAN = '1';
}

if (process.env.PAPERCUSP_PSU_PTY_DIR_AUTOCLEAN === '1') {
  const isolatedDir = process.env.PAPERCUSP_PSU_PTY_DIR;
  afterAll(() => rmSync(isolatedDir, { recursive: true, force: true }));
}
