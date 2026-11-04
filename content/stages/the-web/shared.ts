import { Color, DirectionalLight, HemisphereLight, MeshStandardNodeMaterial, Vector3, Vector4, type Material, type MeshStandardMaterial, type Node, type Object3D, type Texture } from 'three/webgpu';
import { cameraPosition, exp, float, length, lights, mix, mx_noise_float, normalize, output, positionWorld, pow, smoothstep, step, uniform, uniformArray, vec3, vec4 } from 'three/tsl';
import { floatUniform, type EnvironmentContext, type GroundField } from '@prismfall/sdk';

export type F = Node<'float'>;
export type V2 = Node<'vec2'>;
export type V3 = Node<'vec3'>;
export type V4 = Node<'vec4'>;

/** The ruined nave's floor (the board's bottom row sits at y = -10). */
export const FLOOR = -12.5;
/** Where the desktop camera looks from (it orbits the board at the origin from +z). */
export const EYE = new Vector3(0, 0.5, 30);
/** Moon: high behind the ruins, slightly left, so webs and spiders are back-lit. */
export const MOON_DIR = new Vector3(-0.45, 0.75, -0.5).normalize();
/** Layer for the world's own shadow casters (the board never shades the ruins). */
export const SHADOW_LAYER = 6;
/** Web impulses kept for the silk's vibration (spider steps, landings, the music's low end). */
export const MAX_IMPULSES = 12;

export type Comfort = 'full' | 'calm' | 'off';

/** Comfort from the Accessibility settings: World events (1 full, 0.5 calm, 0 off) and reduced motion. */
export function comfortOf(ctx: EnvironmentContext): Comfort {
  const events = (ctx.uniforms.worldEvents as unknown as { value: number }).value;
  if (events < 0.25) return 'off';
  if (events < 0.75 || ctx.quality.reducedMotion) return 'calm';
  return 'full';
}

export interface WebWorld {
  readonly ctx: EnvironmentContext;
  users: number;
  readonly moon: DirectionalLight;
  readonly hemi: HemisphereLight;
  /** World-only lights (never the board's): the moon with its shadow map, and the fog-glow fill. */
  readonly lightsNode: ReturnType<typeof lights>;
  readonly u: {
    fogColor: ReturnType<typeof uniform>;
    moonGlow: ReturnType<typeof uniform>;
    green: ReturnType<typeof uniform>;
    fogDensity: ReturnType<typeof floatUniform>;
    /** Extra fog thickness near the floor (per metre), thinning with height over ~18 m. */
    groundFog: ReturnType<typeof floatUniform>;
    /** Smoothed music features (0..1) for subtle reactivity. */
    bass: ReturnType<typeof floatUniform>;
    mid: ReturnType<typeof floatUniform>;
    treble: ReturnType<typeof floatUniform>;
    section: ReturnType<typeof floatUniform>;
    /** Brief silver light from a line clear, carried through the fog. */
    clear: ReturnType<typeof floatUniform>;
    time: ReturnType<typeof floatUniform>;
  };
  /** Web impulses: xyz + start time; w of the paired array is the strength. */
  readonly impulsePos: Vector4[];
  readonly impulseAmp: Vector4[];
  readonly impulsePosNode: ReturnType<typeof uniformArray>;
  readonly impulseAmpNode: ReturnType<typeof uniformArray>;
  nextImpulse: number;
  time: number;
  lastTick: number;
  readonly shadowSize: number;
}

const store = new WeakMap<GroundField, WebWorld>();

