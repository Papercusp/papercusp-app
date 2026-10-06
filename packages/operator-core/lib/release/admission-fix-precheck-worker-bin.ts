import { runAdmissionPrecheckWorkerFromEnvironment } from './admission-fix-precheck-managed';

void runAdmissionPrecheckWorkerFromEnvironment().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error('[release:repair-queue] pre-check worker startup failed', error);
    process.exitCode = 1;
  },
);
