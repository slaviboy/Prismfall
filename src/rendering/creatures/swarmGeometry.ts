import { BufferAttribute, BufferGeometry } from 'three/webgpu';

/**
 * Procedural creature bodies for swarms. Each vertex carries `part` = (side, span, along, kind):
 * side −1/+1 marks left/right wings or fins (0 body), span 0..1 is the distance out along a wing,
 * along −1..1 runs tail→head, kind tags special parts (tentacles). The swarm shader animates them.
 * Bodies face −Z (forward) with +Y up; units are metres before the swarm's size scale.
 */
export const SWARM_KINDS = ['bird', 'eagle', 'fish', 'koi', 'jellyfish', 'ray', 'turtle', 'butterfly', 'whale'] as const;
export type SwarmKind = (typeof SWARM_KINDS)[number];

class Builder {
  readonly pos: number[] = [];
  readonly part: number[] = [];
  readonly idx: number[] = [];

  v(x: number, y: number, z: number, side = 0, span = 0, along = 0, kind = 0): number {
    this.pos.push(x, y, z);
    this.part.push(side, span, along, kind);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number, both = true): void {
    this.idx.push(a, b, c);
    if (both) this.idx.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number, both = true): void {
    this.tri(a, b, c, both);
    this.tri(a, c, d, both);
  }

