// Entry point of queue.html. Run asks the app for a traced pgqueuer run (POST /queue/trace: real
// workers, real table, real NOTIFYs) and plays it back on one plate, scaled to PLAY_SECONDS.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { fontsReady, hex, setInkResolution } from "../neon";
import { recorded, TRACES } from "../replay";
import { otherThemeName, THEME, toggleTheme } from "../theme";
import { QueueScene, workerHue } from "./scene";
import { counts, derive, type QueueConfig, type QueueTrace, type RawQueueTrace } from "./trace";

const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:8000";
const PLAY_SECONDS = 9;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Knobs = Omit<QueueConfig, "fail_rate" | "max_attempts" | "drip_ms" | "seed"> & { fail_pct: number };
const BASE: Knobs = { jobs: 24, workers: 3, batch_size: 2, max_concurrent_tasks: 4, concurrency_limit: 0, job_ms: 120, fail_pct: 0, retry_ms: 150, enqueue: "batch", priorities: false };
const PRESETS: Record<string, Partial<Knobs>> = {
  skip: {},                                                                       // three workers split one table
  notify: { jobs: 20, enqueue: "drip", job_ms: 80 },                              // each INSERT wakes the idle workers
  limit: { jobs: 16, concurrency_limit: 2, job_ms: 150 },                         // never more than 2 picked, fleet-wide
  retry: { jobs: 20, fail_pct: 30, retry_ms: 200 },                               // red rows wait out execute_after
  priority: { jobs: 14, workers: 1, batch_size: 1, max_concurrent_tasks: 2, concurrency_limit: 1, job_ms: 60, priorities: true },
};

// -------------------------------------------------------------------------------
// Renderer, scene, camera (the same setup as the search city)
// -------------------------------------------------------------------------------
const container = $("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THEME.toneMap ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(THEME.sky);
if (THEME.fog) scene.fog = new THREE.Fog(THEME.sky, 80, 160);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;

const CAMS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  all: { pos: [0, 28, 29], look: [0, -1.5, 0.5] },
  table: { pos: [0, 13, 8], look: [0, 0, -4] },
  workers: { pos: [0, 10, 21], look: [0, 2, 7] },
};
let camTarget = { pos: new THREE.Vector3(...CAMS.all.pos), look: new THREE.Vector3(...CAMS.all.look) };
camera.position.copy(camTarget.pos);
controls.target.copy(camTarget.look);
let flying = 0;
function flyTo(name: string): void {
  const c = CAMS[name];
  camTarget = { pos: new THREE.Vector3(...c.pos), look: new THREE.Vector3(...c.look) };
  flying = 1;
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = THEME.bloom ? new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.25, 0.8) : null;
if (bloom) composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize(): void {
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom?.resolution.set(w, h);
  setInkResolution(w, h);
}
addEventListener("resize", resize);
resize();

// -------------------------------------------------------------------------------
// Playback: one clock in trace-ms, driven by frames or by the scrub bar
// -------------------------------------------------------------------------------
let view: QueueScene | null = null;
let t = 0, end = 1, playing = false, lastFrame = 0, speed = 0.02;
let lastHud = "";

function play(tr: QueueTrace): void {
  if (view) scene.remove(view.group);
  view = new QueueScene(tr);
  scene.add(view.group);
  // a little tail so the last tokens finish landing in the log
  end = tr.end * 1.08;
  speed = end / (PLAY_SECONDS * 1000);
  t = 0;
  playing = true;
  const c = tr.config;
  const cap = c.max_concurrent_tasks ? `max_concurrent_tasks ${Math.max(c.max_concurrent_tasks, 2 * c.batch_size)}` : "no per-worker cap";
  const limit = c.concurrency_limit ? `concurrency_limit ${c.concurrency_limit}` : "no concurrency limit";
  const fails = c.fail_rate ? `, ${Math.round(c.fail_rate * 100)}% of attempts fail` : "";
  $("subtitle").textContent =
    `${c.jobs} jobs, ${c.workers} workers, batch_size ${c.batch_size}, ${cap}, ${limit}, ` +
    `${c.enqueue === "drip" ? "one INSERT per job" : "one INSERT for all"}${fails}. ${tr.server.split(" (")[0]}`;
  $("workers-legend").innerHTML = tr.workers
    .map((_, i) => {
      const n = tr.jobs.reduce((s, j) => s + j.attempts.filter(a => a.worker === i).length, 0);
      return `<span><i style="background:${hex(workerHue(i))}"></i>worker ${i + 1}<em>${n} attempts</em></span>`;
    })
    .join("");
}

