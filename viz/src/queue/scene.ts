// The queue as a neon plate: Python inserting on the far side, the pgqueuer table in the middle
// (one cell per row), the workers on the near side, and the log of finished jobs at the front.
// Nothing is modelled: a cell lights in a worker's hue exactly while that worker holds the row
// (status 'picked', locked with FOR UPDATE SKIP LOCKED), turns red while a failed job waits out its
// retry delay, and disappears when the job succeeds and pgqueuer deletes the row.

import * as THREE from "three";
import { bannerText, Cage, districtLabel, lineColor, outlined, plate, signColor } from "../neon";
import { THEME } from "../theme";
import { jobState, type JobState, type QJob, type QueueTrace } from "./trace";

const Z = { producer: -14, table: -4, workers: 7, log: 14.5 };
const PLATE = { w: 28, d: 38, z: -1 };
// the band boundaries: producer | table | workers | log
const BANDS = [(Z.producer + Z.table) / 2 - 1, (Z.table + Z.workers) / 2 + 1, (Z.workers + Z.log) / 2 + 0.5];

// paper: yellow, lime, sky, lilac, ... in order; neon: spread over the wheel so neighbours differ
export const workerHue = (w: number) => THEME.hues[(THEME.paper ? w : w * 3 + 1) % THEME.hues.length];
const HELD_FILL = 0xfce9e7; // the app's danger-button wash

interface Cell { cage: Cage; top: THREE.Vector3; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> }

export class QueueScene {
  readonly group = new THREE.Group();
  private producer!: Cage;
  private producerTop = new THREE.Vector3(0, 3.6, Z.producer);
  private cells: Cell[] = [];
  private workers: Cage[] = [];
  private workerTop: THREE.Vector3[] = [];
  private tokens: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[] = [];
  private logPos = new Map<number, THREE.Vector3>();
  private rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly fly: number;    // trace-ms a token takes between districts
  private readonly ringMs: number; // trace-ms a NOTIFY ring takes to reach the workers

  constructor(readonly tr: QueueTrace) {
    this.fly = Math.min(120, Math.max(12, tr.end * 0.035));
    this.ringMs = Math.min(200, Math.max(20, tr.end * 0.06));
    this.buildFloor();
    this.buildTitles();
    this.buildProducer();
    this.buildTable();
    this.buildWorkers();
    this.buildLog();
    this.buildTokens();
    this.buildRings();
  }

  //-------------------------------------------------------------------------------
  // Static geometry
  //-------------------------------------------------------------------------------
  private buildFloor(): void {
    plate(this.group, PLATE.w, PLATE.d, PLATE.z, BANDS);
  }

  private buildTitles(): void {
    const top = PLATE.z - PLATE.d / 2, x = -PLATE.w / 2 + 0.9;
    districtLabel(this.group, "Python", "enqueue with INSERT", x, top + 1.6);
    districtLabel(this.group, "pgqueuer table", "FOR UPDATE SKIP LOCKED", x, BANDS[0] + 1.4);
    districtLabel(this.group, "workers", "LISTEN ch_pgqueuer", x, BANDS[1] + 1.4);
    districtLabel(this.group, "done", "pgqueuer_log", x, BANDS[2] + 1.4);
  }

  private buildProducer(): void {
    this.producer = new Cage(1.8, 3.2, 1.8);
    this.producer.position.set(0, 1.6, Z.producer);
    this.group.add(this.producer);
  }

  private cols(): number {
    return Math.min(20, Math.max(8, Math.ceil(Math.sqrt(this.tr.jobs.length * 3))));
  }
  private buildTable(): void {
    const n = this.tr.jobs.length, cols = this.cols(), rows = Math.ceil(n / cols);
    const sx = Math.min(1.9, 22 / cols), sz = Math.min(1.5, 9 / rows);
    for (const j of this.tr.jobs) {
      const col = j.id % cols, row = Math.floor(j.id / cols);
      const h = 0.3 + 0.28 * j.priority;
      const cage = new Cage(sx * 0.78, h, sz * 0.72);
      const x = (col - (cols - 1) / 2) * sx, z = Z.table + (row - (rows - 1) / 2) * sz;
      cage.position.set(x, h / 2, z);
      cage.visible = false;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), new THREE.MeshBasicMaterial({ color: THEME.paper ? THEME.bad : THEME.idleTx, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.04, z);
      ring.visible = false;
      this.group.add(cage, ring);
      this.cells.push({ cage, top: new THREE.Vector3(x, h + 0.3, z), ring });
    }
  }