  /** Ellipsoid body along Z (length l, width w, height h) with `segs` rings. */
  body(l: number, w: number, h: number, segs = 8, ring = 8, taper = (t: number) => Math.sin(Math.PI * t)): void {
    const start = this.pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = (0.5 - t) * l;
      const r = Math.max(0.02, taper(t));
      for (let j = 0; j < ring; j++) {
        const a = (j / ring) * Math.PI * 2;
        this.v(Math.cos(a) * w * r * 0.5, Math.sin(a) * h * r * 0.5, z, 0, 0, 1 - 2 * t);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < ring; j++) {
        const a = start + i * ring + j;
        const b = start + i * ring + ((j + 1) % ring);
        this.quad(a, b, b + ring, a + ring, false);
      }
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('part', new BufferAttribute(new Float32Array(this.part), 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

function wings(b: Builder, span: number, chord: number, sweep: number, segs = 4, z0 = 0.05): void {
  for (const side of [-1, 1]) {
    const row: [number, number][] = [];
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      const x = side * (0.05 + s * span);
      const c = chord * (1 - s * 0.6);
      const zLead = z0 - c * 0.35 + s * sweep;
      const lead = b.v(x, 0, zLead, side, s, 0.2);
      const trail = b.v(x, 0, zLead + c, side, s, -0.2);
      row.push([lead, trail]);
    }
    for (let i = 0; i < segs; i++) b.quad(row[i]![0], row[i + 1]![0], row[i + 1]![1], row[i]![1]);
  }
}

function tailFin(b: Builder, l: number, h: number): void {
  const root = b.v(0, 0, l * 0.42, 0, 0, -0.85);
  const top = b.v(0, h, l * 0.62, 0, 0, -1);
  const bottom = b.v(0, -h, l * 0.62, 0, 0, -1);
  b.tri(root, top, bottom);
}

export function swarmGeometry(kind: SwarmKind): BufferGeometry {
  const b = new Builder();
  switch (kind) {
    case 'bird':
      b.body(0.32, 0.08, 0.08, 6, 6);
      wings(b, 0.42, 0.14, 0.06, 4);
      tailFin(b, 0.32, 0.03);
      break;
    case 'eagle':
      b.body(0.9, 0.2, 0.18, 6, 7);
      wings(b, 1.1, 0.4, 0.12, 5);
      tailFin(b, 0.9, 0.12);
      break;
    case 'fish':
    case 'koi':
      b.body(kind === 'koi' ? 0.6 : 0.3, kind === 'koi' ? 0.13 : 0.07, kind === 'koi' ? 0.15 : 0.1, 8, 7, (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.7));
      tailFin(b, kind === 'koi' ? 0.6 : 0.3, kind === 'koi' ? 0.12 : 0.07);
      // Pectoral fins.
      for (const side of [-1, 1]) {
        const l = kind === 'koi' ? 0.6 : 0.3;
        const r0 = b.v(side * 0.04, -0.02, -l * 0.12, side, 0, 0.3);
        const r1 = b.v(side * 0.04, -0.02, -l * 0.02, side, 0, 0.2);
        const tip = b.v(side * l * 0.22, -l * 0.08, l * 0.02, side, 1, 0.2);
        b.tri(r0, r1, tip);
      }
      break;
    case 'jellyfish': {
      // Bell (dome) and trailing tentacle ribbons.
      const ring = 12;
      const rows = 5;
      const start = b.pos.length / 3;
      for (let i = 0; i <= rows; i++) {
        const t = i / rows;
        const a0 = t * Math.PI * 0.5;
        for (let j = 0; j < ring; j++) {
          const a = (j / ring) * Math.PI * 2;
          const r = Math.sin(a0) * 0.5;
          b.v(Math.cos(a) * r, Math.cos(a0) * 0.42, Math.sin(a) * r, 0, t, 1, 0);
        }
      }
      for (let i = 0; i < rows; i++) for (let j = 0; j < ring; j++) b.quad(start + i * ring + j, start + i * ring + ((j + 1) % ring), start + (i + 1) * ring + ((j + 1) % ring), start + (i + 1) * ring + j);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = Math.cos(a) * 0.32;
        const z = Math.sin(a) * 0.32;
        let prev: [number, number] | null = null;
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          const y = -t * 1.6;
          const w = 0.03 * (1 - t * 0.7);
          const l = b.v(x - w * Math.sin(a), y, z + w * Math.cos(a), 0, t, -t, 1);
          const r = b.v(x + w * Math.sin(a), y, z - w * Math.cos(a), 0, t, -t, 1);
          if (prev) b.quad(prev[0], prev[1], r, l);
          prev = [l, r];
        }
      }
      break;
    }
    case 'ray': {
      // A flat diamond whose wing tips undulate.
      const segs = 6;
      const nose = b.v(0, 0, -0.55, 0, 0, 1);
      const tail = b.v(0, 0, 0.45, 0, 0, -1);
      const tailTip = b.v(0, 0, 1.4, 0, 0, -1, 1);
      for (const side of [-1, 1]) {
        let prevTop = nose;
        for (let i = 1; i <= segs; i++) {
          const s = i / segs;
          const x = side * s * 0.9;
          const z = -0.55 + s * 0.65 - s * s * 0.1;
          const v = b.v(x, 0, z, side, s, 0.3 - s * 0.3);
          b.tri(prevTop, v, tail);
          prevTop = v;
        }
      }
      b.tri(tail, b.v(-0.02, 0, 0.5, 0, 0, -1), tailTip);
      break;
    }
    case 'turtle': {
      b.body(0.9, 0.75, 0.32, 6, 10, (t) => Math.pow(Math.sin(Math.PI * t), 0.55));
      b.body(0.25, 0.16, 0.14, 3, 6);
      // Head pushed forward.
      const head = b.pos.length / 3 - 6 * 4;
      for (let i = head; i < b.pos.length / 3; i++) b.pos[i * 3 + 2]! -= 0.55;
      for (const [side, front] of [[-1, 1], [1, 1], [-1, 0], [1, 0]] as const) {
        const z = front ? -0.18 : 0.3;
        const len = front ? 0.55 : 0.3;
        const a = b.v(side * 0.3, 0, z - 0.08, side, 0, front ? 0.3 : -0.3);
        const c = b.v(side * 0.3, 0, z + 0.08, side, 0, front ? 0.3 : -0.3);
        const tip = b.v(side * (0.3 + len), 0, z + (front ? 0.12 : 0.18), side, 1, front ? 0.3 : -0.3);
        b.tri(a, c, tip);
      }
      break;
    }
    case 'butterfly':
      b.body(0.12, 0.025, 0.025, 4, 5);
      for (const side of [-1, 1]) {
        const r = b.v(side * 0.01, 0, -0.02, side, 0, 0.3);
        const r2 = b.v(side * 0.01, 0, 0.04, side, 0, -0.3);
        const a = b.v(side * 0.16, 0, -0.1, side, 1, 0.4);
        const c = b.v(side * 0.17, 0, 0.02, side, 1, 0);
        const d = b.v(side * 0.11, 0, 0.11, side, 0.7, -0.4);
        b.quad(r, a, c, r2);
        b.tri(r2, c, d);
      }
      break;
    case 'whale':
      b.body(14, 3.2, 3, 12, 10, (t) => (t < 0.85 ? Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.1)), 0.6) : Math.max(0.05, (1 - t) * 1.6)));
      // Flukes.
      for (const side of [-1, 1]) {
        const root = b.v(0, 0, 6.6, 0, 0, -1);
        const back = b.v(0, 0, 7.6, 0, 0, -1);
        const tip = b.v(side * 2.6, 0, 7.8, side, 1, -1);
        b.tri(root, tip, back);
      }
      for (const side of [-1, 1]) {
        const r0 = b.v(side * 1.3, -0.6, -2.6, side, 0, 0.35);
        const r1 = b.v(side * 1.3, -0.6, -1.4, side, 0, 0.2);
        const tip = b.v(side * 4.2, -1.4, -0.4, side, 1, 0.2);
        b.tri(r0, r1, tip);
      }
      break;
  }
  return b.build();
}
