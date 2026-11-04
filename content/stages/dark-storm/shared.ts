import {
  Data3DTexture,
  DataTexture,
  DataUtils,
  DirectionalLight,
  HalfFloatType,
  HemisphereLight,
  LinearFilter,
  MeshStandardNodeMaterial,
  PointLight,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Node,
  type Object3D,
} from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  int,
  length,
  lights,
  max,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  vec2,
  vec3,
} from 'three/tsl';
import type { EnvFrame, EnvironmentContext, GroundField } from '@prismfall/sdk';
import { StormDirector, flashEnvelope, makeRng, strikeDuration, thunderDelay, apparentDistance, type Strike } from './director';
import { EYE, ledgeMask, pointAt, puddle, rockiness, streamMask, terrainHeight } from './terrain';

/**
 * State every Dark Storm component shares within one built environment: the storm director, the
 * strikes in progress and the light they throw, the world's own lights (a dim storm-sky hemisphere,
 * three point lights that follow the brightest flashes and a shadow-casting light pointed at the
 * strongest), the rain and wind, noise volumes and the ledge's surface map. The board is never lit
 * by any of it: these lights exist only in the world's materials (`lightsNode`).
 */

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;
export const cast = <T>(n: unknown): T => n as T;

const _u1 = () => uniform(0);
const _u3 = () => uniform(new Vector3());
export type U1 = ReturnType<typeof _u1>;
export type U3 = ReturnType<typeof _u3>;

/** The cloud deck: its base (lumps hang a little lower) and top, world metres. */
export const CLOUD_BASE = 400;
export const CLOUD_TOP = 1700;
/** Flash slots the world's lights and shaders follow. */
export const MAX_FLASH = 3;
/** Layer of the world's shadow casters (only the props cast). */
export const SHADOW_LAYER = 6;
/** The surface map around the viewer: x0, z0, size (m) and resolution. */
export const SURFACE = { x0: EYE.x - 160, z0: EYE.z - 190, size: 320, res: 512 } as const;

/** How flash light falls off with distance (see the point lights). */
export const FLASH_DECAY = 1.6;
/** Flash brightness to point-light intensity: a near strike lights the ledge 300 m away to about 1.5. */
export const FLASH_POWER = 9000;

/** Lightning's colour: a cold blue-white (linear). */
export const FLASH_COLOR: [number, number, number] = [0.78, 0.86, 1.0];
/** The storm's ambient: almost black blue-grey sky light, and a darker ground. */
const AMBIENT_SKY: [number, number, number] = [0.075, 0.09, 0.12];
const AMBIENT_GROUND: [number, number, number] = [0.008, 0.0088, 0.01];
/** A faint break in the storm far to the right: the horizon's last light. */
export const GLOW_AZIMUTH = 34;
export const GLOW_COLOR: [number, number, number] = [0.05, 0.058, 0.064];

/** A strike being drawn and lighting the world. */
export interface ActiveStrike {
  readonly strike: Strike;
  /** Frame time (s) of its first return stroke. */
  readonly start: number;
  /** Where the channel leaves the cloud and where it ends (ground strike point or far end). */
  readonly top: Vector3;
  readonly bottom: Vector3;
  /** Where its light on the land comes from, and where the cloud glows from within. */
  readonly light: Vector3;
  readonly glow: Vector3;
  /** Glow radius inside the cloud (m). */
  readonly glowRadius: number;
  /** Peak brightness after comfort scaling. */
  readonly peak: number;
  readonly duration: number;
  readonly reduced: boolean;
  /** Bolt geometry slot (−1 = none drawn). */
  slot: number;
  /** Current brightness 0..1 (envelope × peak), written each frame. */
  level: number;
}

