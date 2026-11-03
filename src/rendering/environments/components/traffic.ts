import { AdditiveBlending, BoxGeometry, BufferAttribute, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Quaternion, Sprite, SpriteNodeMaterial, Vector3, type Node } from 'three/webgpu';
import { abs, cameraPosition, cameraProjectionMatrix, cos, dot, exp, float, floor, fract, instancedBufferAttribute, length, max, min, mix, mod, mrt, normalize, positionGeometry, pow, screenSize, tan, atan, select, sin, smoothstep, step, uv, vec2, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog, noBloom } from '../../shaders/uniforms';
import { cityDetail, citySchema, placeTowers, type Tower } from './city';
import { colorUniform, floatUniform, seeded, zColor } from './common';
import { revealMask } from './reveal';

// Colours go through colorUniform like every component (manifest hex is linearised twice), so
// the defaults are lighter than the light they give.
const schema = z.object({
  /**
   * The city's layout: copy the skyline layer's `count`, `near`, `far`, `spread`, `grid`,
   * `street`, `height`, `width`, `skyline`, `ground`, `exclude` and `seed`, so the streets run
   * exactly between its towers.
   */
  city: citySchema.optional(),
  /**
   * Roads seen across open ground or water (a far embankment in a photo): arcs at a constant
   * distance from the viewer, so the lamps sit at a constant elevation and match a panorama's
   * perspective. `elevation` is the road's angle below (negative) or above the viewer's eye.
   */
  roads: z
    .array(
      z.object({
        radius: z.number().positive(),
        /** Azimuths (degrees from the view axis, + right) the road spans. */
        from: z.number(),
        to: z.number(),
        elevation: z.number(),
        lanes: z.number().int().min(1).max(4).default(2),
        laneWidth: z.number().positive().default(3.5),
        speed: z.tuple([z.number().positive(), z.number().positive()]).default([10, 16]),
        gap: z.tuple([z.number().positive(), z.number().positive()]).default([10, 60]),
        /** Lamp brightness multiplier (distant lamps are point sources). */
        brightness: z.number().min(0).default(1),
        /** Seconds of motion each lamp smears over (a camera's exposure; 0 = points). */
        trail: z.number().min(0).max(1).default(0),
      }),
    )
    .default([]),
  /** Streets further than this from the viewer carry no traffic (the haze hides them anyway). */
  range: z.number().positive().default(460),
  /** Where the viewer stands (x, z), and the clear cone around the board: tan of its half-angle. */
  viewer: z.tuple([z.number(), z.number()]).default([0, 30]),
  /** Height of the viewer's eye (for roads given by elevation). */
  eyeY: z.number().default(1),
  clearance: z.number().min(0).default(0.36),
  /** Lane centre offset from the street centre (right-hand traffic). */
  laneOffset: z.number().min(0).default(1.7),
  /** Cars move in platoons (released by signals): cars per platoon, spacing in it, gaps between. */
  platoon: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([2, 8]),
  spacing: z.tuple([z.number().positive(), z.number().positive()]).default([7, 16]),
  gap: z.tuple([z.number().positive(), z.number().positive()]).default([35, 140]),
  /** Lane speeds (m/s); each lane slows and speeds up as a whole (stop-and-go waves). */
  speed: z.tuple([z.number().positive(), z.number().positive()]).default([7, 13]),
  stopAndGo: z.number().min(0).max(0.9).default(0.5),
  /** Headlights (LED and halogen), tail lights, and their brightness. */
  headlight: zColor.default('#fffcf6'),
  halogen: zColor.default('#fff3d9'),
  tail: zColor.default('#ff4030'),
  brightness: z.number().min(0).default(1),
  /** Lamp size (world units) before the minimum pixel size applies. */
  size: z.number().positive().default(0.42),
  /** Street lights along both sides (spacing 0 = none). */
  streetlights: z
    .object({
      spacing: z.number().min(0).default(34),
      height: z.number().positive().default(8.5),
      sodium: zColor.default('#ffdba8'),
      led: zColor.default('#f4f6ff'),
      /** Share of streets with old sodium lamps. */
      sodiumShare: z.number().min(0).max(1).default(0.55),
      brightness: z.number().min(0).default(0.6),
    })
    .prefault({}),
  /**
   * An elevated expressway along the waterfront in front of the towers (parallel to the grid's
   * x streets): deck on piers, lamps on the median, two directions of fast traffic.
   */
  expressway: z
    .object({
      center: z.tuple([z.number(), z.number()]).default([0, -98]),
      halfLength: z.number().positive().default(640),
      /** Deck top above the ground. */
      height: z.number().positive().default(9),
      lanes: z.number().int().min(1).max(4).default(2),
      laneWidth: z.number().positive().default(3.5),
      speed: z.tuple([z.number().positive(), z.number().positive()]).default([17, 25]),
      gap: z.tuple([z.number().positive(), z.number().positive()]).default([6, 45]),
      pierSpacing: z.number().positive().default(34),
      lampSpacing: z.number().positive().default(42),
      color: zColor.default('#5a5c66'),
    })
    .optional(),
  /** Glossy streaks of every lamp in the wet street (the water layer adds the sharp mirror). */
  reflections: z
    .object({
      strength: z.number().min(0).default(0.35),
      /** Half-spread of a streak in degrees (wet asphalt roughness). */
      spread: z.number().min(0).default(1.1),
    })
    .prefault({}),
  /** Height of the wet surface (defaults to just above the city ground). */
  wetY: z.number().optional(),
  bloom: z.number().min(0).default(0.35),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Lane direction codes: 0 +x, 1 +z (towards the viewer), 2 -x, 3 -z. */
export interface Lane {
  readonly x: number;
  readonly z: number;
  readonly dir: 0 | 1 | 2 | 3;
  readonly length: number;
  /** On the expressway deck rather than the street. */
  readonly elevated?: boolean;
  /** An arc road around the viewer: x is its radius, z its starting azimuth (radians). */
  readonly arc?: { readonly sign: 1 | -1; readonly y: number; readonly road: number };
}

/** Lanes of the arc roads: right-hand traffic, so heading right (+) is the nearer lane. */
export function arcLanes(roads: Params['roads'], eyeY: number): Lane[] {
  const lanes: Lane[] = [];
  roads.forEach((r, road) => {
    const y = eyeY + Math.tan((r.elevation * Math.PI) / 180) * r.radius;
    const a0 = (Math.min(r.from, r.to) * Math.PI) / 180;
    const a1 = (Math.max(r.from, r.to) * Math.PI) / 180;
    for (let k = 0; k < r.lanes; k++) {
      const off = 1.2 + r.laneWidth * (k + 0.5);
      const inner = r.radius - off;
      const outer = r.radius + off;
      lanes.push({ x: inner, z: a0, dir: 0, length: inner * (a1 - a0), arc: { sign: 1, y, road } }, { x: outer, z: a1, dir: 2, length: outer * (a1 - a0), arc: { sign: -1, y, road } });
    }
  });
  return lanes;
}

export interface Street {
  /** Centre line from (x0, z0) to (x1, z1); always axis-aligned. */
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

/**
 * Streets of a tower grid: the half-grid lines between rows and columns of towers, each spanning
 * the towers along it and clipped to `range` around the viewer. A street with towers on only one
 * side (the front avenue along the facades) still counts.
 */
export function cityStreets(towers: readonly Tower[], grid: number, viewer: readonly [number, number], range: number, minLength = 30): Street[] {
  const rows = new Map<number, number[]>();
  const cols = new Map<number, number[]>();
  for (const t of towers) {
    const gx = Math.round(t.x / grid);
    const gz = Math.round(t.z / grid);
    (rows.get(gz) ?? rows.set(gz, []).get(gz)!).push(gx);
    (cols.get(gx) ?? cols.set(gx, []).get(gx)!).push(gz);
  }
  const streets: Street[] = [];
  const [vx, vz] = viewer;
  const span = (lines: Map<number, number[]>, k: number): [number, number] | null => {
    const v = [...(lines.get(k) ?? []), ...(lines.get(k + 1) ?? [])];
    return v.length ? [Math.min(...v), Math.max(...v)] : null;
  };
  const keys = (m: Map<number, number[]>): number[] => {
    const ks = [...m.keys()];
    return Array.from({ length: Math.max(...ks) - Math.min(...ks) + 2 }, (_, i) => Math.min(...ks) - 1 + i);
  };
  if (towers.length === 0) return streets;
  for (const gz of keys(rows)) {
    const s = span(rows, gz);
    if (!s) continue;
    const zc = (gz + 0.5) * grid;
    const dz = zc - vz;
    if (Math.abs(dz) >= range) continue;
    const half = Math.sqrt(range * range - dz * dz);
    const x0 = Math.max((s[0] - 0.5) * grid, vx - half);
    const x1 = Math.min((s[1] + 0.5) * grid, vx + half);
    if (x1 - x0 >= minLength) streets.push({ x0, z0: zc, x1, z1: zc });
  }
  for (const gx of keys(cols)) {
    const s = span(cols, gx);
    if (!s) continue;
    const xc = (gx + 0.5) * grid;
    const dx = xc - vx;
    if (Math.abs(dx) >= range) continue;
    const half = Math.sqrt(range * range - dx * dx);
    const z0 = Math.max((s[0] - 0.5) * grid, vz - half);
    const z1 = Math.min((s[1] + 0.5) * grid, vz + half);
    if (z1 - z0 >= minLength) streets.push({ x0: xc, z0, x1: xc, z1 });
  }
  return streets;
}

/** Two lanes per street, driving on the right. */
export function streetLanes(streets: readonly Street[], offset: number): Lane[] {
  const lanes: Lane[] = [];
  for (const s of streets) {
    if (s.z0 === s.z1) {
      const length = s.x1 - s.x0;
      // Heading +x the right-hand side is +z; heading -x it is -z.
      lanes.push({ x: s.x0, z: s.z0 + offset, dir: 0, length }, { x: s.x1, z: s.z0 - offset, dir: 2, length });
    } else {
      const length = s.z1 - s.z0;
      // Heading +z (towards the viewer) the right-hand side is -x.
      lanes.push({ x: s.x0 - offset, z: s.z0, dir: 1, length }, { x: s.x0 + offset, z: s.z1, dir: 3, length });
    }
  }
  return lanes;
}

/** The expressway's lanes: right-hand traffic either side of the median, all along x. */
export function expresswayLanes(e: NonNullable<Params['expressway']>): Lane[] {
  const lanes: Lane[] = [];
  const [cx, cz] = e.center;
  const length = e.halfLength * 2;
  for (let k = 0; k < e.lanes; k++) {
    const off = 1.2 + e.laneWidth * (k + 0.5);
    lanes.push({ x: cx - e.halfLength, z: cz + off, dir: 0, length, elevated: true }, { x: cx + e.halfLength, z: cz - off, dir: 2, length, elevated: true });
  }
  return lanes;
}

/**
 * Night traffic on the city's streets: white headlight pairs and red tail-light pairs flowing in
 * both directions along every street between the towers, in platoons with gaps (as signals
 * release them), each lane slowing and speeding up as a whole, with brake lights brightening as
 * it slows. Lamps are directional: a car coming towards the viewer shows bright headlights, one
 * driving away shows its tail lights, a crossing car a dim glint of each. Street lights line both
 * sides. The wet street mirrors it all (the water layer's reflection), and towers hide what is
 * behind them. Lights inside the clear cone around the board fade out.
 *
 * Every lamp is an instanced sprite placed on the GPU from time and its lane; no per-frame CPU.
 */
export const trafficComponent: ComponentFactory<Params> = {
  type: 'traffic',
  version: 1,
  description: 'Night-city traffic on the city street grid: directional headlights and tail lights in platoons, brake lights, street lights.',
  schema,
  create(ctx, p) {
    const towers = p.city ? placeTowers(p.city, cityDetail(ctx.quality.detail), seeded(p.city.seed * 271 + 3)) : [];
    const streets = p.city ? cityStreets(towers, p.city.grid, p.viewer, p.range) : [];
    const lanes = [...streetLanes(streets, p.laneOffset), ...(p.expressway ? expresswayLanes(p.expressway) : []), ...arcLanes(p.roads, p.eyeY)];
    const ground = p.city?.ground ?? -15;
    const rand = seeded(p.seed * 5023 + 17);
    const share = ctx.quality.detail === 'low' ? 0.45 : ctx.quality.detail === 'medium' ? 0.7 : 1;
    const between = (r: readonly [number, number]): number => r[0] + (r[1] - r[0]) * rand();
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    for (const lane of lanes) {
      const e = lane.elevated ? p.expressway : undefined;
      const road = lane.arc ? p.roads[lane.arc.road] : undefined;
      const speed = between(e ? e.speed : road ? road.speed : p.speed);
      const gap = e ? e.gap : road ? road.gap : p.gap;
      // Lane height and lamp brightness; arc lanes use direction codes 8 (+) and 9 (-).
      const laneY = lane.arc ? lane.arc.y : ground + (e ? e.height : 0);
      const code = lane.arc ? (lane.arc.sign > 0 ? 8 : 9) : lane.dir + (e ? 4 : 0);
      const laneSeed = rand();
      let s = rand() * gap[1];
      while (s < lane.length) {
        const n = Math.round(between(p.platoon));
        for (let k = 0; k < n && s < lane.length; k++) {
          const carSeed = rand();
          // Direction code, plus 4 on the deck.
          if (rand() < share) for (let light = 0; light < 4; light++) {
            a.push(lane.x, lane.z, code, lane.length);
            b.push(s, speed, laneSeed, light + carSeed * 0.5);
            c.push(laneY, road ? road.brightness : 1, road ? road.trail * speed : 0, 0);
          }
          s += between(p.spacing) * (e ? 1.6 : 1);
        }
        s += between(gap);
      }
    }
    const count = a.length / 4;
    const group = new Group();
    const disposables: { dispose(): void }[] = [];
    const u = { presence: floatUniform(1), brightness: floatUniform(p.brightness), lamps: floatUniform(p.streetlights.brightness) };
    const time = ctx.quality.reducedMotion ? ctx.uniforms.time.mul(0.6) : ctx.uniforms.time;
    const [vx, vz] = p.viewer;
    const pixelAt = (dist: F): F => {
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
      return dist.mul(2).div(p11.mul(screenSize.y)) as F;
    };
    /** Fades lamps inside the clear cone around the board (horizontal angle from the view axis). */
    const clearFade = (pos: V3): F => {
      const k = abs(pos.x.sub(vx)).div(max(float(vz).sub(pos.z), 1));
      return smoothstep(p.clearance * 0.8, p.clearance * 1.2, k) as F;
    };
    /** A lamp: a round core the lamp's size in a faint, tight glare; the quad is four times the lamp. */
    const lampShape = (): F => {
      const r = length(uv().sub(0.5).mul(2));
      return exp(r.div(0.24).pow(2).negate()).add(exp(r.div(0.7).pow(2).negate()).mul(0.07)) as F;
    };
    const lampMaterial = (pos: V3, trueSize: F, light: V3, smear?: { length: F; dir: Node<'vec2'> }): SpriteNodeMaterial => {
      const pixel = pixelAt(length(cameraPosition.sub(pos)));
      const draw = max(trueSize, pixel.mul(1.6));
      const cover = trueSize.div(draw);
      // A smeared lamp spreads the same light over a longer quad.
      const stretch = smear ? float(1).add(smear.length.div(draw.mul(2))) : float(1);
      const lit = light.mul(cover.mul(cover)).div(stretch).mul(lampShape()).mul(clearFade(pos)).mul(u.presence) as V3;
      const m = new SpriteNodeMaterial();
      // The smear trails behind the lamp: centre the quad half a smear back along the road.
      m.positionNode = smear ? pos.sub(vec3(smear.dir.x, 0, smear.dir.y).mul(smear.length.mul(0.5))) : pos;
      m.scaleNode = smear ? vec2(draw.mul(4).add(smear.length), draw.mul(4)) : draw.mul(4);
      m.colorNode = vec4(additiveFog(lit), 1);
      m.mrtNode = mrt({ emissive: vec4(additiveFog(lit).mul(p.bloom), 1) });
      m.transparent = true;
      m.depthWrite = false;
      m.blending = AdditiveBlending;
      m.fog = false;
      return m;
    };
    /**
     * Glossy reflection of a lamp in the wet street: a thin strip on the ground running from below
     * the lamp towards the viewer, centred on the mirror point, seen as a vertical smear under it.
     */
    const streakMesh = (count: number, pos: V3, light: V3): Mesh => {
      const quad = new InstancedBufferGeometry();
      quad.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
      quad.setIndex([0, 1, 2, 2, 1, 3]);
      quad.instanceCount = count;
      const y = p.wetY ?? ground + 0.12;
      const foot = vec2(pos.x, pos.z);
      const camXZ = vec2(cameraPosition.x, cameraPosition.z);
      const toward = camXZ.sub(foot);
      const dist = max(length(toward), 1);
      const dirV = toward.div(dist);
      const h = max(pos.y.sub(y), 0.05);
      const H = max(cameraPosition.y.sub(y), 0.5);
      // The mirror point is seen at depression angle θm = atan((H + h) / d); roughness spreads the
      // reflection over θm ± δ, so every streak spans about the same angle on screen.
      const thetaM = atan(H.add(h).div(dist));
      const g = positionGeometry;
      const along = g.y.mul(2).sub(1);
      const theta = thetaM.add(along.mul((p.reflections.spread * Math.PI) / 180)).clamp(0.004, 1.4);
      const groundDist = H.div(tan(theta));
      const sideV = vec2(dirV.y.negate(), dirV.x);
      const pixel = pixelAt(groundDist);
      const width = max(float(p.size * 0.9), pixel.mul(1.3));
      // Skip the water's mirrored pass (its camera is below the surface): the mirror already has the lamps.
      const above = step(y, cameraPosition.y);
      const xz = camXZ.sub(dirV.mul(groundDist)).add(sideV.mul(g.x.mul(width).mul(0.5).mul(above)));
      const world = vec3(xz.x, y, xz.y) as V3;
      const profile = exp(along.mul(along).mul(-3.2)).mul(exp(g.x.mul(g.x).mul(-2.5))).mul(step(groundDist, dist)).mul(above);
      const cover = min(float(1), float(p.size * 0.9).div(width));
      const lit = light.mul(profile).mul(cover).mul(p.reflections.strength).mul(clearFade(pos)).mul(u.presence) as V3;
      const m = new MeshBasicNodeMaterial();
      m.positionNode = world;
      m.colorNode = vec4(additiveFog(lit), 1);
      m.mrtNode = mrt({ emissive: vec4(additiveFog(lit).mul(p.bloom * 0.5), 1) });
      m.transparent = true;
      m.depthWrite = false;
      m.blending = AdditiveBlending;
      m.side = DoubleSide;
      m.fog = false;
      const mesh = new Mesh(quad, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = -4;
      disposables.push(quad, m);
      return mesh;
    };

    if (count > 0) {
      const A = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(a), 4), 'vec4');
      const B = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(b), 4), 'vec4');
      const C = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(c), 4), 'vec4');
      const isArc = A.z.greaterThan(7.5);
      const arcSign = select(A.z.greaterThan(8.5), float(-1), float(1));
      const ang = mod(A.z, 4).mul(Math.PI / 2);
      const laneY = C.x;
      const laneLen = A.w;
      const laneSeed = B.z;
      // Lane-wide stop-and-go: speed v·(1 + k·cos(ωt + φ)); braking while it falls.
      const omega = float(Math.PI * 2).div(mix(float(30), float(65), laneSeed));
      const phase = time.mul(omega).add(laneSeed.mul(40));
      const travel = B.x.add(B.y.mul(time.add(sin(phase).mul(p.stopAndGo).div(omega))));
      const s = mod(travel, laneLen);
      // Straight lanes: start point and direction code. Arc lanes: radius and starting azimuth.
      const azimuth = A.y.add(arcSign.mul(s).div(A.x));
      const arcDir = vec2(cos(azimuth), sin(azimuth)).mul(arcSign);
      const dir = select(isArc, arcDir, vec2(cos(ang), sin(ang)));
      const brake = smoothstep(0.3, 0.85, sin(phase)).mul(p.stopAndGo * 1.6).clamp(0, 1);
      const light = floor(B.w);
      const carSeed = fract(B.w).mul(2);
      const isHead = light.lessThan(1.5);
      const side = mod(light, 2).mul(2).sub(1);
      const carLen = mix(float(4.2), float(4.9), carSeed);
      const along = select(isHead, carLen.mul(0.5), carLen.mul(-0.5));
      const track = mix(float(0.6), float(0.78), fract(carSeed.mul(7.3)));
      const perp = vec2(dir.y.negate(), dir.x);
      const straightXZ = A.xy.add(dir.mul(s));
      const arcXZ = vec2(float(p.viewer[0]).add(sin(azimuth).mul(A.x)), float(p.viewer[1]).sub(cos(azimuth).mul(A.x)));
      const xz = select(isArc, arcXZ, straightXZ).add(dir.mul(along)).add(perp.mul(side.mul(track)));
      const pos = vec3(xz.x, laneY.add(select(isHead, float(0.68), float(0.85))), xz.y) as V3;
      // Directional lamps: headlights shine forward, tail lights are seen from behind; the car
      // body hides each from the wrong side.
      const toCam = normalize(cameraPosition.sub(pos));
      const f = dot(vec3(dir.x, 0, dir.y), toCam);
      // Seen side-on, a headlight still shows its lens and the light it throws ahead.
      const head = pow(max(f, 0), 3).mul(0.85).add(abs(f).oneMinus().mul(0.22)).add(0.04).mul(smoothstep(-0.3, 0.1, f));
      const tail = pow(max(f.negate(), 0), 1.5).mul(0.5).add(0.25).add(brake.mul(0.9)).mul(smoothstep(0.3, -0.1, f));
      const ends = smoothstep(0, 12, s).mul(smoothstep(laneLen, laneLen.sub(12), s));
      const headC = mix(colorUniform(p.headlight), colorUniform(p.halogen), smoothstep(0.55, 0.6, fract(carSeed.mul(3.7))));
      const color = select(isHead, headC.mul(head).mul(4.5), colorUniform(p.tail).mul(tail).mul(1.6)).mul(ends).mul(C.y).mul(u.brightness) as V3;
      const size = select(isHead, float(p.size), float(p.size * 0.85)) as F;
      const mat = lampMaterial(pos, size, color, c.some((v, i) => i % 4 === 2 && v > 0) ? { length: C.z as F, dir } : undefined);
      const sprite = new Sprite(mat);
      sprite.count = count;
      sprite.frustumCulled = false;
      sprite.renderOrder = -4;
      group.add(sprite);
      disposables.push(mat, sprite.geometry);
      if (p.reflections.strength > 0) group.add(streakMesh(count, pos, color));
    }

    const sl = p.streetlights;
    if (sl.spacing > 0 && sl.brightness > 0 && (p.city || p.expressway)) {
      const lamps: number[] = [];
      const lr = seeded(p.seed * 911 + 5);
      const kerb = (p.city?.street ?? 7) * 0.5 - 0.6;
      for (const st of streets) {
        const along = st.z0 === st.z1 ? [1, 0] : [0, 1];
        const len = Math.hypot(st.x1 - st.x0, st.z1 - st.z0);
        const sodium = lr() < sl.sodiumShare ? 1 : 0;
        const n = Math.floor(len / sl.spacing);
        for (let i = 0; i <= n; i++) {
          // Staggered on the two sides.
          for (const sideSign of [-1, 1]) {
            const t = (i + (sideSign > 0 ? 0.5 : 0)) * sl.spacing;
            if (t > len) continue;
            if (lr() > share) continue;
            lamps.push(st.x0 + along[0]! * t - along[1]! * sideSign * kerb, ground + sl.height, st.z0 + along[1]! * t + along[0]! * sideSign * kerb, sodium + lr() * 0.5);
          }
        }
      }
      const e = p.expressway;
      if (e) {
        // Twin lamps on the median, sodium like most urban expressways.
        for (let x = e.center[0] - e.halfLength; x <= e.center[0] + e.halfLength; x += e.lampSpacing) {
          for (const side of [-1, 1]) if (lr() < share) lamps.push(x, ground + e.height + 10, e.center[1] + side * 0.9, 1 + lr() * 0.5);
        }
      }
      if (lamps.length > 0) {
        const L = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(lamps), 4), 'vec4');
        const pos = L.xyz as V3;
        const c = mix(colorUniform(sl.led), colorUniform(sl.sodium), step(1, L.w)).mul(fract(L.w).mul(0.8).add(0.8)).mul(u.lamps) as V3;
        const mat = lampMaterial(pos, float(0.45) as F, c.mul(1.4) as V3);
        const sprite = new Sprite(mat);
        sprite.count = lamps.length / 4;
        sprite.frustumCulled = false;
        sprite.renderOrder = -4;
        group.add(sprite);
        disposables.push(mat, sprite.geometry);
        if (p.reflections.strength > 0) group.add(streakMesh(lamps.length / 4, pos, c.mul(1.4) as V3));
      }
    }

    if (p.expressway) {
      const e = p.expressway;
      const [cx, cz] = e.center;
      const half = 1.2 + e.lanes * e.laneWidth + 0.9;
      const top = ground + e.height;
      const parts: Matrix4[] = [];
      const box = (x: number, y: number, zz: number, sx: number, sy: number, sz: number): void => {
        parts.push(new Matrix4().compose(new Vector3(x, y, zz), new Quaternion(), new Vector3(sx, sy, sz)));
      };
      const len = e.halfLength * 2;
      // Deck slab, edge parapets, median barrier.
      box(cx, top - 0.8, cz, len, 1.6, half * 2);
      for (const side of [-1, 1]) box(cx, top + 0.2, cz + side * (half - 0.15), len, 0.4, 0.3);
      box(cx, top + 0.4, cz, len, 0.8, 0.5);
      // Piers: a column under the median with a cap beam under the deck.
      for (let x = cx - e.halfLength + e.pierSpacing * 0.5; x < cx + e.halfLength; x += e.pierSpacing) {
        box(x, ground + (e.height - 1.6) / 2, cz, 1.8, e.height - 1.6, 2.4);
        box(x, top - 2.1, cz, 1.6, 1.0, half * 1.7);
      }
      const unit = new BoxGeometry(1, 1, 1);
      const deckMat = new MeshStandardNodeMaterial();
      deckMat.colorNode = vec4(colorUniform(e.color), 1);
      deckMat.roughness = 0.85;
      deckMat.metalness = 0;
      deckMat.opacityNode = revealMask(u.presence);
      deckMat.alphaTest = 0.5;
      noBloom(deckMat);
      const deck = new InstancedMesh(unit, deckMat, parts.length);
      parts.forEach((m, i) => deck.setMatrixAt(i, m));
      deck.instanceMatrix.needsUpdate = true;
      deck.computeBoundingSphere();
      group.add(deck);
      disposables.push(unit, deckMat, deck);
    }

    return {
      object: group,
      reactive: { brightness: u.brightness, lamps: u.lamps },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const d of disposables) d.dispose();
      },
    };
  },
};
