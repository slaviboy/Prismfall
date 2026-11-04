import { BufferAttribute, BufferGeometry, CircleGeometry, Group, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import {
  Fn,
  abs,
  cameraPosition,
  cameraViewMatrix,
  dot,
  exp,
  float,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  normalGeometry,
  output,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { noBloom, z, type ComponentFactory } from '@prismfall/sdk';
import { EYE, LOCH, terrainHeight, standingHeight } from './terrain';
import { StormMaterial, boltReflection, cast, haze, noisePlane, releaseStorm, ripples, sat, skyRadiance, storm, surfaceMap, surfaceUV, tickStorm, type F, type V2, type V3, type V4 } from './shared';

const schema = z.object({
  /** Ring and segment counts of the ground mesh (scaled by detail). */
  rings: z.number().int().min(40).max(300).default(190),
  segments: z.number().int().min(64).max(1200).default(720),
  reach: z.number().positive().default(2150),
  /** Loch surface: wind chop and rain on it. */
  chop: z.number().min(0).default(1),
});

type Params = z.infer<typeof schema>;

/** Polar ground mesh around the eye: dense near, coarse far, heights from terrainHeight. */
function groundGeometry(rings: number, segments: number, reach: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const radii: number[] = [];
  for (let r = 0.5; r < 600; r *= 1 + 8 / rings) radii.push(r);
  for (let r = 600; r <= reach; r += 10 * (190 / rings)) radii.push(r);
  const n = new Vector3();
  for (const r of radii) {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const x = EYE.x + Math.sin(a) * r;
      const zz = EYE.z - Math.cos(a) * r;
      const h = terrainHeight(x, zz);
      const e = Math.max(0.25, r * 0.008);
      const hx = terrainHeight(x + e, zz) - terrainHeight(x - e, zz);
      const hz = terrainHeight(x, zz + e) - terrainHeight(x, zz - e);
      n.set(-hx, 2 * e, -hz).normalize();
      pos.push(x, h, zz);
      nrm.push(n.x, n.y, n.z);
    }
  }
  const count = radii.length;
  for (let i = 0; i < count - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = (i + 1) * segments + j;
      const d = (i + 1) * segments + ((j + 1) % segments);
      idx.push(a, c, b, b, c, d);
    }
  }
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

/** The world appears outward from the viewer during crossfades (opaque parts, alphaTest 0.5). */
export function reveal(presence: F, reach = 2200): F {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.05)).mul(0.06);
  return cast<F>(step(dist.div(reach).add(edge).add(0.02), presence.mul(1.12)));
}

/**
 * The land: the wet moorland ledge the viewer stands on (peat, heather and rock slabs, puddles in
 * every hollow pocked by rain rings, a peat stream with running water), the broken slope down to the
 * glen, the loch, and the dark ring of mountains. Everything is soaked: low roughness, darkened
 * albedo and a sheen that reflects the storm sky, so each flash lights the wet ground and the water
 * shows the lightning. Lit only by the storm's own lights, with shadows from the flash.
 */
