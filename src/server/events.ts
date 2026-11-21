import type { LinkStatus, Message } from './types.js';

export type AppEvent = { type: 'message'; message: Message } | { type: 'link'; status: LinkStatus };

export class EventBus {
  private readonly listeners = new Set<(e: AppEvent) => void>();

  publish(e: AppEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // One broken listener must not stop the others.
      }
    }
  }

  subscribe(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
