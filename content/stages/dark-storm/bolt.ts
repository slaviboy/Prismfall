/**
 * Lightning channels, built on the CPU once per strike (pure TypeScript, no three.js).
 *
 * A cloud-to-ground channel is grown like a stepped leader: a random walk from the cloud base that
 * drifts towards its strike point, in steps of irregular length with kinks of tens of degrees, then
 * roughened again at a finer scale by midpoint displacement (lightning is tortuous at every scale).
 * Branches leave it mostly in its upper part, lean downwards and outwards, die away in the air and
 * fork again now and then. A cloud-to-cloud discharge crawls along under the cloud base, sagging,
 * with many spreading branches (spider lightning). Every channel comes from its own seed, so no two
 * strikes look alike.
 *
 * Each segment carries its distance along the channel from the cloud (`order`, 0..1), so the
 * renderer can grow the dim leader downwards before the return stroke lights the whole channel.
 */
import { makeRng, type StrikeKind } from './director';

export type V3 = [number, number, number];

export interface Segment {
  readonly a: V3;
  readonly b: V3;
  /** Relative thickness (1 = the main channel at its top). */
  readonly width: number;
  /** Relative brightness (1 = main channel). */
  readonly glow: number;
  /** Position along the channel from the cloud: 0 at the top, 1 where the main channel ends. */
  readonly order: number;
  /** 0 = main channel; branches are numbered from 1. */
  readonly branch: number;
  /** 0 main channel, 1 branch, 2 sub-branch. */
  readonly level: number;
}

export interface ChannelSpec {
  readonly kind: StrikeKind;
  /** Where the channel leaves the cloud. */
  readonly top: V3;
  /** The strike point on the ground, or the far end of a cloud-to-cloud channel. */
  readonly bottom: V3;
  readonly seed: number;
  /** 0..1: quality (fewer, coarser segments at low detail). */
  readonly detail?: number;
  /** Upper bound on the segment count. */
  readonly maxSegments?: number;
}

export interface Channel {
  readonly segments: Segment[];
  /** Length of the main channel (m). */
  readonly length: number;
}

const add = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const mul = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const len = (p: V3): number => Math.hypot(p[0], p[1], p[2]);
const norm = (p: V3): V3 => mul(p, 1 / (len(p) || 1));
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];

/** Two unit vectors perpendicular to `d` and to each other. */
function basis(d: V3): [V3, V3] {
  const helper: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, helper));
  return [u, cross(d, u)];
}

/** A random unit vector. */
function randomDir(rand: () => number): V3 {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

/**
 * A leader walk from `from` towards `to` in about `steps` steps: each step heads partly at the target
 * and partly in a random direction (more freely early on), with irregular lengths. Ends at `to` when
 * `land` is true, otherwise wherever the walk got (a branch dying in the air).
 */
function walk(rand: () => number, from: V3, to: V3, steps: number, wander: number, land: boolean, sag = 0): V3[] {
  const pts: V3[] = [from];
  let p = from;
  const total = len(sub(to, from));
  const stepLen = total / steps;
  const dir0 = norm(sub(to, from));
  let heading = dir0;
  for (let i = 1; i < steps; i++) {
    // A landing leader homes in on its strike point; a branch only keeps its general direction
    // (homing on a point in the air made branches loop back on themselves).
    const pull = land ? norm(sub(to, p)) : dir0;
    const progress = i / steps;
    // Persistent heading with random kinks; the pull towards the target grows near the end.
    const kink = randomDir(rand);
    const w = 0.35 + 0.5 * progress * progress;
    heading = norm(add(add(mul(heading, 0.55), mul(pull, w)), mul(kink, wander * (1 - 0.6 * progress))));
    let step = stepLen * (0.55 + rand() * 0.9);
    if (rand() < 0.08) step *= 1.8;
    let next = add(p, mul(heading, step));
    if (sag > 0) next = [next[0], next[1] - sag * Math.sin(Math.PI * progress) * stepLen * 0.08, next[2]];
    pts.push(next);
    p = next;
    if (land && len(sub(to, p)) < stepLen * 0.8) break;
  }
  if (land) pts.push(to);
  return pts;
}

/** Fine tortuosity: midpoint displacement of every segment, `levels` times. */
function roughen(rand: () => number, pts: V3[], levels: number, amount: number): V3[] {
  let cur = pts;
  let amp = amount;
  for (let l = 0; l < levels; l++) {
    const next: V3[] = [cur[0]!];
    for (let i = 0; i < cur.length - 1; i++) {
      const p = cur[i]!;
      const q = cur[i + 1]!;
      const d = sub(q, p);
      const [u, v] = basis(norm(d));
      const k = len(d) * amp;
      const mid = mul(add(p, q), 0.5);
      next.push(add(mid, add(mul(u, (rand() * 2 - 1) * k), mul(v, (rand() * 2 - 1) * k))), q);
    }
    cur = next;
    amp *= 0.55;
  }
  return cur;
}

/** Cumulative arc length along a polyline. */
function arcLengths(pts: V3[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)));
  return s;
}

