import {
  AdditiveBlending,
  BackSide,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  RepeatWrapping,
  RGBAFormat,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Node,
  type Texture,
} from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  length,
  max,
  mix,
  mrt,
  mx_fractal_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { noBloom } from '../../shaders/uniforms';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';
import { saturnRingProfile } from './ringProfile';

const schema = z.object({
  position: zVec3.default([-160, 60, -420]),
  radius: z.number().default(70),
  /** Procedural bands (used when there is no `map`). */
  colorA: zColor.default('#c48a5a'),
  colorB: zColor.default('#5a3a72'),
  bands: z.number().default(9),
  /** An equirectangular (cylindrical) surface map in the stage folder, for a real planet surface. */
  map: z.string().optional(),
  mapSaturation: z.number().min(0).default(1),
  mapTint: zColor.default('#ffffff'),
  mapExposure: z.number().min(0).default(1),
  atmosphere: zColor.default('#8fb4ff'),
  atmosphereStrength: z.number().default(0.9),
  /** Direction towards the sun (world space). */
  lightDirection: zVec3.default([1, 0.4, 0.6]),
  /** Optional second sun direction, reached as the bindable `phase` goes from 0 to 1. */
  lightDirectionEnd: zVec3.optional(),
  /** Faint light on the night side (starlight), as a fraction of daylight. */
  night: z.number().min(0).default(0.004),
  rotationSpeed: z.number().default(0.01),
  /** Axis tilt in the screen plane (radians). */
  tilt: z.number().default(0.35),
  /** Axis tipped towards (+) or away from the viewer (radians): opens the rings into an ellipse. */
  incline: z.number().default(0),
  ring: z
    .object({
      inner: z.number(),
      outer: z.number(),
      color: zColor,
      opacity: z.number().default(0.7),
      /** 'bands': simple stripes (additive). 'saturn': Saturn's measured ring structure, lit and shadowed. */
      profile: z.enum(['bands', 'saturn']).default('bands'),
      /** Ring plane angle from the planet's equator view (radians). */
      tilt: z.number().default(Math.PI / 2.3),
      seed: z.number().default(1),
    })
    .optional(),
});

const LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * A planet: a real surface map (or procedural bands) lit by a moving sun with a soft, warm
 * terminator and limb darkening; an atmosphere halo whose glow depends on the light path (front
 * lit, or a bright ring when the sun is behind the planet); and an optional ring system with
 * Saturn's structure that casts its shadow on the planet, takes the planet's shadow, and glows
 * where sunlight passes through it.
 */
