// A SQL console for the book: a real Postgres (PGlite) in a Web Worker, seeded per chapter with
// ?lab=vectors|jsonb|pgmq|graph, preset queries as chips, and the result sets drawn as tables.
// ?embed=1 hides the page title, since the chapter around the iframe already has one.

import { PGliteWorker } from "@electric-sql/pglite/worker";
import { LABS, type Lab } from "./labs";

type Field = { name: string };
type Result = { rows: Record<string, unknown>[]; fields: Field[]; affectedRows?: number };

const params = new URLSearchParams(location.search);
if (params.has("embed")) document.documentElement.dataset.embed = "";
const lab: Lab = LABS[params.get("lab") ?? "vectors"] ?? LABS.vectors;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const editor = $<HTMLTextAreaElement>("sql");
const runBtn = $<HTMLButtonElement>("run");
const resetBtn = $<HTMLButtonElement>("reset");
const statusEl = $("status");
const out = $("out");
const chips = $("chips");
const pgEl = $("pg");

const MAX_ROWS = 200;
// numeric and bigint arrive as strings; they still line up on the right
const NUMERIC = /^-?\d+(\.\d+)?$/;

let worker: Worker | undefined;
let db: PGliteWorker | undefined;

// -------------------------------------------------------------------------------
// Database
// -------------------------------------------------------------------------------
async function boot(): Promise<void> {
  setBusy(true, "Starting Postgres…");
  worker?.terminate();
  const t0 = performance.now();
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  db = await PGliteWorker.create(worker);
  for (const name of lab.scripts ?? []) {
    const res = await fetch(`./sql/${name}`);
    if (!res.ok) throw new Error(`${res.status} for ${name}`);
    await db.exec(await res.text());
  }
  await db.exec(lab.seed);
  const [{ v }] = (await db.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows;
  pgEl.textContent = `Postgres ${v}, started in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  setBusy(false, "Ready");
}

async function run(): Promise<void> {
  if (!db || runBtn.disabled) return;
  const text = editor.value;
  setBusy(true, "Running…");
  const t0 = performance.now();
  try {
    // exec runs every statement in the box; each one that returns rows gets a table
    const results = (await db.exec(text)) as Result[];
    const ms = performance.now() - t0;
    render(results);
    const n = results.length;
    setBusy(false, `${n} statement${n === 1 ? "" : "s"} in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`);
  } catch (e) {
    out.replaceChildren(errorCard(e));
    setBusy(false, "Error");
  }
}

// -------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------
function render(results: Result[]): void {
  const shown = results.filter((r) => r.fields.length > 0);
  if (!shown.length) {
    const affected = results.reduce((a, r) => a + (r.affectedRows ?? 0), 0);
    out.replaceChildren(note(affected ? `Done, ${affected} row${affected === 1 ? "" : "s"} affected.` : "Done, no rows returned."));
    return;
  }
  // a one-value result (a void call, a count, send's msg_id) is a chip, not a table; neighbours share a row
  const nodes: HTMLElement[] = [];
  for (const r of shown) {
    if (r.fields.length === 1 && r.rows.length === 1 && r.fields[0].name !== "QUERY PLAN") {
      let line = nodes.at(-1);
      if (!line?.classList.contains("scalars")) {
        line = document.createElement("div");
        line.className = "scalars";
        nodes.push(line);
      }
      line.append(scalar(r.fields[0].name, r.rows[0][r.fields[0].name]));
    } else nodes.push(table(r));
  }
  out.replaceChildren(...nodes);
}

function scalar(name: string, value: unknown): HTMLElement {
  const span = document.createElement("span");
  const b = document.createElement("b");
  b.textContent = name;
  const code = document.createElement("code");
  // a void function (pgmq.create, pg_sleep) returns an empty string
  code.textContent = value === "" ? "done" : format(value);
  span.append(b, code);
  return span;
}

function table(r: Result): HTMLElement {
  // EXPLAIN comes back as one text column; it reads better as a block of text
  if (r.fields.length === 1 && r.fields[0].name === "QUERY PLAN") {
    const pre = document.createElement("pre");
    pre.className = "plan";
    pre.textContent = r.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    return pre;
  }
  const wrap = document.createElement("div");
  wrap.className = "table";
  const t = document.createElement("table");
  const head = t.createTHead().insertRow();
  const first = r.rows[0] ?? {};
  for (const f of r.fields) {
    const th = document.createElement("th");
    th.textContent = f.name;
    if (isNumeric(first[f.name])) th.className = "num";
    head.append(th);
  }
  const body = t.createTBody();
  for (const row of r.rows.slice(0, MAX_ROWS)) {
    const tr = body.insertRow();
    for (const f of r.fields) {
      const value = row[f.name];
      const td = tr.insertCell();
      td.textContent = format(value);
      if (isNumeric(value)) td.className = "num";
      if (value === null) td.className = "null";
    }
  }
  wrap.append(t);
  const count = document.createElement("p");
  count.className = "count";
  const more = r.rows.length > MAX_ROWS ? `, first ${MAX_ROWS} shown` : "";
  count.textContent = `${r.rows.length} row${r.rows.length === 1 ? "" : "s"}${more}`;
  wrap.append(count);
  return wrap;
}

function isNumeric(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && NUMERIC.test(value));
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = text;
  return p;
}

function errorCard(e: unknown): HTMLElement {
  const div = document.createElement("div");
  div.className = "error";
  const b = document.createElement("b");
  b.textContent = "Postgres says: ";
  div.append(b, e instanceof Error ? e.message : String(e));
  return div;
}

function setBusy(busy: boolean, text: string): void {
  runBtn.disabled = busy;
  resetBtn.disabled = busy;
  statusEl.textContent = text;
}

// -------------------------------------------------------------------------------
// Controls
// -------------------------------------------------------------------------------
function pick(i: number): void {
  editor.value = lab.examples[i].sql;
  chips.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", j === i));
}

document.title = lab.title;
$("lab-title").textContent = lab.title;
$("lab-blurb").textContent = lab.blurb;
lab.examples.forEach((ex, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = ex.label;
  b.addEventListener("click", () => {
    pick(i);
    void run();
  });
  chips.append(b);
});
pick(0);

runBtn.addEventListener("click", () => void run());
resetBtn.addEventListener("click", () => {
  out.replaceChildren();
  boot().catch((e) => out.replaceChildren(errorCard(e)));
});
editor.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void run();
  } else if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
  }
});

boot()
  .then(run)
  .catch((e) => {
    out.replaceChildren(errorCard(e));
    statusEl.textContent = "Postgres did not start";
  });
