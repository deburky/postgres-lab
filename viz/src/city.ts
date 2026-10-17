// One city per run, drawn as neon on a glowing grid: Python on the far side, the Postgres backends
// in the middle, the documentation as a field on the near side. Every question has its own hue that
// follows it through its token, beacon, index-walk ring, result links and signs.

import * as THREE from "three";
import { bannerText, Cage, districtLabel, hex, lineColor, outlined, plate, type Sign, signColor, standingText } from "./neon";
import { THEME } from "./theme";
import { backendState, knnStmt, phase, type RawTrace, type Request, type Scenario } from "./trace";

const Z = { python: -12, backends: -2, field: 12 };
const FIELD_HALF = 9;
export const PLATE_W = 30;
const BANDS = [(Z.python + Z.backends) / 2, (Z.backends + Z.field - FIELD_HALF) / 2];
const SPACING = 2.4;
const spread = (i: number, n: number) => (i - (n - 1) / 2) * SPACING;
const RETURN_MS = 25; // trace-ms the answer sparks take to fly back to Python


export class City {
  readonly group = new THREE.Group();
  private tower!: Cage;
  private backends = new Map<number, Cage>();
  private backendPos = new Map<number, THREE.Vector3>();
  private towerTop = new THREE.Vector3(0, 3.9, Z.python);
  private tokens = new Map<number, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>();

  private field!: THREE.InstancedMesh;
  private fieldIndex = new Map<number, number>();
  private fieldPos = new Map<number, THREE.Vector3>();
  private fieldKey = "";
  private beacons = new Map<number, THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>>();
  private rings = new Map<number, THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>>();
  private beams = new Map<number, THREE.Line>();
  private links = new Map<number, THREE.LineSegments>();
  private sparks = new Map<number, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[]>();
  private questionSigns = new Map<number, Sign>();
  private resultSigns = new Map<number, Sign[]>();

  constructor(readonly sc: Scenario, private readonly trace: Pick<RawTrace, "table" | "field">, offsetX = 0) {
    this.group.position.x = offsetX;
    this.buildFloor();
    this.buildTitles();
    this.buildPython();
    this.buildBackends();
    this.buildField();
    this.buildTokens();
  }

  hue(r: Request): number {
    return THEME.hues[r.id % THEME.hues.length];
  }

  // ---------------------------------------------------------------------------
  // Static geometry
  // ---------------------------------------------------------------------------
  private buildFloor(): void {
    plate(this.group, PLATE_W, 44, 2, BANDS);
  }

  private buildTitles(): void {
    const async = this.sc.config.concurrency === "async";
    const title = bannerText(async ? "ASYNC" : "SYNC", THEME.paper ? THEME.title : hex(async ? THEME.io : THEME.busy), 3.2, 700);
    title.position.set(0, 9.5, Z.python - 6);
    this.group.add(title);
    const sub = bannerText(
      async ? "one asyncio task and one connection per question, all at once" : "one thread, one connection, one question after another",
      THEME.text, 1.4, 500);
    sub.position.set(0, 7.6, Z.python - 6);
    this.group.add(sub);

    const tb = this.trace.table, x = -PLATE_W / 2 + 0.9;
    districtLabel(this.group, "Python", "", x, 2 - 22 + 1.6);
    districtLabel(this.group, "Postgres backends", "one process per connection", x, BANDS[0] + 1.3);
    districtLabel(this.group, "SQLAlchemy docs", `${tb.rows} chunks, pgvector HNSW`, x, BANDS[1] + 1.3);
  }

  private buildPython(): void {
    this.tower = new Cage(1.8, 3.4, 1.8);
    this.tower.position.set(0, 1.7, Z.python);
    this.group.add(this.tower);
  }

  private buildBackends(): void {
    const n = this.sc.pids.length;
    this.sc.pids.forEach((pid, i) => {
      const b = new Cage(1.5, 2.2, 1.5);
      b.position.set(spread(i, n), 1.1, Z.backends);
      this.group.add(b);
      this.backends.set(pid, b);
      this.backendPos.set(pid, new THREE.Vector3(spread(i, n), 2.8, Z.backends));
    });
  }