export function world(ctx: EnvironmentContext): WebWorld {
  let w = store.get(ctx.ground);
  if (!w) {
    const detail = ctx.quality.detail;
    const shadowSize = detail === 'low' ? 0 : detail === 'medium' ? 2048 : 4096;
    const moon = new DirectionalLight(new Color('#aebfd8'), 2.9);
    moon.position.copy(MOON_DIR).multiplyScalar(260);
    moon.target.position.set(0, FLOOR, -40);
    moon.castShadow = shadowSize > 0;
    if (shadowSize > 0) {
      moon.shadow.mapSize.set(shadowSize, shadowSize);
      const c = moon.shadow.camera;
      c.left = -170;
      c.right = 170;
      c.top = 150;
      c.bottom = -150;
      c.near = 20;
      c.far = 620;
      moon.shadow.bias = -0.0006;
      moon.shadow.normalBias = 0.08;
      moon.shadow.radius = 3;
      c.layers.set(SHADOW_LAYER);
    }
    moon.updateMatrixWorld(true);
    moon.target.updateMatrixWorld(true);
    // A cold sky above and a faint green-grey fog glow below: never uniformly black.
    const hemi = new HemisphereLight(new Color('#4a5a70'), new Color('#1a2420'), 1.7);
    // Lights outside the scene graph never get their matrices updated: do it once (the hemisphere's
    // direction comes from its world position).
    hemi.position.set(0, 1, 0);
    hemi.updateMatrixWorld(true);
    // A faint cold fill from the viewer's side: stone texture reads in the dark without going grey.
    const fill = new DirectionalLight(new Color('#6a7a94'), 0.7);
    fill.position.set(25, 40, 120);
    fill.target.position.set(0, FLOOR, -60);
    fill.updateMatrixWorld(true);
    fill.target.updateMatrixWorld(true);
    const impulsePos = Array.from({ length: MAX_IMPULSES }, () => new Vector4(0, -1000, 0, -100));
    const impulseAmp = Array.from({ length: MAX_IMPULSES }, () => new Vector4(0, 0, 0, 0));
    w = {
      ctx,
      users: 0,
      moon,
      hemi,
      lightsNode: lights([moon, hemi, fill]),
      u: {
        fogColor: uniform(new Vector3(0.01, 0.013, 0.017)),
        moonGlow: uniform(new Vector3(0.12, 0.14, 0.18)),
        green: uniform(new Vector3(0.006, 0.013, 0.009)),
        fogDensity: floatUniform(0.0024),
        groundFog: floatUniform(0.009),
        bass: floatUniform(0),
        mid: floatUniform(0),
        treble: floatUniform(0),
        section: floatUniform(0),
        clear: floatUniform(0),
        time: floatUniform(0),
      },
      impulsePos,
      impulseAmp,
      impulsePosNode: uniformArray(impulsePos, 'vec4'),
      impulseAmpNode: uniformArray(impulseAmp, 'vec4'),
      nextImpulse: 0,
      time: 0,
      lastTick: -1,
      shadowSize,
    };
    store.set(ctx.ground, w);
  }
  w.users++;
  return w;
}

export function release(w: WebWorld): void {
  w.users--;
  if (w.users > 0) return;
  w.moon.shadow.map?.dispose();
  w.moon.dispose();
  w.hemi.dispose();
  store.delete(w.ctx.ground);
}

/** Once per frame (whichever component updates first): clock and smoothed music features. */
export function tick(w: WebWorld, time: number, dt: number, audio: { bass: number; mid: number; treble: number; sectionIntensity: number }): void {
  if (w.lastTick === time) return;
  w.lastTick = time;
  w.time = time;
  w.u.time.value = time;
  const k = Math.min(1, dt * 4);
  w.u.bass.value += (audio.bass - w.u.bass.value) * k;
  w.u.mid.value += (audio.mid - w.u.mid.value) * k;
  w.u.treble.value += (audio.treble - w.u.treble.value) * Math.min(1, dt * 8);
  w.u.section.value += (audio.sectionIntensity - w.u.section.value) * Math.min(1, dt * 0.5);
  w.u.clear.value = Math.max(0, w.u.clear.value - dt * 0.9);
}

/** Excites the webs near a point (a spider's step, a landing); strength ~0.05 (tiny) .. 1 (heavy). */
export function pluck(w: WebWorld, x: number, y: number, z: number, strength: number): void {
  const i = w.nextImpulse;
  w.nextImpulse = (w.nextImpulse + 1) % MAX_IMPULSES;
  w.impulsePos[i]!.set(x, y, z, w.time);
  w.impulseAmp[i]!.set(strength, 0, 0, 0);
}

/** Optical depth of the fog between the camera and a world point: a thin volume plus ground fog. */
export function fogDepth(w: WebWorld, p: V3): F {
  const toP = p.sub(cameraPosition);
  const L = length(toP);
  const yc = cameraPosition.y.sub(FLOOR).max(0);
  const yp = p.y.sub(FLOOR).max(0);
  const H = 18;
  const ec = exp(yc.div(-H));
  const ep = exp(yp.div(-H));
  const dy = yp.sub(yc);
  const avg = mix(ep, ec.sub(ep).mul(H).div(dy.abs().max(0.05)).mul(dy.sign()), step(0.05, dy.abs()));
  // Slow drifting banks: the fog is never an even wash.
  const bank = mx_noise_float(p.mul(0.012).add(vec3(w.u.time.mul(0.012), 0, w.u.time.mul(0.006)))).mul(0.45).add(0.8);
  return L.mul(w.u.fogDensity.add(avg.max(0).mul(w.u.groundFog).mul(bank))) as F;
}

/** Fog colour seen along a direction: dark blue-grey, brighter towards the moon, greener low down. */
export function fogTint(w: WebWorld, dir: V3): V3 {
  const toward = dir.dot(vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).max(0);
  const scatter = pow(toward, float(6)).mul(0.9).add(pow(toward, float(2)).mul(0.25));
  const low = smoothstep(0.25, -0.15, dir.y);
  const base = mix(w.u.fogColor as unknown as V3, (w.u.green as unknown as V3).add(w.u.fogColor as unknown as V3), low.mul(0.8));
  return base.add((w.u.moonGlow as unknown as V3).mul(scatter)).add(vec3(0.05, 0.055, 0.07).mul(w.u.clear)) as V3;
}

