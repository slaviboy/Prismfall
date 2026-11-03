import type { Color } from 'three/webgpu';
import { DirectionalLight, HemisphereLight, Matrix4, MeshStandardNodeMaterial, Vector3, Vector4, type Material, type MeshStandardMaterial, type Node, type Object3D, type Texture } from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  diffuseColor,
  dot,
  exp,
  float,
  length,
  lights,
  max,
  mix,
  normalize,
  normalWorld,
  output,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  uniformArray,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';
import type { EnvFrame, EnvironmentContext, GroundField } from '@prismfall/sdk';

/**
 * Pieces every Last Frontier component shares: the time of day (golden afternoon, sunset, blue
 * hour, night, driven by game progress), the world's own sun and sky lights (so the town, the train
 * and the ground are lit and shadowed by the sun in the photograph, never by the board's light
 * rig), the atmospheric haze, and the conversion of Blender materials to that lighting.
 */

export type F = Node<'float'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;
const _u3 = () => uniform(new Vector3());
const _u1 = () => uniform(0);
export type U3 = ReturnType<typeof _u3>;
export type U1 = ReturnType<typeof _u1>;

/** The photograph's sun (Goegap Road): azimuth 108 deg to the right of the view, 6.5 deg up. */
export const SUN_AZIMUTH = 108;
export const SUN_ELEVATION = 6.5;

/** Unit direction towards (azimuth, elevation): azimuth 0 = straight ahead (−z), positive to the right. */
export function skyDirection(azimuthDeg: number, elevationDeg: number, out = new Vector3()): Vector3 {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ramp = (x: number, a: number, b: number): number => Math.min(1, Math.max(0, (x - a) / (b - a)));
const smooth = (x: number, a: number, b: number): number => {
  const t = ramp(x, a, b);
  return t * t * (3 - 2 * t);
};

/** Time-of-day keys over progress 0..1. */
interface Key {
  at: number;
  sunEl: number;
  sun: [number, number, number];
  sunI: number;
  sky: [number, number, number];
  ground: [number, number, number];
  hemiI: number;
  haze: [number, number, number];
  hazeSun: [number, number, number];
  photo: [number, number, number];
  exposure: number;
}

const KEYS: Key[] = [
  // Golden afternoon: the photograph as shot.
  {
    at: 0.0,
    sunEl: 6.5,
    sun: [1.0, 0.8, 0.56],
    sunI: 3.1,
    sky: [0.5, 0.6, 0.78],
    ground: [0.62, 0.46, 0.32],
    hemiI: 0.95,
    haze: [0.86, 0.79, 0.69],
    hazeSun: [1.0, 0.78, 0.5],
    photo: [1, 1, 1],
    exposure: 1.0,
  },
  {
    at: 0.28,
    sunEl: 3.8,
    sun: [1.0, 0.68, 0.4],
    sunI: 2.7,
    sky: [0.54, 0.54, 0.66],
    ground: [0.62, 0.42, 0.28],
    hemiI: 0.85,
    haze: [0.9, 0.7, 0.55],
    hazeSun: [1.0, 0.64, 0.36],
    photo: [1.12, 0.9, 0.72],
    exposure: 0.94,
  },
  // Sunset: low red-orange light, long shadows.
  {
    at: 0.45,
    sunEl: 0.8,
    sun: [1.0, 0.47, 0.22],
    sunI: 1.8,
    sky: [0.52, 0.42, 0.52],
    ground: [0.5, 0.3, 0.2],
    hemiI: 0.62,
    haze: [0.82, 0.52, 0.4],
    hazeSun: [1.0, 0.48, 0.24],
    photo: [1.22, 0.76, 0.56],
    exposure: 0.74,
  },
  // Blue hour: the sun is down, the sky lights everything cool and soft.
  {
    at: 0.62,
    sunEl: -2.5,
    sun: [0.9, 0.45, 0.3],
    sunI: 0.0,
    sky: [0.3, 0.36, 0.56],
    ground: [0.22, 0.18, 0.18],
    hemiI: 0.5,
    haze: [0.3, 0.33, 0.46],
    hazeSun: [0.62, 0.36, 0.3],
    photo: [0.72, 0.76, 0.98],
    exposure: 0.42,
  },
  // Night: moonlight and lanterns.
  {
    at: 0.82,
    sunEl: -8,
    sun: [0.62, 0.72, 1.0],
    sunI: 0.38,
    sky: [0.1, 0.13, 0.24],
    ground: [0.06, 0.05, 0.06],
    hemiI: 0.42,
    haze: [0.07, 0.085, 0.13],
    hazeSun: [0.1, 0.12, 0.2],
    photo: [0.58, 0.66, 0.98],
    exposure: 0.17,
  },
  {
    at: 1.0,
    sunEl: -10,
    sun: [0.62, 0.72, 1.0],
    sunI: 0.4,
    sky: [0.08, 0.1, 0.2],
    ground: [0.05, 0.045, 0.05],
    hemiI: 0.4,
    haze: [0.055, 0.065, 0.1],
    hazeSun: [0.08, 0.1, 0.16],
    photo: [0.56, 0.64, 0.98],
    exposure: 0.14,
  },
];

/** The moon at night (the light swings over to it once the sun has set). */
const MOON_AZIMUTH = -52;
const MOON_ELEVATION = 38;

function sampleKeys(t: number): Key {
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1]!.at) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const k = smooth(t, a.at, b.at);
  const mix3 = (x: [number, number, number], y: [number, number, number]): [number, number, number] => [lerp(x[0], y[0], k), lerp(x[1], y[1], k), lerp(x[2], y[2], k)];
  return {
    at: t,
    sunEl: lerp(a.sunEl, b.sunEl, k),
    sun: mix3(a.sun, b.sun),
    sunI: lerp(a.sunI, b.sunI, k),
    sky: mix3(a.sky, b.sky),
    ground: mix3(a.ground, b.ground),
    hemiI: lerp(a.hemiI, b.hemiI, k),
    haze: mix3(a.haze, b.haze),
    hazeSun: mix3(a.hazeSun, b.hazeSun),
    photo: mix3(a.photo, b.photo),
    exposure: lerp(a.exposure, b.exposure, k),
  };
}