function hud(): void {
  if (!view) return;
  const c = counts(view.tr, t), cfg = view.tr.config;
  const limit = cfg.concurrency_limit ? ` / ${cfg.concurrency_limit}` : "";
  // a tile gets its sticky note only while its number is not zero: the eye goes where things happen
  const tile = (n: number | string, label: string, cls: string, on: boolean) => `<span class="${on ? cls : ""}"><b>${n}</b>${label}</span>`;
  const html =
    tile(c.queued, "queued", "", false) + tile(`${c.running}${limit}`, "picked", "run", c.running > 0) +
    tile(c.retry, "waiting to retry", "bad", c.retry > 0) + tile(c.done, "done", "ok", c.done > 0) +
    tile(c.held, "held as failed", "bad", c.held > 0) + tile(`${Math.round(view.tr.duration_ms)} ms`, "wall time", "", false);
  if (html !== lastHud) { $("counts").innerHTML = html; lastHud = html; }
  $("clock").textContent = `${Math.round(Math.min(t, view.tr.end))} ms`;
  if (playing) $<HTMLInputElement>("scrub").value = String(Math.round((1000 * t) / end));
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = lastFrame ? now - lastFrame : 16;
  lastFrame = now;
  if (playing) {
    t = Math.min(end, t + dt * speed);
    if (t >= end) playing = false;
  }
  if (flying > 0) {
    flying = Math.max(0, flying - dt / 900);
    const k = 1 - Math.pow(flying, 2);
    camera.position.lerp(camTarget.pos, Math.min(1, 0.08 + k * 0.1));
    controls.target.lerp(camTarget.look, Math.min(1, 0.08 + k * 0.1));
  }
  controls.update();
  view?.update(t);
  hud();
  composer.render();
}

// -------------------------------------------------------------------------------
// The form
// -------------------------------------------------------------------------------
const form = $<HTMLFormElement>("run-form");

function setKnobs(k: Knobs): void {
  for (const [name, value] of Object.entries(k)) {
    const el = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = Boolean(value);
    else el.value = String(value);
  }
}

function readKnobs(): QueueConfig {
  const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
  return {
    jobs: Number(v("jobs")), workers: Number(v("workers")), batch_size: Number(v("batch_size")),
    max_concurrent_tasks: Number(v("max_concurrent_tasks")),
    concurrency_limit: Number(v("concurrency_limit")), job_ms: Number(v("job_ms")),
    fail_rate: Number(v("fail_pct")) / 100, max_attempts: 3, retry_ms: Number(v("retry_ms")),
    enqueue: v("enqueue") as "batch" | "drip", drip_ms: 60,
    priorities: (form.elements.namedItem("priorities") as HTMLInputElement).checked, seed: 7,
  };
}

let preset = "skip";

async function run(): Promise<void> {
  const btn = $<HTMLButtonElement>("run-btn");
  btn.disabled = true; btn.textContent = "running…";
  $("status").textContent = "";
  try {
    const tr = derive(TRACES ? await recorded<RawQueueTrace>(`queue-${preset}`) : await fetchTrace());
    if (tr.timed_out) $("status").textContent = "The run hit the 60 s limit; showing what happened until then.";
    play(tr);
  } catch (err) {
    $("status").textContent = TRACES ? `Could not load the recorded run: ${err}` : `No answer from ${API}: ${err}`;
  } finally {
    btn.disabled = false; btn.textContent = "Run";
  }
}

async function fetchTrace(): Promise<RawQueueTrace> {
  const res = await fetch(`${API}/queue/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(readKnobs()) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as RawQueueTrace;
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
  b.addEventListener("click", () => {
    preset = b.dataset.preset!;
    setKnobs({ ...BASE, ...PRESETS[b.dataset.preset!] });
    for (const o of document.querySelectorAll("[data-preset]")) o.classList.toggle("on", o === b);
    void run();
  });
}
form.addEventListener("submit", e => { e.preventDefault(); void run(); });
$("replay-btn").addEventListener("click", () => { t = 0; playing = !!view; });
$<HTMLInputElement>("scrub").addEventListener("input", e => {
  playing = false;
  t = (Number((e.target as HTMLInputElement).value) / 1000) * end;
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-cam]")) b.addEventListener("click", () => flyTo(b.dataset.cam!));
$("theme-btn").textContent = otherThemeName();
$("theme-btn").addEventListener("click", toggleTheme);

// ?preset=retry opens on that scenario (the book links each one)
const wanted = new URLSearchParams(location.search).get("preset");
if (wanted && wanted in PRESETS) preset = wanted;
setKnobs({ ...BASE, ...PRESETS[preset] });
if (TRACES) {
  // recorded runs only: the knobs show what each preset ran with, and Run is gone
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) el.disabled = true;
  $("run-btn").hidden = true;
  form.querySelectorAll(".eyebrow")[1].textContent = "Knobs (recorded run)";
}
document.querySelector(`[data-preset=${preset}]`)?.classList.add("on");
requestAnimationFrame(frame);
void fontsReady().then(run); // open on a running example, once the scene's font is in
