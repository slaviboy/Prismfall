import { BufferAttribute, BufferGeometry, CircleGeometry, DataTexture, Group, LinearFilter, Mesh, MeshBasicNodeMaterial, RedFormat, RepeatWrapping, SRGBColorSpace, TextureLoader, UnsignedByteType, Vector3, type MRTNode, type Object3D, type Renderer, type Texture } from 'three/webgpu';
import { cameraPosition, dot, exp, float, mix, mrt, mx_noise_float, normalize, normalWorld, output, positionWorld, reflector, screenUV, smoothstep, step, texture, vec2, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { fogModelFor } from './atmosphere';
import { cast, noisePlane, release, shared, type F, type V2, type V3 } from './shared';
import { createLighting, zLighting } from './surface';
import { EYE, WATER, terrainHeight } from './terrain';

const schema = z.object({
  exposure: z.number().min(0).default(0.4),
  lighting: zLighting,
  /** Ground textures (Poly Haven, CC0): mud and leaf litter, blended by noise and slope. */
  mud: z.object({ diffuse: z.string(), normal: z.string(), arm: z.string(), tile: z.number().default(3.4) }),
  litter: z.object({ diffuse: z.string(), normal: z.string(), tile: z.number().default(2.6) }),
  /** Ring and segment counts of the ground mesh (scaled by detail). */
  rings: z.number().int().min(40).max(260).default(170),
  segments: z.number().int().min(64).max(1024).default(640),
  reach: z.number().positive().default(1950),
  water: z
    .object({
      reflection: z.number().min(0).max(1).default(0.8),
      resolution: z.number().min(0.25).max(1).default(0.5),
      ripples: z.number().min(0).default(1),
    })
    .prefault({}),
});

type Params = z.infer<typeof schema>;

/** The reflector renders the world only (no playfield) and to the plain colour output. */
function reflectWorldOnly(node: ReturnType<typeof reflector>, scene: Object3D, halfRate: boolean): void {
  const outputOnly: MRTNode = mrt({ '': output });
  outputOnly.setBlendMode('', outputOnly.getBlendMode('output'));
  const base = node.reflector as unknown as { updateBefore(frame: { renderer: Renderer }): unknown };
  const original = base.updateBefore.bind(base);
  let hidden: Object3D[] | null = null;
  let frameNo = 0;
  base.updateBefore = (frame) => {
    // On WebGL 2, or below High detail, the mirror is refreshed every other frame: it is a whole
    // second render of the world, and still water changes slowly (measured on WebGL 2: no render
    // object churn from skipping it, unlike the shadow capture).
    const webgl = (frame.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend !== true;
    if ((halfRate || webgl) && frameNo++ % 2 === 1) return undefined;
    hidden ??= ['board', 'fx'].map((name) => scene.getObjectByName(name)).filter((o): o is Object3D => !!o);
    const r = frame.renderer;
    const setMRT = r.setMRT;
    r.setMRT = (m: MRTNode | null) => setMRT.call(r, m ?? outputOnly);
    const shown = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    try {
      return original(frame);
    } finally {
      r.setMRT = setMRT;
      hidden.forEach((o, i) => (o.visible = shown[i] as boolean));
    }
  };
}

function loadTexture(ctx: EnvironmentContext, path: string, srgb: boolean): Texture {
  const url = ctx.assets.url(path);
  const tex = new TextureLoader().load(url ?? '');
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** The area the water's depth map covers (metres) and its height encoding. */
const HM = { x0: EYE.x - 600, z0: EYE.z - 1150, size: 1200, below: 3, range: 4, res: 256 };

/** Terrain heights around the marsh baked into a small texture (R8: 4 m of range around the water). */
function heightTexture(): DataTexture {
  const n = HM.res;
  const data = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = HM.x0 + ((i + 0.5) / n) * HM.size;
      const zz = HM.z0 + ((j + 0.5) / n) * HM.size;
      const h = (terrainHeight(x, zz) - (WATER - HM.below)) / HM.range;
      data[j * n + i] = Math.round(Math.min(1, Math.max(0, h)) * 255);
    }
  }
  const tex = new DataTexture(data, n, n, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Polar ground mesh around the eye: dense near, coarse far, heights from terrainHeight. */
function groundGeometry(rings: number, segments: number, reach: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  // Geometric rings out to 700 m (fine near the eye), then even 11 m steps to the ridges.
  const radii: number[] = [];
  for (let r = 0.6; r < 700; r *= 1 + 8.5 / rings) radii.push(r);
  for (let r = 700; r <= reach; r += 11 * (170 / rings)) radii.push(r);
  rings = radii.length;
  const e = 0.6;
  const n = new Vector3();
  for (let i = 0; i < rings; i++) {
    const r = radii[i]!;
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const x = EYE.x + Math.sin(a) * r;
      const zz = EYE.z - Math.cos(a) * r;
      const h = terrainHeight(x, zz);
      const s = Math.max(e, r * 0.01);
      const hx = terrainHeight(x + s, zz) - terrainHeight(x - s, zz);
      const hz = terrainHeight(x, zz + s) - terrainHeight(x, zz - s);
      n.set(-hx, 2 * s, -hz).normalize();
      pos.push(x, h, zz);
      nrm.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = (i + 1) * segments + j;
      const d = (i + 1) * segments + ((j + 1) % segments);
      idx.push(a, c, b, b, c, d);
    }
  }
  // Cap the centre.
  const centre = pos.length / 3;
  pos.push(EYE.x, terrainHeight(EYE.x, EYE.z), EYE.z);
  nrm.push(0, 1, 0);
  for (let j = 0; j < segments; j++) idx.push(centre, j, (j + 1) % segments);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The land: a terrain mesh out to the far ridges in photographed mud and leaf litter (wet and dark
 * near the water), and the marsh water: a still mirror (a planar reflection of the fog, trees and
 * creatures) broken by faint ripples. Both are lit by the moon with the creatures' shadows and
 * fogged by the Veil's fog. Installs the ground height for props and VR.
 */
export const landComponent: ComponentFactory<Params> = {
  type: 'veilLand',
  version: 1,
  description: 'Terrain in photographed mud and litter, and a reflective marsh, lit by the moon and fogged.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const fog = await fogModelFor(ctx, s, p.exposure);
    const light = createLighting(s, fog, p.lighting);
    ctx.ground.provide(terrainHeight);
    const detail = ctx.quality.detail;
    const scale = detail === 'low' ? 0.55 : detail === 'medium' ? 0.8 : 1;
    const geo = groundGeometry(Math.round(p.rings * scale), Math.round(p.segments * scale), p.reach);
    const mudD = loadTexture(ctx, p.mud.diffuse, true);
    const mudN = loadTexture(ctx, p.mud.normal, false);
    const mudA = loadTexture(ctx, p.mud.arm, false);
    const litD = loadTexture(ctx, p.litter.diffuse, true);
    const litN = loadTexture(ctx, p.litter.normal, false);
    const noise = noisePlane(s);
    const u = { presence: floatUniform(1) };

    const w = positionWorld;
    const dist = cast<F>(w.sub(cameraPosition).length());
    const uvM = cast<V2>(w.xz.div(p.mud.tile));
    const uvL = cast<V2>(w.xz.div(p.litter.tile).add(vec2(0.37, 0.61)));
    const macro = cast<F>(texture(noise, w.xz.div(70)).r);
    const macro2 = cast<F>(texture(noise, w.xz.div(19).add(0.5)).r);
    const normalWorldGeo = cast<V3>(normalize(normalWorld));
    const slope = cast<F>(float(1).sub(normalWorldGeo.y));
    const litterMix = cast<F>(smoothstep(0.42, 0.62, macro.mul(0.7).add(macro2.mul(0.3))).mul(smoothstep(0.35, 0.1, slope)));
    const above = cast<F>(w.y.sub(WATER));
    // Wet near the water: darker, glossy mud that reads as a sheen at grazing angles.
    const wet = cast<F>(smoothstep(0.9, 0.0, above));
    const albedoM = cast<V3>(texture(mudD, uvM).rgb);
    const albedoL = cast<V3>(texture(litD, uvL).rgb);
    const arm = texture(mudA, uvM);
    let albedo: V3 = cast<V3>(mix(albedoM, albedoL, litterMix));
    // Dead grass: pale straw patches on the drier, flatter ground, finely streaked.
    const grassN = cast<F>(texture(noise, w.xz.div(23).add(vec2(0.31, 0.77))).r);
    const grassMask = cast<F>(smoothstep(0.5, 0.66, grassN.mul(0.7).add(macro2.mul(0.3))).mul(smoothstep(0.3, 1.2, above)).mul(smoothstep(0.4, 0.15, slope)));
    const streak = cast<F>(texture(noise, w.xz.mul(vec2(1.7, 0.45))).r);
    const straw = cast<V3>(vec3(0.36, 0.31, 0.22).mul(streak.mul(0.5).add(0.72)));
    albedo = cast<V3>(mix(albedo, straw, grassMask.mul(0.7)));
    // A cooler, greyer grade under the moon; tiling fades out with distance.
    const avg = vec3(0.16, 0.14, 0.12);
    albedo = cast<V3>(mix(albedo, avg, smoothstep(60, 260, dist).mul(0.6)));
    albedo = cast<V3>(mix(albedo, vec3(dot(albedo, vec3(0.3, 0.59, 0.11))), 0.25).mul(macro.mul(0.35).add(0.8)).mul(mix(float(1), float(0.62), wet)));
    // Far off, the land becomes weathered rock: mottled, banded, its gullies darker.
    const far = cast<F>(smoothstep(420, 1000, dist));
    const rockA = cast<F>(texture(noise, w.xz.div(37)).r);
    const rockB = cast<F>(texture(noise, w.xz.div(11).add(0.2)).r);
    const rockTone = cast<V3>(vec3(0.15, 0.148, 0.15).mul(rockA.mul(0.7).add(0.55)).mul(rockB.mul(0.3).add(0.85)).mul(float(1).sub(slope.mul(0.4))));
    albedo = cast<V3>(mix(albedo, rockTone, far));
    const nM = cast<V3>(texture(mudN, uvM).xyz.mul(2).sub(1));
    const nL = cast<V3>(texture(litN, uvL).xyz.mul(2).sub(1));
    const nT = cast<V3>(mix(nM, nL, litterMix));
    // World-aligned tangent frame (u = +x, v = -z) around the geometric normal.
    const ng = normalWorldGeo;
    const t = cast<V3>(normalize(vec3(1, 0, 0).sub(ng.mul(ng.x))));
    const b = cast<V3>(normalize(vec3(0, 0, -1).sub(ng.mul(ng.z.negate()))));
    const fade = cast<F>(smoothstep(140, 30, dist).mul(mix(float(1), float(0.4), wet)));
    // Rock relief far off: the normal tilted by the slope of two noise octaves (ribs and gullies).
    const relief = (xz: V2): F => cast<F>(texture(noise, xz.div(41)).r.mul(0.65).add(texture(noise, xz.div(14)).r.mul(0.35)));
    const e = 5;
    const gx = cast<F>(relief(cast<V2>(w.xz.add(vec2(e, 0)))).sub(relief(cast<V2>(w.xz.sub(vec2(e, 0))))));
    const gz = cast<F>(relief(cast<V2>(w.xz.add(vec2(0, e)))).sub(relief(cast<V2>(w.xz.sub(vec2(0, e))))));
    const ngFar = cast<V3>(normalize(ng.sub(vec3(gx, 0, gz).mul(far.mul(3.2)))));
    const n = cast<V3>(normalize(t.mul(nT.x.mul(fade)).add(b.mul(nT.y.mul(fade))).add(ngFar.mul(nT.z.max(0.3)))));
    const rough = cast<F>(mix(arm.g, float(0.12), wet));
    const color = light.shade({ albedo, normal: n, world: w as unknown as V3, roughness: rough, ao: cast<F>(arm.r.mul(0.6).add(0.4)), wet: cast<F>(wet.mul(1.3)) });
    const ground = new MeshBasicNodeMaterial();
    ground.colorNode = vec4(color, 1);
    // Crossfades: the land appears outward from the viewer.
    const reveal = cast<F>(step(dist, float(p.reach).mul(u.presence).add(1)));
    ground.opacityNode = reveal;
    ground.alphaTest = 0.5;
    ground.fog = false;
    ground.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const groundMesh = new Mesh(geo, ground);
    groundMesh.frustumCulled = false;
    groundMesh.name = 'veil-ground';

    // The marsh: one plane at the water level that knows its depth from a baked heightmap, so the
    // shallows show the mud through still water and the shores fade out without a line.
    const group = new Group();
    group.add(groundMesh);
    const hm = heightTexture();
    const waterGeo = new CircleGeometry(p.reach, 96);
    waterGeo.rotateX(-Math.PI / 2);
    waterGeo.translate(EYE.x, WATER, EYE.z);
    const wpos = positionWorld;
    const tt = ctx.uniforms.time;
    const uvH = cast<V2>(wpos.xz.sub(vec2(HM.x0, HM.z0)).div(HM.size));
    const inside = cast<F>(step(0.0, uvH.x).mul(step(uvH.x, 1)).mul(step(0.0, uvH.y)).mul(step(uvH.y, 1)));
    const floorH = cast<F>(texture(hm, uvH).r.mul(HM.range).add(WATER - HM.below));
    const depth = cast<F>(mix(float(3), float(WATER).sub(floorH).max(0), inside));
    const shallow = cast<F>(float(1).sub(smoothstep(0.0, 0.75, depth)));
    const rip = cast<F>(mx_noise_float(vec3(wpos.xz.mul(0.35), tt.mul(0.12))).mul(0.6).add(mx_noise_float(vec3(wpos.xz.mul(1.3), tt.mul(0.25))).mul(0.4)));
    const ripX = cast<F>(texture(noise, wpos.xz.div(9).add(vec2(tt.mul(0.004), 0))).r.sub(0.5));
    const ripZ = cast<F>(texture(noise, wpos.xz.div(7).add(vec2(0, tt.mul(0.005)))).r.sub(0.5));
    const wn = cast<V3>(normalize(vec3(ripX.mul(0.06 * p.water.ripples), 1, ripZ.mul(0.06 * p.water.ripples))));
    const v = cast<V3>(normalize(cameraPosition.sub(wpos)));
    const cosV = cast<F>(dot(wn, v).clamp(0, 1));
    const fres = cast<F>(float(0.02).add(float(0.98).mul(float(1).sub(cosV).pow(5))));
    let refl: V3 = fog.base(cast<V3>(vec3(v.x.negate(), v.y, v.z.negate())));
    // The mirror owns its render targets: released with the layer.
    let mirrorNode: { dispose(): void } | null = null;
    if (ctx.quality.reflections !== 'off' && p.water.reflection > 0) {
      const slow = detail === 'low' || detail === 'medium';
      const mirror = reflector({ resolutionScale: p.water.resolution * (detail === 'low' ? 0.6 : slow ? 0.8 : 1), bounces: false });
      mirrorNode = mirror;
      mirror.target.rotateX(-Math.PI / 2);
      mirror.target.position.y = WATER;
      group.add(mirror.target);
      reflectWorldOnly(mirror, ctx.scene, slow);
      mirror.uvNode = screenUV.flipX().add(vec2(ripX, ripZ).mul(0.012 * p.water.ripples).mul(exp(dist.mul(-0.004))));
      refl = cast<V3>(mix(refl, mirror.rgb, p.water.reflection));
    }
    // Through the shallows: the drowned mud, dimmer with depth; deep water is nearly black.
    const mudSeen = cast<V3>(vec3(0.052, 0.048, 0.042).mul(shallow.mul(0.8).add(0.2)));
    const body = cast<V3>(mix(vec3(0.006, 0.008, 0.01), mudSeen, shallow));
    const waterLit = cast<V3>(mix(body, refl, fres.mul(1.25).add(0.14).mul(float(1).sub(shallow.mul(0.45))).clamp(0, 1)));
    // The moon's path on the water: a broad sheen and sharp glints on the ripples.
    const r = cast<V3>(v.negate().reflect(wn));
    const toMoon = cast<F>(dot(r, light.moonDir).max(0));
    const glint = cast<F>(toMoon.pow(260).mul(rip.mul(0.5).add(0.5)).mul(0.9).add(toMoon.pow(18).mul(0.08)));
    const waterCol = fog.apply(cast<V3>(waterLit.add(vec3(0.6, 0.66, 0.78).mul(glint))), wpos as unknown as V3);
    const water = new MeshBasicNodeMaterial();
    water.colorNode = vec4(waterCol, 1);
    water.opacityNode = reveal;
    water.alphaTest = 0.5;
    water.fog = false;
    water.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const waterMesh = new Mesh(waterGeo, water);
    waterMesh.frustumCulled = false;
    waterMesh.renderOrder = -8;
    waterMesh.name = 'veil-water';
    group.add(waterMesh);

    return {
      object: group,
      setPresence(val) {
        u.presence.value = val;
      },
      dispose() {
        ctx.ground.provide(null);
        geo.dispose();
        waterGeo.dispose();
        ground.dispose();
        water.dispose();
        mirrorNode?.dispose();
        [mudD, mudN, mudA, litD, litN].forEach((t2) => t2.dispose());
        hm.dispose();
        release(ctx, s);
      },
    };
  },
};