  private fieldPoint(xyz: ArrayLike<number>, off = 0): THREE.Vector3 {
    return new THREE.Vector3(xyz[off] * FIELD_HALF, 0.3 + (xyz[off + 1] + 1) * 1.2, Z.field + xyz[off + 2] * FIELD_HALF);
  }

  private buildField(): void {
    const { ids, xyz } = this.trace.field;
    const n = ids.length;
    const geom = new THREE.OctahedronGeometry(0.22, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff }); // unlit: the instance colour is the colour
    this.field = new THREE.InstancedMesh(geom, mat, n);
    const m = new THREE.Matrix4();
    const c = new THREE.Color(THEME.field);
    for (let i = 0; i < n; i++) {
      const p = this.fieldPoint(xyz, i * 3);
      m.setPosition(p);
      this.field.setMatrixAt(i, m);
      this.field.setColorAt(i, c);
      this.fieldIndex.set(ids[i], i);
      this.fieldPos.set(ids[i], p);
    }
    this.field.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.field);
    if (THEME.paper) {
      // the same chunks again, a little larger, inside out and in ink: each one gets an outline
      const shell = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial({ color: THEME.ink, side: THREE.BackSide }), n);
      const big = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        this.field.getMatrixAt(i, m);
        big.copy(m).multiply(new THREE.Matrix4().makeScale(1.22, 1.22, 1.22));
        shell.setMatrixAt(i, big);
      }
      this.group.add(shell);
    }

    for (const r of this.sc.requests) {
      const hue = this.hue(r);
      const p = this.fieldPoint(r.point);

      const beacon = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 4.2, 8), new THREE.MeshBasicMaterial({ color: hue })), [1.8, 1.01, 1.8]);
      beacon.position.set(p.x, 2.1, p.z);
      beacon.visible = false;
      this.group.add(beacon);
      this.beacons.set(r.id, beacon);

      const qs = standingText(r.text, signColor(hue), 5);
      qs.position.set(p.x + 0.4, 4.5 + 2.5, p.z);
      this.group.add(qs);
      this.questionSigns.set(r.id, qs);

      const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ color: lineColor(hue), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.05, p.z);
      ring.visible = false;
      this.group.add(ring);
      this.rings.set(r.id, ring);

      const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: lineColor(hue), transparent: true, opacity: 0.85 }));
      beam.visible = false;
      this.group.add(beam);
      this.beams.set(r.id, beam);

      // neon links from the question to each chunk it matched, and a sign on each
      const pts: THREE.Vector3[] = [];
      const rs: Sign[] = [];
      for (const h of r.results) {
        const fp = this.fieldPos.get(h.id);
        if (!fp) continue;
        pts.push(new THREE.Vector3(p.x, 4.2, p.z), fp.clone());
        const sign = standingText(`${(1 - h.distance).toFixed(2)}  ${h.title}`, signColor(hue), 3.6);
        sign.position.set(fp.x, fp.y + 0.2 + 1.8, fp.z);
        this.group.add(sign);
        rs.push(sign);
      }
      const links = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: lineColor(hue), transparent: true, opacity: THEME.paper ? 0.45 : 0.7 }));
      links.visible = false;
      this.group.add(links);
      this.links.set(r.id, links);
      this.resultSigns.set(r.id, rs);

      const sp = r.results.map(() => {
        const s = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: hue })));
        s.visible = false;
        this.group.add(s);
        return s;
      });
      this.sparks.set(r.id, sp);
    }
  }

  private buildTokens(): void {
    for (const r of this.sc.requests) {
      const mesh = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), new THREE.MeshBasicMaterial({ color: this.hue(r) })), 1.12);
      mesh.visible = false;
      this.group.add(mesh);
      this.tokens.set(r.id, mesh);
    }
  }

  // ---------------------------------------------------------------------------
  // Where a question's token should be at time t
  // ---------------------------------------------------------------------------
  private target(r: Request, t: number): { pos: THREE.Vector3; visible: boolean } {
    const wp = this.towerTop;
    const lead = 15;
    if (t < r.start - lead) return { pos: wp.clone().setY(9), visible: false };
    if (t < r.start) return { pos: wp.clone().setY(9 - 5.1 * ((t - (r.start - lead)) / lead)), visible: true };
    if (t >= r.end) {
      const k = Math.min(1, (t - r.end) / 40);
      return { pos: wp.clone().setY(wp.y + 4 * k), visible: k < 1 };
    }
    if (phase(r, t) === "io") {
      const bp = (r.pid != null && this.backendPos.get(r.pid)) || wp;
      return { pos: bp.clone(), visible: true };
    }
    return { pos: wp.clone(), visible: true };
  }

  private scanning(r: Request, t: number): number {
    const s = knnStmt(r);
    if (!s || t < s.start || t >= s.end) return -1;
    return (t - s.start) / Math.max(1, s.end - s.start);
  }
  private answered(r: Request, t: number): boolean {
    const s = knnStmt(r);
    return !!s && t >= s.end;
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------
  update(t: number, dtMs: number): void {
    const sc = this.sc;

    // Python: amber while running (pulsing while embedding), teal while everything is waiting
    const embedding = sc.requests.some(r => phase(r, t) === "embed");
    const running = embedding || sc.requests.some(r => phase(r, t) === "busy");
    const alive = sc.requests.some(r => phase(r, t) !== null);
    this.tower.light(running ? THEME.busy : alive ? THEME.io : null, embedding ? 0.5 + 0.5 * Math.sin(t * 0.8) : 1);

    // backends
    for (const pid of sc.pids) {
      const st = backendState(sc, pid, t);
      const b = this.backends.get(pid)!;
      b.light(st === "active" ? THEME.active : st === "idle in transaction" ? THEME.idleTx : null, st === "active" ? 1 : 0.4);
      b.visible = st !== "gone";
    }

    // the field: chunks a question matched take that question's hue once found
    const found = sc.requests.filter(r => this.answered(r, t));
    const key = found.map(r => r.id).join(",");
    if (key !== this.fieldKey) {
      this.fieldKey = key;
      const base = new THREE.Color(THEME.field);
      for (let i = 0; i < this.field.count; i++) this.field.setColorAt(i, base);
      for (const r of found) {
        const c = new THREE.Color(this.hue(r));
        for (const h of r.results) {
          const idx = this.fieldIndex.get(h.id);
          if (idx != null) this.field.setColorAt(idx, c);
        }
      }
      this.field.instanceColor!.needsUpdate = true;
    }

    // per question
    for (const r of sc.requests) {
      const scan = this.scanning(r, t);
      const done = this.answered(r, t);
      this.beacons.get(r.id)!.visible = scan >= 0 || done;
      this.questionSigns.get(r.id)!.visible = scan >= 0 || done;
      this.links.get(r.id)!.visible = done;
      for (const s of this.resultSigns.get(r.id)!) s.visible = done;

      const ring = this.rings.get(r.id)!;
      ring.visible = scan >= 0;
      if (scan >= 0) { const s = 0.5 + scan * 7; ring.scale.set(s, s, 1); (ring.material as THREE.MeshBasicMaterial).opacity = 0.95 - scan * 0.7; }

      const beam = this.beams.get(r.id)!;
      beam.visible = scan >= 0 && r.pid != null && this.backendPos.has(r.pid);
      if (beam.visible) {
        const from = this.backendPos.get(r.pid!)!;
        const beacon = this.beacons.get(r.id)!;
        const pos = beam.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, from.x, from.y, from.z);
        pos.setXYZ(1, beacon.position.x, 4.2, beacon.position.z);
        pos.needsUpdate = true;
      }

      const sparks = this.sparks.get(r.id)!;
      const s = knnStmt(r);
      const fly = s ? (t - s.end) / RETURN_MS : -1;
      sparks.forEach((sp, i) => {
        const from = this.fieldPos.get(r.results[i]?.id ?? -1);
        sp.visible = fly >= 0 && fly < 1 && !!from;
        if (sp.visible && from) {
          sp.position.lerpVectors(from, this.towerTop, fly);
          sp.position.y += Math.sin(fly * Math.PI) * 5;
        }
      });
    }

    // tokens
    const k = 1 - Math.exp(-dtMs / 6);
    for (const r of sc.requests) {
      const tk = this.tokens.get(r.id)!;
      const { pos, visible } = this.target(r, t);
      if (!tk.visible && visible) tk.position.copy(pos);
      tk.visible = visible;
      tk.position.lerp(pos, dtMs > 50 ? 1 : k);
    }
  }
}