export interface Frontier {
  readonly u: {
    /** Direction towards the light that casts shadows (the sun, then the moon). */
    lightDir: U3;
    /** Direction towards the sun itself (for haze in-scatter, even below the horizon). */
    sunDir: U3;
    sunColor: U3;
    skyColor: U3;
    groundColor: U3;
    hazeColor: U3;
    hazeSun: U3;
    hazeDensity: U1;
    /** Panorama grade: colour multiplier and exposure. */
    photoTint: U3;
    photoExposure: U1;
    /** 0 by day, 1 when lanterns and lamps burn fully. */
    lamps: U1;
    /** 0 by day, 1 at full night (stars, moon). */
    night: U1;
    /** Smoothed progress 0..1 (the time of day). */
    tod: U1;
    /** Wind (m/s, world). */
    wind: U3;
    /** Music: smoothed bass, mid and treble (gentle, never flashing). */
    bass: U1;
    mids: U1;
    highs: U1;
  };
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly lightsNode: ReturnType<typeof lights>;
  /** Lantern and lit-window light on nearby surfaces: xyz position, w = strength (0 = off). */
  readonly lampValues: Vector4[];
  readonly lampArray: ReturnType<typeof uniformArray>;
  shadowBoxes: number[][];
  hazeDistance: number;
  shadowSize: number;
  /** Seconds of a gust in progress (0 = calm); set by the dust component, read by others. */
  gust: number;
  users: number;
  lastTime: number;
  todValue: number;
}

const store = new WeakMap<GroundField, Frontier>();

