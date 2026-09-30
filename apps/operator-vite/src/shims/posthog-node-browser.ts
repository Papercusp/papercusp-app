/** Server analytics is never active in the SPA bundle. */
export class PostHog {
  capture(): void {}
  identify(): void {}
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
