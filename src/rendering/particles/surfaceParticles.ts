import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DataUtils,
  HalfFloatType,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  NormalBlending,
  RGBAFormat,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  Vector4,
  type Bone,
  type Node,
} from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cameraWorldMatrix,
  cos,
  dot,
  float,
  floor,
  fract,
  int,
  ivec2,
  length,
  max,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  mrt,
  mx_noise_vec3,
  normalLocal,
  positionLocal,
  sin,
  smoothstep,
  step,
  textureLoad,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, frameUniforms, type FloatUniform } from '../shaders/uniforms';
import { clearFront } from '../shaders/clearFront';
import type { SurfaceSampleSet } from './meshSampler';

export interface SurfaceParticleOptions {
  /** Particle diameter in world units. */
  readonly size: number;
  readonly brightness: number;
  /** Linear RGB tint, and how much it replaces the sampled surface colour (0 = model colours). */
  readonly tint: readonly [number, number, number];
  readonly colorMix: number;
  readonly blend: 'additive' | 'normal';
  /** Shimmer along the surface normal (world units). */
  readonly jitter: number;
  /** How far particles travel when dissolved (world units). */
  readonly spread: number;
  /** World-space drift direction while dissolved (wind). */
  readonly wind: readonly [number, number, number];
  /** Share of the brightness sent to bloom. */
  readonly bloom: number;
  /**
   * 0 = flat colour; 1 = lit by `light` through the (skinned) surface normal, so the body reads as
   * a rounded form rather than a cut-out. Unset means 0.
   */
  readonly shading?: number;
  /** World direction towards the light for `shading` (default: above, slightly towards the camera). */
  readonly light?: readonly [number, number, number];
  /** Saturation of the sampled surface colours: 1 as sampled (default), 0 grey (keeps their lightness). */
  readonly saturation?: number;
  /** Luminous moving points instead of plain surface dots (see GlowOptions); unset keeps the plain look. */
  readonly glow?: GlowOptions;
  /** Shimmer as the world clear wave passes the body (x the particles' light; 0 or unset = none). Since SDK 1.5. */
  readonly clearWave?: number;
}

/**
 * The glowing style: additive points with soft bright cores that twinkle, brighter along the
 * silhouette (fresnel) than across the body, that drift around their surface point, stream slowly
 * along the body, and partly shed into a fading wake behind a moving creature. Everything runs in
 * the vertex shader from time and a per-particle seed (stateless); distances are world units.
 */
export interface GlowOptions {
  /** Linear RGB glow colour. */
  readonly color: readonly [number, number, number];
  /** 0 = the glow colour only, 1 = the surface colours sampled from the model (lifted to glow). */
  readonly textureMix: number;
  /** Brightness of the body seen face-on, relative to its edges (0..1): lower = stronger outlines. */
  readonly core: number;
  /** How strongly edges (grazing to the view) brighten, 0..2. */
  readonly edge: number;
  /** Twinkle depth of every point (0..1). */
  readonly twinkle: number;
  /** Share of points that now and then flash brightly (0..1). */
  readonly sparkle: number;
  /** Radius of each point's slow orbit around its surface point. */
  readonly drift: number;
  /** Length of the slow stream of points along the body (against its motion; upwards when still). */
  readonly flow: number;
  /** Cycles per second of that stream. */
  readonly flowRate: number;
  /** Share of points that leave the body and trail behind as a fading wake (0..1). */
  readonly shed: number;
  /** Seconds a shed point lives. */
  readonly shedLife: number;
  /** How far a shed point wanders (curl-like noise) over its life; it also rises a little. */
  readonly shedSpread: number;
  /** Depth of the slow breathing of the glow with the bass (0..1); see uniforms.breath. */
  readonly breathe: number;
  /** How much the treble adds to the sparkle (0..1); see uniforms.sparkle. */
  readonly shimmer: number;
}

