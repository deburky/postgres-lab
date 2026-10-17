// The recorded trace (src/examples/sqlalchemy/trace_sync_async.py, or one live question from the
// app's POST /trace) and the per-instant questions the city asks of it. Nothing here is modelled:
// every interval is a measured timestamp pair.

export type Kind =
  | "request_start" | "embed_start" | "embed_end" | "pool_ask" | "connect" | "checkout" | "checkin"
  | "stmt_start" | "stmt_end" | "request_end";

export interface RawEvent { t: number; kind: Kind; req: number; worker: string; conn?: number; pid?: number | null; sql?: string; rows?: number; dim?: number }
export interface RawConnection { slot: number; pid: number | null; connected_at: number }
export interface RawSample { t: number; pids: Record<string, string> }
export interface Plan { node: string; rows_scanned: number; shared_hit: number; shared_read: number; exec_ms: number }
export interface Hit { id: number; title: string; distance: number }
export interface RawQuery { id: number; text: string; point: [number, number, number]; results: Hit[] }
export interface RawScenario {
  name: string; title: string; description: string;
  config: { requests: number; concurrency: "sync" | "async"; pool_size: number };
  plan: Plan | null;
  duration_ms: number; events: RawEvent[]; connections: RawConnection[]; samples: RawSample[]; queries: RawQuery[];
  sql?: string;
}
export interface RawTrace {
  generated: string; server: string; pgvector: string | null; url: string; sample_ms: number;
  table: { name: string; rows: number; dim: number; k: number; index: string; embed_model: string };
  field: { ids: number[]; titles: string[]; sources: string[]; xyz: number[] };
  scenarios: RawScenario[];
}

export interface Stmt { start: number; end: number; sql: string }
export interface Request {
  id: number; worker: string; text: string;
  start: number; embed?: { start: number; end: number; dim: number }; ask: number; checkout: number; checkin: number; end: number;
  conn: number; pid: number | null; stmts: Stmt[];
  point: [number, number, number]; results: Hit[];
}
export type Phase = "embed" | "busy" | "io";
export type BackendState = "active" | "idle" | "idle in transaction" | "gone";

export interface Scenario extends RawScenario {
  requests: Request[];
  conns: RawConnection[];
  pids: number[];
  end: number;
}

export function derive(sc: RawScenario): Scenario {
  const map = new Map<number, Partial<Request> & { stmts: Stmt[] }>();
  for (const e of sc.events) {
    if (e.req < 0) continue;
    let r = map.get(e.req);
    if (!r) { r = { id: e.req, worker: e.worker, stmts: [] }; map.set(e.req, r); }
    switch (e.kind) {
      case "request_start": r.start = e.t; r.worker = e.worker; break;
      case "embed_start": r.embed = { start: e.t, end: NaN, dim: 0 }; break;
      case "embed_end": if (r.embed) { r.embed.end = e.t; r.embed.dim = e.dim ?? 0; } break;
      case "pool_ask": r.ask = e.t; break;
      case "checkout": r.checkout = e.t; r.conn = e.conn ?? 0; r.pid = e.pid ?? null; break;
      case "checkin": r.checkin = e.t; break;
      case "stmt_start": r.stmts.push({ start: e.t, end: NaN, sql: e.sql ?? "" }); break;
      case "stmt_end": { const s = r.stmts[r.stmts.length - 1]; if (s && Number.isNaN(s.end)) s.end = e.t; break; }
      case "request_end": r.end = e.t; break;
      default: break;
    }
  }
  const queries = new Map(sc.queries.map(q => [q.id, q]));
  const requests = [...map.values()]
    .map(r => {
      const q = queries.get(r.id!);
      return {
        ...r,
        ask: r.ask ?? r.start,
        checkout: r.checkout ?? r.start,
        checkin: r.checkin ?? r.end,
        stmts: r.stmts.map(s => ({ ...s, end: Number.isNaN(s.end) ? (r.end ?? s.start) : s.end })),
        text: q?.text ?? "",
        point: q?.point ?? [0, 0, 0],
        results: q?.results ?? [],
      } as Request;
    })
    .sort((a, b) => a.id - b.id);
  const conns = [...sc.connections].sort((a, b) => a.slot - b.slot);
  const sampled = [...new Set(sc.samples.flatMap(s => Object.keys(s.pids)))].map(Number);
  const pids = [...new Set([...sampled, ...requests.map(r => r.pid).filter((p): p is number => p != null)])].sort((a, b) => a - b);
  const end = Math.max(sc.duration_ms, ...sc.samples.map(s => s.t));
  return { ...sc, requests, conns, pids, end };
}

/** What a request is doing at time t, or null before it starts / after it ends. */
export function phase(r: Request, t: number): Phase | null {
  if (t < r.start || t >= r.end) return null;
  if (r.embed && t >= r.embed.start && t < r.embed.end) return "embed";
  for (const s of r.stmts) if (t >= s.start && t < s.end) return "io";
  return "busy";
}

/** The kNN statement of a request (the tracer's and the app's spellings). */
export function knnStmt(r: Request): Stmt | undefined {
  return r.stmts.find(s => /^SELECT (id|doc_chunks\.id)/.test(s.sql));
}

/** Latest sampled state of a backend at or before t; without samples (live), derived from the statements. */
export function backendState(sc: Scenario, pid: number, t: number): BackendState {
  if (sc.samples.length === 0) {
    const r = sc.requests.find(q => q.pid === pid);
    if (!r || t < r.checkout || t >= r.checkin) return "gone";
    return r.stmts.some(s => t >= s.start && t < s.end) ? "active" : "idle in transaction";
  }
  let last: string | undefined;
  for (const s of sc.samples) { if (s.t > t) break; last = s.pids[String(pid)]; }
  if (last === "active" || last === "idle" || last === "idle in transaction") return last;
  return "gone";
}
