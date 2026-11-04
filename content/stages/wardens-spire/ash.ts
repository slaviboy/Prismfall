import { AdditiveBlending, InstancedBufferAttribute, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import { float, fract, instancedBufferAttribute, length, mix, mrt, normalize, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import { additiveFog, clearFrontRaw, colorUniform, frameUniforms, seeded, z, zColor, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { COLORS, DEG, EYE, beamField, clearMask, release, shared } from './shared';

/**
 * Ash and embers in the air: fine ash drifting down on the wind (dark, faintly lit by the red
 * land, glowing when the Warden's beam passes through it) and embers rising from the lava. They
 * live by view angle outside the clear zone around the board. One draw call each; the treble
 * stirs them gently.
 */

const schema = z.object({
  kind: z.enum(['ash', 'embers']).default('ash'),
  count: z.number().int().min(1).max(20000).default(1600),
  /** View azimuth band (degrees, mirrored both sides), distance (m) and height band (m). */
  azimuth: z.tuple([z.number(), z.number()]).default([25, 62]),
  distance: z.tuple([z.number(), z.number()]).default([90, 1100]),
  height: z.tuple([z.number(), z.number()]).default([-60, 260]),
  size: z.tuple([z.number(), z.number()]).default([0.22, 0.5]),
  /** Wind (m/s) and vertical speed (m/s, negative falls). */
  wind: z.tuple([z.number(), z.number()]).default([3.5, -1.2]),
  rise: z.number().default(-0.9),
  color: zColor.default('#3a3230'),
  /** Base brightness, and how much the beam lights them. */
  brightness: z.number().default(0.06),
  beamLit: z.number().default(2.4),
  bloom: z.number().default(0.15),
  seed: z.number().default(3),
});

type Params = z.infer<typeof schema>;

export const ashComponent: ComponentFactory<Params> = {
  type: 'wardenSpireAsh',
  version: 1,
  description: 'Ash drifting on the wind and embers rising from the lava, glowing where the Warden’s beam passes.',
  schema,
  create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const detail = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.65 : ctx.quality.detail === 'high' ? 1 : 1.3;
    const count = Math.max(16, Math.round(p.count * detail * Math.min(2, Math.max(0.2, ctx.quality.particles))));
    const rand = seeded(p.seed * 4241);
    const d0 = new Float32Array(count * 4);
    const d1 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const az = (p.azimuth[0] + (p.azimuth[1] - p.azimuth[0]) * rand()) * side * DEG;
      const dist = p.distance[0] * Math.pow(p.distance[1] / p.distance[0], rand());
      d0[i * 4] = EYE[0] + Math.sin(az) * dist;
      d0[i * 4 + 1] = p.height[0] + (p.height[1] - p.height[0]) * rand();
      d0[i * 4 + 2] = EYE[2] - Math.cos(az) * dist;
      d0[i * 4 + 3] = p.size[0] + (p.size[1] - p.size[0]) * rand();
      d1[i * 4] = rand();
      d1[i * 4 + 1] = rand();
      d1[i * 4 + 2] = rand();
      d1[i * 4 + 3] = rand();
    }
    const a0 = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(d0, 4), 'vec4');
    const a1 = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(d1, 4), 'vec4');
    const presence = uniform(1);
    const treble = uniform(0);
    const time = ctx.uniforms.time;
    const span = p.height[1] - p.height[0];
    // Vertical wrap-around; horizontal drift with a loop so particles return to their region.
    const vy = float(p.rise).mul(a1.x.mul(0.6).add(0.7));
    const yy = fract(a0.y.sub(p.height[0]).add(time.mul(vy)).div(span)).mul(span).add(p.height[0]);
    const loopT = time.mul(0.012).add(a1.y.mul(6.283));
    const turb = float(1).add(treble.mul(0.8));
    const drift = vec3(sin(loopT).mul(p.wind[0] * 6), 0, sin(loopT.mul(0.7).add(1.3)).mul(p.wind[1] * 6));
    const flutter = vec3(sin(time.mul(a1.z.mul(1.4).add(0.6)).add(a1.w.mul(30))).mul(2.5), sin(time.mul(0.9).add(a1.x.mul(20))).mul(1.2), sin(time.mul(a1.w.add(0.7)).add(a1.z.mul(25))).mul(2.5)).mul(turb);
    const pos0 = vec3(a0.x, yy, a0.z).add(drift).add(flutter);
    // A clear's front lifts the embers and the ash in its band and throws them out from the board
    // (motion), and they catch its light as it passes (light).
    const away = normalize(vec3(pos0.x.sub(frameUniforms.waveOrigin.x), 0, pos0.z.sub(frameUniforms.waveOrigin.z)).add(vec3(0.0001, 0, 0)));
    const front = clearFrontRaw(pos0).min(1.2);
    const gust = front.mul(frameUniforms.waveMotion);
    const pos = pos0.add(away.mul(gust.mul(5))).add(vec3(0, gust.mul(p.kind === 'embers' ? 6 : 3), 0));
    const flare = front.mul(frameUniforms.waveLight);
    const q = uv().sub(0.5).mul(2);
    const shape = smoothstep(1, 0, length(q)).pow(p.kind === 'embers' ? 2.2 : 1.2);
    const fadeY = smoothstep(0, 0.08, yy.sub(p.height[0]).div(span)).mul(smoothstep(1, 0.85, yy.sub(p.height[0]).div(span)));
    const base = colorUniform(p.color);
    let color;
    if (p.kind === 'embers') {
      const heat = sin(time.mul(a1.z.mul(3).add(1)).add(a1.w.mul(40))).mul(0.3).add(0.7);
      const cool = yy.sub(p.height[0]).div(span);
      color = mix(vec3(1.0, 0.55, 0.18), COLORS.lava, cool).mul(heat.mul(p.brightness).mul(float(1).add(treble.mul(0.5)))).mul(s.u.lavaHeat).mul(flare.mul(1.4).add(1));
    } else {
      const lit = beamField(s, pos).mul(p.beamLit);
      color = base.mul(p.brightness).add(COLORS.beam.mul(lit.mul(0.6))).add(COLORS.bolt.mul(s.u.boltPower.mul(0.02))).add(COLORS.lava.mul(flare.mul(0.05)));
    }
    const out = color.mul(shape).mul(fadeY).mul(presence).mul(clearMask(pos, 22, 27));
    const material = new SpriteNodeMaterial();
    material.positionNode = pos;
    material.scaleNode = a0.w;
    material.colorNode = vec4(additiveFog(out), 1);
    material.blending = AdditiveBlending;
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(out.mul(p.bloom), 1) });
    const sprite = new Sprite(material);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 5;
    return {
      object: sprite,
      update(frame) {
        treble.value += (frame.audio.treble - treble.value) * (1 - Math.exp(-frame.dt / 0.5));
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        material.dispose();
        release(ctx, s);
      },
    };
  },
};