/** Defaults of the glowing style (cyan, soft body, bright edges, gentle drift and shedding). */
export const DEFAULT_GLOW: GlowOptions = {
  color: [0.35, 0.85, 1],
  textureMix: 0.2,
  core: 0.35,
  edge: 1,
  twinkle: 0.5,
  sparkle: 0.1,
  drift: 0.04,
  flow: 0.25,
  flowRate: 0.12,
  shed: 0.12,
  shedLife: 2.5,
  shedSpread: 1.2,
  breathe: 0.3,
  shimmer: 0.4,
};

export interface SurfaceParticles {
  readonly objects: Mesh[];
  readonly uniforms: {
    /** 0 = on the surface, 1 = fully scattered; each particle follows with its own delay. */
    readonly dissolve: { value: number };
    readonly brightness: { value: number };
    readonly size: { value: number };
    readonly presence: { value: number };
    /** World velocity of the creature (its wake trails against it); zero when it stands still. */
    readonly velocity: { value: Vector3 };
    /** Slow bass envelope (0..1) that breathes the glow; set by the owner each frame. */
    readonly breath: { value: number };
    /** Treble envelope (0..1) that adds sparkle. */
    readonly sparkle: { value: number };
  };
  /** Follows the source meshes' morph target influences (call once per frame after animating). */
  update(): void;
  dispose(): void;
}

const TAU = Math.PI * 2;
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];
/** Morph textures are this many texels wide (a power of two, so index maths stays exact in floats). */
export const MORPH_TEXTURE_WIDTH = 4096;
/** Morph targets blended per frame (the strongest influences); frame-sequence morphs need two. */
const MORPH_SLOTS = 4;

/** A group of sample sets drawn as one particle mesh. */
interface Part {
  readonly sets: SurfaceSampleSet[];
  /** Per set: its joint indices into the part's skeleton (null when the set keeps its own). */
  readonly remap: (Uint16Array | null)[];
  /** Per set: a transform of its points into the part's bind space (null = none). */
  readonly transform: (Matrix4 | null)[];
  readonly skeleton: Skeleton | null;
  readonly source: Mesh;
}

