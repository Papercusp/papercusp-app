// WI-10004849: dependency-generation.sh serializes every physical dependency copy
// on this host behind one flock and refuses a copy without disk headroom. Tests
// that drive the shell copy tiny fixture trees; they must neither queue behind a
// real gate/deploy holding the host lock for a ~16 GB copy (a test would sit for
// minutes and time out) nor fail with exit 77 because the box is low on disk.
// Each worker gets a private lock file and a zero reserve/margin. Tests that
// exercise the lock or the headroom check set these variables explicitly.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DEPENDENCY_GENERATION_COPY_LOCK_FILE ??= join(
  tmpdir(),
  `papercusp-dependency-generation-copy.test-${process.pid}.lock`,
);
process.env.DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT ??= '0';
process.env.DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES ??= '0';