export interface Storm {
  readonly u: {
    /** Flash lights: xyz position, w intensity (light on the land). */
    flashPos: ReturnType<typeof uniformArray>;
    /** Cloud glow: xyz centre, w radius (m). */
    flashGlow: ReturnType<typeof uniformArray>;
    /** Overall brightness of the lit cloud deck (diffuse light from the whole sky). */
    skyFlash: U1;
    /** Rain 0..1.5, wind velocity (m/s), integrated wind offset (m), current gust 0..1. */
    rain: U1;
    wind: U3;
    windOffset: U3;
    gust: U1;
    /** Integrated cloud drift (m). */
    cloudOffset: U3;
    /** Storm time (s), slowed under reduced motion. */
    time: U1;
    /** World crossfade 0..1. */
    presence: U1;
    /** Each flash's main channel as a line for reflections: A = strike point and brightness, B = top and width. */
    boltA: ReturnType<typeof uniformArray>;
    boltB: ReturnType<typeof uniformArray>;
  };
  readonly boltAValues: Vector4[];
  readonly boltBValues: Vector4[];
  readonly flashValues: Vector4[];
  readonly glowValues: Vector4[];
  readonly hemi: HemisphereLight;
  readonly points: PointLight[];
  readonly sun: DirectionalLight;
  readonly lightsNode: ReturnType<typeof lights>;
  readonly director: StormDirector;
  readonly active: ActiveStrike[];
  /** Components that draw strikes register here (the lightning component). */
  readonly onStrike: Set<(a: ActiveStrike) => void>;
  noise3: Data3DTexture | null;
  noise2: DataTexture | null;
  surface: DataTexture | null;
  shadowSize: number;
  users: number;
  lastTime: number;
  /** A drop is coming (the music's anticipation): the director was asked once for it. */
  anticipating: boolean;
  /** Debug log: every strike with its frame time and the thunder delay it scheduled. */
  readonly log: { id: number; level: number; kind: string; distance: number; apparent: number; delay: number; perf: number; frameTime: number; crack: boolean }[];
}

const store = new WeakMap<GroundField, Storm>();

/** One shared storm per built environment (each build has its own ground field). */
export function storm(ctx: EnvironmentContext): Storm {
  let s = store.get(ctx.ground);
  if (!s) {
    const flashValues = Array.from({ length: MAX_FLASH }, () => new Vector4(0, 400, -1000, 0));
    const glowValues = Array.from({ length: MAX_FLASH }, () => new Vector4(0, 600, -1000, 300));
    const boltAValues = Array.from({ length: MAX_FLASH }, () => new Vector4(0, -1000, -1000, 0));
    const boltBValues = Array.from({ length: MAX_FLASH }, () => new Vector4(0, -900, -1000, 1));
    const hemi = new HemisphereLight(0xffffff, 0xffffff, 1);
    hemi.color.setRGB(...AMBIENT_SKY);
    hemi.groundColor.setRGB(...AMBIENT_GROUND);
    // Flash lights fall off as d^-1.6: between a point (d^-2) and a long channel's line source (d^-1).
    const points = Array.from({ length: MAX_FLASH }, () => {
      const p = new PointLight(0xffffff, 0, 0, FLASH_DECAY);
      p.color.setRGB(...FLASH_COLOR);
      return p;
    });
    const sun = new DirectionalLight(0xffffff, 0);
    sun.color.setRGB(...FLASH_COLOR);
    const detail = ctx.quality.detail;
    const shadowSize = detail === 'low' ? 0 : detail === 'medium' ? 1024 : 2048;
    sun.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      sun.shadow.mapSize.set(shadowSize, shadowSize);
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.08;
      sun.shadow.radius = 2;
      sun.shadow.camera.layers.set(SHADOW_LAYER);
    }
    // Seeded per session: the storm is different every time the world is built.
    const director = new StormDirector((Math.random() * 4294967296) >>> 0);
    s = {
      u: {
        flashPos: uniformArray(flashValues, 'vec4'),
        flashGlow: uniformArray(glowValues, 'vec4'),
        skyFlash: uniform(0),
        rain: uniform(1),
        wind: uniform(new Vector3(-3, 0, -1.5)),
        windOffset: uniform(new Vector3()),
        gust: uniform(0),
        cloudOffset: uniform(new Vector3()),
        time: uniform(0),
        presence: uniform(1),
        boltA: uniformArray(boltAValues, 'vec4'),
        boltB: uniformArray(boltBValues, 'vec4'),
      },
      flashValues,
      glowValues,
      boltAValues,
      boltBValues,
      hemi,
      points,
      sun,
      lightsNode: lights([hemi, sun, ...points]),
      director,
      active: [],
      onStrike: new Set(),
      noise3: null,
      noise2: null,
      surface: null,
      shadowSize,
      users: 0,
      lastTime: -1,
      anticipating: false,
      log: [],
    };
    store.set(ctx.ground, s);
  }
  s.users++;
  return s;
}

