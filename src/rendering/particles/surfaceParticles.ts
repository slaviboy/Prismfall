import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, NormalBlending, SkinnedMesh, Uint16BufferAttribute, type Node } from 'three/webgpu';
import {
  attribute,
  cameraWorldMatrix,
  cos,
  float,
  length,
  mix,
  modelWorldMatrixInverse,
  mrt,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, type FloatUniform } from '../shaders/uniforms';
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
}

export interface SurfaceParticles {
  readonly objects: Mesh[];
  readonly uniforms: {
    /** 0 = on the surface, 1 = fully scattered; each particle follows with its own delay. */
    readonly dissolve: { value: number };
    readonly brightness: { value: number };
    readonly size: { value: number };
    readonly presence: { value: number };
  };
  dispose(): void;
}

const TAU = Math.PI * 2;
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** Expands each sample into a quad (4 corners sharing the sample's data). */
function quadGeometry(set: SurfaceSampleSet): BufferGeometry {
  const n = set.count;
  const position = new Float32Array(n * 12);
  const normal = new Float32Array(n * 12);
  const color = new Float32Array(n * 12);
  const seed = new Float32Array(n * 4);
  const corner = new Float32Array(n * 8);
  const index = new Uint32Array(n * 6);
  const skinIndex = set.skinIndex ? new Uint16Array(n * 16) : null;
  const skinWeight = set.skinWeight ? new Float32Array(n * 16) : null;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      for (let c = 0; c < 3; c++) {
        position[v * 3 + c] = set.position[i * 3 + c] as number;
        normal[v * 3 + c] = set.normal[i * 3 + c] as number;
        color[v * 3 + c] = set.color[i * 3 + c] as number;
      }
      seed[v] = set.seed[i] as number;
      corner[v * 2] = CORNERS[k * 2] as number;
      corner[v * 2 + 1] = CORNERS[k * 2 + 1] as number;
      if (skinIndex && skinWeight && set.skinIndex && set.skinWeight) {
        for (let j = 0; j < 4; j++) {
          skinIndex[v * 4 + j] = set.skinIndex[i * 4 + j] as number;
          skinWeight[v * 4 + j] = set.skinWeight[i * 4 + j] as number;
        }
      }
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('pnormal', new BufferAttribute(normal, 3));
  g.setAttribute('pcolor', new BufferAttribute(color, 3));
  g.setAttribute('pseed', new BufferAttribute(seed, 1));
  g.setAttribute('corner', new BufferAttribute(corner, 2));
  if (skinIndex && skinWeight) {
    g.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  }
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Particles that sit on a model's real surface. Each sampled mesh gets a particle mesh attached to
 * it; for skinned meshes the particles are a SkinnedMesh bound to the same skeleton, so the GPU
 * skins them exactly like the body (no per-particle CPU work). The material faces every quad to
 * the camera after skinning, shimmers it along the surface normal, and scatters it outward and
 * downwind as `dissolve` rises (each particle with its own delay), so the shape can break apart
 * and reform.
 */
export function createSurfaceParticles(sets: readonly SurfaceSampleSet[], opts: SurfaceParticleOptions, time: FloatUniform): SurfaceParticles {
  const u = {
    dissolve: uniform(0),
    brightness: uniform(opts.brightness),
    size: uniform(opts.size),
    presence: uniform(1),
  };
  const seed = attribute<'float'>('pseed', 'float');
  const normal = attribute<'vec3'>('pnormal', 'vec3');
  const surfaceColor = attribute<'vec3'>('pcolor', 'vec3');
  const corner = attribute<'vec2'>('corner', 'vec2');

  // Per-particle dissolve progress with a staggered start.
  const start = seed.mul(0.55);
  const d = smoothstep(start, start.add(0.45), u.dissolve);
  const toLocal = (world: Node<'vec3'>) => modelWorldMatrixInverse.mul(vec4(world, 0)).xyz;
  const wind = toLocal(vec3(...opts.wind));
  const swirl = vec3(sin(time.mul(0.7).add(seed.mul(41))), cos(time.mul(0.55).add(seed.mul(23))), sin(time.mul(0.6).add(seed.mul(11))));
  const scatter = normal.mul(opts.spread).add(wind).mul(d.mul(d)).add(toLocal(swirl).mul(d.mul(opts.spread * 0.25)));
  const shimmer = normal.mul(sin(time.mul(seed.mul(2).add(1.5)).add(seed.mul(TAU))).mul(opts.jitter));
  // Camera-facing quad: the camera's right and up axes, brought into the mesh's space.
  const right = toLocal(cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz);
  const up = toLocal(cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  const radius = u.size.mul(0.5).mul(seed.mul(0.6).add(0.7)).mul(float(1).sub(d.mul(0.4)));
  const offset = right.mul(corner.x).add(up.mul(corner.y)).mul(radius);

  const material = new MeshBasicNodeMaterial();
  material.positionNode = positionLocal.add(scatter).add(shimmer).add(offset);
  const shape = smoothstep(1, 0, length(corner)).pow(1.5);
  const color = mix(surfaceColor, vec3(...opts.tint), opts.colorMix);
  const twinkle = sin(time.mul(seed.mul(3).add(1)).add(seed.mul(50))).mul(0.15).add(0.9);
  const light = color.mul(shape).mul(twinkle).mul(u.brightness).mul(float(1).sub(d.mul(0.8))).mul(u.presence);
  if (opts.blend === 'additive') {
    material.colorNode = vec4(additiveFog(light), 1);
    material.blending = AdditiveBlending;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(light.mul(opts.bloom), 1) });
  } else {
    material.colorNode = vec4(color.mul(u.brightness), shape.mul(u.presence).mul(float(1).sub(d.mul(0.8))));
    material.blending = NormalBlending;
    material.mrtNode = mrt({ emissive: vec4(color.mul(opts.bloom), shape.mul(u.presence)) });
  }
  material.transparent = true;
  material.depthWrite = false;

  const objects: Mesh[] = [];
  const geometries: BufferGeometry[] = [];
  for (const set of sets) {
    const geometry = quadGeometry(set);
    geometries.push(geometry);
    const source = set.mesh;
    let particles: Mesh;
    if (source instanceof SkinnedMesh && set.skinIndex) {
      const skinned = new SkinnedMesh(geometry, material);
      // Same transform as the body and the same skeleton: the GPU skins both identically.
      skinned.bind(source.skeleton, source.bindMatrix);
      skinned.bindMode = source.bindMode;
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
  return {
    objects,
    uniforms: u,
    dispose() {
      for (const o of objects) o.removeFromParent();
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
}