/** One shared state per built environment (each build has its own ground field). */
export function frontier(ctx: EnvironmentContext): Frontier {
  let s = store.get(ctx.ground);
  if (!s) {
    const lampValues = Array.from({ length: MAX_LAMPS }, () => new Vector4(0, -1000, 0, 0));
    const sun = new DirectionalLight(0xffffff, 3);
    const hemi = new HemisphereLight(0xffffff, 0xffffff, 1);
    const detail = ctx.quality.detail;
    const shadowSize = detail === 'low' ? 0 : detail === 'medium' ? 2048 : 4096;
    sun.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      // Wide and shallow: a low sun sees the town edge-on, so the map is wide across the light.
      sun.shadow.mapSize.set(shadowSize, shadowSize / 2);
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.06;
      sun.shadow.radius = 2;
      // Only the world's own casters (layer 7): the board never shades the town.
      sun.shadow.camera.layers.set(SHADOW_LAYER);
    }
    s = {
      u: {
        lightDir: uniform(skyDirection(SUN_AZIMUTH, SUN_ELEVATION)),
        sunDir: uniform(skyDirection(SUN_AZIMUTH, SUN_ELEVATION)),
        sunColor: uniform(new Vector3(1, 0.8, 0.56)),
        skyColor: uniform(new Vector3(0.5, 0.6, 0.78)),
        groundColor: uniform(new Vector3(0.6, 0.45, 0.32)),
        hazeColor: uniform(new Vector3(0.86, 0.79, 0.69)),
        hazeSun: uniform(new Vector3(1, 0.78, 0.5)),
        hazeDensity: uniform(1 / 2600),
        photoTint: uniform(new Vector3(1, 1, 1)),
        photoExposure: uniform(1),
        lamps: uniform(0),
        night: uniform(0),
        tod: uniform(0),
        wind: uniform(new Vector3(-2.2, 0, -0.9)),
        bass: uniform(0),
        mids: uniform(0),
        highs: uniform(0),
      },
      sun,
      hemi,
      lightsNode: lights([sun, hemi]),
      lampValues,
      lampArray: uniformArray(lampValues, 'vec4'),
      shadowBoxes: [],
      hazeDistance: 7000,
      shadowSize,
      gust: 0,
      users: 0,
      lastTime: -1,
      todValue: -1,
    };
    store.set(ctx.ground, s);
  }
  s.users++;
  return s;
}

export function releaseFrontier(ctx: EnvironmentContext, s: Frontier): void {
  s.users--;
  if (s.users > 0) return;
  s.sun.shadow.map?.dispose();
  s.sun.dispose();
  s.hemi.dispose();
  store.delete(ctx.ground);
}

export const SHADOW_LAYER = 7;
/** Lamps whose warm light falls on nearby walls, boardwalks and the street at night. */
export const MAX_LAMPS = 12;
/** Lantern flame colour (linear). */
export const LAMP_COLOR: [number, number, number] = [1.0, 0.56, 0.24];

/**
 * Warm light from the lanterns and lit windows on a surface (irradiance, multiplied by the albedo
 * by the caller), faded in with the lamps. Inverse-square with a soft core, Lambert on the normal.
 */
export function lampLight(s: Frontier, position: V3 = positionWorld as unknown as V3, normal: V3 = normalWorld as unknown as V3): V3 {
  let sum: F = float(0);
  for (let i = 0; i < MAX_LAMPS; i++) {
    const L = s.lampArray.element(i) as unknown as V4;
    const d = L.xyz.sub(position);
    const d2 = dot(d, d);
    const ndl = max(dot(normal, d.mul(d2.max(0.0001).inverseSqrt())), 0)
      .mul(0.85)
      .add(0.15);
    sum = sum.add(L.w.mul(ndl).div(d2.add(1.5))) as F;
  }
  return vec3(...LAMP_COLOR).mul(sum.mul(s.u.lamps)) as V3;
}

/** Marks an object tree as a shadow caster of the world's sun (and receiver). */
export function castWorldShadows(root: Object3D, cast = true): void {
  root.traverse((o) => {
    o.layers.enable(SHADOW_LAYER);
    o.castShadow = cast;
    o.receiveShadow = true;
  });
}

const _v = new Vector3();
const _c = new Vector3();
const _m = new Matrix4();

/**
 * Advances the shared time of day once per frame (whichever component updates first) and writes
 * the lights and uniforms. Progress is smoothed over several seconds so the day turns gently.
 */