export function releaseStorm(ctx: EnvironmentContext, s: Storm): void {
  s.users--;
  if (s.users > 0) return;
  s.noise3?.dispose();
  s.noise2?.dispose();
  s.surface?.dispose();
  s.sun.shadow.map?.dispose();
  s.sun.dispose();
  s.hemi.dispose();
  for (const p of s.points) p.dispose();
  store.delete(ctx.ground);
}

/** Marks an object tree as a caster of the flash's shadows (and a receiver). */
export function castFlashShadows(root: Object3D, cast = true): void {
  root.traverse((o) => {
    o.layers.enable(SHADOW_LAYER);
    o.castShadow = cast;
    o.receiveShadow = true;
  });
}

/** Comfort and intensity from the player's settings (see StormComfort in director.ts). */
function comfortOf(ctx: EnvironmentContext): { mode: 'full' | 'calm' | 'off'; flashReduced: boolean; intensity: number; flash: number } {
  const events = ctx.uniforms.worldEvents.value;
  const mode = events < 0.25 ? 'off' : events < 0.75 || ctx.quality.reducedMotion ? 'calm' : 'full';
  const flashReduced = ctx.uniforms.flashLimit.value < 0.99;
  const intensity = Math.max(0.3, Math.min(2, ctx.uniforms.weatherIntensity?.value ?? 1));
  // Peak illumination: flash reduction, the screen-effects setting (0 in VR, where flashes fill the
  // view) and the calmer comfort modes all hold the big flashes back.
  const flash = ctx.uniforms.flashLimit.value * (0.6 + 0.4 * ctx.uniforms.screenEffects.value) * (mode === 'off' ? 0.5 : mode === 'calm' ? 0.75 : 1);
  return { mode, flashReduced, intensity, flash };
}

/** The stepped leader comes down this long (s) before the first return stroke lights the channel. */
export const LEADER = 0.06;

/** Peak brightness of each level (before energy and comfort). */
const LEVEL_PEAK = { 1: 0.32, 2: 0.55, 3: 0.95, 4: 1.25 } as const;

const _v = new Vector3();
const _c = new Vector3();

function placeStrike(strike: Strike, time: number, comfort: ReturnType<typeof comfortOf>): ActiveStrike {
  const rand = makeRng(strike.seed ^ 0x51ed270b);
  const g = pointAt(strike.azimuth, strike.distance);
  const groundY = terrainHeight(g.x, g.z);
  const base = CLOUD_BASE - 20 + rand() * 50;
  let top: Vector3;
  let bottom: Vector3;
  let light: Vector3;
  let glow: Vector3;
  if (strike.kind === 'cloudToGround') {
    // The channel leaves the cloud somewhat off to one side of where it strikes.
    const lean = pointAt(strike.azimuth + (rand() - 0.5) * 12, strike.distance * (0.85 + rand() * 0.3));
    top = new Vector3(lean.x, base, lean.z);
    bottom = new Vector3(g.x, groundY, g.z);
    light = bottom.clone().lerp(top, 0.3);
    glow = top.clone().setY(base + 160 + rand() * 120);
  } else if (strike.kind === 'cloudToCloud') {
    const far = pointAt(strike.azimuth + (rand() < 0.5 ? -1 : 1) * (10 + rand() * 18), strike.distance * (0.8 + rand() * 0.5));
    top = new Vector3(g.x, base - 30 - rand() * 50, g.z);
    bottom = new Vector3(far.x, base - 20 - rand() * 60, far.z);
    light = top.clone().lerp(bottom, 0.5);
    glow = light.clone().setY(base + 220);
  } else {
    top = new Vector3(g.x, base + 300, g.z);
    bottom = top.clone();
    light = top.clone().setY(base + 250);
    glow = top.clone().setY(base + 260 + rand() * 250);
  }
  const peak = Math.pow(strike.energy, 1.3) * LEVEL_PEAK[strike.level] * comfort.flash;
  const reduced = comfort.flashReduced;
  return { strike, start: time + (comfort.flashReduced ? 0 : LEADER), top, bottom, light, glow, glowRadius: 260 + strike.energy * 420 + (strike.kind === 'intracloud' ? 200 : 0), peak, duration: strikeDuration(strike.strokes, reduced), reduced, slot: -1, level: 0 };
}

/**
 * Advances the shared storm once per frame (whichever component updates first): the director,
 * strikes starting and ending, the flash lights, the wind and the weather sounds.
 */
