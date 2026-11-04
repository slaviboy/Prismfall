import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { attribute, cameraWorldMatrix, cos, dot, float, fract, length, max, mix, mrt, sin, smoothstep, step, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog, frameUniforms } from '../../shaders/uniforms';
import { colorUniform, scaledCount, seeded, zColor, zVec3 } from './common';
import { RevealTracker } from './modelMotion';

const TAU = Math.PI * 2;

const motion = z.discriminatedUnion('kind', [
  /** A school swimming a loop (an ellipse with a gentle rise and fall) around `center`. */
  z.object({
    kind: z.literal('school'),
    center: zVec3,
    radius: zVec3.default([30, 4, 14]),
    /** World units per second along the loop. */
    speed: z.number().positive().default(6),
    /** How far fish keep from the school's centre line. */
    spread: zVec3.default([5, 2, 3]),
    clockwise: z.boolean().default(false),
  }),
  /**
   * A vortex in the view plane (x/y) around `center`: fish circle between the two radii, the
   * inner ones faster, breathing slowly in and out; `squash` flattens the ring vertically.
   */
  z.object({
    kind: z.literal('vortex'),
    center: zVec3,
    radius: z.tuple([z.number().positive(), z.number().positive()]).default([28, 60]),
    squash: z.number().positive().default(0.62),
    /** Thickness of the ring along z. */
    depth: z.number().min(0).default(18),
    /** Angular speed at the inner radius (radians per second). */
    speed: z.number().default(0.32),
  }),
]);

