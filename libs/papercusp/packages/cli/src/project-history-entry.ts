/** Packaged entry point for the standalone Project History generator. */
import { cmdProjectHistory } from './project-history-cli.ts';

try {
  await cmdProjectHistory(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`papercusp project-history: ${message}\n`);
  process.exitCode = 1;
}
