import { AdditiveBlending, DoubleSide, Group, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import {
  Fn,
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  int,
  length,
  max,
  mix,
  mrt,
  normalize,
  positionGeometry,
  pow,
  screenSize,
  sin,
  smoothstep,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { clearFront, floatUniform, seeded, z, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { MAX_IMPULSES, MOON_DIR, fogDepth, frontCrossing, release, revealMask, tick, world, type F, type V3, type V4, type WebWorld } from './shared';

const zWeb = z.object({
  center: zVec3,
  /** Facing of the web's plane (any length). */
  normal: zVec3.default([0, 0, 1]),
  /** Up within the plane (orb webs hang with the hub above the middle). */
  up: zVec3.default([0, 1, 0]),
  radius: z.number().positive(),
  /** Where the frame is tied (world points); otherwise an irregular frame around the orb. */
  anchors: z.array(zVec3).optional(),
  radials: z.number().int().min(8).max(60).default(28),
  /** Spiral turns across the capture area. */
  turns: z.number().int().min(6).max(90).default(38),
  /** Share of the capture spiral torn away (old, ragged webs). */
  torn: z.number().min(0).max(1).default(0.12),
  /** Dew beads per metre of spiral. */
  dew: z.number().min(0).default(0.6),
  /** Thread thickness (m) of the capture spiral; radials and frame are thicker. */
  thickness: z.number().positive().default(0.012),
  /** Brightness of the silk. */
  sheen: z.number().min(0).default(1),
  seed: z.number().default(1),
});

const schema = z.object({
  webs: z.array(zWeb).default([]),
  /** Single silk lines: draglines hanging from the ceiling, guy lines between ruins. */
  threads: z.array(z.object({ from: zVec3, to: zVec3, sag: z.number().default(0.02), thickness: z.number().default(0.01) })).default([]),
  /** Overall vibration response to the music's low end. */
  breathe: z.number().min(0).default(1),
});

type Params = z.infer<typeof schema>;
type Web = z.infer<typeof zWeb>;

/** A built web for creatures to walk on (registered on the world). */
export interface WebSurface {
  center: Vector3;
  normal: Vector3;
  up: Vector3;
  right: Vector3;
  radius: number;
}

/** Webs shared with the spiders (to walk across them and pluck them). */
const surfaces = new WeakMap<WebWorld, WebSurface[]>();
export function websOf(w: WebWorld): WebSurface[] {
  let s = surfaces.get(w);
  if (!s) {
    s = [];
    surfaces.set(w, s);
  }
  return s;
}

/** Thread kinds (packed in the instance attribute). */
const FRAME = 0;
const RADIAL = 1;
const SPIRAL = 2;
const HUB = 3;
const DEW = 4;

interface Segs {
  a: number[];
  b: number[];
  c: number[];
}

/** Ray from the hub along an in-plane direction to a polygon (in-plane coordinates): distance. */
function rayToPolygon(hx: number, hy: number, dx: number, dy: number, poly: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const ex = bx - ax;
    const ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - hx) * ey - (ay - hy) * ex) / den;
    const u = ((ax - hx) * dy - (ay - hy) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 1;
}

/**
 * Builds one orb web as thread segments: an irregular frame tied to its anchors, radials from an
 * off-centre hub to the frame, a capture spiral that sags between radials and is torn in places, a
 * hub of short criss-cross threads, and dew beads. Each endpoint carries how free it is to move
 * (0 at the frame and anchors, 1 in the capture area) for the vibration.
 */
function buildWeb(web: Web, out: Segs, surface: WebSurface): void {
  const rand = seeded(web.seed * 7919 + 17);
  const n = surface.normal;
  const up = surface.up;
  const right = surface.right;
  const C = surface.center;
  const R = web.radius;
  const P = (x: number, y: number, depth = 0) => new Vector3().copy(C).addScaledVector(right, x).addScaledVector(up, y).addScaledVector(n, depth);
  // In-plane frame polygon.
  let poly: [number, number][];
  let anchors3: Vector3[] | null = null;
  if (web.anchors && web.anchors.length >= 3) {
    anchors3 = web.anchors.map((a) => new Vector3(...a));
    poly = anchors3.map((a) => {
      const d = a.clone().sub(C);
      // Frame corners sit part-way to the anchors; long anchor lines span the rest.
      const k = 0.62 + rand() * 0.12;
      return [d.dot(right) * k, d.dot(up) * k];
    });
    // Order around the hub.
    poly.sort((p0, p1) => Math.atan2(p0[1], p0[0]) - Math.atan2(p1[1], p1[0]));
  } else {
    const corners = 5 + Math.floor(rand() * 3);
    poly = [];
    for (let i = 0; i < corners; i++) {
      const ang = (i / corners) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const r = R * (0.95 + rand() * 0.3);
      poly.push([Math.cos(ang) * r, Math.sin(ang) * r]);
    }
  }
  const push = (a: Vector3, b: Vector3, fa: number, fb: number, kind: number, width: number): void => {
    out.a.push(a.x, a.y, a.z, fa);
    out.b.push(b.x, b.y, b.z, fb);
    out.c.push(n.x, n.y, n.z, kind + Math.min(0.99, width / 0.2) * 0.999);
  };
  const t = web.thickness;
  // Frame threads (doubled, slightly apart, as real frames are).
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    push(P(ax, ay), P(bx, by), 0.15, 0.15, FRAME, t * 2.4);
    push(P(ax * 1.01, ay * 1.01, 0.01), P(bx * 0.99, by * 0.99, -0.01), 0.15, 0.15, FRAME, t * 1.6);
  }
  if (anchors3) {
    for (let i = 0; i < anchors3.length; i++) {
      const [px, py] = poly[i]!;
      const corner = P(px, py);
      // The anchor this corner belongs to: the nearest in-plane direction.
      let best = anchors3[0]!;
      let bd = Infinity;
      for (const a of anchors3) {
        const d = a.clone().sub(C);
        const dd = Math.hypot(d.dot(right) - px, d.dot(up) - py);
        if (dd < bd) {
          bd = dd;
          best = a;
        }
      }
      push(corner, best, 0.12, 0, FRAME, t * 2.6);
    }
  }
  // Hub, a little above the middle.
  const hx = (rand() - 0.5) * R * 0.08;
  const hy = R * (0.06 + rand() * 0.06);
  const radials = web.radials;
  const angles: number[] = [];
  for (let i = 0; i < radials; i++) angles.push((i / radials) * Math.PI * 2 + (rand() - 0.5) * (Math.PI * 2 / radials) * 0.5);
  const reach = angles.map((ang) => rayToPolygon(hx, hy, Math.cos(ang), Math.sin(ang), poly));
  const at = (i: number, r: number, depth = 0): Vector3 => {
    const ang = angles[i % radials]!;
    return P(hx + Math.cos(ang) * r, hy + Math.sin(ang) * r, depth);
  };
  const free = (r: number, i: number): number => Math.min(1, Math.max(0, 1 - r / reach[i % radials]!)) ** 0.6;
  for (let i = 0; i < radials; i++) {
    // Radials run in a few slightly bent pieces (they are not taut rods).
    const L = reach[i]!;
    const pieces = 4;
    for (let k = 0; k < pieces; k++) {
      const r0 = (k / pieces) * L;
      const r1 = ((k + 1) / pieces) * L;
      const bend = (rand() - 0.5) * 0.004 * L;
      push(at(i, r0, bend), at(i, r1, -bend), free(r0, i), free(r1, i), RADIAL, t * 1.5);
    }
  }
  // Hub: short criss-cross threads.
  const hubR = R * 0.07;
  for (let k = 0; k < 26; k++) {
    const i = Math.floor(rand() * radials);
    const j = (i + 1 + Math.floor(rand() * 4)) % radials;
    const ri = hubR * (0.3 + rand() * 0.7);
    const rj = hubR * (0.3 + rand() * 0.7);
    push(at(i, ri), at(j, rj), free(ri, i), free(rj, j), HUB, t * 1.1);
  }
  // Capture spiral: from the free zone outward, sagging inward between radials, torn in places.
  const r0 = R * 0.16;
  const turns = web.turns;
  const total = turns * radials;
  let tornRun = 0;
  for (let s = 0; s < total; s++) {
    const i = s % radials;
    const f0 = s / total;
    const f1 = (s + 1) / total;
    const ra = r0 + (reach[i]! * 0.92 - r0) * f0;
    const rb = r0 + (reach[(i + 1) % radials]! * 0.92 - r0) * f1;
    if (tornRun > 0) {
      tornRun--;
      continue;
    }
    if (rand() < web.torn * 0.03) {
      tornRun = 3 + Math.floor(rand() * radials * 0.6);
      continue;
    }
    const a = at(i, ra);
    const b = at(i + 1, rb);
    // Sag: the midpoint pulled towards the hub.
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const toHub = P(hx, hy).sub(mid).normalize().multiplyScalar(a.distanceTo(b) * 0.08);
    mid.add(toHub);
    const fa = free(ra, i);
    const fb = free(rb, i + 1);
    push(a, mid, fa, (fa + fb) / 2, SPIRAL, t);
    push(mid, b, (fa + fb) / 2, fb, SPIRAL, t);
    // Dew beads along this piece.
    const len = a.distanceTo(b);
    let beads = len * web.dew;
    while (beads > 0) {
      if (rand() < beads) {
        const u = rand();
        const p = u < 0.5 ? a.clone().lerp(mid, u * 2) : mid.clone().lerp(b, u * 2 - 1);
        const size = t * (2.2 + rand() * 3.5);
        push(p, p, fa, fa, DEW, size);
      }
      beads -= 1;
    }
  }
}

/** A single silk line (sagging) as a few segments. */
function buildThread(th: Params['threads'][number], out: Segs): void {
  const a = new Vector3(...th.from);
  const b = new Vector3(...th.to);
  const n = new Vector3(0, 0, 1);
  const pieces = 10;
  const L = a.distanceTo(b);
  const point = (u: number) => a.clone().lerp(b, u).add(new Vector3(0, -Math.sin(Math.PI * u) * th.sag * L, 0));
  for (let k = 0; k < pieces; k++) {
    const u0 = k / pieces;
    const u1 = (k + 1) / pieces;
    const p0 = point(u0);
    const p1 = point(u1);
    out.a.push(p0.x, p0.y, p0.z, Math.sin(Math.PI * u0) * 0.6);
    out.b.push(p1.x, p1.y, p1.z, Math.sin(Math.PI * u1) * 0.6);
    out.c.push(n.x, n.y, n.z, RADIAL + Math.min(0.99, th.thickness / 0.2) * 0.999);
  }
}

/**
 * Enormous procedural orb webs and loose silk lines. Threads are instanced ribbons expanded in the
 * vertex shader: never thinner than about a pixel, with their coverage carried as transparency, so
 * fine silk stays visible far away without aliasing into lines. Silk shades as thin fibres
 * (Kajiya-Kay): it lights up only where the moon catches it at the right angle, otherwise it is a
 * faint grey veil; dew beads sparkle. Spider steps and landings pluck the webs (damped waves that
 * travel from the impulse; anchors stay still), and the music's low end makes them breathe.
 */
export const webWebs: ComponentFactory<Params> = {
  type: 'webWebs',
  version: 1,
  description: 'Procedural orb webs and silk lines: thread shading, dew, plucked vibration and music breathing.',
  schema,
  create(ctx, p) {
    const w = world(ctx);
    const presence = floatUniform(1);
    const breathe = floatUniform(p.breathe);
    const segs: Segs = { a: [], b: [], c: [] };
    const reg = websOf(w);
    for (const web of p.webs) {
      const n = new Vector3(...web.normal).normalize();
      const up0 = new Vector3(...web.up);
      const right = new Vector3().crossVectors(up0, n).normalize();
      const up = new Vector3().crossVectors(n, right).normalize();
      const surface: WebSurface = { center: new Vector3(...web.center), normal: n, up, right, radius: web.radius };
      reg.push(surface);
      buildWeb(web, segs, surface);
    }
    for (const th of p.threads) buildThread(th, segs);
    const count = segs.a.length / 4;
    const ia = new InstancedBufferAttribute(new Float32Array(segs.a), 4);
    const ib = new InstancedBufferAttribute(new Float32Array(segs.b), 4);
    const ic = new InstancedBufferAttribute(new Float32Array(segs.c), 4);
    const A = instancedBufferAttribute<'vec4'>(ia, 'vec4') as unknown as V4;
    const B = instancedBufferAttribute<'vec4'>(ib, 'vec4') as unknown as V4;
    const Cc = instancedBufferAttribute<'vec4'>(ic, 'vec4') as unknown as V4;
    const vAcross = varyingProperty('float', 'vSilkAcross') as unknown as F;
    const vAlong = varyingProperty('float', 'vSilkAlong') as unknown as F;
    const vCover = varyingProperty('float', 'vSilkCover') as unknown as F;
    const vKind = varyingProperty('float', 'vSilkKind') as unknown as F;
    const vT = varyingProperty('vec3', 'vSilkT') as unknown as V3;
    const vW = varyingProperty('vec3', 'vSilkW') as unknown as V3;
    const vSeed = varyingProperty('float', 'vSilkSeed') as unknown as F;
    const time = w.u.time as unknown as F;
    const bass = w.u.bass as unknown as F;
    const mid = w.u.mid as unknown as F;
    const posArr = w.impulsePosNode;
    const ampArr = w.impulseAmpNode;
    /** Displacement along the web normal at a point with freedom f (0 anchored .. 1 free). */
    const displace = (p0: V3, f: F, nrm: V3, seed: F): V3 => {
      let d: F = float(0) as F;
      for (let i = 0; i < MAX_IMPULSES; i++) {
        const ip = posArr.element(int(i)) as unknown as V4;
        const amp = (ampArr.element(int(i)) as unknown as V4).x;
        const age = time.sub(ip.w);
        const dist = length(p0.sub(ip.xyz));
        // A wave front travelling ~9 m/s, ringing at ~6 Hz, dying over ~1.6 s and ~10 m.
        const front = smoothstep(age.mul(9).add(0.5), age.mul(9).sub(0.5), dist);
        const ring = sin(age.mul(38).sub(dist.mul(4.2))).mul(exp(age.mul(-1.6))).mul(exp(dist.mul(-0.1)));
        d = d.add(amp.mul(front).mul(ring).mul(age.greaterThan(0).select(float(1), float(0))).mul(0.12)) as F;
      }
      const sway = sin(time.mul(0.6).add(seed.mul(6.28))).mul(0.02).add(sin(time.mul(1.7).add(seed.mul(3.1))).mul(0.01));
      const music = bass.mul(0.05).add(mid.mul(sin(time.mul(9).add(seed.mul(40))).mul(0.01)));
      return nrm.mul(d.add(sway.add(music).mul(breathe)).mul(f)) as V3;
    };
    const m = new MeshBasicNodeMaterial();
    m.vertexNode = Fn(() => {
      const kind = Cc.w.floor();
      const width = Cc.w.fract().mul(0.2);
      const nrm = normalize(Cc.xyz) as V3;
      const seed = A.x.mul(0.137).add(A.z.mul(0.071)).fract() as F;
      const pa = A.xyz.add(displace(A.xyz as V3, A.w as F, nrm, seed)) as V3;
      const pb = B.xyz.add(displace(B.xyz as V3, B.w as F, nrm, seed)) as V3;
      const q = positionGeometry.xy; // -0.5..0.5 along x, across y
      const isDew = kind.greaterThan(DEW - 0.5);
      const va = cameraViewMatrix.mul(vec4(pa, 1));
      const vb = cameraViewMatrix.mul(vec4(pb, 1));
      const centre = mix(va, vb, q.x.add(0.5));
      const dist = centre.z.negate().max(0.1);
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): { y: F } }).element(1).y;
      const pxWorld = dist.mul(2).div(p11).div(screenSize.y);
      // At least ~0.9 px wide; thinner real threads keep their light as lower coverage.
      const half = max(width.mul(0.5), pxWorld.mul(0.45));
      const cover = width.div(half.mul(2)).min(1);
      const dir = vb.xy.sub(va.xy);
      const along = normalize(dir.add(vec4(1e-5, 0, 0, 0).xy));
      const side = vec3(along.y.negate(), along.x, 0);
      // Dew beads are round sprites at their point.
      const dewHalf = max(width.mul(0.5), pxWorld.mul(0.7));
      const offset = isDew.select(vec3(q.x.mul(dewHalf.mul(2)), q.y.mul(dewHalf.mul(2)), 0), side.mul(q.y.mul(half.mul(2))));
      const pos = isDew.select(va.xyz, centre.xyz).add(offset);
      vAcross.assign(q.y.mul(2));
      vAlong.assign(q.x.mul(2));
      vCover.assign(isDew.select(width.div(dewHalf.mul(2)).min(1).pow(1.2), cover));
      vKind.assign(kind);
      vT.assign(normalize(pb.sub(pa).add(vec3(0, 1e-5, 0))));
      vW.assign(mix(pa, pb, q.x.add(0.5)));
      vSeed.assign(seed);
      return cameraProjectionMatrix.mul(vec4(pos, 1));
    })();
    // Fibre shading.
    const T = vT;
    const L = vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z);
    const V = normalize(cameraPosition.sub(vW));
    const H = normalize(L.add(V));
    const tH = dot(T, H);
    const tL = dot(T, L);
    const spec = pow(float(1).sub(tH.mul(tH)).max(0).sqrt(), float(24)).mul(2.2);
    const diffuse = float(1).sub(tL.mul(tL)).max(0).sqrt().mul(0.16);
    const isDew = vKind.greaterThan(DEW - 0.5);
    const round = isDew.select(smoothstep(1, 0.4, length(vec3(vAcross, vAlong, 0))), smoothstep(1, 0.2, abs(vAcross)));
    // Dew: a bright point where the moon reflects, twinkling with the treble.
    const twinkle = sin(time.mul(2.3).add(vSeed.mul(60))).mul(0.5).add(0.5).pow(6).mul((w.u.treble as unknown as F).mul(1.5).add(0.6));
    const dewLight = twinkle.mul(0.9).add(0.12);
    const moonCol = vec3(0.62, 0.7, 0.82);
    const silk = moonCol.mul(spec.add(diffuse)).add(vec3(0.03, 0.034, 0.042));
    // A clear's front runs out through the webs: the dew beads in its band glint and the silk
    // catches a pale sheen as it passes (light only, the beads' own size).
    const front = clearFront(vW);
    const glint = isDew.select(front.mul(sin(vSeed.mul(91).add(time.mul(1.3))).mul(0.5).add(0.5).mul(1.2).add(0.4)), front.mul(spec.mul(0.35).add(0.08)));
    const light = isDew.select(moonCol.mul(dewLight), silk).add(vec3(0.05, 0.05, 0.065).mul(w.u.clear as unknown as F)).add(vec3(0.7, 0.78, 0.9).mul(glint));
    const keep = exp(fogDepth(w, vW).negate());
    const alpha = round.mul(vCover).mul(keep).mul(revealMask(presence as unknown as F, 900)).mul(float(p.webs[0]?.sheen ?? 1));
    const col = light.mul(alpha);
    m.colorNode = vec4(col, 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(col.mul(isDew.select(float(0.4), float(0.05))), 1) });
    const geo = new PlaneGeometry(1, 1);
    const mesh = new Mesh(geo, m);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    const group = new Group();
    group.add(mesh);
    let lastFrame = -1;
    return {
      object: group,
      reactive: { breathe },
      update(frame) {
        tick(w, frame.time, frame.dt, frame.audio);
        // A clear's front plucks each web as it reaches it (bigger clears harder), so the shiver
        // runs out from the board through the webs; it hums now and then.
        const o = ctx.uniforms.waveOrigin.value;
        if (lastFrame >= 0) {
          for (const s of reg) {
            const k = frontCrossing(ctx, s.center.distanceTo(o), lastFrame, frame.time);
            if (k <= 0.01) continue;
            pluckAt(w, s.center, Math.min(1, 0.2 + k * 0.55));
            if (k > 0.5 && frame.presence > 0.5) ctx.sounds.emit('webHum', s.center.x, s.center.y, s.center.z, Math.min(0.6, k * 0.4));
          }
        }
        lastFrame = frame.time;
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        geo.dispose();
        m.dispose();
        reg.length = 0;
        release(w);
      },
    };
  },
};

function pluckAt(w: WebWorld, c: Vector3, k: number): void {
  const i = w.nextImpulse;
  w.nextImpulse = (w.nextImpulse + 1) % MAX_IMPULSES;
  w.impulsePos[i]!.set(c.x, c.y, c.z, w.time);
  w.impulseAmp[i]!.set(k, 0, 0, 0);
}
