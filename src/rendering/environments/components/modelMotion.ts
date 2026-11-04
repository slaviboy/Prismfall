import { AnimationClip, CatmullRomCurve3, Matrix3, Matrix4, PropertyBinding, Vector3, VectorKeyframeTrack, type KeyframeTrack, type Object3D } from 'three/webgpu';

/**
 * Pure helpers behind the `model` component's walking creatures: root motion removal (so a clip
 * that walks forward by itself can follow a path), stateless path progress with stops (pauses with
 * their own clip, easing in and out), and procedural bone oscillation.
 */

export interface InPlaceClip {
  readonly clip: AnimationClip;
  /** Ground speed the clip walked at, in the root object's units per second (0 when it stood still). */
  readonly speed: number;
  /** Name of the bone whose horizontal motion was removed, or null when the clip had none. */
  readonly bone: string | null;
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
};

function countDescendants(o: Object3D): number {
  let n = 0;
  o.traverse(() => n++);
  return n - 1;
}

/**
 * Removes a clip's root motion: the horizontal part of the position track of the animated bone
 * that carries the most of the skeleton (hips, pelvis), so the creature walks on the spot and
 * keeps its vertical bob. The removed motion is measured first (median per-key velocity, robust to
 * a loop that snaps back to the start) and returned as the clip's ground speed in `root` units.
 * `root` must be the untransformed model scene at rest (world matrices are refreshed here).
 */
export function inPlaceClip(clip: AnimationClip, root: Object3D): InPlaceClip {
  root.updateMatrixWorld(true);
  let best: { track: KeyframeTrack; index: number; node: Object3D; weight: number } | null = null;
  clip.tracks.forEach((track, index) => {
    const parsed = PropertyBinding.parseTrackName(track.name);
    if (parsed.propertyName !== 'position' || track.getValueSize() !== 3) return;
    const node = PropertyBinding.findNode(root, parsed.nodeName) as Object3D | null;
    if (!node?.parent) return;
    const weight = countDescendants(node);
    if (!best || weight > best.weight) best = { track, index, node, weight };
  });
  const chosen = best as { track: KeyframeTrack; index: number; node: Object3D; weight: number } | null;
  if (!chosen || chosen.track.times.length < 2) return { clip, speed: 0, bone: null };
  const { track, index, node } = chosen;
  const parentWorld = node.parent!.matrixWorld;
  const toLocal = new Matrix4().copy(parentWorld).invert();
  // World up and the root's frame, expressed in the bone's parent space.
  const up = new Vector3(0, 1, 0).transformDirection(toLocal);
  const values = track.values;
  const times = track.times;
  const p = new Vector3();
  const horizontal = (i: number, out: Vector3) => {
    out.fromArray(values, i * 3);
    return out.addScaledVector(up, -out.dot(up));
  };
  // Median velocity between keys (a loop that snaps back is one outlier among many).
  const vx: number[] = [];
  const vy: number[] = [];
  const vz: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 1; i < times.length; i++) {
    const dt = times[i]! - times[i - 1]!;
    if (dt <= 0) continue;
    horizontal(i - 1, a);
    horizontal(i, b);
    vx.push((b.x - a.x) / dt);
    vy.push((b.y - a.y) / dt);
    vz.push((b.z - a.z) / dt);
  }
  // The median key velocity, brought from the parent's space into the root's.
  const velocity = new Vector3(median(vx), median(vy), median(vz)).applyMatrix3(new Matrix3().setFromMatrix4(parentWorld));
  // Lock the horizontal position to the bone's rest position; keep its height over time.
  const rest = new Vector3().copy(node.position);
  const restH = rest.clone().addScaledVector(up, -rest.dot(up));
  const out = new Float32Array(values.length);
  for (let i = 0; i < times.length; i++) {
    p.fromArray(values, i * 3);
    const height = p.dot(up);
    p.copy(restH).addScaledVector(up, height);
    p.toArray(out, i * 3);
  }
  const tracks = clip.tracks.slice();
  tracks[index] = new VectorKeyframeTrack(track.name, Array.from(times), Array.from(out));
  const speed = Math.hypot(velocity.x, velocity.z);
  return { clip: new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode), speed, bone: node.name };
}

export interface PathStop {
  /** Share of the path (0..1) where the walker halts. */
  readonly at: number;
  /** Seconds it stays. */
  readonly for: number;
}

