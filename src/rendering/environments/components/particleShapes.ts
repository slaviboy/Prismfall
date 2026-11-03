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

/** A six-fold snowflake of unit radius as length-weighted points along its spines and branches. */
function snowflakePoints(rand: () => number, n: number): Float32Array {
  const segs: [number, number, number, number][] = [];
  const spines = 6;
  const start = 0.1 + rand() * 0.06;
  const branches = 3 + Math.floor(rand() * 3);
  const spread = (50 + rand() * 20) * (Math.PI / 180);
  const layout = Array.from({ length: branches }, (_, k) => ({ t: 0.28 + (k / branches) * 0.6 + rand() * 0.05, len: 0.18 + rand() * 0.3 }));
  const plate = rand() < 0.5;
  for (let a = 0; a < spines; a++) {
    const ang = (a / spines) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    segs.push([dx * start, dy * start, dx, dy]);
    for (const b of layout) {
      const bx = dx * b.t;
      const by = dy * b.t;
      const len = b.len * (1 - b.t * 0.55);
      for (const side of [-1, 1]) {
        const ba = ang + side * spread;
        segs.push([bx, by, bx + Math.cos(ba) * len, by + Math.sin(ba) * len]);
      }
    }
    // Centre hexagon edge.
    const nx = Math.cos(ang + Math.PI / 3);
    const ny = Math.sin(ang + Math.PI / 3);
    segs.push([dx * start, dy * start, nx * start, ny * start]);
    if (plate) {
      // A small hexagonal plate at the tip.
      const r = 0.07;
      for (let k = 0; k < 6; k++) {
        const p0 = (k / 6) * Math.PI * 2;
        const p1 = ((k + 1) / 6) * Math.PI * 2;
        segs.push([dx + Math.cos(p0) * r, dy + Math.sin(p0) * r, dx + Math.cos(p1) * r, dy + Math.sin(p1) * r]);
      }
    }
  }
  const lengths = segs.map(([x0, y0, x1, y1]) => Math.hypot(x1 - x0, y1 - y0));
  const total = lengths.reduce((s, l) => s + l, 0);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let r = rand() * total;
    let k = 0;
    while (k < segs.length - 1 && r > (lengths[k] as number)) r -= lengths[k++] as number;
    const [x0, y0, x1, y1] = segs[k] as [number, number, number, number];
    const t = rand();
    const w = (rand() - 0.5) * 0.022;
    const len = (lengths[k] as number) || 1;
    out[i * 3] = x0 + (x1 - x0) * t + (-(y1 - y0) / len) * w;
    out[i * 3 + 1] = y0 + (y1 - y0) * t + ((x1 - x0) / len) * w;
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
    const designs = Array.from({ length: 4 }, () => snowflakePoints(rand, per));
    const total = per * p.count;
    const a = new Float32Array(total * 4);
    const b = new Float32Array(total * 4);
    for (let s = 0; s < p.count; s++) {
      const pts = designs[s % designs.length] as Float32Array;
      for (let i = 0; i < per; i++) {
        const o = (s * per + i) * 4;
        a.set([pts[i * 3] as number, pts[i * 3 + 1] as number, pts[i * 3 + 2] as number, rand()], o);
        // Scatter direction (where the particle comes from and bursts to) and a size factor.
        const th = rand() * Math.PI * 2;
        const ph = Math.acos(rand() * 2 - 1);
        b.set([Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph), 0.6 + rand() * 0.8], o);
      }
    }
    const pa = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(a, 4), 'vec4');
    const pb = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(b, 4), 'vec4');
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
    // Local point: rotate the flake in its plane, then turn it a little towards the side.
    const lx = pa.x.mul(cos(roll)).sub(pa.y.mul(sin(roll)));
    const ly = pa.x.mul(sin(roll)).add(pa.y.mul(cos(roll)));
    const target = vec3(lx.mul(cos(yaw)), ly, lx.mul(sin(yaw)).add(pa.z)).mul(scale);
    const cloud = pb.xyz.mul(scale.mul(2.6));
    const formed = mix(cloud, target, form);
    const shimmer = pb.xyz.mul(sin(time.mul(seed.mul(3).add(2)).add(seed.mul(40))).mul(scale.mul(0.012)));
    const thrown = pb.xyz.mul(scale.mul(2.2)).add(target.mul(0.8)).mul(burst.mul(burst));
    const position = centre.add(formed).add(shimmer).add(thrown);

    const fadeIn = smoothstep(0, 0.1, phase);
    const fadeOut = float(1).sub(smoothstep(0.35, 1, burst));
    const alive = fadeIn.mul(fadeOut).mul(u.presence);
    const radius = length(vec3(pa.x, pa.y, 0));
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
