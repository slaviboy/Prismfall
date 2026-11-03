import { AdditiveBlending, InstancedBufferAttribute, NormalBlending, Sprite, SpriteNodeMaterial, type Node } from 'three/webgpu';
import { cos, float, fract, hash, instanceIndex, instancedBufferAttribute, length, mix, mrt, sin, smoothstep, uint, uniform, uv, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, seeded, zColor, zVec3 } from './common';

const schema = z.object({
  shape: z.enum(['snowflake']).default('snowflake'),
  /** Number of shapes alive at once. */
  count: z.number().int().min(1).max(64).default(8),
  /** Particles per shape. */
  particles: z.number().int().min(50).max(4000).default(700),
  /** Shape diameter range (world units). */
  size: z.tuple([z.number(), z.number()]).default([6, 11]),
  /** Where shapes appear: a box, mirrored left and right of the view axis (|x| >= minX). */
  area: z.object({ center: zVec3.default([0, 6, -80]), size: zVec3.default([150, 30, 70]), minX: z.number().min(0).default(24) }).prefault({}),
  /** Seconds per life: form, hold, burst. */
  period: z.number().positive().default(16),
  drift: zVec3.default([0.6, -0.4, 0]),
  /** Spin in degrees per second. */
  spin: z.number().default(8),
  particleSize: z.number().positive().default(0.16),
  color: zColor.default('#ffffff'),
  colorB: zColor.default('#bfe6ff'),
  brightness: z.number().min(0).default(1.2),
  blend: z.enum(['additive', 'normal']).default('additive'),
  bloom: z.number().min(0).default(0.4),
  /** QUADs and perfect clears make every shape burst. */
  burstOnClears: z.boolean().default(true),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;

type Seg = [number, number, number, number];
type Poly = [number, number][];

/**
 * Snowflake crystal types. Each is built as one arm in local coordinates (the arm runs along +x)
 * from line segments and filled plates; the arm is repeated around the centre and mirrored.
 */
const KINDS = ['stellar', 'fern', 'sectored', 'starPlate', 'rings', 'spear', 'twelve', 'broad'] as const;
type Kind = (typeof KINDS)[number];

const DEG = Math.PI / 180;
const hexagon = (cx: number, cy: number, r: number): Poly => Array.from({ length: 6 }, (_, k) => [cx + Math.cos((k * Math.PI) / 3) * r, cy + Math.sin((k * Math.PI) / 3) * r] as [number, number]);
const outline = (poly: Poly): Seg[] =>
  poly.map((pt, k) => {
    const next = poly[(k + 1) % poly.length] as [number, number];
    return [pt[0], pt[1], next[0], next[1]];
  });
/** The wedge between the arm axis and the next arm, out to radius r. */
const wedge = (r: number): Poly => [
  [0, 0],
  [r, 0],
  [Math.cos(60 * DEG) * r, Math.sin(60 * DEG) * r],
];

function arm(kind: Kind, rand: () => number): { segs: Seg[]; plates: Poly[] } {
  const segs: Seg[] = [];
  const plates: Poly[] = [];
  // A branch leaving the axis at (x, 0); mirroring happens later, so one side is enough.
  const branch = (x: number, ang: number, len: number) => segs.push([x, 0, x + Math.cos(ang) * len, Math.sin(ang) * len]);
  switch (kind) {
    case 'stellar': {
      segs.push([0.08, 0, 1, 0]);
      const n = 4 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        const t = 0.3 + (k / n) * 0.58;
        const len = (0.2 + rand() * 0.18) * (1 - t * 0.6);
        branch(t, 60 * DEG, len);
        // Sub-branches growing off each branch towards the tip.
        const sx = t + Math.cos(60 * DEG) * len * 0.55;
        const sy = Math.sin(60 * DEG) * len * 0.55;
        segs.push([sx, sy, sx + len * 0.35, sy]);
      }
      break;
    }
    case 'fern': {
      segs.push([0.06, 0, 1, 0]);
      const n = 9 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        const t = 0.18 + (k / n) * 0.78;
        branch(t, 58 * DEG, Math.sin(((t - 0.18) / 0.8) * Math.PI) * (0.16 + rand() * 0.05) + 0.02);
      }
      break;
    }
    case 'sectored': {
      const r = 0.62 + rand() * 0.12;
      plates.push(wedge(r));
      segs.push([0, 0, r, 0], [r, 0, Math.cos(60 * DEG) * r, Math.sin(60 * DEG) * r]);
      // A ridge to the middle of the plate edge and a short spike beyond the corner.
      segs.push([0, 0, Math.cos(30 * DEG) * r * 0.86, Math.sin(30 * DEG) * r * 0.86], [r, 0, r + 0.18, 0]);
      break;
    }
    case 'starPlate': {
      segs.push([0.22, 0, 0.9, 0]);
      plates.push(hexagon(0.97, 0, 0.11 + rand() * 0.05), wedge(0.24));
      segs.push(...outline(hexagon(0.97, 0, 0.13)));
      if (rand() < 0.6) branch(0.55, 60 * DEG, 0.14);
      break;
    }
    case 'rings': {
      for (const r of [0.28, 0.56, 0.84]) segs.push([r, 0, Math.cos(60 * DEG) * r, Math.sin(60 * DEG) * r]);
      segs.push([0, 0, 0.98, 0], [0.56 * Math.cos(30 * DEG), 0.56 * Math.sin(30 * DEG), 0.84 * Math.cos(30 * DEG), 0.84 * Math.sin(30 * DEG)]);
      break;
    }
    case 'spear': {
      segs.push([0.06, 0, 0.62, 0]);
      const w = 0.09 + rand() * 0.04;
      const tip: Poly = [
        [0.6, 0],
        [0.8, w],
        [1.02, 0],
        [0.8, -w],
      ];
      plates.push(tip);
      segs.push(...outline(tip));
      branch(0.36, 60 * DEG, 0.16);
      break;
    }
    case 'twelve': {
      segs.push([0.06, 0, 1, 0]);
      branch(0.6, 55 * DEG, 0.14);
      // The in-between spine at 30 degrees, shorter (mirroring gives the one at -30).
      segs.push([0.06 * Math.cos(30 * DEG), 0.06 * Math.sin(30 * DEG), 0.62 * Math.cos(30 * DEG), 0.62 * Math.sin(30 * DEG)]);
      break;
    }
    case 'broad': {
      const w = 0.07 + rand() * 0.05;
      const blade: Poly = [
        [0.12, 0],
        [0.3, w],
        [0.92, w * 0.8],
        [1.04, 0],
        [0.92, -w * 0.8],
        [0.3, -w],
      ];
      plates.push(blade);
      segs.push(...outline(blade), [0.12, 0, 1.04, 0]);
      break;
    }
  }
  return { segs, plates };
}