export function tickFrontier(s: Frontier, frame: EnvFrame): void {
  if (s.lastTime === frame.time) return;
  const dt = s.lastTime < 0 ? 1 : Math.min(0.25, Math.max(0, frame.time - s.lastTime));
  s.lastTime = frame.time;
  const target = Math.min(1, Math.max(0, frame.game.progress));
  s.todValue = s.todValue < 0 ? target : s.todValue + (target - s.todValue) * (1 - Math.exp(-dt / 6));
  const t = s.todValue;
  const k = sampleKeys(t);
  const u = s.u;
  u.tod.value = t;
  skyDirection(SUN_AZIMUTH, k.sunEl, u.sunDir.value);
  // The shadow light follows the sun until it sets, then the moon.
  const moonT = smooth(t, 0.66, 0.8);
  const sunL = skyDirection(SUN_AZIMUTH, Math.max(k.sunEl, 1.2), _v);
  const moonL = skyDirection(MOON_AZIMUTH, MOON_ELEVATION, _c);
  u.lightDir.value.copy(sunL).lerp(moonL, moonT).normalize();
  const below = smooth(k.sunEl, 1.5, -1.0);
  const sunI = moonT > 0 ? k.sunI : k.sunI * (1 - below * 0.7);
  u.sunColor.value.set(k.sun[0] * sunI, k.sun[1] * sunI, k.sun[2] * sunI);
  u.skyColor.value.set(k.sky[0] * k.hemiI, k.sky[1] * k.hemiI, k.sky[2] * k.hemiI);
  u.groundColor.value.set(k.ground[0] * k.hemiI, k.ground[1] * k.hemiI, k.ground[2] * k.hemiI);
  u.hazeColor.value.set(...k.haze);
  u.hazeSun.value.set(...k.hazeSun);
  u.hazeDensity.value = 1 / s.hazeDistance;
  u.photoTint.value.set(...k.photo);
  u.photoExposure.value = k.exposure;
  u.lamps.value = smooth(t, 0.4, 0.62);
  u.night.value = smooth(t, 0.6, 0.85);
  // Music: smoothed slowly; worlds breathe with it, they never flash.
  const a = frame.audio;
  const follow = (cur: number, v: number, tau: number) => cur + (v - cur) * (1 - Math.exp(-dt / tau));
  u.bass.value = follow(u.bass.value, a.bass, 0.9);
  u.mids.value = follow(u.mids.value, (a.lowMid + a.mid) * 0.5, 0.6);
  u.highs.value = follow(u.highs.value, (a.highMid + a.treble) * 0.5, 0.35);

  // Lights.
  s.sun.intensity = 1;
  s.sun.color.setRGB(u.sunColor.value.x, u.sunColor.value.y, u.sunColor.value.z);
  s.hemi.color.setRGB(u.skyColor.value.x, u.skyColor.value.y, u.skyColor.value.z);
  s.hemi.groundColor.setRGB(u.groundColor.value.x, u.groundColor.value.y, u.groundColor.value.z);
  s.hemi.intensity = 1;
  fitShadow(s);
}

/** Fits the sun's orthographic shadow camera tightly around the shadow boxes, seen from the light. */
function fitShadow(s: Frontier): void {
  const L = s.u.lightDir.value;
  const boxes = s.shadowBoxes.length ? s.shadowBoxes : [[-125, -8, -150, -10, 26, 10]];
  // Light basis: forward = −L, right and up perpendicular.
  const fwd = _v.copy(L).negate();
  const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();
  let minR = Infinity;
  let maxR = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  let minF = Infinity;
  let maxF = -Infinity;
  const centre = new Vector3();
  let n = 0;
  for (const b of boxes) {
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(i & 1 ? b[3]! : b[0]!, i & 2 ? b[4]! : b[1]!, i & 4 ? b[5]! : b[2]!);
      centre.add(p);
      n++;
      minR = Math.min(minR, p.dot(right));
      maxR = Math.max(maxR, p.dot(right));
      minU = Math.min(minU, p.dot(up));
      maxU = Math.max(maxU, p.dot(up));
      minF = Math.min(minF, p.dot(fwd));
      maxF = Math.max(maxF, p.dot(fwd));
    }
  }
  centre.multiplyScalar(1 / n);
  const cr = (minR + maxR) / 2;
  const cu = (minU + maxU) / 2;
  const cf = (minF + maxF) / 2;
  // Light position: the box centre in light space, pulled back along the light.
  const target = new Vector3().addScaledVector(right, cr).addScaledVector(up, cu).addScaledVector(fwd, cf);
  const depth = maxF - minF;
  s.sun.position.copy(target).addScaledVector(fwd, -(depth / 2 + 50));
  s.sun.target.position.copy(target);
  const cam = s.sun.shadow.camera;
  cam.left = minR - cr - 2;
  cam.right = maxR - cr + 2;
  cam.bottom = minU - cu - 2;
  cam.top = maxU - cu + 2;
  cam.near = 1;
  cam.far = depth + 120;
  cam.updateProjectionMatrix();
  s.sun.updateMatrixWorld(true);
  s.sun.target.updateMatrixWorld(true);
  s.hemi.updateMatrixWorld(true);
  void _m;
}

