'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktopTestScratchRoot = path.join(os.tmpdir(), 'papercusp-desktop-tests');

function makeDesktopTestScratchDirSync(prefix) {
  fs.mkdirSync(desktopTestScratchRoot, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(desktopTestScratchRoot, prefix));
}

async function makeDesktopTestScratchDir(prefix) {
  await fs.promises.mkdir(desktopTestScratchRoot, { recursive: true, mode: 0o700 });
  return fs.promises.mkdtemp(path.join(desktopTestScratchRoot, prefix));
}

module.exports = {
  desktopTestScratchRoot,
  makeDesktopTestScratchDir,
  makeDesktopTestScratchDirSync,
};
