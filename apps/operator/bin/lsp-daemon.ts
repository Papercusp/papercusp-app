#!/usr/bin/env node
import './boot-malloc-arena';
import './boot-integrity-first';
import './boot-flag-store';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { startSidecarParentDeathWatch } from '@papercusp/operator-core/lib/process-supervision/parent-death-watch';
import { createLspDaemonShutdown } from '../lib/lsp-daemon-shutdown';

if (process.env.PAPERCUSP_LSP_DAEMON_MODE === '1' || isCliEntry(import.meta.url)) {
  startSidecarParentDeathWatch();
  void import('@papercusp/operator-core/lib/code-intelligence/lsp-daemon-server').then(
    ({ runLspDaemonServer }) => runLspDaemonServer(undefined, undefined, createLspDaemonShutdown()),
    (error) => { console.error('[lsp-daemon] fatal boot:', error); process.exit(1); },
  );
}