/**
 * Atmospheric haze for a lit colour at a world position: dims with distance towards the sky colour
 * (brighter and warmer looking towards the sun).
 */
export function haze(s: Frontier, color: V3, position: V3 = positionWorld as unknown as V3): V3 {
  const toP = position.sub(cameraPosition);
  const dist = length(toP);
  const dir = toP.div(max(dist, 0.001));
  const amount = float(1).sub(exp(dist.mul(s.u.hazeDensity).negate()));
  const toward = pow(max(dot(normalize(dir), s.u.sunDir), 0), 6);
  const air = mix(s.u.hazeColor, s.u.hazeSun, clamp(toward.mul(0.8), 0, 1)) as unknown as V3;
  return mix(color, air, amount) as unknown as V3;
}

/** A standard material lit only by the world's sun and sky, never by the scene's environment map. */
export class FrontierMaterial extends MeshStandardNodeMaterial {
  override setupEnvironment(): null {
    return null;
  }
}

export interface LitOptions {
  /** Vertex colour carries baked AO (COLOR_0.r). */
  vertexAO: boolean;
  presence: U1;
  /** Extra emissive (window light, lantern glow), added before haze. */
  emissive?: V3;
  /** Multiply the base colour (night dimming of photographic assets, tints). */
  tint?: Color;
}

/** Copies a glTF material into a FrontierMaterial with the world's lighting, AO and haze. */
export function litMaterial(s: Frontier, src: Material, opts: LitOptions): FrontierMaterial {
  const m = new FrontierMaterial();
  const g = src as MeshStandardMaterial;
  m.name = src.name;
  if (g.color) m.color.copy(g.color);
  if (opts.tint) m.color.multiply(opts.tint);
  m.map = g.map ?? null;
  m.normalMap = g.normalMap ?? null;
  if (g.normalScale) m.normalScale.copy(g.normalScale);
  m.roughness = g.roughness ?? 0.8;
  m.roughnessMap = g.roughnessMap ?? null;
  m.metalness = g.metalness ?? 0;
  m.metalnessMap = g.metalnessMap ?? null;
  m.aoMap = g.aoMap ?? null;
  m.alphaMap = g.alphaMap ?? null;
  m.alphaTest = g.alphaTest ?? 0;
  m.transparent = g.transparent ?? false;
  m.opacity = g.opacity ?? 1;
  m.side = g.side;
  m.vertexColors = false;
  m.fog = false;
  m.lightsNode = s.lightsNode;
  if (opts.vertexAO) m.aoNode = clamp(vertexColor(0).r.mul(1.05), 0, 1);
  const lit = output.rgb as unknown as V3;
  const lamp = lampLight(s).mul(diffuseColor.rgb) as V3;
  const glow = opts.emissive ? (lamp.add(opts.emissive) as V3) : lamp;
  const withGlow = lit.add(glow) as V3;
  m.outputNode = vec4(haze(s, withGlow).mul(opts.presence), output.a);
  return m;
}

/** Texture fields worth disposing on a converted glTF material. */
export function texturesOf(m: Material): Texture[] {
  const g = m as MeshStandardMaterial;
  return [g.map, g.normalMap, g.roughnessMap, g.metalnessMap, g.aoMap, g.emissiveMap, g.alphaMap].filter((t): t is Texture => !!t);
}

/** Smoothstep in TSL with numeric edges (tiny helper for readability). */
export const sstep = (a: number, b: number, x: F): F => smoothstep(a, b, x) as F;
export const vec = (x: number, y: number, zz: number): V3 => vec3(x, y, zz) as V3;
