/**
 * P-013 startup-progress timer, run as its OWN small Node process.
 *
 * "Display meaningful startup progress immediately" is a property of the
 * launched binary: exec to the first "Starting PUI…" byte. Measured inside the
 * long-lived Vitest worker, that interval also carries the worker's event-loop
 * lateness (IPC from the forked operator, earlier panes' buffers, GC): the same
 * installed binary read 194–354 ms there and 18–26 ms here on the same box
 * (WI-10004247 run 6). A quiet process with nothing else on its loop measures
 * the product, not the harness.
 *
 * Input: one JSON argument { bin, args, cwd, env, cols, rows, launches }.
 * Output: one line `PUI_STARTUP_PROGRESS_TIMER <json>` with every sample (ms,
 * or null when the text never appeared within 10 s). Terminal queries are never
 * answered, like a bare pipe (the capability probe then waits its full 2 s).
 */
import { spawn as ptySpawn } from '@lydell/node-pty';

type Input = {
  bin: string; args: string[]; cwd: string; env: Record<string, string>;
  cols: number; rows: number; launches: number;
};

const input = JSON.parse(process.argv[2] ?? '{}') as Input;
const samples: Array<number | null> = [];
for (let launch = 0; launch < input.launches; launch += 1) {
  const started = performance.now();
  const pty = ptySpawn(input.bin, input.args, {
    name: 'xterm-256color', cols: input.cols, rows: input.rows, cwd: input.cwd, env: input.env,
  });
  const ms = await new Promise<number | null>((resolve) => {
    let raw = '';
    const timer = setTimeout(() => resolve(null), 10_000);
    pty.onData((chunk) => {
      raw += chunk;
      if (!raw.includes('Starting PUI')) return;
      clearTimeout(timer);
      resolve(performance.now() - started);
    });
  });
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  pty.kill('SIGKILL');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  samples.push(ms === null ? null : Math.round(ms * 10) / 10);
}
console.log(`PUI_STARTUP_PROGRESS_TIMER ${JSON.stringify({ samples })}`);
process.exit(0);