export function tickStorm(s: Storm, ctx: EnvironmentContext, frame: EnvFrame): void {
  if (s.lastTime === frame.time) return;
  const dt = s.lastTime < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, frame.time - s.lastTime));
  s.lastTime = frame.time;
  const comfort = comfortOf(ctx);
  const d = s.director;
  d.comfort.mode = comfort.mode;
  d.comfort.flashReduced = comfort.flashReduced;
  d.comfort.intensity = comfort.intensity;
  const u = s.u;
  u.presence.value = frame.presence;
  const slow = ctx.quality.reducedMotion ? 0.5 : 1;
  u.time.value += dt * slow;
  const shown = frame.presence > 0.5;
  for (const strike of d.update(dt, { section: frame.audio.sectionIntensity, progress: frame.game.progress })) {
    const a = placeStrike(strike, frame.time, comfort);
    s.active.push(a);
    s.onStrike.forEach((l) => l(a));
    // The same event data times and places its sound: the crack with the flash for a nearby
    // strike, the thunder after the delay its apparent distance gives.
    // The flash comes after the leader; crack and thunder are timed from that moment.
    const lead = a.start - frame.time;
    const delay = thunderDelay(strike.distance) + lead;
    const apparent = apparentDistance(strike.distance);
    const crack = strike.level === 4 || (strike.level === 3 && strike.distance < 700 && strike.kind === 'cloudToGround');
    if (shown) {
      const p = strike.kind === 'cloudToGround' ? a.bottom : a.light;
      const thunder = d.levels.thunder;
      if (crack) ctx.sounds.storm?.({ kind: 'crack', x: p.x, y: p.y, z: p.z, distance: apparent, energy: strike.energy * (0.7 + 0.3 * thunder), delay: lead, tag: strike.id });
      ctx.sounds.storm?.({
        kind: 'thunder',
        x: p.x,
        y: p.y,
        z: p.z,
        distance: apparent,
        energy: Math.min(1, strike.energy * (0.55 + 0.45 * thunder)),
        delay,
        seed: strike.seed,
        strokes: strike.strokes,
        channel: strike.kind === 'cloudToGround' ? 'ground' : 'cloud',
        tag: strike.id,
      });
    }
    s.log.push({ id: strike.id, level: strike.level, kind: strike.kind, distance: strike.distance, apparent, delay, perf: performance.now(), frameTime: frame.time, crack: crack && shown });
    if (s.log.length > 64) s.log.shift();
  }
  // Current brightness of every strike; the brightest three drive the lights.
  let sky = 0;
  for (let i = s.active.length - 1; i >= 0; i--) {
    const a = s.active[i]!;
    const t = frame.time - a.start;
    if (t > a.duration) {
      s.active.splice(i, 1);
      continue;
    }
    a.level = a.peak * flashEnvelope(a.strike.strokes, t, a.reduced) * frame.presence;
    // The lit cloud deck lights everything from above: a lot for a near strike, little far away.
    sky += a.level * (a.strike.kind === 'intracloud' ? 0.22 : 0.38) / (1 + a.light.distanceTo(_c.set(EYE.x, EYE.y, EYE.z)) / 1400);
  }
  const ranked = [...s.active].sort((p, q) => q.level - p.level);
  for (let i = 0; i < MAX_FLASH; i++) {
    const a = ranked[i];
    const fv = s.flashValues[i]!;
    const gv = s.glowValues[i]!;
    const light = s.points[i]!;
    const ba = s.boltAValues[i]!;
    const bb = s.boltBValues[i]!;
    if (a && a.level > 0.0005 && a.strike.kind !== 'intracloud') {
      ba.set(a.bottom.x, a.bottom.y, a.bottom.z, a.level);
      bb.set(a.top.x, a.top.y, a.top.z, 6 + a.strike.energy * 10);
    } else ba.w = 0;
    if (a && a.level > 0.0005) {
      fv.set(a.light.x, a.light.y, a.light.z, a.level);
      gv.set(a.glow.x, a.glow.y, a.glow.z, a.glowRadius);
      light.position.copy(a.light);
      light.intensity = a.level * FLASH_POWER;
    } else {
      fv.w = 0;
      light.intensity = 0;
    }
    light.updateMatrixWorld();
  }
  u.skyFlash.value = sky;
  s.hemi.color.setRGB(AMBIENT_SKY[0] + FLASH_COLOR[0] * sky * 0.5, AMBIENT_SKY[1] + FLASH_COLOR[1] * sky * 0.5, AMBIENT_SKY[2] + FLASH_COLOR[2] * sky * 0.5);
  s.hemi.groundColor.setRGB(AMBIENT_GROUND[0] + sky * 0.02, AMBIENT_GROUND[1] + sky * 0.022, AMBIENT_GROUND[2] + sky * 0.026);
  // The shadow light points at the strongest flash; its shadows fall across the ledge.
  const top = ranked[0];
  const sun = s.sun;
  if (top && top.level > 0.001) {
    _v.copy(top.light).sub(_c.set(EYE.x, -2, EYE.z - 40)).normalize();
    if (_v.y < 0.12) _v.y = 0.12;
    _v.normalize();
    sun.intensity = (top.level * 0.9) / (1 + top.light.distanceTo(_c.set(EYE.x, EYE.y, EYE.z)) / 600);
  } else {
    _v.set(0.3, 0.8, -0.5).normalize();
    sun.intensity = 0;
  }
  const centre = _c.set(EYE.x, -2, EYE.z - 40);
  sun.target.position.copy(centre);
  sun.position.copy(centre).addScaledVector(_v, 300);
  const cam = sun.shadow.camera;
  cam.left = -150;
  cam.right = 150;
  cam.top = 150;
  cam.bottom = -150;
  cam.near = 20;
  cam.far = 700;
  cam.updateProjectionMatrix();
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
  s.hemi.updateMatrixWorld(true);

  // The last bars before a drop: the storm starts to gather towards its intense core (the director
  // still decides when, by its own rules).
  const audio = frame.audio;
  if (audio.nextEvent === 'drop' && audio.anticipation > 0.55) {
    if (!s.anticipating) d.followSection('drop');
    s.anticipating = true;
  } else s.anticipating = false;

  // Wind: a westerly pushing the rain across the view, swinging and strengthening in gusts. A clear
  // sends a gust of its own out with its front (scaled like every clear-wave motion: less under
  // reduced motion and calm world events, none with world events off).
  const L = d.levels;
  const clearGust = Math.min(1, frame.game.clearWave) * 0.5 * ctx.uniforms.waveMotion.value;
  const gust = Math.max(L.gust, clearGust);
  const strength = 2.5 + L.wind * 7 + gust * 6;
  const swing = Math.sin(u.time.value * 0.05) * 0.35 + Math.sin(u.time.value * 0.013 + 1.7) * 0.25;
  u.wind.value.set(-Math.cos(swing) * strength, 0, -Math.sin(swing) * strength * 0.6 - 1);
  u.windOffset.value.addScaledVector(u.wind.value, dt * slow);
  u.cloudOffset.value.x += (-6 - L.cloudSpeed * 9) * dt * slow;
  u.cloudOffset.value.z += (-2 - L.cloudSpeed * 3) * dt * slow;
  u.gust.value = gust;
  u.rain.value = L.rain * Math.max(0.35, Math.min(1.5, 0.6 + 0.4 * comfort.intensity));
  if (frame.presence > 0.02) {
    ctx.sounds.weather?.({ rain: u.rain.value * frame.presence, wind: (L.wind * 0.85 + 0.15) * frame.presence, gust: gust * frame.presence, surfaces: { water: 0.7, rock: 0.55, wood: 0.15, foliage: 0.5 } });
  }
}