/** Applies the world's fog to a shaded colour at a world point. */
export function fogged(w: WebWorld, color: V3, p: V3 = positionWorld as unknown as V3, extra: F = float(1) as F): V3 {
  const tau = fogDepth(w, p).mul(extra);
  const dir = normalize(p.sub(cameraPosition)) as V3;
  return mix(fogTint(w, dir), color, exp(tau.negate())) as V3;
}

/** The world appears outward from the viewer during crossfades (opaque parts use alphaTest 0.5). */
export function revealMask(presence: F, reach = 900): F {
  const dist = length(positionWorld.sub(cameraPosition));
  const edge = mx_noise_float(positionWorld.mul(0.05)).mul(0.08);
  const front = smoothstep(0, 1, presence).mul(1.12);
  return step(dist.div(reach).add(edge).add(float(0.02)), front) as F;
}

export interface LitOptions {
  presence: F;
  /** Albedo multiplier (linear). */
  tint?: [number, number, number];
  roughness?: number;
  metalness?: number;
  /** Extra fog (1 = the world's). */
  fog?: number;
  /** Self-light (linear rgb) added before fog. */
  glow?: V3;
  doubleSided?: boolean;
  /** Keep the source's alpha test / transparency (cobwebs). */
  alphaTest?: number;
}

/**
 * A world material from a loaded glTF material: its maps, lit by the moon (with shadows) and the fog
 * glow, fogged, and revealed with the world. Skinned meshes skin as usual (no position override).
 */
export function litMaterial(w: WebWorld, src: Material | null | undefined, o: LitOptions): MeshStandardNodeMaterial {
  const s = (src ?? {}) as Partial<MeshStandardMaterial>;
  const m = new MeshStandardNodeMaterial();
  m.lightsNode = w.lightsNode;
  if (s.map) m.map = s.map;
  if (s.normalMap) {
    m.normalMap = s.normalMap;
    if (s.normalScale) m.normalScale.copy(s.normalScale);
  }
  if (s.roughnessMap) m.roughnessMap = s.roughnessMap;
  if (s.metalnessMap) m.metalnessMap = s.metalnessMap;
  // Occlusion maps would need a second UV set the optimised models no longer carry.
  m.color.copy(s.color ?? new Color(1, 1, 1));
  if (o.tint) m.color.multiply(new Color(...o.tint));
  m.roughness = o.roughness ?? s.roughness ?? 0.85;
  m.metalness = o.metalness ?? s.metalness ?? 0;
  if (o.doubleSided) m.side = 2;
  if (o.glow) m.emissiveNode = o.glow;
  m.fog = false;
  m.outputNode = vec4(fogged(w, output.rgb as unknown as V3, positionWorld as unknown as V3, float(o.fog ?? 1) as F), output.a);
  m.opacityNode = revealMask(o.presence).mul(s.map && o.alphaTest !== undefined ? (output.a as unknown as F) : float(1));
  m.alphaTest = o.alphaTest ?? 0.5;
  return m;
}

/** Marks an object tree as a moon-shadow caster (and receiver). */
export function castMoonShadows(root: Object3D, cast = true): void {
  root.traverse((o) => {
    o.layers.enable(SHADOW_LAYER);
    o.castShadow = cast;
    o.receiveShadow = true;
  });
}

/** Textures of a material (for disposal). */
export function texturesOf(m: Material): Texture[] {
  const s = m as Partial<MeshStandardMaterial>;
  return [s.map, s.normalMap, s.roughnessMap, s.metalnessMap, s.aoMap, s.emissiveMap].filter((t): t is Texture => !!t);
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * The world clear wave on the CPU (the same maths as the SDK's `clearFront()` shader helper): the
 * strength of the fronts whose leading edge crossed `distance` from the board between frame times
 * `t0` and `t1`, 0 if none. Scaled for motion (accessibility) like `clearFrontMotion()`.
 */
export function frontCrossing(ctx: EnvironmentContext, distance: number, t0: number, t1: number): number {
  const u = ctx.uniforms;
  const shape = u.waveShape.value;
  const x = Math.log(Math.max(distance, shape.x) / shape.x) * shape.y;
  let sum = 0;
  for (const slot of [u.wave0, u.wave1, u.wave2, u.wave3]) {
    const s = slot.value;
    const f0 = (t0 - s.x) * shape.z;
    const f1 = (t1 - s.x) * shape.z;
    if (f1 < 0 || f0 >= x || f1 < x || x >= s.z) continue;
    const fade = clamp01((x - s.z * 0.55) / (s.z * 0.45));
    sum += s.y * (1 - fade * fade * (3 - 2 * fade));
  }
  return Math.min(1.5, sum) * u.waveMotion.value;
}