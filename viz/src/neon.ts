// Shared primitives for both scenes (city.ts, queue/scene.ts): cages, outlined solids, lines and
// text sprites, drawn either as ink on paper (the default) or as neon, from THEME.

import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { THEME } from "./theme";

export type Sign = THREE.Sprite;

// -------------------------------------------------------------------------------
// Ink strokes: screen-space lines a fixed number of pixels wide (WebGL lines are always 1 px)
// -------------------------------------------------------------------------------
const inkMaterials = new Set<LineMaterial>();

export function inkMaterial(color = THEME.ink, px = THEME.edgePx, opacity = 1): LineMaterial {
  const m = new LineMaterial({ color, linewidth: px, transparent: opacity < 1, opacity, worldUnits: false });
  m.resolution.set(innerWidth, innerHeight);
  inkMaterials.add(m);
  return m;
}

/** Call on resize: ink widths are in pixels of the current canvas. */
export function setInkResolution(w: number, h: number): void {
  for (const m of inkMaterials) m.resolution.set(w, h);
}

/** Ink segments along a polyline's point pairs, e.g. EdgesGeometry positions. */
export function inkSegments(positions: ArrayLike<number>, color = THEME.ink, px = THEME.edgePx, opacity = 1): LineSegments2 {
  const g = new LineSegmentsGeometry();
  g.setPositions(Array.from(positions));
  return new LineSegments2(g, inkMaterial(color, px, opacity));
}

/** A thin ink shell behind a solid, the sticker outline every small object gets on paper. */
export function outlined<T extends THREE.Mesh>(mesh: T, grow: number | [number, number, number] = 1.18): T {
  if (!THEME.paper) return mesh;
  const shell = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: THEME.ink, side: THREE.BackSide }));
  if (typeof grow === "number") shell.scale.setScalar(grow);
  else shell.scale.set(...grow);
  mesh.add(shell);
  return mesh;
}

// -------------------------------------------------------------------------------
// Cages: every building. Paper: a white box with ink edges, filled with a sticky-note colour
// while lit. Neon: a translucent box with glowing edges.
// -------------------------------------------------------------------------------
export class Cage extends THREE.Group {
  private fill: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial> | null = null;
  private ink: LineSegments2 | null = null;
  private white = new THREE.Color(0xffffff);

  constructor(w: number, h: number, d: number) {
    super();
    const geo = new THREE.BoxGeometry(w, h, d);
    const edgeGeo = new THREE.EdgesGeometry(geo);
    if (THEME.paper) {
      this.fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      this.ink = inkSegments(edgeGeo.attributes.position.array);
      this.add(this.fill, this.ink);
    } else {
      this.fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: THEME.wire, transparent: true, opacity: 0.08, depthWrite: false }));
      this.edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: THEME.wire, transparent: true, opacity: 0.9 }));
      this.add(this.fill, this.edges);
    }
  }

  /** null = idle; a colour = lit, `glow` 0..1 = how strongly; `edge` overrides the outline colour */
  light(color: number | null, glow = 1, edge?: number): void {
    if (this.ink) {
      // paper: the sticky colour, faded toward white when glow is low; ink edges unless told otherwise
      const c = color == null ? this.white : this.white.clone().lerp(new THREE.Color(color), 0.35 + 0.65 * glow);
      this.fill.material.color.copy(c);
      (this.ink.material as LineMaterial).color.setHex(edge ?? THEME.ink);
      return;
    }
    const c = color ?? THEME.wire;
    this.edges!.material.color.setHex(edge ?? c);
    this.fill.material.color.setHex(c);
    this.fill.material.opacity = color == null ? 0.08 : 0.15 + 0.45 * glow;
    this.edges!.material.opacity = color == null ? 0.7 : 1;
  }
}

// -------------------------------------------------------------------------------
// Colours for things that carry a hue: on paper the hue fills, the ink draws
// -------------------------------------------------------------------------------
/** Text colour for a sign belonging to something with this hue. */
export const signColor = (hue: number): string => (THEME.paper ? hex(THEME.ink) : hex(hue));
/** Line colour (links, beams, rings) for something with this hue. */
export const lineColor = (hue: number): number => (THEME.paper ? THEME.ink : hue);

