/**
 * Branching lightning channels for volcanic discharges, built once on the CPU. A bolt is a list of
 * straight segments in a unit frame (the main channel runs from the origin to about (0, -1, 0));
 * the renderer scales, turns and places it. Shapes come from midpoint displacement: a jagged
 * main channel with tortuous branches leaving it at 25-55 degrees, some with sub-branches.
 */

export type V3 = [number, number, number];

export interface BoltSegment {
  readonly a: V3;
  readonly b: V3;
  /** 0 main channel, 1 branch, 2 sub-branch. */
  readonly level: number;
  /** 0 for the main channel; branches are numbered from 1 (strokes light different branches). */
  readonly branch: number;
}

const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const add = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const scale = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const len = (p: V3): number => Math.hypot(p[0], p[1], p[2]);
const norm = (p: V3): V3 => scale(p, 1 / (len(p) || 1));
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];

/** Two unit vectors perpendicular to `d` (and to each other). */
function basis(d: V3): [V3, V3] {
  const helper: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, helper));
  return [u, cross(d, u)];
}

/** A jagged polyline from `from` to `to`: `levels` rounds of midpoint displacement. */
function jagged(rand: () => number, from: V3, to: V3, levels: number, roughness: number): V3[] {
  let pts: V3[] = [from, to];
  let amp = roughness;
  for (let l = 0; l < levels; l++) {
    const next: V3[] = [pts[0] as V3];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i] as V3;
      const q = pts[i + 1] as V3;
      const d = sub(q, p);
      const [u, v] = basis(norm(d));
      const k = len(d) * amp;
      const ang = rand() * Math.PI * 2;
      const off = add(scale(u, Math.cos(ang) * k * (rand() * 2 - 1)), scale(v, Math.sin(ang) * k * (rand() * 2 - 1)));
      next.push(add(scale(add(p, q), 0.5), off), q);
    }
    pts = next;
    amp *= 0.6;
  }
  return pts;
}

export function makeBolt(rand: () => number): BoltSegment[] {
  const segs: BoltSegment[] = [];
  const main = jagged(rand, [0, 0, 0], [(rand() - 0.5) * 0.3, -1, (rand() - 0.5) * 0.3], 6, 0.55);
  for (let i = 0; i < main.length - 1; i++) segs.push({ a: main[i] as V3, b: main[i + 1] as V3, level: 0, branch: 0 });
  let branch = 1;
  const branches = 4 + Math.floor(rand() * 4);
  for (let k = 0; k < branches; k++) {
    // Branches leave the upper and middle channel, shorter further along it.
    const t = 0.08 + rand() * 0.72;
    const i = Math.min(main.length - 2, Math.floor(t * (main.length - 1)));
    const start = main[i] as V3;
    const dir = norm(sub(main[i + 1] as V3, start));
    const [u, v] = basis(dir);
    const ang = rand() * Math.PI * 2;
    const tilt = ((25 + rand() * 30) * Math.PI) / 180;
    const side = add(scale(u, Math.cos(ang)), scale(v, Math.sin(ang)));
    const bdir = norm(add(scale(dir, Math.cos(tilt)), scale(side, Math.sin(tilt))));
    const blen = (0.18 + rand() * 0.3) * (1 - t * 0.5);
    const pts = jagged(rand, start, add(start, scale(bdir, blen)), 4, 0.38);
    const id = branch++;
    for (let j = 0; j < pts.length - 1; j++) segs.push({ a: pts[j] as V3, b: pts[j + 1] as V3, level: 1, branch: id });
    if (rand() < 0.45) {
      const j = 2 + Math.floor(rand() * Math.max(1, pts.length - 4));
      const s0 = pts[Math.min(j, pts.length - 2)] as V3;
      const [u2] = basis(bdir);
      const sdir = norm(add(bdir, scale(u2, rand() < 0.5 ? 0.8 : -0.8)));
      const spts = jagged(rand, s0, add(s0, scale(sdir, blen * (0.3 + rand() * 0.3))), 3, 0.35);
      for (let m = 0; m < spts.length - 1; m++) segs.push({ a: spts[m] as V3, b: spts[m + 1] as V3, level: 2, branch: id });
    }
  }
  return segs;
}