function polyArea(poly: Poly): number {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k] as [number, number];
    const [x1, y1] = poly[(k + 1) % poly.length] as [number, number];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** A snowflake of unit radius: points along its lines (by length) and inside its plates (by area). */
function snowflakePoints(rand: () => number, n: number, kind: Kind): Float32Array {
  const { segs, plates } = arm(kind, rand);
  const lengths = segs.map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0));
  const areas = plates.map(polyArea);
  const lineTotal = lengths.reduce((t, l) => t + l, 0);
  const areaTotal = areas.reduce((t, a) => t + a, 0);
  // Plates get a lighter fill than the lines, so their outlines still read.
  const plateWeight = areaTotal * 7;
  const pick = (weights: number[], total: number): number => {
    let r = rand() * total;
    let k = 0;
    while (k < weights.length - 1 && r > (weights[k] as number)) r -= weights[k++] as number;
    return k;
  };
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    if (plates.length > 0 && rand() * (lineTotal + plateWeight) < plateWeight) {
      // A uniform point in one triangle of the plate's fan, triangles weighted by area.
      const poly = plates[pick(areas, areaTotal)] as Poly;
      const fan = Array.from({ length: poly.length - 2 }, (_, k) => polyArea([poly[0] as [number, number], poly[k + 1] as [number, number], poly[k + 2] as [number, number]]));
      const k = 1 + pick(fan, fan.reduce((t, f) => t + f, 0));
      let u = rand();
      let v = rand();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const [ax, ay] = poly[0] as [number, number];
      const [bx, by] = poly[k] as [number, number];
      const [cx, cy] = poly[k + 1] as [number, number];
      x = ax + (bx - ax) * u + (cx - ax) * v;
      y = ay + (by - ay) * u + (cy - ay) * v;
    } else {
      const k = pick(lengths, lineTotal);
      const [x0, y0, x1, y1] = segs[k] as Seg;
      const t = rand();
      const len = (lengths[k] as number) || 1;
      const w = (rand() - 0.5) * 0.02;
      x = x0 + (x1 - x0) * t + (-(y1 - y0) / len) * w;
      y = y0 + (y1 - y0) * t + ((x1 - x0) / len) * w;
    }
    // Repeat around the centre; half the points mirror across the arm axis (crystal symmetry).
    if (rand() < 0.5) y = -y;
    const ang = (Math.floor(rand() * 6) / 6) * Math.PI * 2;
    out[i * 3] = x * Math.cos(ang) - y * Math.sin(ang);
    out[i * 3 + 1] = x * Math.sin(ang) + y * Math.cos(ang);
    out[i * 3 + 2] = (rand() - 0.5) * 0.02;
  }
  return out;
}

