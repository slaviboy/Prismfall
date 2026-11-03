import { z } from 'zod';

const v3 = z.tuple([z.number(), z.number(), z.number()]);

/** Where a group walks. Open paths are crossings (enter, walk, leave, rest, repeat); loops never end. */
export const pathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), from: v3, to: v3 }),
  z.object({ kind: z.literal('loop'), center: v3, radius: z.tuple([z.number(), z.number()]), clockwise: z.boolean().default(false) }),
  z.object({ kind: z.literal('polyline'), points: z.array(v3).min(2), closed: z.boolean().default(false) }),
]);

export type CreaturePath = z.infer<typeof pathSchema>;

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** Unit direction of travel on the ground plane. */
  dx: number;
  dz: number;
}

/** Polyline form of any path (loops become 64-sided ellipses). */
export function pathPoints(path: CreaturePath): { points: [number, number, number][]; closed: boolean } {
  switch (path.kind) {
    case 'line':
      return { points: [path.from, path.to], closed: false };
    case 'polyline':
      return { points: path.points, closed: path.closed };
    case 'loop': {
      const n = 64;
      const pts: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 * (path.clockwise ? -1 : 1);
        pts.push([path.center[0] + Math.cos(a) * path.radius[0], path.center[1], path.center[2] + Math.sin(a) * path.radius[1]]);
      }
      return { points: pts, closed: true };
    }
  }
}

/** Arc-length parameterised path. */
export class PathTrack {
  readonly length: number;
  readonly closed: boolean;
  private readonly pts: [number, number, number][];
  private readonly cumulative: number[];

  constructor(path: CreaturePath) {
    const { points, closed } = pathPoints(path);
    this.closed = closed;
    this.pts = closed ? [...points, points[0]!] : points;
    this.cumulative = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1]!;
      const b = this.pts[i]!;
      this.cumulative.push(this.cumulative[i - 1]! + Math.hypot(b[0] - a[0], b[2] - a[2]));
    }
    this.length = Math.max(1e-6, this.cumulative[this.cumulative.length - 1]!);
  }

  /** Point at arc length `s` (wrapped for loops, clamped-and-extrapolated for open paths). */
  at(s: number, out: PathPoint): PathPoint {
    let d = s;
    if (this.closed) d = ((s % this.length) + this.length) % this.length;
    const n = this.pts.length;
    let i = 1;
    if (d <= 0) i = 1;
    else if (d >= this.length) i = n - 1;
    else while (i < n - 1 && this.cumulative[i]! < d) i++;
    const a = this.pts[i - 1]!;
    const b = this.pts[i]!;
    const segLen = Math.max(1e-6, this.cumulative[i]! - this.cumulative[i - 1]!);
    const t = (d - this.cumulative[i - 1]!) / segLen;
    out.x = a[0] + (b[0] - a[0]) * t;
    out.y = a[1] + (b[1] - a[1]) * t;
    out.z = a[2] + (b[2] - a[2]) * t;
    const dl = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    out.dx = (b[0] - a[0]) / dl;
    out.dz = (b[2] - a[2]) / dl;
    return out;
  }
}

export interface GroupMotionParams {
  /** Ground speed at scale 1 (m/s). */
  readonly speed: number;
  /** Seconds before the first crossing starts. */
  readonly delay: number;
  /** Seconds of rest (out of sight) between crossings on open paths. */
  readonly rest: number;
  /** Optional stops while walking: walk `stopEvery` s, stand `stopFor` s. 0 disables. */
  readonly stopEvery: number;
  readonly stopFor: number;
}

/**
 * Time → distance for one group, including smooth starts/stops and the rest gap between open-path
 * crossings. Deterministic in time, so a stage looks the same however the frame rate varies.
 */
export class GroupMotion {
  /** Distance walked along the current crossing (group lead). */
  distance = 0;
  /** 0..1 walking factor (eases to 0 during stops). */
  walking = 0;
  /** Index of the current crossing (open paths) for per-crossing variety. */
  crossing = 0;
  private clock = 0;
  private walkClock = 0;

  constructor(
    private readonly p: GroupMotionParams,
    private readonly span: number,
    private readonly closed: boolean,
  ) {}

  /** Advances time; returns the distance moved this step (for gait phase). */
  step(dt: number): number {
    this.clock += dt;
    if (this.clock < this.p.delay) {
      this.walking = 0;
      return 0;
    }
    this.walkClock += dt;
    let target = 1;
    if (this.p.stopEvery > 0 && this.p.stopFor > 0) {
      const cycle = this.p.stopEvery + this.p.stopFor;
      const t = this.walkClock % cycle;
      target = t < this.p.stopEvery ? 1 : 0;
    }
    // Ease in and out of stops (about a second to start or stop walking).
    this.walking += (target - this.walking) * Math.min(1, dt * 1.6);
    const moved = this.p.speed * this.walking * dt;
    this.distance += moved;
    // Open paths: once the last member has left (span = path + group length), rest, then re-enter.
    if (!this.closed && this.distance >= this.span + this.p.rest * this.p.speed) {
      this.distance = 0;
      this.crossing++;
    }
    return moved;
  }
}

/** Visibility along an open crossing: fades in over `fade` metres at the start, out at the end. */
export function crossingFade(distance: number, length: number, fade: number): number {
  if (distance <= 0 || distance >= length) return 0;
  const f = Math.max(1e-3, fade);
  return Math.min(1, distance / f, (length - distance) / f);
}