// ------------------------------------------------------------------------------------------ noise

/** Deterministic mulberry32. */
export const rng = makeRng;

/**
 * A tiling 3D noise volume (N³ RGBA8) for the clouds: R a billowy fBm, G a finer fBm, B a cellular
 * (billow) noise, A a high-frequency detail.
 */
export function noiseVolume(s: Storm, N = 64): Data3DTexture {
  if (s.noise3) return s.noise3;
  const data = new Uint8Array(N * N * N * 4);
  const rnd = rng(91);
  const acc = new Float32Array(N * N * N);
  const fbmChannel = (c: number, periods: number[]) => {
    acc.fill(0);
    let amp = 1;
    let total = 0;
    for (const P of periods) {
      const lat = new Float32Array(P * P * P);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      const cell = N / P;
      for (let z = 0; z < N; z++) {
        const fz = z / cell;
        const z0 = Math.floor(fz);
        let tz = fz - z0;
        tz = tz * tz * (3 - 2 * tz);
        const za = (z0 % P) * P * P;
        const zb = ((z0 + 1) % P) * P * P;
        for (let y = 0; y < N; y++) {
          const fy = y / cell;
          const y0 = Math.floor(fy);
          let ty = fy - y0;
          ty = ty * ty * (3 - 2 * ty);
          const ya = (y0 % P) * P;
          const yb = ((y0 + 1) % P) * P;
          for (let x = 0; x < N; x++) {
            const fx = x / cell;
            const x0 = Math.floor(fx);
            let tx = fx - x0;
            tx = tx * tx * (3 - 2 * tx);
            const xa = x0 % P;
            const xb = (x0 + 1) % P;
            const c00 = lat[za + ya + xa]! + (lat[za + ya + xb]! - lat[za + ya + xa]!) * tx;
            const c10 = lat[za + yb + xa]! + (lat[za + yb + xb]! - lat[za + yb + xa]!) * tx;
            const c01 = lat[zb + ya + xa]! + (lat[zb + ya + xb]! - lat[zb + ya + xa]!) * tx;
            const c11 = lat[zb + yb + xa]! + (lat[zb + yb + xb]! - lat[zb + yb + xa]!) * tx;
            const a = c00 + (c10 - c00) * ty;
            const b = c01 + (c11 - c01) * ty;
            acc[(z * N + y) * N + x]! += (a + (b - a) * tz) * amp;
          }
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < acc.length; i++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((acc[i]! / total - 0.5) * 1.7 + 0.5) * 255)));
  };
  fbmChannel(0, [4, 8, 16]);
  fbmChannel(1, [8, 16, 32]);
  fbmChannel(3, [16, 32, 64]);
  // Billows: inverted distance to scattered points (tiling cellular noise).
  const P = 5;
  const pts: number[] = [];
  for (let i = 0; i < P * P * P; i++) pts.push(rnd(), rnd(), rnd());
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const px = (x / N) * P;
        const py = (y / N) * P;
        const pz = (z / N) * P;
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        const cz = Math.floor(pz);
        let best = 9;
        for (let k = -1; k <= 1; k++) {
          for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) {
              const gx = (cx + i + P) % P;
              const gy = (cy + j + P) % P;
              const gz = (cz + k + P) % P;
              const o = (gz * P * P + gy * P + gx) * 3;
              const qx = cx + i + pts[o]!;
              const qy = cy + j + pts[o + 1]!;
              const qz = cz + k + pts[o + 2]!;
              const dd = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
              if (dd < best) best = dd;
            }
          }
        }
        data[((z * N + y) * N + x) * 4 + 2] = Math.round(Math.max(0, 1 - Math.sqrt(best) * 1.05) * 255);
      }
    }
  }
  const tex = new Data3DTexture(data, N, N, N);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  s.noise3 = tex;
  return tex;
}