export const planetComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'planet',
  version: 2,
  description: 'Planet with a real or procedural surface, moving sun, atmosphere halo and optional shadowed ring system.',
  schema,
  async create(ctx, p) {
    const group = new Group();
    group.position.set(...p.position);
    group.rotation.set(p.incline, 0, p.tilt);
    let mapTex: Texture | null = null;
    if (p.map) {
      const url = ctx.assets.url(p.map);
      if (url) {
        mapTex = await new TextureLoader().loadAsync(url);
        mapTex.colorSpace = SRGBColorSpace;
        mapTex.wrapS = RepeatWrapping;
        mapTex.minFilter = LinearMipmapLinearFilter;
        mapTex.anisotropy = 8;
      } else console.warn(`[planet] map ${p.map} not found`);
    }

    const u = { atmosphere: floatUniform(p.atmosphereStrength), presence: floatUniform(1), phase: floatUniform(0) };
    const center = uniform(new Vector3());
    const ringNormal = uniform(new Vector3(0, 1, 0));
    const L0 = new Vector3(...p.lightDirection).normalize();
    const L1 = new Vector3(...(p.lightDirectionEnd ?? p.lightDirection)).normalize();
    const light = normalize(mix(uniform(L0), uniform(L1), u.phase));
    const R = p.radius;
    const atmoColor = colorUniform(p.atmosphere);

    const ringTex = p.ring?.profile === 'saturn' ? makeProfileTexture(p.ring.seed) : null;
    const ringT = (r: Node<'float'>): Node<'float'> => (p.ring ? r.sub(p.ring.inner).div(p.ring.outer - p.ring.inner) : float(0));

    // ---- surface
    const N = normalize(positionWorld.sub(center));
    const V = normalize(cameraPosition.sub(positionWorld));
    const ndl = dot(N, light);
    const ndv = clamp(dot(N, V), 0, 1);
    let albedo: Node<'vec3'>;
    if (mapTex) {
      const tex = texture(mapTex, uv()).rgb;
      albedo = mix(vec3(dot(tex, LUMA)), tex, p.mapSaturation).mul(colorUniform(p.mapTint)).mul(p.mapExposure);
      // Gas-giant poles fade into a darker, bluer haze over the last latitudes.
      const polar = smoothstep(0.86, 0.995, abs(positionLocal.y.div(R)));
      albedo = mix(albedo, vec3(dot(albedo, LUMA)).mul(vec3(0.72, 0.78, 0.9)), polar.mul(0.7));
    } else {
      const lat = positionLocal.y.div(R);
      const noise = mx_fractal_noise_float(positionLocal.mul(3 / R), 4, 2.0, 0.5);
      const bands = sin(lat.mul(p.bands).add(noise.mul(1.6))).mul(0.5).add(0.5);
      albedo = mix(colorUniform(p.colorA), colorUniform(p.colorB), bands);
    }
    const day = clamp(ndl, 0, 1);
    // Light reaching the terminator crosses more atmosphere: softer and warmer there.
    const soft = smoothstep(-0.07, 0.14, ndl);
    const warm = mix(vec3(1.12, 0.84, 0.66), vec3(1, 1, 1), smoothstep(0.02, 0.4, day));
    const limbDark = ndv.mul(0.3).add(0.7);
    let surface = albedo.mul(day.mul(0.94).add(soft.mul(0.05))).mul(limbDark).mul(warm);
    if (p.ring && ringTex) {
      // Shadow of the rings: follow the sun ray from this point to the ring plane.
      const denom = dot(light, ringNormal);
      const t = dot(center.sub(positionWorld), ringNormal).div(denom.add(denom.greaterThanEqual(0).select(1e-4, -1e-4)));
      const hit = positionWorld.add(light.mul(t));
      const rt = ringT(length(hit.sub(center)));
      const occ = texture(ringTex, vec2(rt.clamp(0, 1), 0.5)).a.mul(step(0, rt)).mul(step(rt, 1)).mul(step(0, t));
      surface = surface.mul(occ.mul(0.88).oneMinus());
    }
    surface = surface.add(albedo.mul(p.night));
    // A thin haze at the very edge of the disc, so the surface detail still shows on a crescent.
    const rim = ndv.oneMinus().pow(5);
    const backlit = max(dot(V.negate(), light), 0).pow(6);
    const atmoDisc = atmoColor.mul(rim.mul(smoothstep(-0.15, 0.5, ndl)).mul(0.45).add(rim.mul(rim).mul(backlit))).mul(u.atmosphere);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(surface.add(atmoDisc).mul(u.presence), 1);
    material.mrtNode = mrt({ emissive: vec4(atmoDisc.mul(0.25).mul(u.presence), 1) });
    material.fog = false;
    const sphere = new Mesh(new SphereGeometry(R, 160, 80), material);
    group.add(sphere);

    // ---- atmosphere halo: brightness from the optical path at the ray's closest approach
    const dirS = normalize(positionWorld.sub(cameraPosition));
    const closest = cameraPosition.add(dirS.mul(dot(center.sub(cameraPosition), dirS)));
    const h = length(closest.sub(center)).sub(R).div(R);
    const density = exp(max(h, 0).div(-0.0042));
    // Only the sunward limb is lit; looking past the limb towards a hidden sun, light scattered
    // forward through the atmosphere makes it glow much more.
    const limbN = normalize(closest.sub(center));
    const illum = smoothstep(-0.12, 0.45, dot(limbN, light));
    const towardSun = max(dot(dirS, light), 0).pow(16).mul(4).mul(smoothstep(-0.3, 0.2, dot(limbN, light)));
    const halo = atmoColor.mul(density.mul(illum.add(towardSun))).mul(u.atmosphere).mul(u.presence);
    const haloMat = new MeshBasicNodeMaterial();
    haloMat.colorNode = vec4(halo, 1);
    haloMat.mrtNode = mrt({ emissive: vec4(halo.mul(0.35), 1) });
    haloMat.side = BackSide;
    haloMat.transparent = true;
    haloMat.depthWrite = false;
    haloMat.blending = AdditiveBlending;
    haloMat.fog = false;
    const haloMesh = new Mesh(new SphereGeometry(R * 1.022, 128, 64), haloMat);
    group.add(haloMesh);

    // ---- rings
    let ringMesh: Mesh | null = null;
    if (p.ring) {
      const ringGeo = new RingGeometry(p.ring.inner, p.ring.outer, 360, 1);
      const rmat = new MeshBasicNodeMaterial();
      const rt = ringT(length(positionLocal.xy));
      if (ringTex) {
        const prof = texture(ringTex, vec2(rt, 0.5));
        const tau = prof.a;
        const Vr = normalize(cameraPosition.sub(positionWorld));
        const nL = dot(light, ringNormal);
        const sameSide = step(0, nL.mul(dot(Vr, ringNormal)));
        // Sunlit face: reflected light; far face: light scattered through the ring, strongest
        // where it is neither empty nor opaque, and much brighter looking towards the sun.
        const lit = prof.rgb.mul(tau).mul(abs(nL).pow(0.4).mul(0.85).add(0.15));
        const forward = max(dot(Vr.negate(), light), 0).pow(5);
        const through = prof.rgb.mul(tau.mul(tau.oneMinus()).mul(2.6)).mul(forward.mul(2.4).add(0.12));
        const rel = positionWorld.sub(center);
        const along = dot(rel, light);
        const perp2 = dot(rel, rel).sub(along.mul(along));
        const shadow = step(along, 0).mul(smoothstep(R * R * 1.03, R * R * 0.97, perp2));
        const col = mix(through, lit, sameSide).mul(shadow.mul(0.96).oneMinus()).mul(colorUniform(p.ring.color));
        rmat.colorNode = vec4(col.mul(u.presence), tau.mul(p.ring.opacity).mul(u.presence));
        rmat.blending = NormalBlending;
        rmat.premultipliedAlpha = true;
        noBloom(rmat);
      } else {
        const stripes = sin(rt.mul(80)).mul(0.25).add(sin(rt.mul(23)).mul(0.25)).add(0.5);
        const edge = smoothstep(0, 0.08, rt).mul(smoothstep(1, 0.85, rt));
        const rcol = colorUniform(p.ring.color).mul(stripes.mul(edge).mul(p.ring.opacity)).mul(u.presence);
        rmat.colorNode = vec4(rcol, 1);
        rmat.blending = AdditiveBlending;
        rmat.mrtNode = mrt({ emissive: vec4(rcol.mul(0.25), 1) });
      }
      rmat.transparent = true;
      rmat.depthWrite = false;
      rmat.side = DoubleSide;
      rmat.fog = false;
      ringMesh = new Mesh(ringGeo, rmat);
      ringMesh.rotation.x = p.ring.tilt;
      group.add(ringMesh);
    }

    const tmp = new Vector3();
    return {
      object: group,
      reactive: { atmosphere: u.atmosphere, phase: u.phase },
      update(frame) {
        sphere.rotation.y += frame.dt * p.rotationSpeed;
        group.updateWorldMatrix(true, true);
        group.getWorldPosition(center.value);
        if (ringMesh) ringNormal.value.copy(tmp.set(0, 0, 1).transformDirection(ringMesh.matrixWorld));
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        sphere.geometry.dispose();
        material.dispose();
        haloMesh.geometry.dispose();
        haloMat.dispose();
        mapTex?.dispose();
        ringTex?.dispose();
        if (ringMesh) {
          ringMesh.geometry.dispose();
          (ringMesh.material as MeshBasicNodeMaterial).dispose();
        }
      },
    };
  },
};

function makeProfileTexture(seed: number): DataTexture {
  const samples = 2048;
  // Bytes rather than floats: 32-bit float textures are not filterable on every WebGPU adapter.
  const bytes = Uint8Array.from(saturnRingProfile(samples, seed), (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  const tex = new DataTexture(bytes, samples, 1, RGBAFormat);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
