/**
 * HotReloader — dev-mode file watcher backing `papercusp plugin watch`
 * (libs/papercusp/packages/cli/src/plugin-cli.ts `cmdPluginWatch`).
 *
 * Watches a plugin's source directory for changes so the CLI can print a
 * "restart needed" hint. It does NOT hot-swap the running `papercusp run`
 * process's already-loaded module — tsx/node's module cache makes a true
 * in-place reload of arbitrary plugin code unreliable, so there is no
 * general way to do that safely here. "reloaded" therefore means only that
 * `papercusp.json` was re-read after the change and still parses with a
 * `name` + `version` — enough to catch a broken manifest edit immediately
 * instead of at the next `papercusp run`.
 *
 * No external watch library: `fs.watch(dir, { recursive: true })` has been
 * supported on Linux/macOS/Windows since Node 20, and this repo pins
 * Node >=25 (see root package.json `engines`).
 */
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export interface HotReloaderOptions {
  /** Debounce window for coalescing bursts of fs events (default 300ms). */
  debounceMs?: number;
}

export interface ReloadedPlugin {
  name: string;
  version: string;
}

// Skip noise from build/VCS output that isn't plugin source.
const IGNORED_SEGMENT = /(^|[/\\])(node_modules|\.git|dist)([/\\]|$)/;

/**
 * Events:
 *   'changed'  { changedAt: Date }                — a debounced fs change fired.
 *   'reloaded' { plugin: { name, version } }        — papercusp.json re-read OK.
 *   'error'    { error: Error }                     — watch failure, or the
 *                                                      manifest failed to
 *                                                      parse / is missing
 *                                                      required fields.
 */
export class HotReloader extends EventEmitter {
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly targetDir: string,
    opts: HotReloaderOptions = {},
  ) {
    super();
    this.debounceMs = opts.debounceMs ?? 300;
  }

  async start(): Promise<void> {
    this.watcher = watch(this.targetDir, { recursive: true }, (_eventType, filename) => {
      const path = filename ? filename.toString() : '';
      if (path && IGNORED_SEGMENT.test(path)) return;
      this.scheduleChange();
    });
    this.watcher.on('error', (error: unknown) => {
      this.emit('error', { error: error instanceof Error ? error : new Error(String(error)) });
    });
  }

  private scheduleChange(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.onDebouncedChange();
    }, this.debounceMs);
  }

  private async onDebouncedChange(): Promise<void> {
    this.emit('changed', { changedAt: new Date() });
    try {
      const plugin = await this.readManifestSummary();
      if (plugin) {
        this.emit('reloaded', { plugin });
      } else {
        this.emit('error', {
          error: new Error(`papercusp.json in ${this.targetDir} is missing "name" or "version"`),
        });
      }
    } catch (error) {
      this.emit('error', { error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  private async readManifestSummary(): Promise<ReloadedPlugin | null> {
    const raw = await readFile(join(this.targetDir, 'papercusp.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReloadedPlugin>;
    if (!parsed.name || !parsed.version) return null;
    return { name: parsed.name, version: parsed.version };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }
}