/** A tiling 2D value-noise fBm (256², single channel) for surface detail. */
export function noisePlane(s: Storm, N = 256): DataTexture {
  if (s.noise2) return s.noise2;
  const data = new Uint8Array(N * N);
  const rnd = rng(37);
  const acc = new Float32Array(N * N);
  let amp = 1;
  let total = 0;
  for (const P of [8, 16, 32, 64]) {
    const lat = Array.from({ length: P * P }, rnd);
    const cell = N / P;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x / cell;
        const fy = y / cell;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = (fx - x0) * (fx - x0) * (3 - 2 * (fx - x0));
        const ty = (fy - y0) * (fy - y0) * (3 - 2 * (fy - y0));
        const at = (i: number, j: number) => lat[(j % P) * P + (i % P)]!;
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        acc[y * N + x]! += (a + (b - a) * ty) * amp;
      }
    }
    total += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < acc.length; i++) data[i] = Math.round((acc[i]! / total) * 255);
  const tex = new DataTexture(data, N, N, RedFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  s.noise2 = tex;
  return tex;
}

/**
 * The ledge's surface map around the viewer (half floats): R puddle water, G the stream, B rock,
 * A the ground height. Ground shading, splashes and drips read it.
 */
export function surfaceMap(s: Storm): DataTexture {
  if (s.surface) return s.surface;
  const n = SURFACE.res;
  const data = new Uint16Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = SURFACE.x0 + ((i + 0.5) / n) * SURFACE.size;
      const zz = SURFACE.z0 + ((j + 0.5) / n) * SURFACE.size;
      const o = (j * n + i) * 4;
      const ledge = ledgeMask(x, zz);
      data[o] = DataUtils.toHalfFloat(puddle(x, zz));
      data[o + 1] = DataUtils.toHalfFloat(streamMask(x, zz));
      data[o + 2] = DataUtils.toHalfFloat(rockiness(x, zz) * ledge);
      data[o + 3] = DataUtils.toHalfFloat(terrainHeight(x, zz));
    }
  }
  const tex = new DataTexture(data, n, n, RGBAFormat, HalfFloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  s.surface = tex;
  return tex;
}

