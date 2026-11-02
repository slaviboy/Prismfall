import { AdditiveBlending, InstancedInterleavedBuffer, Sprite, SpriteNodeMaterial, type Object3D } from 'three/webgpu';
import {
  abs,
  clamp,
  cos,
  exp,
  float,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mrt,
  select,
  sin,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { frameUniforms } from '../shaders/uniforms';

/** Particle look; encoded as a float in the buffer. */
export const PARTICLE_SHAPES = { soft: 0, spark: 1, shard: 2, petal: 3, bubble: 4, square: 5, ring: 6, star: 7 } as const;
export type ParticleShape = keyof typeof PARTICLE_SHAPES;

export interface BurstParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  /** World size in units. */
  size: number;
  life: number;
  /** Seconds of delay before the particle appears. */
  delay?: number;
  gravity?: number;
  drag?: number;
  shape?: ParticleShape;
  /** Swirl strength (cheap curl-like turbulence). */
  swirl?: number;
}

const STRIDE = 16; // [x y z t0] [vx vy vz life] [r g b size] [gravity drag shape swirl]

/**
 * GPU-driven burst particles. The CPU writes spawn parameters into a ring buffer only when an
 * effect fires; the vertex shader computes each particle's whole life analytically.
 * One draw call for all bursts, no per-frame JS work.
 */
export class BurstSystem {
  readonly object: Object3D;
  private readonly data: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly sprite: Sprite;
  private readonly capacity: number;
  private cursor = 0;
  /** Particle budget multiplier from quality settings (0..2). */
  density = 1;
  private pendingFrom = -1;
  private pendingTo = -1;

  constructor(capacity = 32768) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    // Park every particle in the past so nothing renders initially.
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 3] = -1e6;
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    const a0 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 0);
    const a1 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 4);
    const a2 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 8);
    const a3 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 12);

    const t = frameUniforms.time;
    const age = t.sub(a0.w);
    const life = a1.w;
    const alive = step(0, age).mul(step(age, life));
    const k = clamp(age.div(max(life, 0.001)), 0, 1);
    const drag = max(a3.y, 0.0001);
    // Exact integral of v·e^(−drag·t): (1 − e^(−drag·t)) / drag.
    const travel = float(1).sub(exp(drag.negate().mul(age))).div(drag);
    const swirlPhase = age.mul(3).add(a0.x.mul(7.3)).add(a0.y.mul(3.1));
    const swirl = vec3(sin(swirlPhase), cos(swirlPhase.mul(1.3)), sin(swirlPhase.mul(0.7))).mul(a3.w).mul(age);
    const pos = a0.xyz
      .add(a1.xyz.mul(travel))
      .add(vec3(0, a3.x.mul(age).mul(age).mul(0.5), 0))
      .add(swirl);

    const shape = a3.z;
    const fadeIn = smoothstep(0, 0.04, age);
    // Sparks and stars shrink; bubbles grow; petals and shards hold their size longer.
    const isRing = step(abs(shape.sub(PARTICLE_SHAPES.ring)), 0.5);
    const shrink = float(1).sub(k.pow(select(shape.equal(PARTICLE_SHAPES.spark), float(0.7), float(1.6))));
    // Bubbles swell gently; rings expand outward like shockwaves; everything else shrinks away.
    const grow = select(shape.equal(PARTICLE_SHAPES.bubble), float(0.6).add(k.mul(0.8)), mix(shrink, float(0.15).add(k.pow(0.6).mul(1.5)), isRing));
    const size = a2.w.mul(grow).mul(fadeIn).mul(alive);

    const p = uv().sub(0.5).mul(2);
    const r = length(p);
    const soft = smoothstep(1, 0, r).pow(1.6);
    const spark = smoothstep(1, 0.0, r).pow(3).add(smoothstep(0.12, 0, abs(p.x)).mul(smoothstep(1, 0, abs(p.y)).mul(0.5)));
    const shard = smoothstep(0.95, 0.8, abs(p.x).add(abs(p.y)));
    const petal = smoothstep(1, 0.75, length(vec2(p.x.mul(1.7), p.y)));
    const bubble = smoothstep(1, 0.85, r).mul(smoothstep(0.55, 0.85, r)).add(smoothstep(0.35, 0, length(p.sub(vec2(-0.35, 0.35)))).mul(0.6));
    const square = step(abs(p.x), 0.8).mul(step(abs(p.y), 0.8));
    const ring = smoothstep(0.15, 0, abs(r.sub(0.75)));
    const star = smoothstep(1, 0, r).pow(4).add(smoothstep(0.08, 0, abs(p.x)).mul(smoothstep(1, 0, abs(p.y))).add(smoothstep(0.08, 0, abs(p.y)).mul(smoothstep(1, 0, abs(p.x)))).mul(0.7));
    const pick = (id: number, v: typeof soft) => step(abs(shape.sub(id)), 0.5).mul(v);
    const mask = pick(0, soft).add(pick(1, spark)).add(pick(2, shard)).add(pick(3, petal)).add(pick(4, bubble)).add(pick(5, square)).add(pick(6, ring)).add(pick(7, star));
    const fade = float(1).sub(k).pow(1.3);
    const intensity = mask.mul(fade).mul(alive).mul(frameUniforms.effectsIntensity);
    const color = a2.xyz.mul(intensity);

    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = size;
    material.colorNode = vec4(color, 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.mrtNode = mrt({ emissive: vec4(color.mul(0.8), 1) });
    this.sprite = new Sprite(material);
    this.sprite.count = capacity;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 5;
    this.object = this.sprite;
  }

  /** Effective number of particles to spawn after the quality budget. */
  budget(requested: number): number {
    return Math.max(0, Math.round(requested * this.density));
  }

  emit(p: BurstParticle, now: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = p.x;
    d[o + 1] = p.y;
    d[o + 2] = p.z;
    d[o + 3] = now + (p.delay ?? 0);
    d[o + 4] = p.vx;
    d[o + 5] = p.vy;
    d[o + 6] = p.vz;
    d[o + 7] = p.life;
    d[o + 8] = p.r;
    d[o + 9] = p.g;
    d[o + 10] = p.b;
    d[o + 11] = p.size;
    d[o + 12] = p.gravity ?? 0;
    d[o + 13] = p.drag ?? 0.5;
    d[o + 14] = PARTICLE_SHAPES[p.shape ?? 'soft'];
    d[o + 15] = p.swirl ?? 0;
    if (this.pendingFrom < 0) {
      this.pendingFrom = i;
      this.pendingTo = i;
    } else if (i === this.pendingTo + 1) {
      this.pendingTo = i;
    } else {
      // Wrapped around: upload everything this frame.
      this.pendingFrom = 0;
      this.pendingTo = this.capacity - 1;
    }
  }

  /** Uploads only the ranges written this frame. */
  flush(): void {
    if (this.pendingFrom < 0) return;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(this.pendingFrom * STRIDE, (this.pendingTo - this.pendingFrom + 1) * STRIDE);
    this.buffer.needsUpdate = true;
    this.pendingFrom = -1;
    this.pendingTo = -1;
  }

  dispose(): void {
    (this.sprite.material as SpriteNodeMaterial).dispose();
    this.sprite.geometry.dispose();
  }
}