export interface PathPlan {
  /** World length of the path. */
  readonly length: number;
  /** Cruising speed, world units per second. */
  readonly speed: number;
  /** Offset into the cycle (0..1). */
  readonly phase: number;
  readonly stops: readonly PathStop[];
  /** Seconds to slow down into a stop and to get going again. */
  readonly ease: number;
}

export interface PathState {
  /** Share of the path covered (0..1). */
  readonly t: number;
  /** World distance covered along the path. */
  readonly distance: number;
  /** Speed factor, 0 (stopped) to 1 (cruising). */
  readonly pace: number;
  /** Index (into the sorted stops) of the stop being approached, held or left; -1 when cruising far from any. */
  readonly stop: number;
  /** Seconds into that stop: negative while slowing towards it, above its `for` while leaving it. */
  readonly stopTime: number;
}

/** Seconds a full cycle of the path takes, stops included. */
export function pathCycle(plan: PathPlan): number {
  const stops = orderedStops(plan.stops);
  let total = 0;
  segments(plan, stops).forEach((s) => (total += s.duration));
  return total + stops.reduce((sum, s) => sum + s.for, 0);
}

/** The stops `pathState` uses, in path order (its `stop` indexes this list). */
export function orderedStops<T extends PathStop>(stops: readonly T[]): T[] {
  return stops.filter((s) => s.at > 0 && s.at < 1 && s.for > 0).sort((a, b) => a.at - b.at);
}

interface Segment {
  from: number;
  to: number;
  /** Ease time at the start (after a stop) and at the end (before a stop). */
  easeIn: number;
  easeOut: number;
  duration: number;
}

function segments(plan: PathPlan, stops: readonly PathStop[]): Segment[] {
  const marks = [0, ...stops.map((s) => s.at), 1];
  const out: Segment[] = [];
  for (let k = 0; k < marks.length - 1; k++) {
    const from = marks[k]!;
    const to = marks[k + 1]!;
    const d = Math.max(0, (to - from) * plan.length);
    const ramps = (k > 0 ? 1 : 0) + (k < marks.length - 2 ? 1 : 0);
    // Each ease covers speed * ease / 2; shorten the eases if the segment is too short for them.
    const ease = ramps > 0 ? Math.min(plan.ease, (2 * d) / (plan.speed * ramps)) : 0;
    const easeIn = k > 0 ? ease : 0;
    const easeOut = k < marks.length - 2 ? ease : 0;
    out.push({ from, to, easeIn, easeOut, duration: d / plan.speed + (easeIn + easeOut) / 2 });
  }
  return out;
}

/**
 * Where a walker is on its looping path at `time`: it cruises at `speed`, eases into each stop,
 * holds there for the stop's duration and eases out again; without stops this is plain
 * `phase + time * speed / length` (mod 1). Stateless, so any time can be evaluated directly.
 */
export function pathState(time: number, plan: PathPlan): PathState {
  const stops = orderedStops(plan.stops);
  const segs = segments(plan, stops);
  const cycle = segs.reduce((s, g) => s + g.duration, 0) + stops.reduce((s, x) => s + x.for, 0);
  let tau = (((plan.phase * cycle + time) % cycle) + cycle) % cycle;
  const v = plan.speed;
  for (let k = 0; k < segs.length; k++) {
    const g = segs[k]!;
    const d = (g.to - g.from) * plan.length;
    if (tau < g.duration || k === segs.length - 1) {
      const s = Math.min(tau, g.duration);
      let dist: number;
      let pace: number;
      if (g.easeIn > 0 && s < g.easeIn) {
        dist = (v * s * s) / (2 * g.easeIn);
        pace = s / g.easeIn;
      } else if (g.easeOut > 0 && s > g.duration - g.easeOut) {
        const q = g.duration - s;
        dist = d - (v * q * q) / (2 * g.easeOut);
        pace = q / g.easeOut;
      } else {
        dist = (v * g.easeIn) / 2 + v * (s - g.easeIn);
        pace = 1;
      }
      dist = Math.min(d, Math.max(0, dist));
      // Which stop this segment is easing towards or away from (the nearer one).
      let stop = -1;
      let stopTime = 0;
      if (g.easeOut > 0 && s > g.duration - g.easeOut) {
        stop = k;
        stopTime = s - g.duration;
      } else if (g.easeIn > 0 && s < g.easeIn) {
        stop = k - 1;
        stopTime = stops[k - 1]!.for + s;
      }
      const distance = g.from * plan.length + dist;
      return { t: plan.length > 0 ? distance / plan.length : 0, distance, pace, stop, stopTime };
    }
    tau -= g.duration;
    const st = stops[k]!;
    if (tau < st.for) return { t: st.at, distance: st.at * plan.length, pace: 0, stop: k, stopTime: tau };
    tau -= st.for;
  }
  return { t: 0, distance: 0, pace: 1, stop: -1, stopTime: 0 };
}

