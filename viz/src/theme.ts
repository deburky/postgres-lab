// Two palettes for the same scenes. Paper is the default: white paper, black ink, straight strokes,
// sticky-note fills for the things that are happening, no glow. Neon is the original night city:
// glowing colours on a #1C232E sky with bloom. Chosen with ?theme=neon (or ?theme=dark).

export type Theme = {
  name: "paper" | "neon";
  paper: boolean;     // ink outlines on fills, ink text; neon draws glowing edges and coloured text
  sky: number;        // scene background
  fog: boolean;
  slab: number;       // the plate under the grid
  grid: number;
  gridBright: number; // plate outline and district lines
  gridOpacity: number;
  ink: number;        // outlines and idle edges on paper
  wire: number;       // an idle wire cage
  field: number;      // a documentation chunk nobody is looking at
  busy: number;       // Python running our code
  io: number;         // waiting on Postgres
  active: number;     // backend executing
  idleTx: number;     // backend idle in transaction; on the queue page, a job waiting to retry
  bad: number;        // a job held as failed
  hues: number[];     // one per question or worker, in this order
  text: string;       // subtitles and district names
  title: string;      // plate titles
  font: string;       // for the text drawn into the scene
  signWeight: number; // font weight of the standing signs
  edgePx: number;     // ink stroke width in screen pixels (paper)
  bloom: boolean;
  toneMap: boolean;
};

export const PAPER: Theme = {
  name: "paper",
  paper: true,
  sky: 0xffffff,
  fog: false,
  slab: 0xffffff,
  grid: 0xe9e9e4,
  gridBright: 0x1e1e1e,
  gridOpacity: 1,
  ink: 0x1e1e1e,
  wire: 0x1e1e1e,
  field: 0xefefec,
  busy: 0xffd166,   // yellow sticky note
  io: 0xc7ea6b,     // lime
  active: 0x9fd3f5, // sky
  idleTx: 0xffb4a2, // peach
  bad: 0xc0392b,
  // sticky notes, lightest first so neighbours differ; peach is kept for "waiting to retry"
  hues: [0xffd166, 0xc7ea6b, 0x9fd3f5, 0xcbb8ff, 0xa8e6cf, 0xffc6e0, 0xf6e27f, 0xb9d7ff, 0xd8f0a8, 0xe6ccff],
  text: "#6f6f6f",
  title: "#1e1e1e",
  font: "'Archivo', system-ui, sans-serif",
  signWeight: 600,
  edgePx: 1.6,
  bloom: false,
  toneMap: false,
};

export const NEON: Theme = {
  name: "neon",
  paper: false,
  // the sky is #1C232E on screen; ACES tone mapping darkens colours, so the scene value is a step lighter
  sky: 0x2b313a,
  fog: true,
  slab: 0x0e131c,
  grid: 0x1d4fd6,
  gridBright: 0x27d6ff,
  gridOpacity: 0.35,
  ink: 0x3b5b9a,
  wire: 0x3b5b9a,
  field: 0x2455e0,
  busy: 0xff8a1f,
  io: 0x19f0d0,
  active: 0x2f8bff,
  idleTx: 0xff3b5c,
  bad: 0xff3b5c,
  hues: [0x00e5ff, 0xff2bd6, 0xb4ff2b, 0xff8a1f, 0x9d5cff, 0xfff02b, 0x2bff9a, 0xff4d5e, 0x5cb8ff, 0xffa8f0],
  text: "#9fb3d9",
  title: "#e6e9ee",
  font: "'Archivo', system-ui, sans-serif",
  signWeight: 500,
  edgePx: 1,
  bloom: true,
  toneMap: true,
};

const wanted = new URLSearchParams(location.search).get("theme");
export const THEME: Theme = wanted === "neon" || wanted === "dark" ? NEON : PAPER;
document.documentElement.dataset.theme = THEME.name;

/** Reload with the other palette; everything in the scene is built from THEME at startup. */
export function toggleTheme(): void {
  const url = new URL(location.href);
  url.searchParams.set("theme", THEME.paper ? "neon" : "paper");
  location.assign(url.toString());
}

/** The button label that switches to the other palette. */
export const otherThemeName = (): string => (THEME.paper ? "Neon" : "Paper");