const schema = z.object({
  count: z.number().int().min(1).max(4000).default(300),
  motion,
  /** Fish length range (world units); `width` is its share of the length. */
  length: z.tuple([z.number().positive(), z.number().positive()]).default([1.2, 2]),
  width: z.number().positive().default(0.32),
  color: zColor.default('#4ad8ff'),
  colorB: zColor.default('#9ab8ff'),
  brightness: z.number().min(0).default(1.2),
  twinkle: z.number().min(0).max(1).default(0.4),
  bloom: z.number().min(0).default(0.12),
  /** Arrival with the run, as in the model component (fish join one by one as it rises). */
  reveal: z
    .object({
      from: z.number().min(0).max(1).default(0),
      to: z.number().min(0).max(1).default(0.1),
      unlock: z.number().min(0).max(2).default(2),
      hold: z.number().positive().default(24),
    })
    .optional(),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type Motion = Params['motion'];

/** Per-fish random numbers (the same ones the shader derives from the fish seed). */
export function fishSeeds(seed: number): [number, number, number, number, number] {
  const f = (k: number, o: number) => (seed * k + o) % 1;
  return [seed, f(7.31, 0.17), f(13.7, 0.41), f(3.17, 0.73), f(23.3, 0.29)];
}

/**
 * Where a fish is at time `t` and which way it swims (CPU mirror of the shader, for tests and
 * tools). `s` are its five seeds (fishSeeds).
 */
export function swimPoint(m: Motion, s: readonly number[], t: number, out: Vector3, dir: Vector3): void {
  const [s1, s2, s3, s4, s5] = s as [number, number, number, number, number];
  if (m.kind === 'vortex') {
    const [r0, r1] = m.radius;
    const r = r0 + (r1 - r0) * Math.pow(s1, 0.7);
    const w = m.speed * Math.sqrt(r0 / r);
    const a = s2 * TAU + t * w + Math.sin(t * 0.13 + s3 * 6) * 0.15;
    const breath = r * (1 + 0.05 * Math.sin(t * 0.2 + s4 * 6));
    out.set(m.center[0] + Math.cos(a) * breath, m.center[1] + Math.sin(a) * breath * m.squash, m.center[2] + (s5 - 0.5) * m.depth + Math.sin(t * 0.3 + s1 * 9) * 1.2);
    dir.set(-Math.sin(a), Math.cos(a) * m.squash, 0).multiplyScalar(Math.sign(w) || 1).normalize();
    return;
  }
  const sign = m.clockwise ? -1 : 1;
  const mean = (m.radius[0] + m.radius[2]) / 2;
  const phi = sign * (t * m.speed) / mean - s1 * 0.35;
  const c = (p: number, v: Vector3) => v.set(m.center[0] + Math.cos(p) * m.radius[0], m.center[1] + Math.sin(p * 2) * m.radius[1] * 0.5, m.center[2] + Math.sin(p) * m.radius[2]);
  c(phi, out);
  const ahead = c(phi + sign * 0.01, new Vector3());
  dir.subVectors(ahead, out).normalize();
  out.x += Math.sin(s2 * TAU + t * 0.4) * m.spread[0] * (s3 - 0.5) * 2;
  out.y += Math.sin(s4 * TAU + t * 0.33) * m.spread[1] * (s5 - 0.5) * 2;
  out.z += Math.cos(s3 * TAU + t * 0.37) * m.spread[2] * (s2 - 0.5) * 2;
}

/**
 * A school of glowing fish drawn as soft, elongated points of light that swim a loop, or a vortex
 * of them circling in the view plane (around the board, for a climax). Each fish is one
 * camera-facing streak oriented along its motion on screen; every position is computed in the
 * vertex shader from time and the fish's seed (no per-frame CPU work). Arrives with the run
 * (`reveal`): fish join one by one as game progress rises, or all at once on a big clear once
 * unlocked.
 */
export const glowSchoolComponent: ComponentFactory<Params> = {
  type: 'glowSchool',
  version: 1,
  description: 'Glowing fish as streaks of light: a school swimming a loop or a vortex circling in the view plane; can arrive with game progress.',
  schema,
  create(ctx, p) {
    const n = Math.max(1, scaledCount(p.count, ctx.quality.detail, ctx.quality.particles));
    const rand = seeded(p.seed * 977);
    const corner = new Float32Array(n * 8);
    const seedA = new Float32Array(n * 4);
    const position = new Float32Array(n * 12);
    const index = new Uint32Array(n * 6);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < n; i++) {
      const s = rand();
      for (let k = 0; k < 4; k++) {
        corner[(i * 4 + k) * 2] = C[k * 2]!;
        corner[(i * 4 + k) * 2 + 1] = C[k * 2 + 1]!;
        seedA[i * 4 + k] = s;
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setAttribute('corner', new BufferAttribute(corner, 2));
    geometry.setAttribute('fseed', new BufferAttribute(seedA, 1));
    geometry.setIndex(new BufferAttribute(index, 1));
    const u = { presence: uniform(1), reveal: uniform(p.reveal ? 0 : 1), brightness: uniform(p.brightness) };
    const time = ctx.uniforms.time;
    const s1 = attribute<'float'>('fseed', 'float');
    const s2 = fract(s1.mul(7.31).add(0.17));
    const s3 = fract(s1.mul(13.7).add(0.41));
    const s4 = fract(s1.mul(3.17).add(0.73));
    const s5 = fract(s1.mul(23.3).add(0.29));
    const m = p.motion;
    let pos: Node<'vec3'>;
    let dir: Node<'vec3'>;
    if (m.kind === 'vortex') {
      const [r0, r1] = m.radius;
      const r = float(r0).add(s1.pow(0.7).mul(r1 - r0));
      const w = float(m.speed).mul(float(r0).div(r).sqrt());
      const a = s2.mul(TAU).add(time.mul(w)).add(sin(time.mul(0.13).add(s3.mul(6))).mul(0.15));
      const breath = r.mul(sin(time.mul(0.2).add(s4.mul(6))).mul(0.05).add(1));
      pos = vec3(cos(a).mul(breath).add(m.center[0]), sin(a).mul(breath).mul(m.squash).add(m.center[1]), s5.sub(0.5).mul(m.depth).add(m.center[2]).add(sin(time.mul(0.3).add(s1.mul(9))).mul(1.2)));
      dir = vec3(sin(a).negate(), cos(a).mul(m.squash), 0).mul(Math.sign(m.speed) || 1);
    } else {
      const sign = m.clockwise ? -1 : 1;
      const mean = (m.radius[0] + m.radius[2]) / 2;
      const phi = time.mul((sign * m.speed) / mean).sub(s1.mul(0.35));
      const centre = (q: Node<'float'>) => vec3(cos(q).mul(m.radius[0]).add(m.center[0]), sin(q.mul(2)).mul(m.radius[1] * 0.5).add(m.center[1]), sin(q).mul(m.radius[2]).add(m.center[2]));
      dir = centre(phi.add(sign * 0.01)).sub(centre(phi));
      pos = centre(phi).add(
        vec3(
          sin(s2.mul(TAU).add(time.mul(0.4))).mul(s3.sub(0.5).mul(2 * m.spread[0])),
          sin(s4.mul(TAU).add(time.mul(0.33))).mul(s5.sub(0.5).mul(2 * m.spread[1])),
          cos(s3.mul(TAU).add(time.mul(0.37))).mul(s2.sub(0.5).mul(2 * m.spread[2])),
        ),
      );
    }
    // A streak along the motion as seen on screen.
    const cr = attribute<'vec2'>('corner', 'vec2');
    const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const up = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    const sx = dot(dir, right);
    const sy = dot(dir, up);
    const sl = max(length(vec3(sx, sy, 0)), 1e-4);
    const ax = right.mul(sx.div(sl)).add(up.mul(sy.div(sl)));
    const px = right.mul(sy.div(sl).negate()).add(up.mul(sx.div(sl)));
    const len = s3.mul(p.length[1] - p.length[0]).add(p.length[0]);
    // Fish join one by one as the reveal rises (each has its own threshold), shrinking from nothing.
    const joined = smoothstep(s4.mul(0.9), s4.mul(0.9).add(0.1), u.reveal);
    const offset = ax.mul(cr.x.mul(len.mul(0.5))).add(px.mul(cr.y.mul(len.mul(p.width * 0.5)))).mul(joined);
    const material = new MeshBasicNodeMaterial();
    material.positionNode = pos.add(offset);
    const rr = length(vec3(cr.x, cr.y, 0));
    const shape = smoothstep(1, 0, rr).pow(1.8).add(smoothstep(0.35, 0, rr).mul(0.9));
    const tw = sin(time.mul(s2.mul(4).add(1.5)).add(s5.mul(TAU))).mul(p.twinkle * 0.5).add(1 - p.twinkle * 0.5);
    const tint = mix(colorUniform(p.color), colorUniform(p.colorB), step(0.6, s3));
    const breathe = frameUniforms.bass.mul(frameUniforms.reactivity).mul(0.12).add(0.94);
    const light = tint.mul(shape).mul(tw).mul(breathe).mul(u.brightness).mul(u.presence).mul(joined);
    material.colorNode = vec4(additiveFog(light), 1);
    material.blending = AdditiveBlending;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(light.mul(p.bloom), 1) });
    material.transparent = true;
    material.depthWrite = false;
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.name = 'glow-school:particles';
    const reveal = new RevealTracker(p.reveal, 3);
    return {
      object: mesh,
      reactive: { brightness: u.brightness },
      update(frame) {
        u.reveal.value = reveal.update(frame.time, frame.game?.progress ?? 0, frame.dt);
        mesh.visible = u.reveal.value > 1e-3 && u.presence.value > 1e-3;
      },
      onGameEvent(e) {
        if (e.kind === 'clear' && (e.lines >= 4 || e.perfectClear)) reveal.bigClear();
      },
      // Event call-ins (since SDK 1.5): `reveal` calls the school in for `params.hold` seconds.
      onCall(call) {
        if (call.action === 'reveal') reveal.callIn(typeof call.params.hold === 'number' ? call.params.hold : (p.reveal?.hold ?? 0));
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