  private buildWorkers(): void {
    const w = this.tr.config.workers;
    const sp = Math.min(4.4, 22 / Math.max(1, w));
    for (let i = 0; i < w; i++) {
      const x = (i - (w - 1) / 2) * sp;
      const cage = new Cage(2.2, 2.4, 2.2);
      cage.position.set(x, 1.2, Z.workers);
      const label = bannerText(`worker ${i + 1}`, signColor(workerHue(i)), 1.1, 600);
      label.position.set(x, 0.6, Z.workers + 2.3);
      this.group.add(cage, label);
      this.workers.push(cage);
      this.workerTop.push(new THREE.Vector3(x, 2.85, Z.workers));
    }
  }

  private buildLog(): void {
    // finished jobs land in completion order, a row per 20
    const done = this.tr.jobs
      .map(j => ({ j, a: j.attempts.find(a => a.ok) }))
      .filter((d): d is { j: QJob; a: NonNullable<typeof d.a> } => !!d.a)
      .sort((x, y) => x.a.end - y.a.end);
    const cols = 20;
    done.forEach(({ j }, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      this.logPos.set(j.id, new THREE.Vector3((col - (cols - 1) / 2) * 1.05, 0.35, Z.log - 0.5 + row * 0.9));
    });
  }

  private buildTokens(): void {
    for (const _ of this.tr.jobs) {
      const t = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: THEME.field })), 1.16);
      t.visible = false;
      this.group.add(t);
      this.tokens.push(t);
    }
  }

  private buildRings(): void {
    for (const _ of this.tr.notifies) {
      const r = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ color: lineColor(THEME.io), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      r.rotation.x = -Math.PI / 2;
      r.position.set(0, 0.06, Z.table);
      r.visible = false;
      this.group.add(r);
      this.rings.push(r);
    }
  }

  //-------------------------------------------------------------------------------
  // Per frame
  //-------------------------------------------------------------------------------
  /** Where job j's token sits at time t, and its colour. */
  private place(j: QJob, st: JobState, t: number, slot: Map<number, number>): { pos: THREE.Vector3; color: number; visible: boolean; scale: number } {
    const cell = this.cells[j.id];
    const fly = (from: THREE.Vector3, to: THREE.Vector3, since: number, arc = 2.5) => {
      const k = Math.min(1, Math.max(0, (t - since) / this.fly));
      const p = from.clone().lerp(to, k);
      p.y += Math.sin(k * Math.PI) * arc;
      return p;
    };
    switch (st.s) {
      case "producer":
        return { pos: this.producerTop, color: THEME.field, visible: false, scale: 1 };
      case "queued":
        return { pos: fly(this.producerTop, cell.top, st.since, 3), color: THEME.field, visible: true, scale: 1 };
      case "running": {
        // up to nine on the roof, 3 x 3, then the next layer
        const k = slot.get(j.id) ?? 0, cell9 = k % 9;
        const top = this.workerTop[st.worker].clone();
        top.x += ((cell9 % 3) - 1) * 0.65;
        top.z += (Math.floor(cell9 / 3) - 1) * 0.65;
        top.y += 0.6 * Math.floor(k / 9);
        return { pos: fly(cell.top, top, st.since, 1.5), color: workerHue(st.worker), visible: true, scale: 1 };
      }
      case "retry": {
        const from = this.workerTop[j.attempts.find(a => a.end === st.since)?.worker ?? 0];
        return { pos: fly(from, cell.top, st.since, 1.5), color: THEME.idleTx, visible: true, scale: 1 };
      }
      case "held": {
        const from = this.workerTop[j.attempts[j.attempts.length - 1].worker];
        return { pos: fly(from, cell.top, st.since, 1.5), color: THEME.idleTx, visible: true, scale: 1.15 };
      }
      case "done": {
        const to = this.logPos.get(j.id) ?? cell.top;
        const k = Math.min(1, (t - st.since) / this.fly);
        return { pos: fly(this.workerTop[st.worker], to, st.since, 2), color: workerHue(st.worker), visible: true, scale: 1 - 0.45 * k };
      }
    }
  }

  update(t: number): void {
    const tr = this.tr;
    const states = tr.jobs.map(j => jobState(j, t));

    // producer: lit while it is still inserting
    const lastEnq = Math.max(...tr.jobs.map(j => j.enqueued));
    const firstEnq = Math.min(...tr.jobs.map(j => j.enqueued));
    this.producer.light(t >= firstEnq - this.fly && t <= lastEnq + this.fly ? THEME.busy : null, 0.7);

    // stack each worker's running jobs in the order it picked them
    const slot = new Map<number, number>();
    const running: number[][] = this.workers.map(() => []);
    states.forEach((st, id) => { if (st.s === "running") running[st.worker].push(id); });
    running.forEach(ids => ids.sort((a, b) => (states[a] as { since: number }).since - (states[b] as { since: number }).since).forEach((id, k) => slot.set(id, k)));

    // NOTIFY rings: from the table outward, reaching the workers' row
    let woken = false;
    tr.notifies.forEach((nt, i) => {
      const r = this.rings[i];
      const k = (t - nt) / this.ringMs;
      r.visible = k >= 0 && k < 1;
      if (r.visible) {
        const s = 1 + k * (Z.workers - Z.table + 2);
        r.scale.set(s, s, 1);
        r.material.opacity = 0.9 * (1 - k);
        if (k > 0.75) woken = true;
      }
    });

    // workers: lit in their own hue while running jobs, a teal flash as a notification arrives, wire when idle
    this.workers.forEach((w, i) => {
      const n = running[i].length;
      if (n) w.light(workerHue(i), 0.35 + 0.15 * Math.min(4, n));
      else w.light(woken ? (THEME.paper ? 0xefefec : THEME.io) : null, THEME.paper ? 1 : 0.6);
    });

    // rows of the pgqueuer table
    states.forEach((st, id) => {
      const c = this.cells[id];
      c.cage.visible = st.s === "queued" || st.s === "running" || st.s === "retry" || st.s === "held";
      c.ring.visible = false;
      const waiting: number | null = THEME.paper ? null : THEME.field; // an unclaimed row: white on paper
      if (st.s === "queued") c.cage.light(waiting, 0.15);
      else if (st.s === "running") c.cage.light(workerHue(st.worker), THEME.paper ? 1 : 0.25 + 0.2 * Math.sin(t * 0.05)); // picked, locked by that worker
      else if (st.s === "held") c.cage.light(THEME.paper ? HELD_FILL : THEME.idleTx, THEME.paper ? 1 : 0.9, THEME.paper ? THEME.bad : undefined);
      else if (st.s === "retry") {
        const left = st.eligible - t;
        c.cage.light(left > 0 ? THEME.idleTx : waiting, left > 0 ? (THEME.paper ? 1 : 0.5) : 0.15);
        if (left > 0) {
          const k = left / Math.max(1, st.eligible - st.since);
          c.ring.visible = true;
          c.ring.scale.setScalar(0.25 + 0.6 * k); // shrinks to the cell as execute_after comes due
        }
      }
    });

    // tokens
    tr.jobs.forEach((j, id) => {
      const tk = this.tokens[id];
      const st = states[id];
      const p = this.place(j, st, t, slot);
      // a job sitting in its row is drawn by the row; its token shows only while it travels
      const resting = (st.s === "queued" || st.s === "retry" || st.s === "held") && t - st.since > this.fly;
      tk.visible = p.visible && !resting;
      tk.position.copy(p.pos);
      tk.scale.setScalar(p.scale);
      tk.material.color.setHex(p.color);
    });
  }
}