export const landComponent: ComponentFactory<Params> = {
  type: 'stormLand',
  version: 1,
  description: 'Dark Storm: wet moorland ledge with puddles and a stream, a glen with a rain-pocked loch, and a ring of dark mountains.',
  schema,
  create(ctx, p) {
    const s = storm(ctx);
    const u = s.u;
    const detail = ctx.quality.detail;
    const k = detail === 'low' ? 0.5 : detail === 'medium' ? 0.7 : detail === 'high' ? 0.85 : 1;
    const group = new Group();
    const geo = groundGeometry(Math.round(p.rings * k), Math.round(p.segments * k), p.reach);
    const map = surfaceMap(s);
    const n2 = noisePlane(s);
    // Standing height for a VR viewer (the ground, or the loch where it is higher).
    ctx.ground.provide(standingHeight);
    ctx.ground.setWaterLevel(null);

    const m = new StormMaterial();
    m.lightsNode = s.lightsNode;
    m.fog = false;
    const world = cast<V3>(positionWorld);
    const xz = cast<V2>(world.xz);
    const uv = surfaceUV(xz);
    const inMap = cast<F>(step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1)));
    const sm = cast<V4>(texture(map, uv));
    const dist = cast<F>(length(world.sub(cameraPosition)));
    const nearK = cast<F>(smoothstep(160, 30, dist));
    const puddleM = cast<F>(smoothstep(0.35, 0.6, sm.r).mul(inMap));
    const streamM = cast<F>(smoothstep(0.3, 0.7, sm.g).mul(inMap));
    const water = cast<F>(max(puddleM, streamM));
    const geoN = cast<V3>(normalGeometry);
    const slope = cast<F>(float(1).sub(geoN.y));
    const nA = cast<F>(texture(n2, xz.div(23)).r);
    const nB = cast<F>(texture(n2, xz.div(4.1)).r);
    const nC = cast<F>(texture(n2, xz.div(0.9)).r);
    const rock = cast<F>(sat(max(sm.b.mul(inMap).mul(1.4), smoothstep(0.28, 0.55, slope.add(nA.sub(0.5).mul(0.3))))));
    // Peat, dark heather and sodden grass on the ledge; bare rock on slabs, scarps and peaks.
    const peat = vec3(0.028, 0.022, 0.018);
    const heather = vec3(0.04, 0.03, 0.034);
    const grass = vec3(0.04, 0.045, 0.026);
    const stone = vec3(0.085, 0.086, 0.09).mul(nB.mul(0.5).add(0.75));
    const soil = cast<V3>(mix(mix(peat, heather, smoothstep(0.35, 0.65, nA)), grass, smoothstep(0.45, 0.75, nB).mul(0.6)));
    let albedo = cast<V3>(mix(soil, stone, rock).mul(nC.mul(0.35).add(0.8)));
    // Soaked: water darkens everything, puddles and the stream are nearly black water.
    albedo = cast<V3>(mix(albedo.mul(0.72), vec3(0.008, 0.009, 0.01), water.mul(0.9)));
    m.colorNode = vec4(albedo, 1);

    // Normals: the mesh's, roughened with noise on land, with rain rings and flow on water.
    const bump = cast<V2>(vec2(texture(n2, xz.div(1.7)).r.sub(texture(n2, xz.div(1.7).add(vec2(0.013, 0))).r), texture(n2, xz.div(1.7)).r.sub(texture(n2, xz.div(1.7).add(vec2(0, 0.013))).r)).mul(nearK).mul(mix(float(1.4), float(3.2), rock)));
    const rain = cast<F>(sat(u.rain.div(1.2)));
    const ring = ripples(s, xz, rain);
    const flowDir = vec2(0.6, -0.8);
    const flow = cast<V2>(vec2(mx_noise_float(vec3(xz.mul(2.2).sub(flowDir.mul(u.time.mul(1.6))), u.time.mul(0.3))), mx_noise_float(vec3(xz.mul(2.2).sub(flowDir.mul(u.time.mul(1.6))).add(7.7), u.time.mul(0.3)))).mul(0.12));
    const tilt = cast<V2>(mix(bump.mul(float(1).sub(water)), ring.add(flow.mul(streamM)), water));
    const nWorld = cast<V3>(normalize(mix(geoN, vec3(0, 1, 0), water.mul(0.85)).add(vec3(tilt.x.negate(), 0, tilt.y.negate()))));
    m.normalNode = cast<V3>(normalize(cameraViewMatrix.mul(vec4(nWorld, 0)).xyz));
    const rough = cast<F>(mix(mix(float(0.42).sub(nB.mul(0.14)), float(0.26).sub(nC.mul(0.08)), rock), float(0.04), water));
    m.roughnessNode = rough;
    m.metalness = 0;

    // The storm sky in the wet ground: the sheen of soaked rock and peat, a mirror in the water.
    const v = cast<V3>(normalize(cameraPosition.sub(world)));
    const r = cast<V3>(reflect(v.negate(), nWorld));
    const ndv = cast<F>(max(dot(nWorld, v), 0));
    const fres = cast<F>(float(0.02).add(float(0.98).mul(pow(float(1).sub(ndv), 5))));
    const gloss = cast<F>(mix(float(0.4), float(1), water).mul(float(1).sub(rough).pow(1.5)));
    const env = cast<V3>(skyRadiance(s, r, rough.mul(3)).add(boltReflection(s, world, r, rough)));
    const sheen = cast<V3>(env.mul(fres).mul(gloss));
    m.emissiveNode = sheen;
    m.outputNode = Fn(() => vec4(haze(s, cast<V3>(output.rgb), world), 1))();
    m.opacityNode = reveal(u.presence, p.reach);
    m.alphaTest = 0.5;
    noBloom(m);
    const ground = new Mesh(geo, m);
    ground.receiveShadow = true;
    ground.frustumCulled = false;
    group.add(ground);

    // The loch: dark water whipped by the wind and pocked by the rain, mirroring the storm.
    const lochGeo = new CircleGeometry(1500, 160);
    lochGeo.rotateX(-Math.PI / 2);
    const lm = new MeshBasicNodeMaterial();
    lm.fog = false;
    const lw = cast<V3>(positionWorld);
    const lxz = cast<V2>(lw.xz);
    const wind = u.windOffset;
    const chopA = cast<F>(mx_noise_float(vec3(lxz.add(wind.xz.mul(0.8)).div(9), u.time.mul(0.25))));
    const chopB = cast<F>(mx_noise_float(vec3(lxz.add(wind.xz.mul(1.3)).div(3.1), u.time.mul(0.4)).add(5.1)));
    const chopC = cast<F>(mx_noise_float(vec3(lxz.add(wind.xz.mul(1.1).add(9)).div(9), u.time.mul(0.25))));
    const chopD = cast<F>(mx_noise_float(vec3(lxz.add(wind.xz.mul(1.4)).div(3.1), u.time.mul(0.4)).add(12.4)));
    const ldist = cast<F>(length(lw.sub(cameraPosition)));
    const fadeChop = cast<F>(smoothstep(2200, 300, ldist));
    const gust = cast<F>(u.gust.mul(0.6).add(0.6));
    const ln = cast<V3>(normalize(vec3(chopA.mul(0.16).add(chopB.mul(0.07)).mul(gust).mul(fadeChop).mul(p.chop), 1, chopC.mul(0.16).add(chopD.mul(0.07)).mul(gust).mul(fadeChop).mul(p.chop))));
    const lv = cast<V3>(normalize(cameraPosition.sub(lw)));
    const lr = cast<V3>(reflect(lv.negate(), ln));
    const lndv = cast<F>(max(dot(ln, lv), 0));
    const lfres = cast<F>(float(0.02).add(float(0.98).mul(pow(float(1).sub(lndv), 5))));
    // Rain on the water roughens its mirror: far away the surface goes grey and soft.
    const lrough = cast<F>(mix(float(0.06), float(0.5), smoothstep(200, 1400, ldist)).add(rain.mul(0.08)));
    const reflected = cast<V3>(skyRadiance(s, lr, lrough.mul(2.5)).add(boltReflection(s, lw, lr, lrough)));
    // The water body takes a little of the flash light (stirred, aerated surface).
    let body: V3 = cast<V3>(vec3(0.0025, 0.003, 0.0035).add(vec3(0.02, 0.024, 0.03).mul(u.skyFlash)));
    body = cast<V3>(body.add(reflected.mul(lfres)));
    lm.colorNode = Fn(() => vec4(haze(s, body, lw).mul(1), 1))();
    lm.opacityNode = reveal(u.presence, p.reach);
    lm.alphaTest = 0.5;
    noBloom(lm);
    const loch = new Mesh(lochGeo, lm);
    loch.position.set(EYE.x, LOCH, EYE.z - 650);
    loch.frustumCulled = false;
    group.add(loch);
    void abs;
    void exp;

    return {
      object: group,
      update(frame) {
        tickStorm(s, ctx, frame);
      },
      setPresence(val) {
        u.presence.value = val;
      },
      dispose() {
        geo.dispose();
        m.dispose();
        lochGeo.dispose();
        lm.dispose();
        ctx.ground.provide(null);
        releaseStorm(ctx, s);
      },
    };
  },
};