/** Expands each sample into a quad (4 corners sharing the sample's data), over all sets of a part. */
function quadGeometry(part: Part): BufferGeometry {
  const n = part.sets.reduce((sum, s) => sum + s.count, 0);
  const skinned = part.sets.every((s) => s.skinIndex && s.skinWeight);
  const position = new Float32Array(n * 12);
  const normal = new Float32Array(n * 12);
  const color = new Float32Array(n * 12);
  const seed = new Float32Array(n * 4);
  const index1 = new Float32Array(n * 4);
  const corner = new Float32Array(n * 8);
  const index = new Uint32Array(n * 6);
  const skinIndex = skinned ? new Uint16Array(n * 16) : null;
  const skinWeight = skinned ? new Float32Array(n * 16) : null;
  let base = 0;
  const p = new Vector3();
  const nrm = new Vector3();
  const normalMatrix = new Matrix3();
  part.sets.forEach((set, si) => {
    const remap = part.remap[si];
    const transform = part.transform[si] ?? null;
    if (transform) normalMatrix.getNormalMatrix(transform);
    for (let j = 0; j < set.count; j++) {
      const i = base + j;
      p.fromArray(set.position, j * 3);
      nrm.fromArray(set.normal, j * 3);
      if (transform) {
        p.applyMatrix4(transform);
        nrm.applyMatrix3(normalMatrix).normalize();
      }
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        p.toArray(position, v * 3);
        nrm.toArray(normal, v * 3);
        for (let c = 0; c < 3; c++) color[v * 3 + c] = set.color[j * 3 + c] as number;
        seed[v] = set.seed[j] as number;
        index1[v] = j;
        corner[v * 2] = CORNERS[k * 2] as number;
        corner[v * 2 + 1] = CORNERS[k * 2 + 1] as number;
        if (skinIndex && skinWeight && set.skinIndex && set.skinWeight) {
          for (let q = 0; q < 4; q++) {
            const joint = set.skinIndex[j * 4 + q] as number;
            skinIndex[v * 4 + q] = remap ? (remap[joint] as number) : joint;
            skinWeight[v * 4 + q] = set.skinWeight[j * 4 + q] as number;
          }
        }
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    base += set.count;
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  // Named `normal` so skinning bends it with the body (the shading and shimmer follow the pose).
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('pcolor', new BufferAttribute(color, 3));
  g.setAttribute('pseed', new BufferAttribute(seed, 1));
  g.setAttribute('pindex', new BufferAttribute(index1, 1));
  g.setAttribute('corner', new BufferAttribute(corner, 2));
  if (skinIndex && skinWeight) {
    g.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  }
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/** Matrices equal within a tolerance relative to their largest entry. */
const near = (a: Matrix4, b: Matrix4): boolean => {
  const scale = Math.max(1e-12, ...a.elements.map(Math.abs), ...b.elements.map(Math.abs));
  return a.elements.every((x, i) => Math.abs(x - (b.elements[i] as number)) <= 1e-5 * scale);
};

/**
 * Groups sample sets into as few particle meshes as possible. Skinned sets whose meshes share a
 * transform and bind matrix become one mesh on a merged skeleton (the union of their joints). Their
 * inverse bind matrices may differ by one common matrix M (quantised exports fold each mesh's
 * dequantisation into them): the set's points are then moved by M into the part's bind space,
 * which skins them identically. Static and morphing sets stay one mesh each.
 */
export function groupSets(sets: readonly SurfaceSampleSet[]): Part[] {
  const parts: { sets: SurfaceSampleSet[]; remap: (Uint16Array | null)[]; transform: (Matrix4 | null)[]; bones: Bone[]; inverses: Matrix4[]; source: SkinnedMesh }[] = [];
  const single: Part[] = [];
  const identity = new Matrix4();
  for (const set of sets) {
    const mesh = set.mesh;
    if (!(mesh instanceof SkinnedMesh) || !set.skinIndex || set.morph) {
      single.push({ sets: [set], remap: [null], transform: [null], skeleton: mesh instanceof SkinnedMesh && set.skinIndex ? mesh.skeleton : null, source: mesh });
      continue;
    }
    mesh.updateWorldMatrix(true, false);
    // M = inverse(partIBM) · setIBM, which must be the same for every joint the two share.
    const offsetFor = (p: (typeof parts)[number]): Matrix4 | null => {
      if (p.source.bindMode !== mesh.bindMode || !near(p.source.bindMatrix, mesh.bindMatrix) || !near(p.source.matrixWorld, mesh.matrixWorld)) return null;
      let m: Matrix4 | null = null;
      for (let j = 0; j < mesh.skeleton.bones.length; j++) {
        const k = p.bones.indexOf(mesh.skeleton.bones[j]!);
        if (k < 0) continue;
        const mj = p.inverses[k]!.clone().invert().multiply(mesh.skeleton.boneInverses[j]!);
        if (!m) m = mj;
        else if (!near(m, mj)) return null;
      }
      return m ?? identity.clone();
    };
    let placed = false;
    for (const target of parts) {
      const m = offsetFor(target);
      if (!m) continue;
      const toPart = near(m, identity) ? null : m;
      const back = toPart ? toPart.clone().invert() : null;
      const remap = new Uint16Array(mesh.skeleton.bones.length);
      mesh.skeleton.bones.forEach((bone, j) => {
        let k = target.bones.indexOf(bone);
        if (k < 0) {
          k = target.bones.length;
          target.bones.push(bone);
          // Moved points need IBM · M⁻¹ to land where the set's own IBM put the originals.
          target.inverses.push(back ? mesh.skeleton.boneInverses[j]!.clone().multiply(back) : mesh.skeleton.boneInverses[j]!.clone());
        }
        remap[j] = k;
      });
      target.sets.push(set);
      target.remap.push(remap);
      target.transform.push(toPart);
      placed = true;
      break;
    }
    if (!placed) parts.push({ sets: [set], remap: [null], transform: [null], bones: [...mesh.skeleton.bones], inverses: mesh.skeleton.boneInverses.map((m) => m.clone()), source: mesh });
  }
  return [
    ...parts.map((p) => ({ sets: p.sets, remap: p.remap, transform: p.transform, skeleton: p.sets.length > 1 ? new Skeleton(p.bones, p.inverses) : p.source.skeleton, source: p.source as Mesh })),
    ...single,
  ];
}

/**
 * Instances of one model reuse the same samples (see the model component), so their quads and
 * morph textures are built once and shared, counted by users and disposed with the last one.
 */
const sharedGeometry = new WeakMap<Float32Array, { geometry: BufferGeometry; users: number }>();
const sharedMorph = new WeakMap<Float32Array, { texture: DataTexture; users: number }>();

function acquire<T>(cache: WeakMap<Float32Array, { users: number } & T>, key: Float32Array, make: () => T): { users: number } & T {
  let entry = cache.get(key);
  if (!entry) {
    entry = { ...make(), users: 0 };
    cache.set(key, entry);
  }
  entry.users++;
  return entry;
}

/** Morph offsets as a half-float RGBA texture: texel (t · count + i) holds target t's offset of particle i. */
function morphTexture(set: SurfaceSampleSet): DataTexture {
  const { targets, deltas } = set.morph!;
  const texels = targets * set.count;
  const width = MORPH_TEXTURE_WIDTH;
  const height = Math.max(1, Math.ceil(texels / width));
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < texels; i++) {
    data[i * 4] = DataUtils.toHalfFloat(deltas[i * 3] as number);
    data[i * 4 + 1] = DataUtils.toHalfFloat(deltas[i * 3 + 1] as number);
    data[i * 4 + 2] = DataUtils.toHalfFloat(deltas[i * 3 + 2] as number);
  }
  const tex = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** The strongest `MORPH_SLOTS` influences, as target indices and weights. */
export function strongestInfluences(influences: ArrayLike<number>, index: Vector4, weight: Vector4): void {
  const top: [number, number][] = [];
  for (let i = 0; i < influences.length; i++) {
    const w = influences[i] as number;
    if (w === 0) continue;
    if (top.length < MORPH_SLOTS) top.push([i, w]);
    else {
      let min = 0;
      for (let k = 1; k < MORPH_SLOTS; k++) if (Math.abs(top[k]![1]) < Math.abs(top[min]![1])) min = k;
      if (Math.abs(w) > Math.abs(top[min]![1])) top[min] = [i, w];
    }
  }
  const at = (k: number): [number, number] => top[k] ?? [0, 0];
  index.set(at(0)[0], at(1)[0], at(2)[0], at(3)[0]);
  weight.set(at(0)[1], at(1)[1], at(2)[1], at(3)[1]);
}

/**
 * Particles that sit on a model's real surface. Sets are grouped (see groupSets) and each group
 * gets one particle mesh attached to its source mesh; for skinned meshes the particles are a
 * SkinnedMesh bound to the same joints, so the GPU skins them exactly like the body (no
 * per-particle CPU work). Morphing meshes (vertex animation) move their particles by the same
 * morph targets, read from a texture for the strongest current influences. The material faces
 * every quad to the camera after skinning, shimmers it along the surface normal, and scatters it
 * outward and downwind as `dissolve` rises (each particle with its own delay), so the shape can
 * break apart and reform.
 */
export function createSurfaceParticles(sets: readonly SurfaceSampleSet[], opts: SurfaceParticleOptions, time: FloatUniform): SurfaceParticles {
  const u = {
    dissolve: uniform(0),
    brightness: uniform(opts.brightness),
    size: uniform(opts.size),
    presence: uniform(1),
    velocity: uniform(new Vector3()),
    breath: uniform(0),
    sparkle: uniform(0),
  };
  const seed = attribute<'float'>('pseed', 'float');
  const normal = normalLocal;
  const surfaceColor = attribute<'vec3'>('pcolor', 'vec3');
  const corner = attribute<'vec2'>('corner', 'vec2');

  // Per-particle dissolve progress with a staggered start.
  const start = seed.mul(0.55);
  const d = smoothstep(start, start.add(0.45), u.dissolve);
  const toLocal = (world: Node<'vec3'>) => modelWorldMatrixInverse.mul(vec4(world, 0)).xyz;
  const wind = toLocal(vec3(...opts.wind));
  const swirl = vec3(sin(time.mul(0.7).add(seed.mul(41))), cos(time.mul(0.55).add(seed.mul(23))), sin(time.mul(0.6).add(seed.mul(11))));
  // The mesh's space can be scaled (instance and node scales): one world unit in it, for the
  // world-unit distances along the (unit-length, mesh-space) normal.
  const worldUnit = length(toLocal(vec3(0, 1, 0)));
  const scatter = normal.mul(worldUnit.mul(opts.spread)).add(wind).mul(d.mul(d)).add(toLocal(swirl).mul(d.mul(opts.spread * 0.25)));
  const shimmer = normal.mul(sin(time.mul(seed.mul(2).add(1.5)).add(seed.mul(TAU))).mul(worldUnit.mul(opts.jitter)));
  // Camera-facing quad: the camera's right and up axes, brought into the mesh's space.
  const right = toLocal(cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz);
  const up = toLocal(cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  const radius = u.size.mul(0.5).mul(seed.mul(0.6).add(0.7)).mul(float(1).sub(d.mul(0.4)));
  const offset = right.mul(corner.x).add(up.mul(corner.y)).mul(radius);
  const shape = smoothstep(1, 0, length(corner)).pow(1.5);
  const shading = opts.shading ?? 0;
  const lightDir = vec3(...(opts.light ?? [0.3, 1, 0.55])).normalize();
  const worldNormal = varying(modelWorldMatrix.mul(vec4(normalLocal, 0)).xyz.normalize(), 'vSurfaceNormal');
  // Half-lambert with a floor: the lit side at full colour, the far side at about a third.
  const lit = mix(float(0.32), float(1), smoothstep(-0.35, 0.9, dot(worldNormal.normalize(), lightDir)));
  const saturation = opts.saturation ?? 1;
  const sampled = saturation === 1 ? surfaceColor : mix(vec3(dot(surfaceColor, vec3(0.2126, 0.7152, 0.0722))), surfaceColor, saturation);
  const color = mix(sampled, vec3(...opts.tint), opts.colorMix).mul(shading > 0 ? mix(float(1), lit, shading) : float(1));
  const twinkle = sin(time.mul(seed.mul(3).add(1)).add(seed.mul(50))).mul(0.15).add(0.9);
  const waveK = opts.clearWave ?? 0;
  // The clear wave passing the body: the points flare and twinkle faster for a moment.
  const shimmerWave = waveK > 0 ? float(1).add(clearFront().mul(waveK).mul(sin(time.mul(seed.mul(9).add(6)).add(seed.mul(70))).mul(0.4).add(0.8))) : float(1);
  const light = color.mul(shape).mul(twinkle).mul(u.brightness).mul(shimmerWave).mul(float(1).sub(d.mul(0.8))).mul(u.presence);

  const makeMaterial = (morph: Node<'vec3'> | null): MeshBasicNodeMaterial => {
    if (opts.glow) return glowMaterial(opts.glow, morph);
    const material = new MeshBasicNodeMaterial();
    const surface = morph ? positionLocal.add(morph) : positionLocal;
    material.positionNode = surface.add(scatter).add(shimmer).add(offset);
    if (opts.blend === 'additive') {
      material.colorNode = vec4(additiveFog(light), 1);
      material.blending = AdditiveBlending;
      material.fog = false;
      material.mrtNode = mrt({ emissive: vec4(light.mul(opts.bloom), 1) });
    } else {
      material.colorNode = vec4(color.mul(u.brightness).mul(shimmerWave), shape.mul(u.presence).mul(float(1).sub(d.mul(0.8))));
      material.blending = NormalBlending;
      material.mrtNode = mrt({ emissive: vec4(color.mul(opts.bloom), shape.mul(u.presence)) });
    }
    material.transparent = true;
    material.depthWrite = false;
    return material;
  };

  const glowMaterial = (g: GlowOptions, morph: Node<'vec3'> | null): MeshBasicNodeMaterial => {
    const material = new MeshBasicNodeMaterial();
    const surface = morph ? positionLocal.add(morph) : positionLocal;
    const s2 = fract(seed.mul(7.31).add(0.17));
    const s3 = fract(seed.mul(13.7).add(0.41));
    const s4 = fract(seed.mul(3.17).add(0.73));
    const s5 = fract(seed.mul(23.3).add(0.29));
    const worldUp = vec3(0, 1, 0);
    const vel = u.velocity;
    const speed = length(vel);
    const moving = smoothstep(0.05, 0.4, speed);
    // Behind the creature (where its wake goes and its body streams to); upwards when it stands.
    const back = mix(worldUp, vel.negate().div(max(speed, 1e-4)), moving).normalize();
    const nWorld = modelWorldMatrix.mul(vec4(normalLocal, 0)).xyz.normalize();
    // Shedding: mostly from trailing surfaces (facing away from the motion); about `shed` of all points.
    const trailing = mix(float(0.6), smoothstep(-0.25, 0.75, dot(nWorld, back)), moving);
    const shedOn = step(s4, trailing.mul(g.shed * 1.6));
    const age = fract(time.div(g.shedLife).add(s3));
    const lifeT = age.mul(g.shedLife);
    const curl = mx_noise_vec3(vec3(seed.mul(37.1), lifeT.mul(0.45), s5.mul(11).add(time.mul(0.03))));
    // A shed point stays where it left the body while the body moves on, wanders and rises a little.
    const wake = vel.mul(lifeT).negate().add(curl.mul(age.mul(g.shedSpread))).add(worldUp.mul(age.mul(g.shedSpread * 0.3)));
    // The others orbit their surface point and stream slowly along the body.
    const orbit = vec3(
      sin(time.mul(s2.mul(0.8).add(0.5)).add(s3.mul(TAU))),
      cos(time.mul(s4.mul(0.7).add(0.45)).add(s2.mul(TAU))),
      sin(time.mul(s5.mul(0.9).add(0.4)).add(s4.mul(TAU))),
    ).mul(g.drift);
    const flowPhase = fract(time.mul(g.flowRate).add(s5));
    const stream = back.mul(flowPhase.sub(0.5).mul(g.flow));
    const motion = toLocal(mix(orbit.add(stream), wake, shedOn));
    const quadRadius = radius.mul(mix(float(1), float(1).sub(age.mul(0.55)), shedOn));
    const quad = right.mul(corner.x).add(up.mul(corner.y)).mul(quadRadius);
    material.positionNode = surface.add(scatter).add(motion).add(quad);
    // Light per point (vertex stage): edges brighter than the body, twinkle, rare bright sparkles,
    // shed points fading out (and in, so a wrapped life never pops).
    const worldPos = modelWorldMatrix.mul(vec4(surface, 1)).xyz;
    const view = cameraPosition.sub(worldPos).normalize();
    const fresnel = float(1).sub(abs(dot(nWorld, view)));
    const edge = mix(float(g.core), float(1), fresnel.mul(fresnel).mul(g.edge).min(1));
    const tw = float(1 - g.twinkle * 0.5).add(sin(time.mul(s2.mul(5).add(2)).add(s3.mul(TAU))).mul(g.twinkle * 0.5));
    const flash = max(sin(time.mul(s4.mul(1.6).add(0.7)).add(s2.mul(40))), 0).pow(18);
    const spark = step(1 - g.sparkle, s5).mul(flash).mul(u.sparkle.mul(frameUniforms.reactivity).mul(g.shimmer * 2).add(1)).mul(2.5);
    const shedFade = mix(float(1), float(1).sub(age).pow(1.5).mul(smoothstep(0, 0.06, age)), shedOn);
    const streamFade = sin(flowPhase.mul(Math.PI)).mul(0.35).add(0.65);
    const wave = waveK > 0 ? clearFront(worldPos).mul(waveK).mul(tw.add(0.4)) : float(0);
    const level = varying(edge.mul(tw).mul(streamFade).add(spark).add(shedOn.mul(0.25)).add(wave).mul(shedFade), 'vGlowLevel');
    // Colour: the glow colour, optionally mixed with the sampled surface colours (lifted to glow).
    const own = sampled.mul(2.4).min(vec3(1.5));
    const base = mix(vec3(...g.color), own, g.textureMix);
    const breathe = float(1).add(u.breath.mul(frameUniforms.reactivity).sub(0.35).mul(g.breathe));
    // A soft point with a bright core.
    const r = length(corner);
    const pointShape = smoothstep(1, 0, r).pow(2.2).add(smoothstep(0.38, 0, r).mul(1.1));
    const glowLight = base.mul(level).mul(pointShape).mul(u.brightness).mul(breathe).mul(float(1).sub(d.mul(0.85))).mul(u.presence);
    material.colorNode = vec4(additiveFog(glowLight), 1);
    material.blending = AdditiveBlending;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(glowLight.mul(opts.bloom), 1) });
    material.transparent = true;
    material.depthWrite = false;
    return material;
  };

  const shared = makeMaterial(null);
  const materials: MeshBasicNodeMaterial[] = [shared];
  const textures: Float32Array[] = [];
  const skeletons: Skeleton[] = [];
  const morphing: { source: Mesh; index: Vector4; weight: Vector4 }[] = [];
  const objects: Mesh[] = [];
  const geometries: Float32Array[] = [];
  for (const part of groupSets(sets)) {
    // Keyed by the first set's samples: the same samples always group into the same parts.
    const key = part.sets[0]!.position;
    const geometry = acquire(sharedGeometry, key, () => ({ geometry: quadGeometry(part) })).geometry;
    geometries.push(key);
    const source = part.source;
    let material = shared;
    const set = part.sets[0]!;
    if (part.sets.length === 1 && set.morph && set.morph.targets > 0) {
      // Offset = Σ weight · texel(target · count + particle), for the strongest influences.
      const tex = acquire(sharedMorph, set.morph.deltas, () => ({ texture: morphTexture(set) })).texture;
      textures.push(set.morph.deltas);
      const index = new Vector4();
      const weight = new Vector4();
      const uIndex = uniform(index);
      const uWeight = uniform(weight);
      const particle = attribute<'float'>('pindex', 'float');
      const load = (target: Node<'float'>) => {
        const texel = target.mul(set.count).add(particle);
        const row = floor(texel.div(MORPH_TEXTURE_WIDTH));
        return textureLoad(tex, ivec2(int(texel.sub(row.mul(MORPH_TEXTURE_WIDTH))), int(row))).xyz as unknown as Node<'vec3'>;
      };
      const delta = load(uIndex.x)
        .mul(uWeight.x)
        .add(load(uIndex.y).mul(uWeight.y))
        .add(load(uIndex.z).mul(uWeight.z))
        .add(load(uIndex.w).mul(uWeight.w));
      material = makeMaterial(delta);
      materials.push(material);
      morphing.push({ source, index, weight });
    }
    let particles: Mesh;
    if (source instanceof SkinnedMesh && part.skeleton) {
      const skinned = new SkinnedMesh(geometry, material);
      // Same transform as the body and the same joints: the GPU skins both identically.
      skinned.bind(part.skeleton, source.bindMatrix);
      skinned.bindMode = source.bindMode;
      if (part.skeleton !== source.skeleton) skeletons.push(part.skeleton);
      particles = skinned;
    } else {
      particles = new Mesh(geometry, material);
    }
    particles.frustumCulled = false;
    particles.renderOrder = 2;
    particles.name = `${source.name || 'mesh'}:particles`;
    source.add(particles);
    objects.push(particles);
  }
  const update = (): void => {
    for (const m of morphing) if (m.source.morphTargetInfluences) strongestInfluences(m.source.morphTargetInfluences, m.index, m.weight);
  };
  update();
  return {
    objects,
    uniforms: u,
    update,
    dispose() {
      for (const o of objects) o.removeFromParent();
      for (const key of geometries) {
        const entry = sharedGeometry.get(key);
        if (entry && --entry.users === 0) {
          entry.geometry.dispose();
          sharedGeometry.delete(key);
        }
      }
      for (const m of materials) m.dispose();
      for (const key of textures) {
        const entry = sharedMorph.get(key);
        if (entry && --entry.users === 0) {
          entry.texture.dispose();
          sharedMorph.delete(key);
        }
      }
      for (const s of skeletons) s.dispose();
    },
  };
}