/**
 * Shapes drawn with particles that live a cycle each: the particles converge from a scattered
 * cloud into the shape, it drifts and turns slowly, then bursts outward and fades, and the next
 * cycle forms a new one elsewhere. Everything is computed on the GPU from time and the shape's
 * index (hashed per cycle), so there is no per-frame CPU work. Big clears burst every shape.
 */
export const particleShapesComponent: ComponentFactory<Params> = {
  type: 'particleShapes',
  version: 1,
  description: 'Particle-built shapes (snowflakes) that form, drift, burst and reform elsewhere.',
  schema,
  create(ctx, p) {
    const rand = seeded(p.seed * 4241);
    const detail = ctx.quality.detail === 'low' ? 0.45 : ctx.quality.detail === 'medium' ? 0.7 : 1;
    const per = Math.max(60, Math.round(p.particles * detail));
    // Two designs per shape slot (of different crystal types), alternating every cycle.
    const total = per * p.count;
    const a = new Float32Array(total * 4);
    const b = new Float32Array(total * 4);
    const c = new Float32Array(total * 4);
    for (let s = 0; s < p.count; s++) {
      const pts = snowflakePoints(rand, per, KINDS[(s * 2) % KINDS.length] as Kind);
      const alt = snowflakePoints(rand, per, KINDS[(s * 2 + 3) % KINDS.length] as Kind);
      for (let i = 0; i < per; i++) {
        const o = (s * per + i) * 4;
        a.set([pts[i * 3] as number, pts[i * 3 + 1] as number, pts[i * 3 + 2] as number, rand()], o);
        c.set([alt[i * 3] as number, alt[i * 3 + 1] as number, alt[i * 3 + 2] as number, 0], o);
        // Scatter direction (where the particle comes from and bursts to) and a size factor.
        const th = rand() * Math.PI * 2;
        const ph = Math.acos(rand() * 2 - 1);
        b.set([Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph), 0.6 + rand() * 0.8], o);
      }
    }
    const pa = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
    const pb = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');
    const pc = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(c, 4), 'vec4');
    const u = { presence: uniform(1), burst: uniform(0), brightness: uniform(p.brightness) };
    const time = ctx.uniforms.time;

    // Per shape and per cycle: life phase, position, size and orientation from hashes.
    const shape = instanceIndex.div(uint(per));
    const offset = hash(shape.add(uint(17)));
    const life = time.div(p.period).add(offset.mul(4));
    const cycle = life.floor();
    const phase = fract(life);
    const key = shape.mul(uint(7919)).add(uint(cycle.mul(131)));
    const h1 = hash(key);
    const h2 = hash(key.add(uint(1)));
    const h3 = hash(key.add(uint(2)));
    const h4 = hash(key.add(uint(3)));
    const [cx, cy, cz] = p.area.center;
    const [sx, sy, sz] = p.area.size;
    const side = h1.sub(0.5).sign();
    const x = side.mul(mix(float(p.area.minX), float(sx * 0.5), h2.abs())).add(cx);
    const centre = vec3(x, h3.sub(0.5).mul(sy).add(cy), h4.sub(0.5).mul(sz).add(cz)).add(vec3(...p.drift).mul(phase.mul(p.period)));
    const scale = mix(float(p.size[0]), float(p.size[1]), hash(key.add(uint(4)))).mul(0.5);
    const yaw = hash(key.add(uint(5))).sub(0.5).mul(1.4);
    const roll = hash(key.add(uint(6))).mul(Math.PI * 2).add(time.mul((p.spin * Math.PI) / 180));

    const seed = pa.w;
    // Form (staggered), hold, burst (staggered), all within one life.
    const form = smoothstep(seed.mul(0.08), seed.mul(0.08).add(0.16), phase);
    const kick = u.burst;
    const burstAt = float(0.74).add(seed.mul(0.05));
    const burst = smoothstep(burstAt, burstAt.add(0.12), phase).max(kick);
    // This cycle's design, rotated in its plane and turned a little towards the side.
    const local = mix(pa.xyz, pc.xyz, fract(cycle.mul(0.5)).mul(2).floor());
    const lx = local.x.mul(cos(roll)).sub(local.y.mul(sin(roll)));
    const ly = local.x.mul(sin(roll)).add(local.y.mul(cos(roll)));
    const target = vec3(lx.mul(cos(yaw)), ly, lx.mul(sin(yaw)).add(local.z)).mul(scale);
    const cloud = pb.xyz.mul(scale.mul(2.6));
    const formed = mix(cloud, target, form);
    const shimmer = pb.xyz.mul(sin(time.mul(seed.mul(3).add(2)).add(seed.mul(40))).mul(scale.mul(0.012)));
    const thrown = pb.xyz.mul(scale.mul(2.2)).add(target.mul(0.8)).mul(burst.mul(burst));
    const position = centre.add(formed).add(shimmer).add(thrown);

    const fadeIn = smoothstep(0, 0.1, phase);
    const fadeOut = float(1).sub(smoothstep(0.35, 1, burst));
    const alive = fadeIn.mul(fadeOut).mul(u.presence);
    const radius = length(vec3(local.x, local.y, 0));
    const core = float(1.2).sub(radius.mul(0.4));
    const q = uv().sub(0.5).mul(2);
    const dot = smoothstep(1, 0, length(q)).pow(1.6);
    const twinkle = sin(time.mul(seed.mul(5).add(2)).add(seed.mul(60))).mul(0.2).add(0.85);
    const tint = mix(colorUniform(p.color), colorUniform(p.colorB), seed);
    const light = tint.mul(dot).mul(core).mul(twinkle).mul(u.brightness).mul(alive);

    const material = new SpriteNodeMaterial();
    material.positionNode = position as Node<'vec3'>;
    material.scaleNode = float(p.particleSize).mul(pb.w).mul(float(1).add(burst.mul(0.6)));
    if (p.blend === 'additive') {
      material.colorNode = vec4(additiveFog(light), 1);
      material.blending = AdditiveBlending;
      material.fog = false;
      material.mrtNode = mrt({ emissive: vec4(light.mul(p.bloom), 1) });
    } else {
      material.colorNode = vec4(tint.mul(u.brightness).mul(core), dot.mul(alive));
      material.blending = NormalBlending;
      material.mrtNode = mrt({ emissive: vec4(tint.mul(p.bloom), dot.mul(alive)) });
    }
    material.transparent = true;
    material.depthWrite = false;
    const sprite = new Sprite(material);
    sprite.count = total;
    sprite.frustumCulled = false;
    sprite.renderOrder = -3;

    let burstValue = 0;
    return {
      object: sprite,
      update(frame) {
        burstValue = Math.max(0, burstValue - frame.dt * 0.6);
        u.burst.value = burstValue > 0 ? Math.min(1, burstValue * 2) : 0;
      },
      onGameEvent(e) {
        if (p.burstOnClears && e.kind === 'clear' && (e.lines >= 4 || e.perfectClear)) burstValue = 1;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        material.dispose();
        sprite.geometry.dispose();
      },
    };
  },
};
