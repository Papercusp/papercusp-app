/** Minimal request-context shim for client-reachable server modules. */
export class AsyncLocalStorage<T> {
  private value: T | undefined;

  run<R>(store: T, callback: () => R): R {
    const previous = this.value;
    this.value = store;
    try {
      return callback();
    } finally {
      this.value = previous;
    }
  }

  getStore(): T | undefined {
    return this.value;
  }

  enterWith(store: T): void {
    this.value = store;
  }

  disable(): void {
    this.value = undefined;
  }
}

/** Server-only context binding; exported so the SPA can link reachable workflow modules. */
export class AsyncResource {
  constructor() {
    throw new Error('node:async_hooks AsyncResource is server-only in the operator-vite browser bundle');
  }

  static bind(): never {
    throw new Error('node:async_hooks AsyncResource is server-only in the operator-vite browser bundle');
  }
}
