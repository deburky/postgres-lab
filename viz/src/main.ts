// Entry point. One Ask runs the questions both ways through the app (POST /trace, sync then async),
// and the two traces play side by side on one clock: sync on the left plate, async on the right.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { City } from "./city";
import { fontsReady, setInkResolution } from "./neon";
import { otherThemeName, THEME, toggleTheme } from "./theme";
import { recorded, TRACES } from "./replay";
import { derive, type RawScenario, type RawTrace, type Scenario } from "./trace";

const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:8000";
const PLAY_SECONDS = 6; // the longer of the two runs always plays over this long; the ratio stays true
const GAP = 34;       // distance between the two plates (each is 30 wide)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const DEFAULT_QUESTIONS = [
  "How does selectinload work?",
  "What does expire_on_commit do?",
  "Difference between flush and commit",
  "How do I configure the connection pool size?",
  "Why does lazy loading fail with AsyncSession?",
  "What is the identity map?",
];

// -------------------------------------------------------------------------------
// Renderer, scene, camera
// -------------------------------------------------------------------------------
const container = $("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THEME.toneMap ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(THEME.sky);
if (THEME.fog) scene.fog = new THREE.Fog(THEME.sky, 100, 190);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05;

const L = -GAP / 2, R = GAP / 2;
const CAMS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  // embedded there is no questions box above the plates, so the camera looks lower and frames them whole
  both: "embed" in document.documentElement.dataset ? { pos: [0, 44, 50], look: [0, 1, 4] } : { pos: [0, 40, 56], look: [0, 9, 0] },
  sync: { pos: [L + 18, 18, 28], look: [L, 0, 0] },
  async: { pos: [R + 18, 18, 28], look: [R, 0, 0] },
  docs: { pos: [0, 24, 40], look: [0, 0, 12] },
};
let camTarget = { pos: new THREE.Vector3(...CAMS.both.pos), look: new THREE.Vector3(...CAMS.both.look) };
camera.position.copy(camTarget.pos);
controls.target.copy(camTarget.look);
let flying = 0;
function flyTo(name: string): void {
  const c = CAMS[name];
  camTarget = { pos: new THREE.Vector3(...c.pos), look: new THREE.Vector3(...c.look) };
  flying = 1;
}

// everything is self-lit neon now; no shadows or scene lights needed

// bloom (dark theme): lit buildings, beacons and sparks glow; the dark plate stays dark
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
// Two runs, one clock
// -------------------------------------------------------------------------------
let field: Pick<RawTrace, "table" | "field">;
let cities: City[] = [];
let t = 0, end = 0, playing = false, lastFrame = 0, speed = 0.02; // speed: trace ms per real ms

function play(sync: Scenario, async: Scenario): void {
  for (const c of cities) scene.remove(c.group);
  cities = [new City(sync, field, L), new City(async, field, R)];
  for (const c of cities) { scene.add(c.group); c.update(0, 1000); }
  t = 0;
  end = Math.max(sync.end, async.end);
  speed = end / (PLAY_SECONDS * 1000);
  playing = true;
  $("times").innerHTML = `<span>sync <b>${Math.round(sync.duration_ms)} ms</b></span><span>async <b>${Math.round(async.duration_ms)} ms</b></span>`;
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
  for (const c of cities) c.update(t, playing ? dt * speed : 16);
  composer.render();
}

// -------------------------------------------------------------------------------
// Ask
// -------------------------------------------------------------------------------
async function trace(questions: string[], mode: "sync" | "async"): Promise<Scenario> {
  if (TRACES) return derive(await recorded<RawScenario>(`city-${mode}`));
  const res = await fetch(`${API}/trace`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questions, mode, k: field.table.k }) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return derive((await res.json()) as RawScenario);
}

async function ask(): Promise<void> {
  const questions = $<HTMLTextAreaElement>("questions").value.split("\n").map(q => q.trim()).filter(q => q.length >= 3);
  if (!questions.length) return;
  const btn = $<HTMLButtonElement>("ask-btn");
  btn.disabled = true; btn.textContent = "asking…";
  $("status").textContent = "";
  try {
    const sync = await trace(questions, "sync");   // one after the other, so the two runs never share the server
    const async = await trace(questions, "async");
    play(sync, async);
  } catch (err) {
    $("status").textContent = `No answer from ${API}: ${err}`;
  } finally {
    btn.disabled = false; btn.textContent = TRACES ? "Replay" : "Ask";
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-cam]")) b.addEventListener("click", () => flyTo(b.dataset.cam!));
$("theme-btn").textContent = otherThemeName();
$("theme-btn").addEventListener("click", toggleTheme);
$("ask-form").addEventListener("submit", e => { e.preventDefault(); void ask(); });
$<HTMLTextAreaElement>("questions").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(); } });
addEventListener("keydown", e => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "/") { e.preventDefault(); $<HTMLTextAreaElement>("questions").focus(); }
});
// the box grows with the questions (4 to 12 lines) so nothing is hidden behind a scrollbar
function fitQuestions(): void {
  const ta = $<HTMLTextAreaElement>("questions");
  ta.rows = Math.min(12, Math.max(4, ta.value.split("\n").length));
}
$<HTMLTextAreaElement>("questions").addEventListener("input", fitQuestions);
$<HTMLTextAreaElement>("questions").value = DEFAULT_QUESTIONS.join("\n");
fitQuestions();

if (TRACES) {
  // recorded runs only: the default questions, replayed
  $<HTMLTextAreaElement>("questions").readOnly = true;
  $("ask-btn").textContent = "Replay";
}

async function loadField(): Promise<Pick<RawTrace, "table" | "field">> {
  if (TRACES) return recorded("field");
  const r = await fetch(`${API}/field`);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as Pick<RawTrace, "table" | "field">;
}

fontsReady().then(loadField)
  .then(f => {
    field = f;
    requestAnimationFrame(frame);
    void ask(); // open on a running example rather than two empty plates
  })
  .catch(err => {
    $("status").textContent = `Cannot reach the app at ${API} (${err}). Start it: DB_ECHO=false uv run --env-file .env uvicorn --app-dir app app:app`;
  });