/** Weight of a stop's own clip: 0 while cruising, rising as the walker slows, 1 while it stands. */
export function stopWeight(state: PathState): number {
  return state.stop < 0 ? 0 : 1 - state.pace;
}

/** A path a walker follows, measured by distance. */
export interface PathShape {
  readonly length: number;
  readonly closed: boolean;
  /** Point and unit tangent at a distance along the path (wrapping on closed paths). */
  sample(distance: number, point: Vector3, tangent: Vector3): void;
  /** Signed heading change per unit distance (+ turns left, towards +x when heading +z). */
  turn(distance: number): number;
  /** Largest |turn| on the path (0 for straight paths). */
  readonly maxTurn: number;
}

const wrapAngle = (a: number): number => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/**
 * A path through `points` (at least two): straight segments, or with `smooth` a centripetal
 * Catmull-Rom curve through them, resampled evenly so distance maps to position directly.
 * `closed` joins the last point back to the first.
 */
export function buildPath(points: readonly Vector3[], closed: boolean, smooth: boolean): PathShape {
  let pts: Vector3[];
  if (smooth && points.length >= 3) {
    const curve = new CatmullRomCurve3(points.map((p) => p.clone()), closed, 'centripetal');
    pts = curve.getSpacedPoints(Math.max(32, points.length * 48));
    if (closed) pts.pop();
  } else pts = points.map((p) => p.clone());
  if (closed) pts.push(pts[0]!.clone());
  const n = pts.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!);
  const length = Math.max(1e-6, cum[n - 1]!);
  // Heading of each segment and the signed turn at each inner vertex (per unit distance).
  const heading = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) heading[i] = Math.atan2(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.z - pts[i]!.z);
  const turnAt = new Float64Array(n);
  let maxTurn = 0;
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? i - 1 : closed ? n - 2 : -1;
    const next = i < n - 1 ? i : closed ? 0 : -1;
    if (prev < 0 || next < 0 || prev === next) continue;
    const span = ((cum[prev + 1]! - cum[prev]!) + (cum[next + 1]! - cum[next]!)) / 2;
    turnAt[i] = span > 1e-9 ? wrapAngle(heading[next]! - heading[prev]!) / span : 0;
    maxTurn = Math.max(maxTurn, Math.abs(turnAt[i]!));
  }
  const locate = (distance: number): { i: number; f: number } => {
    const d = closed ? ((distance % length) + length) % length : Math.min(length, Math.max(0, distance));
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid]! <= d) lo = mid;
      else hi = mid - 1;
    }
    const seg = cum[lo + 1]! - cum[lo]!;
    return { i: lo, f: seg > 1e-12 ? (d - cum[lo]!) / seg : 0 };
  };
  return {
    length,
    closed,
    maxTurn,
    sample(distance, point, tangent) {
      const { i, f } = locate(distance);
      point.lerpVectors(pts[i]!, pts[i + 1]!, f);
      tangent.subVectors(pts[i + 1]!, pts[i]!).normalize();
    },
    turn(distance) {
      const { i, f } = locate(distance);
      return turnAt[i]! * (1 - f) + turnAt[i + 1]! * f;
    },
  };
}

/** How creatures arrive with the run (see the model component's `reveal`). */
export interface RevealPlan {
  /** Game progress (0..1) where they start to assemble. */
  readonly from: number;
  /** Progress where they are fully there. */
  readonly to: number;
  /** Progress from which a big clear (QUAD, perfect clear) calls them in early. */
  readonly unlock: number;
  /** Seconds such a call lasts. */
  readonly hold: number;
}

/** Target presence (0..1): a smooth ramp over [from, to] of progress, or 1 while called in. */
export function revealTarget(plan: RevealPlan, progress: number, time: number, calledUntil: number): number {
  const span = plan.to - plan.from;
  const x = span > 1e-6 ? Math.min(1, Math.max(0, (progress - plan.from) / span)) : progress >= plan.from ? 1 : 0;
  const ramp = x * x * (3 - 2 * x);
  return time < calledUntil ? 1 : ramp;
}

