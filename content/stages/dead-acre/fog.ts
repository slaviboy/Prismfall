import { BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, NormalBlending } from 'three/webgpu';
import { abs, atan, attribute, cameraPosition, exp, float, length, max, mix, mrt, normalize, positionWorld, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { clearFrontRaw, floatUniform, frameUniforms, z, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { backdropSampler, backdropTexture, lampLight, noiseTexture, release, shared, zBackdrop, ORIGIN_Z, type F, type V3 } from './shared';

const schema = z.object({
  ground: z.number().default(-1.05),
  origin: zVec3.default([0, 0, ORIGIN_Z]),
  /** Horizontal fog sheets stacked from the grass up to `top` metres. */
  layers: z.number().int().min(2).max(32).default(20),
  top: z.number().positive().default(1.2),
  /** Reach of the fog from the viewer (metres). */
  radius: z.number().positive().default(140),
  /** Extinction per metre inside a bank, and between banks (thin mist). */
  density: z.number().min(0).default(0.09),
  mist: z.number().min(0).default(0.014),
  /** Bank size (metres) and drift (m/s, x and z). */
  scale: z.number().positive().default(34),
  drift: z.tuple([z.number(), z.number()]).default([0.55, 0.18]),
  /** Brightness of the fog relative to the glowing photo fog at the horizon behind it. */
  brightness: z.number().min(0).default(1),
  /** How strongly the sodium lamps light the fog around them. */
  lampScatter: z.number().min(0).default(1),
  /** Azimuth (degrees) inside which the fog thins away in front of the playfield. */
  clear: z.tuple([z.number(), z.number()]).default([13, 20]),
  /** The playfield, kept clear: fog in front of this rectangle (centred on the origin of the board plane) is not drawn. */
  board: z.tuple([z.number(), z.number()]).default([10.5, 11.8]),
  backdrop: zBackdrop,
  seed: z.number().default(7),
});

type Params = z.infer<typeof schema>;

/**
 * Ground fog: banks of mist drifting across the field, as horizontal sheets stacked from the grass to
 * about chest height (one draw call). Each sheet's opacity is the optical depth of its slab along the
 * view ray, so the fog thickens towards the horizon and figures' legs are lost in it first. Banks
 * are tiling noise with a threshold that rises with height, so they form mounds rather than flat
 * layers. Their colour is the photo's own fog glow behind them; the sodium lamps light them nearby.
 * Nothing is drawn in front of the playfield.
 */
export const fogComponent: ComponentFactory<Params> = {
  type: 'deadAcreFog',
  version: 1,
  description: 'Drifting banks of ground fog lit by the photo glow and the sodium lamps.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const backdropTex = await backdropTexture(ctx, s, p.backdrop.src);
    const noise = noiseTexture(s, p.seed);
    const layers = ctx.quality.detail === 'low' ? Math.max(3, Math.round(p.layers * 0.4)) : ctx.quality.detail === 'medium' ? Math.max(4, Math.round(p.layers * 0.7)) : p.layers;
    const u = { presence: floatUniform(1), density: floatUniform(1), drift: floatUniform(1), dusk: floatUniform(0) };
    const backdrop = backdropSampler(backdropTex, p.backdrop, u.dusk as unknown as F);

    // Sheets from the lowest (drawn first) to the highest: correct order for a viewer above them.
    const [ox, , oz] = p.origin;
    const pos: number[] = [];
    const lay: number[] = [];
    const idx: number[] = [];
    const R = p.radius;
    for (let i = 0; i < layers; i++) {
      const h01 = (i + 0.5) / layers;
      const y = p.ground + h01 * p.top;
      const base = pos.length / 3;
      pos.push(ox - R, y, oz + 10, ox + R, y, oz + 10, ox + R, y, oz - R, ox - R, y, oz - R);
      for (let k = 0; k < 4; k++) lay.push(h01);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geometry.setAttribute('layer', new BufferAttribute(new Float32Array(lay), 1));
    geometry.setIndex(idx);
    geometry.computeBoundingSphere();

    const h01 = attribute<'float'>('layer', 'float');
    const t = ctx.uniforms.time as unknown as F;
    const toP = positionWorld.sub(cameraPosition);
    const dist = length(toP);
    const dir = toP.div(dist.max(1e-3));
    const driftT = t.mul(u.drift).mul(ctx.quality.reducedMotion ? 0.4 : 1);
    const flow = vec2(p.drift[0], p.drift[1]).mul(driftT).mul(h01.mul(0.2).add(0.9));
    // A clear's front rolls through the fog: the banks in its band are pushed out from the board
    // (motion) and lift with pale light as it passes (light), then settle back.
    const away = normalize(vec2(positionWorld.x.sub(frameUniforms.waveOrigin.x), positionWorld.z.sub(frameUniforms.waveOrigin.z)).add(vec2(0.0001, 0)));
    const raw = clearFrontRaw(positionWorld as unknown as V3).min(1.2);
    const push = raw.mul(frameUniforms.waveMotion).mul(3.5);
    const wave = raw.mul(frameUniforms.waveLight);
    const uvA = positionWorld.xz.sub(away.mul(push)).div(p.scale).add(flow.div(p.scale));
    const nA = texture(noise, uvA).r;
    const nB = texture(noise, uvA.mul(2.7).add(vec2(0.37, 0.71)).sub(flow.div(p.scale * 1.6))).g;
    const nC = texture(noise, uvA.mul(0.45).add(vec2(0.13, 0.29))).b;
    const nD = texture(noise, uvA.mul(6.1).add(vec2(0.53, 0.11)).add(flow.div(p.scale * 0.8))).a;
    const n = nA.mul(0.5).add(nB.mul(0.25)).add(nC.mul(0.35)).add(nD.mul(0.12)).sub(0.12);
    // Banks pile up: the higher the sheet, the thicker the noise must be to reach it.
    const thr = float(0.38).add(h01.mul(0.3));
    const bank = smoothstep(thr.sub(0.12), thr.add(0.34), n);
    const dens = bank.mul(p.density).add(float(p.mist).mul(float(1).sub(h01))).mul(u.density);
    const slab = p.top / layers;
    const path = float(slab).div(max(abs(dir.y), 0.02));
    let alpha: F = float(1).sub(exp(dens.mul(path).negate())).mul(wave.mul(0.6).add(1)).min(0.45) as F;
    // Fade in from just below the viewer and out towards the far field (the photo carries on).
    alpha = alpha.mul(smoothstep(2.5, 9, dist).mul(smoothstep(4, 30, dist).mul(0.35).add(0.65))).mul(smoothstep(R, R * 0.35, dist)) as F;
    // Sheets seen edge-on at the horizon would show as lines; the photo carries the fog there.
    alpha = alpha.mul(smoothstep(0.003, 0.03, abs(dir.y))) as F;
    // Keep the playfield clear: drop fog that lies between the viewer and the board rectangle.
    // (a soft fade by azimuth, so there is no edge when the board is not shown).
    const azimuth = abs(atan(dir.x, dir.z.negate())).mul(180 / Math.PI);
    const inside = smoothstep(p.clear[1], p.clear[0], azimuth);
    const front = smoothstep(-2, 1, positionWorld.z);
    alpha = alpha.mul(float(1).sub(inside.mul(front))).mul(u.presence) as F;
    // Colour: the photo's fog glow at the horizon in this direction, a little brighter in the
    // thick of a bank, plus the lamps scattering in it.
    const turn = backdrop.turnOf(dir as V3);
    const glow = backdrop.at(turn, float(1.2));
    const low = backdrop.at(turn, float(-2.5));
    const col = mix(low, glow, h01.mul(0.35).add(0.6)).mul(p.brightness).mul(bank.mul(0.25).add(0.85));
    const lit = col.add(lampLight(s, positionWorld as V3, null).mul(p.lampScatter * 0.08)).add(vec3(0.62, 0.6, 0.55).mul(wave.mul(0.14)));

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(lit, 1);
    material.opacityNode = alpha;
    material.transparent = true;
    material.depthWrite = false;
    material.blending = NormalBlending;
    material.fog = false;
    // Blend into the bloom buffer with the fog's own alpha (no rectangles over bright skies).
    material.mrtNode = mrt({ emissive: vec4(vec3(0, 0, 0), alpha) });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;

    return {
      object: mesh,
      reactive: { density: u.density, drift: u.drift, dusk: u.dusk },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
        release(ctx, s);
      },
    };
  },
};
