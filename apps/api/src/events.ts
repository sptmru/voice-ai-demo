import type { Response } from 'express';
import type { AgentEvent, EmitEvent, Repository } from '../../../packages/core/src/domain.js';

/** Persistence is the source of truth. A subscriber is registered before replay;
 * its queue closes the race between replay SELECT and a concurrent publish. */
export class EventStream {
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private publishing = new Map<string, Promise<AgentEvent>>();
  private responses = new Map<string, Set<Response>>();
  constructor(private repo: Repository) {}
  async drain(sessionId: string) {
    await this.publishing.get(sessionId);
  }
  closeSession(sessionId: string) {
    for (const response of this.responses.get(sessionId) || []) response.end();
    this.responses.delete(sessionId);
    this.listeners.delete(sessionId);
    this.publishing.delete(sessionId);
  }
  emitForSession =
    (sessionId: string): EmitEvent =>
    (type, payload, durationMs, correlationId) => {
      const previous = this.publishing.get(sessionId);
      const publish = async () => {
        const event = await this.repo.appendEvent(sessionId, type, payload, durationMs, correlationId);
        for (const listener of this.listeners.get(sessionId) || []) listener(event);
        return event;
      };
      // Order persistence AND delivery: an earlier DB insert may resolve later than
      // a concurrent insert, which would otherwise be discarded by the SSE cursor.
      const next = previous ? previous.then(publish, publish) : publish();
      this.publishing.set(sessionId, next);
      void next
        .finally(() => {
          if (this.publishing.get(sessionId) === next) this.publishing.delete(sessionId);
        })
        .catch(() => undefined);
      return next;
    };
  async subscribe(sessionId: string, response: Response, afterId: number) {
    const responses = this.responses.get(sessionId) || new Set<Response>();
    this.responses.set(sessionId, responses);
    responses.add(response);
    let replaying = true;
    const queued: AgentEvent[] = [];
    let lastId = afterId;
    const send = (event: AgentEvent) => {
      if (event.id <= lastId || response.destroyed || response.writableEnded) return;
      lastId = event.id;
      response.write(`id: ${event.id}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`);
      if (response.writableLength > 1024 * 1024) response.end();
    };
    const listener = (event: AgentEvent) => (replaying ? queued.push(event) : send(event));
    const subscribers = this.listeners.get(sessionId) || new Set();
    this.listeners.set(sessionId, subscribers);
    subscribers.add(listener);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
    response.on('close', () => {
      responses.delete(response);
      if (!responses.size) this.responses.delete(sessionId);
      clearInterval(heartbeat);
      subscribers.delete(listener);
      if (!subscribers.size) this.listeners.delete(sessionId);
    });
    try {
      // Register before rechecking existence: a deletion either closes this
      // response or makes this check fail. Reads never acquire the mutation lock,
      // so initial SSE replay cannot reject a concurrent voice upgrade as busy.
      await this.repo.getSession(sessionId);
      for (const event of await this.repo.getEvents(sessionId, afterId)) send(event);
      queued.sort((a, b) => a.id - b.id).forEach(send);
      replaying = false;
    } catch {
      response.end();
    }
  }
}
