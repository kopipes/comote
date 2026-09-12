import { EventEmitter } from "node:events";

export interface ComoteEvent {
  id: string;
  threadId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class EventHub {
  private readonly emitter = new EventEmitter();
  private readonly history = new Map<string, ComoteEvent[]>();
  private sequence = 0;

  publish(threadId: string, type: string, payload: Record<string, unknown>): ComoteEvent {
    const event: ComoteEvent = {
      id: `${Date.now()}-${++this.sequence}`,
      threadId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    const items = this.history.get(threadId) ?? [];
    items.push(event);
    if (items.length > 250) items.splice(0, items.length - 250);
    this.history.set(threadId, items);
    this.emitter.emit(threadId, event);
    this.emitter.emit("*", event);
    return event;
  }

  recent(threadId: string): ComoteEvent[] {
    return this.history.get(threadId) ?? [];
  }

  subscribe(threadId: string, listener: (event: ComoteEvent) => void): () => void {
    this.emitter.on(threadId, listener);
    return () => this.emitter.off(threadId, listener);
  }

  subscribeAll(listener: (event: ComoteEvent) => void): () => void {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }
}