/** Eases a reveal level towards its target (frame-rate independent; seconds to ~63%). */
export function stepReveal(level: number, target: number, dt: number, tau = 2.5): number {
  return level + (target - level) * (1 - Math.exp(-Math.max(0, dt) / Math.max(1e-3, tau)));
}

/**
 * Follows a reveal over a run: call `update` every frame with the clock and game progress, and
 * `bigClear` on a QUAD or perfect clear (it calls the creatures in once progress passed `unlock`).
 * `level` (0..1) eases towards the target; without a plan it stays 1.
 */
export class RevealTracker {
  level: number;
  private calledUntil = -1;
  private clock = 0;
  private progress = 0;

  constructor(
    private readonly plan: RevealPlan | undefined,
    private readonly tau = 2.5,
  ) {
    this.level = plan ? 0 : 1;
  }

  update(time: number, progress: number, dt: number): number {
    this.clock = time;
    this.progress = progress;
    if (this.plan) this.level = stepReveal(this.level, revealTarget(this.plan, progress, time, this.calledUntil), dt, this.tau);
    return this.level;
  }

  /** A QUAD or perfect clear: calls the creatures in once progress has passed `unlock`. */
  bigClear(): void {
    if (this.plan && this.progress >= this.plan.unlock) this.callIn(this.plan.hold);
  }

  /** An event call-in (`reveal`): calls the creatures in for `hold` seconds, whatever the progress. */
  callIn(hold = this.plan?.hold ?? 0): void {
    if (this.plan && hold > 0) this.calledUntil = Math.max(this.calledUntil, this.clock + hold);
  }
}

/** The board's rectangle on screen, in normalised device coordinates. */
export interface NdcRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A waypoint of a near-field pass: where it is on screen (NDC) and how far from the camera. */
export interface PassWaypoint {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

/**
 * Waypoints of a near-field pass (a creature crossing close in front of the camera): all on one
 * side of the board, never inside its screen rectangle widened by `margin`, so the path never
 * crosses the playfield or the cone around it from the viewer's eye. `in`: it emerges in the
 * distance beside the board and sweeps out past the camera; `out`: the reverse. `height` is the
 * NDC height the pass keeps to (it rises a little towards the far end).
 */
/**
 * Waypoints of a side-on crossing (`pass.path: "lateral"`, SDK 1.7): across one side of the frame at
 * about `far` units from the camera, between the frame edge (beyond it) and the board's widened
 * edge, never inside the board's rectangle. `in` enters at the frame edge and travels towards the
 * board, dissolving before the clear zone; `out` emerges beside the board and leaves by the frame
 * edge. A slight change of distance along the way keeps it from looking like a flat cut-out.
 */
export function lateralWaypoints(rect: NdcRect, side: 1 | -1, direction: 'in' | 'out', height: number, far: number, margin: number): PassWaypoint[] {
  const edge = Math.max(0, side > 0 ? rect.x1 : -rect.x0) + margin;
  const inner = Math.min(0.9, edge + 0.03);
  const xs = [1.3, 1.0, (1.0 + inner) / 2, inner];
  const ds = [far * 1.06, far, far * 0.97, far * 0.95];
  const pts = xs.map((x, i) => ({ x: x * side, y: Math.max(-0.95, Math.min(0.95, height)), distance: ds[i] as number }));
  return direction === 'in' ? pts : pts.reverse();
}

export function passWaypoints(rect: NdcRect, side: 1 | -1, direction: 'in' | 'out', height: number, near: number, far: number, margin: number): PassWaypoint[] {
  const edge = Math.max(0, side > 0 ? rect.x1 : -rect.x0) + margin;
  const inner = Math.min(0.97, edge + 0.04);
  const x1 = Math.min(0.95, Math.max(inner + 0.12, edge + 0.3));
  const xs = [inner, x1, Math.max(x1 + 0.05, 0.88), 1.45];
  const ds = [far, far * 0.42 + near * 1.04, near * 1.5, near];
  const ys = [height + 0.1, height + 0.05, height, height - 0.06];
  const pts = xs.map((x, i) => ({ x: x * side, y: Math.max(-0.95, Math.min(0.95, ys[i] as number)), distance: ds[i] as number }));
  return direction === 'in' ? pts : pts.reverse();
}