// -------------------------------------------------------------------------------
// Text sprites
// -------------------------------------------------------------------------------
/** Archivo has to be loaded before any canvas text is drawn with it, or the sprites fall back. */
export async function fontsReady(): Promise<void> {
  try {
    await Promise.all(["500 100px Archivo", "600 100px Archivo", "700 100px Archivo"].map(f => document.fonts.load(f)));
  } catch {
    // offline: the system font stands in
  }
}

/** Text standing upright, reading bottom to top, as a sprite: always faces the screen. */
export function standingText(text: string, color: string, height: number): Sign {
  const W = 256, H = 2560;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.translate(W / 2, H);
  g.rotate(-Math.PI / 2);
  g.font = `${THEME.signWeight} 104px ${THEME.font}`;
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text, 40, 0, H - 80);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(c), transparent: true, premultipliedAlpha: true, depthWrite: false }));
  sp.scale.set(height * W / H, height, 1);
  sp.visible = false;
  return sp;
}

/** Horizontal text as a sprite: plate titles and district names. */
export function bannerText(text: string, color: string, height: number, weight = 600, align: "center" | "left" = "center"): Sign {
  const W = 4096, H = 256;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.font = `${weight} 150px ${THEME.font}`;
  g.textBaseline = "middle";
  g.textAlign = align;
  g.fillStyle = color;
  g.fillText(text, align === "left" ? 0 : W / 2, H / 2, W - 80);
  // titles and district names lie on the plate: drawn last and over it, never struck through by its lines
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(c), transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: false }));
  sp.renderOrder = 10;
  sp.scale.set(height * W / H, height, 1);
  if (align === "left") sp.center.set(0, 0.5); // the position is where the text starts
  return sp;
}

/** A district's name in ink with a muted detail line under it, starting at (x, z) on the plate.
 *  Both keep one size on screen wherever they stand, like captions on a diagram. */
export function districtLabel(group: THREE.Group, name: string, detail: string, x: number, z: number): void {
  const caption = (text: string, color: string, h: number, weight: number, cy: number) => {
    const sp = bannerText(text, color, h, weight, "left");
    (sp.material as THREE.SpriteMaterial).sizeAttenuation = false;
    sp.center.set(0, cy); // cy > 0.5 hangs the line below the point, < 0.5 lifts it above
    sp.position.set(x, 0.05, z);
    group.add(sp);
  };
  caption(name, THEME.paper ? "#3a3a3a" : THEME.text, 0.019, 700, detail ? 0.15 : 0.5);
  if (detail) caption(detail, THEME.text, 0.015, 500, 0.95);
}

/** Premultiplied so the mipmaps average text with transparent, not with black: no grey fringe on paper. */
export function textTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.premultiplyAlpha = true;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

export const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

// -------------------------------------------------------------------------------
// The plate both scenes stand on
// -------------------------------------------------------------------------------
/** Slab, grid, outline and district lines at the given z values. */
export function plate(group: THREE.Group, w: number, d: number, z: number, districtZ: number[]): void {
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), new THREE.MeshBasicMaterial({ color: THEME.slab }));
  slab.position.set(0, -0.16, z);
  group.add(slab);
  const grid = new THREE.GridHelper(w, 20, THEME.grid, THEME.grid);
  grid.position.set(0, 0.01, z);
  const gm = grid.material as THREE.LineBasicMaterial;
  gm.transparent = true;
  gm.opacity = THEME.gridOpacity;
  group.add(grid);
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const outline: number[] = [];
  corners.forEach(([x0, z0], i) => {
    const [x1, z1] = corners[(i + 1) % 4];
    outline.push(x0, 0.02, z + z0, x1, 0.02, z + z1);
  });
  const lines: number[] = [];
  for (const dz of districtZ) lines.push(-w / 2, 0.02, dz, w / 2, 0.02, dz);
  if (THEME.paper) {
    group.add(inkSegments(outline, THEME.gridBright, 2));
    // district boundaries: a lighter rule, like the app's line-soft
    group.add(inkSegments(lines, 0xb9b9b3, 1.2));
  } else {
    const mk = (pts: number[], opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: THEME.gridBright, transparent: true, opacity }));
    };
    group.add(mk(outline, 0.9), mk(lines, 0.5));
  }
}
