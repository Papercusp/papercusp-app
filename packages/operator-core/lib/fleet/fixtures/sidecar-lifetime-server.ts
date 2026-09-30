/** Separate-process fixture: real IPC, exec and kernel containment; admission
 * persistence is replaced with an explicit test barrier. Never used at runtime. */
import { writeFile } from 'node:fs/promises';
import { runSpawnerSidecarServer } from '../spawner-sidecar-server';
import { execProcess } from '../sidecar-exec-process';

runSpawnerSidecarServer({
  executeProcess: (params, deps) => execProcess(params, {
    ...deps,
    beginExecution: async () => {
      if (process.env.PC_TEST_WAIT_ADMISSION_PATH) {
        await writeFile(process.env.PC_TEST_WAIT_ADMISSION_PATH, 'waiting');
        // The test kills this process before admission is granted. No PID exists.
        await new Promise(() => {});
      }
      return {
        receiptId: 'fixture',
        context: { contractVersion: 1, requestId: 'fixture', rootRequestId: 'fixture', parentRequestId: null,
          idempotencyKey: 'fixture', admissionClass: 'process', priority: 0, demand: { cpuWeight: 1 },
          depth: 0, createdAtMs: 1, decisionGeneration: 1 },
        lease: { leaseId: 'fixture', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'fixture' },
        finish: async () => true, cancel: async () => true,
      };
    },
  }),
});
