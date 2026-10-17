// The timeline POST /queue/trace returns (app/queue_trace.py), folded into one record per job.
// Every interval is a measured pair of timestamps, in ms from the first enqueue.

export interface QueueConfig {
  jobs: number; workers: number; batch_size: number; max_concurrent_tasks: number; concurrency_limit: number; job_ms: number;
  fail_rate: number; max_attempts: number; retry_ms: number; enqueue: "batch" | "drip"; drip_ms: number;
  priorities: boolean; seed: number;
}

export type RawEvent =
  | { t: number; kind: "insert"; jobs: number }
  | { t: number; kind: "notify" }
  | { t: number; kind: "enqueue"; job: number; priority: number }
  | { t: number; kind: "start"; job: number; worker: number; attempt: number }
  | { t: number; kind: "end"; job: number; worker: number; attempt: number; ok: boolean; retry_ms?: number; held?: boolean };

export interface RawQueueTrace {
  config: QueueConfig; server: string; workers: string[]; duration_ms: number; timed_out: boolean;
  held_in_table: number; events: RawEvent[];
}

export interface Attempt { start: number; end: number; worker: number; ok: boolean; retryMs: number; held: boolean }
export interface QJob { id: number; enqueued: number; priority: number; attempts: Attempt[] }

export type JobState =
  | { s: "producer" }                                   // not inserted yet
  | { s: "queued"; since: number }                      // a row in pgqueuer, waiting
  | { s: "running"; worker: number; since: number; attempt: number }
  | { s: "retry"; since: number; eligible: number }     // back in the table, execute_after in the future
  | { s: "done"; since: number; worker: number }        // successful: the row is gone, a log row remains
  | { s: "held"; since: number };                       // failed for good, kept in the table

export interface QueueTrace extends RawQueueTrace {
  jobs: QJob[];
  notifies: number[];
  end: number;
}

export function derive(raw: RawQueueTrace): QueueTrace {
  const jobs: QJob[] = Array.from({ length: raw.config.jobs }, (_, id) => ({ id, enqueued: Infinity, priority: 0, attempts: [] }));
  const open = new Map<string, Attempt>();
  for (const e of raw.events) {
    if (e.kind === "enqueue") { jobs[e.job].enqueued = e.t; jobs[e.job].priority = e.priority; }
    else if (e.kind === "start") {
      const a: Attempt = { start: e.t, end: Infinity, worker: e.worker, ok: false, retryMs: 0, held: false };
      jobs[e.job].attempts.push(a);
      open.set(`${e.job}:${e.attempt}`, a);
    } else if (e.kind === "end") {
      const a = open.get(`${e.job}:${e.attempt}`);
      if (a) { a.end = e.t; a.ok = e.ok; a.retryMs = e.retry_ms ?? 0; a.held = e.held ?? false; }
    }
  }
  // a job can start a hair before its enqueue event is appended (the INSERT returns after a fast
  // worker has already picked the row); clamp so it is never picked before it exists
  for (const j of jobs) if (j.attempts.length && j.attempts[0].start < j.enqueued) j.enqueued = j.attempts[0].start;
  const notifies = raw.events.filter(e => e.kind === "notify").map(e => e.t);
  return { ...raw, jobs, notifies, end: raw.duration_ms };
}

export function jobState(j: QJob, t: number): JobState {
  if (t < j.enqueued) return { s: "producer" };
  let prev: Attempt | null = null;
  for (const [i, a] of j.attempts.entries()) {
    if (t < a.start) break;
    if (t < a.end) return { s: "running", worker: a.worker, since: a.start, attempt: i };
    if (a.ok) return { s: "done", since: a.end, worker: a.worker };
    if (a.held) return { s: "held", since: a.end };
    prev = a;
  }
  // waiting: for the first time, or again after a failed attempt until execute_after (and then some)
  return prev ? { s: "retry", since: prev.end, eligible: prev.end + prev.retryMs } : { s: "queued", since: j.enqueued };
}

export interface Counts { queued: number; running: number; retry: number; done: number; held: number }

export function counts(tr: QueueTrace, t: number): Counts {
  const c: Counts = { queued: 0, running: 0, retry: 0, done: 0, held: 0 };
  for (const j of tr.jobs) {
    const st = jobState(j, t).s;
    if (st !== "producer") c[st]++;
  }
  return c;
}
