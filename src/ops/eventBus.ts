import type { RunEvent, RunEventSink } from "./events.js";

type Subscriber = {
  id: string;
  sink: RunEventSink;
};

export class RunEventBus {
  private subscribersByRunId = new Map<string, Map<string, Subscriber>>();
  private lastEventsByRunId = new Map<string, RunEvent[]>();
  private maxBufferedEvents: number;

  constructor(opts?: { maxBufferedEvents?: number }) {
    this.maxBufferedEvents = Math.max(0, opts?.maxBufferedEvents ?? 500);
  }

  publish(event: RunEvent) {
    const runId = event.runId;
    const buf = this.lastEventsByRunId.get(runId) ?? [];
    buf.push(event);
    if (buf.length > this.maxBufferedEvents)
      buf.splice(0, buf.length - this.maxBufferedEvents);
    this.lastEventsByRunId.set(runId, buf);

    const subs = this.subscribersByRunId.get(runId);
    if (!subs) return;
    for (const s of subs.values()) s.sink(event);
  }

  getBuffered(runId: string): RunEvent[] {
    return [...(this.lastEventsByRunId.get(runId) ?? [])];
  }

  subscribe(runId: string, subscriberId: string, sink: RunEventSink) {
    const subs = this.subscribersByRunId.get(runId) ?? new Map();
    subs.set(subscriberId, { id: subscriberId, sink });
    this.subscribersByRunId.set(runId, subs);

    return () => {
      const s = this.subscribersByRunId.get(runId);
      if (!s) return;
      s.delete(subscriberId);
      if (s.size === 0) this.subscribersByRunId.delete(runId);
    };
  }
}