/** UV of a world xz position in the surface map. */
export function surfaceUV(xz: V2): V2 {
  return cast<V2>(xz.sub(vec2(SURFACE.x0, SURFACE.z0)).div(SURFACE.size));
}

// --------------------------------------------------------------------------------------- lighting

/** A standard material lit only by the storm's own lights, never by the scene's environment map. */
export class StormMaterial extends MeshStandardNodeMaterial {
  override setupEnvironment(): null {
    return null;
  }
}

/** Cheap hash of a vec2 into 0..1. */
export function hash2(p: V2): F {
  return cast<F>(fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
}

/**
 * The stormy sky's radiance in a direction (for reflections, haze and the dome's backdrop): almost
 * black overhead, a little lighter towards the horizon, the faint last light of a break in the storm
 * low to the right, and the cloud deck glowing from within around each flash.
 */
export function skyRadiance(s: Storm, dir: V3, blur: F | number = 0): V3 {
  const blurN = cast<F>(typeof blur === 'number' ? float(blur) : blur);
  const el = cast<F>(dir.y);
  const zenith = vec3(0.008, 0.0095, 0.013);
  const horizon = vec3(0.028, 0.033, 0.042);
  let col = cast<V3>(mix(horizon, zenith, smoothstep(0.0, 0.32, el)));
  // The break in the storm: a long, low band of slightly brighter sky.
  const az = (GLOW_AZIMUTH * Math.PI) / 180;
  const toward = cast<F>(max(dot(normalize(vec3(dir.x, 0, dir.z)), vec3(Math.sin(az), 0, -Math.cos(az))), 0));
  col = cast<V3>(col.add(vec3(...GLOW_COLOR).mul(pow(toward, 4)).mul(exp(el.abs().mul(-10)))));
  // A second, fainter break far to the left.
  const az2 = (-52 * Math.PI) / 180;
  const toward2 = cast<F>(max(dot(normalize(vec3(dir.x, 0, dir.z)), vec3(Math.sin(az2), 0, -Math.cos(az2))), 0));
  col = cast<V3>(col.add(vec3(...GLOW_COLOR).mul(pow(toward2, 6).mul(0.45)).mul(exp(el.abs().mul(-12)))));
  // Below the horizon: the dark land (reflections of the ground).
  col = cast<V3>(mix(col, vec3(0.004, 0.0045, 0.005), smoothstep(0.0, -0.08, el)));
  // Flashes: the cloud lit from within around each glow centre, wide and soft.
  const spread = blurN.mul(0.6).add(1);
  for (let i = 0; i < MAX_FLASH; i++) {
    const fp = cast<V4>(s.u.flashPos.element(int(i)));
    const gp = cast<V4>(s.u.flashGlow.element(int(i)));
    const to = gp.xyz.sub(cameraPosition);
    const dist = length(to);
    const c = dot(dir, to.div(dist));
    const width = gp.w.div(dist).mul(spread).max(0.02);
    const lobe = exp(float(1).sub(c).div(width.mul(width)).negate().mul(1.4));
    const halo = exp(float(1).sub(c).mul(-6).div(spread));
    const above = smoothstep(-0.05, 0.08, el);
    col = cast<V3>(col.add(vec3(...FLASH_COLOR).mul(fp.w.max(0).pow(0.75).mul(lobe.mul(0.8).add(halo.mul(0.03))).mul(above))));
  }
  return col;
}

/** Atmospheric depth: extinction per metre (rain haze) and the haze's colour. */
export const HAZE_DENSITY = 1 / 1250;

/**
 * Haze between the camera and a surface: the colour fades towards the storm air with distance, and
 * during a flash the air itself lights up, brightest towards the flash (rain scatters forwards).
 */
export function haze(s: Storm, color: V3, position: V3, density: number = HAZE_DENSITY): V3 {
  const toP = position.sub(cameraPosition);
  const dist = length(toP);
  const dir = cast<V3>(toP.div(max(dist, 0.001)));
  const amount = float(1).sub(exp(dist.mul(density).negate()));
  // The air itself is darker than the horizon sky behind it: far land stands in silhouette.
  let air = cast<V3>(vec3(0.0125, 0.0148, 0.019));
  for (let i = 0; i < MAX_FLASH; i++) {
    const fp = cast<V4>(s.u.flashPos.element(int(i)));
    const toF = fp.xyz.sub(cameraPosition);
    const fd = length(toF);
    // Rain scatters forwards: the air glows towards the flash, and more the nearer the flash is.
    const forward = pow(max(dot(dir, toF.div(fd)), 0), 6).mul(0.9).add(0.06);
    air = cast<V3>(air.add(vec3(...FLASH_COLOR).mul(fp.w.mul(forward).mul(0.12).div(fd.div(700).add(1)))));
  }
  return cast<V3>(mix(color, air, amount));
}

/**
 * Rain ripples on still water: rings spreading from drops landing at random in a grid of cells,
 * at three scales; returns the surface slope (dh/dx, dh/dz) to tilt the water's normal.
 */
export function ripples(s: Storm, xz: V2, rate: F | number = 1): V2 {
  const rateN = cast<F>(typeof rate === 'number' ? float(rate) : rate);
  let slope = cast<V2>(vec2(0, 0));
  const t = s.u.time;
  const layers: [number, number, number][] = [
    [0.55, 1.3, 0],
    [0.37, 1.7, 0.31],
    [0.83, 1.05, 0.67],
  ];
  for (const [size, speed, off] of layers) {
    const p = xz.div(size).add(off * 7.3);
    const cell = floor(p);
    const h = hash2(cell);
    const h2 = hash2(cell.add(19.7));
    const centre = cell.add(vec2(h, h2).mul(0.6).add(0.2));
    const d = p.sub(centre);
    const r = length(d).max(1e-4);
    const phase = fract(t.mul(speed).add(h.mul(13.1)));
    const radius = phase.mul(0.55);
    const x = r.sub(radius);
    const env = exp(x.mul(x).mul(-160)).mul(float(1).sub(phase).pow(2));
    // Each cell only drops when the rain is heavy enough.
    const active = smoothstep(rateN.oneMinus().mul(0.9), rateN.oneMinus().mul(0.9).add(0.15), h2);
    const dh = env.mul(sin(x.mul(70)).mul(-70).add(x.mul(-320).mul(cos(x.mul(70))))).mul(0.0045).mul(active);
    slope = cast<V2>(slope.add(d.div(r).mul(dh).div(size)));
  }
  return slope;
}

/**
 * Lightning seen in a reflection: how close the reflected ray from `p` along `r` passes to each
 * flash's main channel (a line from its strike point up to the cloud), as a glow that widens on
 * rougher surfaces. Returns the reflected radiance.
 */
export function boltReflection(s: Storm, p: V3, r: V3, rough: F | number): V3 {
  const roughN = cast<F>(typeof rough === 'number' ? float(rough) : rough);
  let sum: V3 = cast<V3>(vec3(0, 0, 0));
  for (let i = 0; i < MAX_FLASH; i++) {
    const A = cast<V4>(s.u.boltA.element(int(i)));
    const B = cast<V4>(s.u.boltB.element(int(i)));
    const seg = B.xyz.sub(A.xyz);
    const w0 = p.sub(A.xyz);
    const a = dot(r, r);
    const b = dot(r, seg);
    const c = dot(seg, seg);
    const d = dot(r, w0);
    const e = dot(seg, w0);
    const den = a.mul(c).sub(b.mul(b)).max(1e-6);
    const t = b.mul(e).sub(c.mul(d)).div(den).max(0);
    const u = clamp(a.mul(e).sub(b.mul(d)).div(den), 0, 1);
    const gap = length(p.add(r.mul(t)).sub(A.xyz.add(seg.mul(u))));
    const width = B.w.add(t.mul(roughN.mul(0.35).add(0.004)));
    const glow = exp(gap.div(width).pow(2).negate()).mul(2.2).add(exp(gap.div(width.mul(6)).negate()).mul(0.25));
    sum = cast<V3>(sum.add(vec3(...FLASH_COLOR).mul(glow.mul(A.w))));
  }
  return sum;
}

/** Clamps a value node to 0..1 (short helper). */
export const sat = (x: F): F => cast<F>(clamp(x, 0, 1));
