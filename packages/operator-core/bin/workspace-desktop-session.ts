#!/usr/bin/env node
import { runWorkspaceDesktopWorker } from '../lib/desktop/workspace-desktop-session-worker';
runWorkspaceDesktopWorker(process.argv.slice(2)).then(
  code => { process.exitCode = code; },
  () => { process.stderr.write('desktop session worker failed\n'); process.exitCode = 1; },
);
