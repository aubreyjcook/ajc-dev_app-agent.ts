/**
 * memory.ts — conversation storage.
 *
 * LLM APIs are stateless: every request must include the whole transcript.
 * "Memory" here just means "somewhere to keep that transcript between
 * requests". The agent asks `Memory.load()` for history before calling the
 * model, and `Memory.append()` to save what happened afterwards.
 *
 * `InMemoryMemory` is the simplest possible implementation. It is perfect for
 * tests, scripts, and single-process dev servers — and wrong for anything
 * with multiple server instances or restarts, because the `Map` is lost.
 * Implement the `Memory` interface against your database when you get there.
 */

import type { Memory, Message } from './types.js';

export class InMemoryMemory implements Memory {
  private readonly store = new Map<string, Message[]>();

  async load(conversationId: string): Promise<Message[]> {
    // Return a copy so callers cannot mutate our internal array by accident.
    return [...(this.store.get(conversationId) ?? [])];
  }

  async append(conversationId: string, messages: Message[]): Promise<void> {
    const existing = this.store.get(conversationId);
    if (existing) {
      existing.push(...messages);
    } else {
      this.store.set(conversationId, [...messages]);
    }
  }

  async clear(conversationId: string): Promise<void> {
    this.store.delete(conversationId);
  }

  /** Handy in tests / debugging. Not part of the `Memory` interface. */
  get conversationIds(): string[] {
    return [...this.store.keys()];
  }
}

/**
 * A `Memory` that remembers nothing. Use it when the *client* owns the
 * history (the common Next.js pattern: the browser sends the full transcript
 * with every request and stores the reply). See `docs/NEXTJS.md`.
 */
export class NullMemory implements Memory {
  async load(): Promise<Message[]> {
    return [];
  }
  async append(): Promise<void> {
    /* intentionally empty */
  }
  async clear(): Promise<void> {
    /* intentionally empty */
  }
}