/** Builds a strike's channel and its branches. */
export function buildChannel(spec: ChannelSpec): Channel {
  if (spec.kind === 'intracloud') return { segments: [], length: 0 };
  const rand = makeRng(spec.seed ^ 0x9e3779b9);
  const detail = Math.max(0, Math.min(1, spec.detail ?? 1));
  const maxSegments = spec.maxSegments ?? 900;
  const segments: Segment[] = [];
  const horizontal = spec.kind === 'cloudToCloud';
  const span = len(sub(spec.bottom, spec.top));
  const steps = Math.round((horizontal ? 40 : 34) + detail * 30 + rand() * 14);
  const coarse = walk(rand, spec.top, spec.bottom, steps, horizontal ? 0.85 : 0.8, true, horizontal ? 1 : 0);
  const main = roughen(rand, coarse, detail > 0.5 ? 2 : 1, 0.3);
  const s = arcLengths(main);
  const L = s[s.length - 1]!;
  const push = (seg: Segment): void => {
    if (segments.length < maxSegments) segments.push(seg);
  };
  for (let i = 0; i < main.length - 1; i++) {
    const t = s[i]! / L;
    push({ a: main[i]!, b: main[i + 1]!, width: 1 - 0.35 * t, glow: 1, order: t, branch: 0, level: 0 });
  }
  // Branches: many in the upper channel (the leader forked as it came down), fewer lower down.
  const count = Math.round((horizontal ? 10 : 8) + detail * (horizontal ? 10 : 9) + rand() * 6);
  let id = 1;
  for (let k = 0; k < count; k++) {
    const t = horizontal ? 0.04 + rand() * 0.9 : Math.pow(rand(), 1.15) * 0.88;
    const at = Math.min(main.length - 2, Math.floor(t * (main.length - 1)));
    const start = main[at]!;
    const dir = norm(sub(main[at + 1]!, start));
    const [u, v] = basis(dir);
    const ang = rand() * Math.PI * 2;
    const side = add(mul(u, Math.cos(ang)), mul(v, Math.sin(ang)));
    const tilt = ((22 + rand() * 38) * Math.PI) / 180;
    let bdir = norm(add(mul(dir, Math.cos(tilt)), mul(side, Math.sin(tilt))));
    // Cloud-to-ground branches head downwards; spider branches spread out under the cloud base.
    if (horizontal) bdir = norm([bdir[0], bdir[1] * 0.25 - 0.08, bdir[2]]);
    else bdir = norm([bdir[0], Math.min(bdir[1], -0.5 - rand() * 0.4), bdir[2]]);
    const blen = span * (horizontal ? 0.12 + rand() * 0.3 : (0.1 + rand() * 0.32) * (1 - t * 0.7));
    const end = add(start, mul(bdir, blen));
    const pts = roughen(rand, walk(rand, start, end, 10 + Math.floor(rand() * 9), 1.05, false), 2, 0.3);
    const bs = arcLengths(pts);
    const bl = bs[bs.length - 1]! || 1;
    const glow = 0.35 + rand() * 0.4;
    const branch = id++;
    const forkOrder = s[at]! / L;
    for (let j = 0; j < pts.length - 1; j++) {
      const along = bs[j]! / bl;
      push({ a: pts[j]!, b: pts[j + 1]!, width: 0.55 * (1 - along * 0.75), glow: glow * (1 - along * 0.8), order: forkOrder + (bs[j]! / L), branch, level: 1 });
    }
    // Some branches fork again.
    if (rand() < 0.5 && pts.length > 4) {
      const j0 = 1 + Math.floor(rand() * (pts.length - 3));
      const s0 = pts[j0]!;
      const [u2] = basis(bdir);
      const sdir = norm(add(bdir, mul(u2, rand() < 0.5 ? 0.9 : -0.9)));
      const send = add(s0, mul(sdir, blen * (0.25 + rand() * 0.35)));
      const spts = roughen(rand, walk(rand, s0, send, 4 + Math.floor(rand() * 4), 0.9, false), 1, 0.25);
      const ss = arcLengths(spts);
      const sl = ss[ss.length - 1]! || 1;
      const base = forkOrder + bs[j0]! / L;
      for (let m = 0; m < spts.length - 1; m++) {
        const along = ss[m]! / sl;
        push({ a: spts[m]!, b: spts[m + 1]!, width: 0.32 * (1 - along * 0.7), glow: glow * 0.6 * (1 - along * 0.8), order: base + ss[m]! / L, branch, level: 2 });
      }
    }
  }
  return { segments, length: L };
}
