import { InstancedInterleavedBuffer, NormalBlending, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import { cameraPosition, clamp, dot, exp, float, instancedBufferAttribute, length, max, mix, mx_noise_float, normalize, pow, smoothstep, step, uv, vec2, vec3, vec4 } from 'three/tsl';
import { noBloom, type EnvironmentContext } from '@prismfall/sdk';
import type { F, Frontier, U1, V3 } from './shared';

/** One puff: smoke from the stack, steam from the cocks, dust from hooves and wheels, a gust cloud. */
export interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds. */
  life: number;
  /** World size at birth and at death. */
  size0: number;
  size1: number;
  /** Peak opacity. */
  opacity: number;
  /** Linear albedo. */
  r: number;
  g: number;
  b: number;
  /** Upward acceleration (buoyancy; negative settles), m/s². */
  rise?: number;
  /** Velocity damping per second. */
  drag?: number;
  /** How much the wind carries it (0..1). */
  windy?: number;
  /** Self-glow (lit steam near the headlight, embers): adds albedo × glow. */
  glow?: number;
  delay?: number;
}

const STRIDE = 20; // [x y z t0] [vx vy vz life] [s0 s1 opacity windy] [r g b rise] [drag glow - -]

/**
 * Alpha-blended GPU puffs lit by the world's sun and sky: forward scattering makes dust and smoke
 * glow gold when they are between the viewer and a low sun, and they darken at night. The CPU only
 * writes a puff when it is born; the vertex shader computes its whole life (drift, wind, buoyancy,
 * growth). One draw call per system.
 */
export class PuffSystem {
  readonly object: Sprite;
  private readonly data: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly capacity: number;
  private cursor = 0;
  private from = -1;
  private to = -1;
  private readonly material: SpriteNodeMaterial;

  constructor(ctx: EnvironmentContext, s: Frontier, capacity: number, presence: U1, opts: { windScale?: number; renderOrder?: number } = {}) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 3] = -1e6;
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    const a0 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 0);
    const a1 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 4);
    const a2 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 8);
    const a3 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 12);
    const a4 = instancedBufferAttribute<'vec4'>(this.buffer, 'vec4', STRIDE, 16);
    const t = ctx.uniforms.time as unknown as F;
    const age = t.sub(a0.w);
    const life = a1.w;
    const alive = step(0, age).mul(step(age, life));
    const k = clamp(age.div(max(life, 0.001)), 0, 1);
    const drag = max(a4.x, 0.0001);
    const travel = float(1)
      .sub(exp(drag.negate().mul(age)))
      .div(drag);
    const wind = s.u.wind.mul(a2.w.mul(opts.windScale ?? 1));
    // Slow curling drift so puffs do not move as rigid dots.
    const curl = vec3(
      mx_noise_float(vec3(a0.x.mul(0.3), age.mul(0.4), a0.z.mul(0.3))),
      mx_noise_float(vec3(a0.z.mul(0.3), age.mul(0.35), 3.1)).mul(0.5),
      mx_noise_float(vec3(age.mul(0.4), a0.x.mul(0.3), 7.7)),
    ).mul(age.mul(0.5));
    const pos = a0.xyz
      .add(a1.xyz.mul(travel))
      .add(wind.mul(age))
      .add(vec3(0, a3.w.mul(age).mul(age).mul(0.5), 0))
      .add(curl);
    const size = mix(a2.x, a2.y, k.pow(0.6)).mul(alive);
    // Opacity: quick fade-in, long fade-out.
    const fade = smoothstep(0, 0.08, k).mul(float(1).sub(k).pow(1.6));
    const p = uv().sub(0.5).mul(2);
    const r = length(p);
    // A soft, slightly lumpy disc; the lower edge softened so ground-level puffs do not cut a line.
    const lumpy = mx_noise_float(vec3(p.mul(1.7), a0.x.add(a0.z))).mul(0.18);
    const disc = smoothstep(1.0, 0.15, r.add(lumpy)).pow(1.4);
    const bottom = smoothstep(-1.0, -0.35, p.y);
    const alpha = disc.mul(bottom).mul(fade).mul(a2.z).mul(alive).mul(presence);
    // Lighting: sky ambient plus the sun, scattered forward (bright when looking towards the sun).
    const view = normalize(pos.sub(cameraPosition));
    const toward = max(dot(view, s.u.sunDir), 0);
    const forward = pow(toward, 5).mul(2.2).add(pow(toward, 1.5).mul(0.35));
    const sunLit = s.u.sunColor.mul(float(0.2).add(forward.mul(0.75)));
    const ambient = mix(s.u.groundColor, s.u.skyColor, 0.55).mul(0.62);
    const albedo = a3.xyz;
    let color: V3 = albedo.mul(sunLit.add(ambient)).add(albedo.mul(a4.y)) as V3;
    // Haze, like everything else in the world.
    const dist = length(pos.sub(cameraPosition));
    const hazeK = float(1).sub(exp(dist.mul(s.u.hazeDensity).negate()));
    color = mix(color, s.u.hazeColor, hazeK) as V3;

    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = size;
    material.colorNode = vec4(color, alpha);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = NormalBlending;
    material.fog = false;
    noBloom(material);
    this.material = material;
    this.object = new Sprite(material);
    this.object.count = capacity;
    this.object.frustumCulled = false;
    this.object.renderOrder = opts.renderOrder ?? 3;
    void vec2;
  }

  emit(p: Puff, now: number): void {
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
    d[o + 8] = p.size0;
    d[o + 9] = p.size1;
    d[o + 10] = p.opacity;
    d[o + 11] = p.windy ?? 1;
    d[o + 12] = p.r;
    d[o + 13] = p.g;
    d[o + 14] = p.b;
    d[o + 15] = p.rise ?? 0;
    d[o + 16] = p.drag ?? 0.8;
    d[o + 17] = p.glow ?? 0;
    if (this.from < 0) {
      this.from = i;
      this.to = i;
    } else if (i === this.to + 1) {
      this.to = i;
    } else {
      this.from = 0;
      this.to = this.capacity - 1;
    }
  }

  flush(): void {
    if (this.from < 0) return;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(this.from * STRIDE, (this.to - this.from + 1) * STRIDE);
    this.buffer.needsUpdate = true;
    this.from = -1;
    this.to = -1;
  }

  dispose(): void {
    this.material.dispose();
  }
}
