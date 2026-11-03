import { Group, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, Sprite, SpriteNodeMaterial, type Material, type Object3D } from 'three/webgpu';
import { cameraPosition, clamp, dot, exp, float, fract, instancedBufferAttribute, length, mix, mrt, mx_noise_float, normalWorldGeometry, normalize, positionWorld, sin, smoothstep, texture3D, uniform, uv, vec3, vec4 } from 'three/tsl';
import { seeded, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { COLORS, WARDEN_HEIGHT, beamField, clearMask, duskLight, lavaUplight, macro, noise3D, release, revealMask, shared, siteCentre, siteYaw, spireLight, stageTexture, triplanar, zSite } from './shared';

/**
 * The black citadel (Blender, assets/blender/scripts/spire_kit.py): photographed dark rock mapped
 * triplanar at architectural scale, rain streaks, molten seams low on its flanks and in its
 * recesses, iron cornices, glowing slits that flicker like fire behind them. Lit by the Warden's
 * core (the crown burns from inside), the beam when it turns down on the fortress, the lava
 * below and the lightning behind (which outlines it). A ring of storm cloud wraps the spire's
 * waist so the tower vanishes into it, with its summit clear above.
 */

const schema = z.object({
  site: zSite,
  src: z.string().default('models/citadel.glb'),
  lod: z.string().default('models/citadel_lod1.glb'),
  rock: z.string().default('textures/dark_rock_02_diff.webp'),
  /** Albedo of the stone (the photograph is darkened to near-black basalt). */
  albedo: z.number().default(0.24),
  /** Brightness of the slits (fire behind them) and the molten seams. */
  slits: z.number().default(1.4),
  seams: z.number().default(1),
  bloom: z.number().default(0.22),
  /** The cloud collar around the spire's waist: height above the plateau (m), radius, count. */
  collar: z
    .object({ height: z.tuple([z.number(), z.number()]).default([150, 270]), radius: z.tuple([z.number(), z.number()]).default([70, 210]), count: z.number().int().default(56), size: z.tuple([z.number(), z.number()]).default([90, 170]), opacity: z.number().default(0.5) })
    .prefault({}),
  seed: z.number().default(5),
});

type Params = z.infer<typeof schema>;

export const citadelComponent: ComponentFactory<Params> = {
  type: 'wardenSpireCitadel',
  version: 1,
  description: 'The Warden’s black citadel: a clustered spire on battered terraces inside a curtain wall, lit by the Warden, the lava and the lightning, with storm cloud around its waist.',
  schema,
  async create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const low = ctx.quality.detail === 'low';
    const src = low ? p.lod : p.src;
    const [gltf, rock, noise] = await Promise.all([ctx.assets.loadGLTF(src), stageTexture(ctx, s, p.rock, 'color'), noise3D(s)]);
    const group = new Group();
    group.name = 'wardens-spire-citadel';
    const centre = siteCentre(p.site);
    const root = gltf.scene.clone(true);
    root.position.set(centre[0], centre[1], centre[2]);
    root.rotation.y = siteYaw(p.site);
    root.scale.setScalar(p.site.scale);
    group.add(root);
    const presence = uniform(1);
    const time = ctx.uniforms.time;
    const wp = positionWorld;
    const n = normalWorldGeometry;
    const base = centre[1];
    const hgt = wp.y.sub(base);
    const disposables: { dispose(): void }[] = [];

    // Stone: the photograph at two architectural scales, near-black, with vertical weathering.
    const stoneTex = rock ? triplanar(rock, wp, n, 1 / 15).mul(0.6).add(triplanar(rock, wp, n, 1 / 70).mul(0.4)) : vec3(0.3, 0.3, 0.3);
    const grey = dot(stoneTex, vec3(0.3, 0.55, 0.15));
    const streaks = mx_noise_float(vec3(wp.x.mul(0.09), wp.y.mul(0.006), wp.z.mul(0.09))).mul(0.5).add(0.5);
    const stoneAlb = mix(vec3(grey, grey, grey), stoneTex, 0.25).mul(p.albedo).mul(macro(wp, 0.01)).mul(streaks.mul(0.5).add(0.75));
    const light = (k: number) => spireLight(s, wp, n, { core: 1, beam: 1.2, bolt: 1, rim: 0.9 * k }).add(lavaUplight(s, wp, n, base - 20, 1.6)).add(duskLight(wp, n, { back: 0.8, k: 0.45 }));
    // Molten seams: low on the flanks (heat rising from below) and wherever the stone faces down.
    const seamN = texture3D(noise, vec3(wp.x.div(70), wp.y.div(120), wp.z.div(70))).g;
    const seamFine = texture3D(noise, vec3(wp.x.div(23), wp.y.div(37), wp.z.div(23)).add(0.4)).b;
    const lowZone = exp(hgt.div(-34));
    const seam = smoothstep(0.016, 0.0, seamN.sub(0.5).abs()).mul(smoothstep(0.55, 0.8, seamFine)).mul(lowZone);
    const seamPulse = mx_noise_float(vec3(wp.x.mul(0.02), time.mul(0.25), wp.z.mul(0.02))).mul(0.3).add(0.85);
    const seamGlow = COLORS.lava.mul(seam.mul(seamPulse).mul(1.6 * p.seams)).mul(s.u.lavaHeat);

    const stone = new MeshBasicNodeMaterial();
    stone.colorNode = vec4(stoneAlb.mul(light(1)).add(seamGlow).mul(presence), 1);
    stone.mrtNode = mrt({ emissive: vec4(seamGlow.mul(p.bloom), 1) });
    stone.fog = true;
    stone.opacityNode = revealMask(presence);
    stone.alphaTest = 0.5;
    disposables.push(stone);

    // Iron: darker, smoother, catching the fire as a sheen.
    const metalAlb = vec3(0.05, 0.043, 0.04).mul(macro(wp, 0.03));
    const view = normalize(wp.sub(cameraPosition));
    const toCore = normalize(s.u.core.sub(wp));
    const sheen = clamp(dot(normalize(toCore.sub(view)), n), 0, 1).pow(18).mul(s.u.coreGlow).mul(float(9000).div(dot(s.u.core.sub(wp), s.u.core.sub(wp)).add(900)));
    const metal = new MeshBasicNodeMaterial();
    metal.colorNode = vec4(metalAlb.mul(light(1).mul(1.6)).add(COLORS.coreHot.mul(sheen.mul(0.6))).add(duskLight(wp, n, { k: 0.08, glint: 0.5 })).mul(presence), 1);
    metal.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    metal.fog = true;
    metal.opacityNode = revealMask(presence);
    metal.alphaTest = 0.5;
    disposables.push(metal);

    // Slits: fire seen through narrow openings; each flickers on its own, brighter near the core.
    const cell = wp.div(3).floor();
    const id = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const flick = sin(time.mul(id.mul(2.3).add(0.6)).add(id.mul(40))).mul(0.25).add(mx_noise_float(vec3(id.mul(30), time.mul(0.6), 1.3)).mul(0.25)).add(0.75);
    const lit = smoothstep(0.15, 0.3, id).mul(0.85).add(0.15);
    const nearCore = exp(length(s.u.core.sub(wp)).div(-260)).mul(0.9).add(0.5);
    const awake = float(1).add(s.u.awaken.mul(2.2));
    const slitCol = mix(vec3(0.9, 0.16, 0.03), vec3(1.0, 0.42, 0.12), id.mul(nearCore).clamp(0, 1));
    const slitE = slitCol.mul(flick.mul(lit).mul(nearCore).mul(awake).mul(p.slits)).mul(clearMask(wp).mul(0.7).add(0.3));
    const glow = new MeshBasicNodeMaterial();
    glow.colorNode = vec4(slitE.mul(presence), 1);
    glow.mrtNode = mrt({ emissive: vec4(slitE.mul(p.bloom), 1) });
    glow.fog = true;
    glow.opacityNode = revealMask(presence);
    glow.alphaTest = 0.5;
    disposables.push(glow);

    root.traverse((o: Object3D) => {
      if (!(o instanceof Mesh)) return;
      const name = (o.material as Material).name;
      o.material = name === 'spireMetal' ? metal : name === 'spireGlow' ? glow : stone;
      o.frustumCulled = false;
    });

    // --- Storm cloud wrapped around the spire's waist.
    const c = p.collar;
    const count = Math.max(12, Math.round(c.count * (low ? 0.5 : ctx.quality.detail === 'medium' ? 0.75 : 1)));
    const rand = seeded(p.seed * 911);
    const d0 = new Float32Array(count * 4);
    const d1 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = c.radius[0] + (c.radius[1] - c.radius[0]) * Math.pow(rand(), 0.8);
      const h = c.height[0] + (c.height[1] - c.height[0]) * rand();
      d0[i * 4] = a;
      d0[i * 4 + 1] = r;
      d0[i * 4 + 2] = h;
      d0[i * 4 + 3] = c.size[0] + (c.size[1] - c.size[0]) * rand();
      d1[i * 4] = rand();
      d1[i * 4 + 1] = rand();
      d1[i * 4 + 2] = (rand() < 0.5 ? -1 : 1) * (0.004 + rand() * 0.006);
      d1[i * 4 + 3] = rand();
    }
    const a0 = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(d0, 4), 'vec4');
    const a1 = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(d1, 4), 'vec4');
    const ang = a0.x.add(time.mul(a1.z));
    const axis = vec3(centre[0], centre[1], centre[2]);
    const sc = p.site.scale;
    const cpos = axis.add(vec3(sin(ang).mul(a0.y.mul(sc)), a0.z.mul(sc).add(sin(time.mul(0.05).add(a1.w.mul(6))).mul(6)), sin(ang.add(Math.PI / 2)).mul(a0.y.mul(sc))));
    const q = uv().sub(0.5).mul(2);
    const puff = texture3D(noise, vec3(uv().mul(0.55).add(a1.xy), time.mul(0.003).add(a1.w))).r;
    const puff2 = texture3D(noise, vec3(uv().mul(1.3).add(a1.yx), time.mul(0.005).add(a1.w.mul(2)))).g;
    const dens = smoothstep(1, 0.25, length(q)).mul(smoothstep(0.28, 0.75, puff.mul(0.75).add(puff2.mul(0.35))));
    // Lit from below by the slits and the lava, from above by the core; the beam when it passes.
    const below = exp(a0.z.sub(c.height[0]).div(-90));
    const toW = length(s.u.core.sub(cpos));
    const coreLit = s.u.coreGlow.mul(float(1).add(s.u.awaken.mul(0.8))).mul(float(9000).div(toW.mul(toW).add(900))).mul(0.6);
    const beamLit = beamField(s, cpos).mul(1.4);
    const ccol = vec3(0.03, 0.025, 0.026)
      .add(COLORS.lava.mul(below.mul(0.12).mul(s.u.lavaHeat)))
      .add(COLORS.core.mul(coreLit))
      .add(COLORS.beam.mul(beamLit))
      .add(COLORS.bolt.mul(s.u.boltPower.mul(2.6e6).div(dot(s.u.boltPos.sub(cpos), s.u.boltPos.sub(cpos)).add(2.5e5)).mul(0.5)));
    const cm = new SpriteNodeMaterial();
    cm.positionNode = cpos;
    cm.scaleNode = a0.w.mul(sc);
    cm.colorNode = vec4(ccol, dens.mul(c.opacity).mul(presence));
    cm.transparent = true;
    cm.depthWrite = false;
    cm.fog = true;
    cm.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const collar = new Sprite(cm);
    collar.count = count;
    collar.frustumCulled = false;
    collar.renderOrder = 1;
    group.add(collar);
    disposables.push(cm);

    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const d of disposables) d.dispose();
        ctx.assets.release(src);
        release(ctx, s);
      },
    };
  },
};

/** World position of the Warden's cage centre for a site. */
export function wardenPosition(site: z.infer<typeof zSite>): [number, number, number] {
  const c = siteCentre(site);
  return [c[0], c[1] + WARDEN_HEIGHT * site.scale, c[2]];
}
