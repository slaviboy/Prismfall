import { BufferAttribute, BufferGeometry, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cos,
  dot,
  float,
  floor,
  length,
  mix,
  mrt,
  mx_cell_noise_float,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorldGeometry,
  normalize,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { createHeightfield, heightNormal, heightfieldSchema } from '../terrain/heightfield';
import { colorUniform, floatUniform, zColor } from './common';
import { revealMask } from './reveal';

const schema = z.object({
  height: heightfieldSchema.prefault({}),
  /** Mesh layout: a wedge fanning out from the viewer, dense near and coarse far away. */
  mesh: z
    .object({
      apex: z.tuple([z.number(), z.number()]).default([0, 34]),
      near: z.number().positive().default(12),
      far: z.number().positive().default(900),
      rows: z.number().int().min(8).max(600).default(220),
      cols: z.number().int().min(8).max(600).default(240),
      /** Half-width growth per unit distance (covers ultrawide views with camera sway). */
      spread: z.number().positive().default(1.4),
    })
    .prefault({}),
  colors: z
    .object({
      low: zColor.default('#6e4128'),
      high: zColor.default('#dba062'),
      rock: zColor.default('#7d4e34'),
      /** Optional snow above `snowLine` (world y). */
      snow: zColor.optional(),
      snowLine: z.number().default(1e6),
      sparkle: zColor.default('#ffe3ad'),
    })
    .prefault({}),
  /** Wind ripples (sand) or wind-carved grooves (snow). */
  ripples: z
    .object({
      strength: z.number().min(0).default(0.35),
      wavelength: z.number().positive().default(1.4),
      direction: z.number().default(20),
      speed: z.number().default(0.04),
      fadeDistance: z.number().positive().default(140),
    })
    .prefault({}),
  sparkle: z.number().min(0).default(0.5),
  roughness: z.number().min(0).max(1).default(0.93),
  /** Slope (0 flat .. 1 vertical) above which rock shows through. */
  rockSlope: z.number().min(0).max(1).default(0.42),
  /** Reactive warm glow along crests and ridges. */
  glow: z.object({ color: zColor.default('#ff9a4a'), strength: z.number().min(0).default(0) }).prefault({}),
  /** Heat shimmer on distant terrain (0 = off). */
  heatHaze: z.number().min(0).max(1).default(0),
  /** Underwater caustics: drifting cells of focused sunlight on the ground (strength 0 = off). */
  caustics: z.object({ strength: z.number().min(0).default(0), scale: z.number().positive().default(0.12), speed: z.number().default(0.35), color: zColor.default('#9ff6ff') }).prefault({}),
});

type Params = z.infer<typeof schema>;

/**
 * Large procedural terrain (dunes, ridged mountains, rolling hills, mesas) built once on the CPU.
 * It provides the stage's ground height, so creatures and props stand exactly on it. The shader adds
 * wind ripples, glints, slope rock and snow, distance-faded to stay clean at any resolution.
 */
export const terrainComponent: ComponentFactory<Params> = {
  type: 'terrain',
  version: 1,
  description: 'Procedural terrain (dunes, mountains, hills, mesas) with wind ripples and glints; provides ground height.',
  schema,
  create(ctx, p) {
    const height = createHeightfield(p.height);
    const { apex, near, far, spread } = p.mesh;
    const detail = ctx.quality.detail === 'low' ? 0.5 : ctx.quality.detail === 'medium' ? 0.75 : 1;
    const rows = Math.max(8, Math.round(p.mesh.rows * detail));
    const cols = Math.max(8, Math.round(p.mesh.cols * detail));
    const count = rows * cols;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const data = new Float32Array(count * 2);
    let minH = Infinity;
    let maxH = -Infinity;
    const heights = new Float32Array(count);
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const d = near * Math.pow(far / near, t);
      const z = apex[1] - d;
      const half = d * spread + 20;
      for (let c = 0; c < cols; c++) {
        const x = apex[0] + (c / (cols - 1) - 0.5) * 2 * half;
        const h = height(x, z);
        const i = r * cols + c;
        positions.set([x, h, z], i * 3);
        // Normal sampling widens with distance so far terrain stays smooth (no sparkle aliasing).
        const n = heightNormal(height, x, z, Math.max(0.4, d * 0.004));
        normals.set(n, i * 3);
        heights[i] = h;
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
      }
    }
    const range = Math.max(1e-3, maxH - minH);
    for (let i = 0; i < count; i++) {
      data[i * 2] = (heights[i]! - minH) / range;
      data[i * 2 + 1] = 1 - normals[i * 3 + 1]!;
    }
    const index = new Uint32Array((rows - 1) * (cols - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        index.set([a, b, d, b, e, d], k);
        k += 6;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('terrain', new BufferAttribute(data, 2));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeBoundingSphere();

    const u = {
      glow: floatUniform(p.glow.strength),
      ripple: floatUniform(p.ripples.strength),
      sparkle: floatUniform(p.sparkle),
      presence: floatUniform(1),
      music: floatUniform(0),
    };
    const time = ctx.uniforms.time;
    const tdata = attribute<'vec2'>('terrain', 'vec2');
    const h01 = tdata.x;
    const slope = tdata.y;
    const wp = positionWorld;
    const camDist = length(wp.sub(cameraPosition));

    // Wind ripples: a travelling sine field along the wind, meandering with noise, strongest on
    // gentle slopes, faded with distance before it could alias.
    const a = (p.ripples.direction * Math.PI) / 180;
    const wind = vec2(Math.cos(a), Math.sin(a));
    const rc = dot(wp.xz, wind).div(p.ripples.wavelength).add(mx_noise_float(vec3(wp.x.mul(0.07), 0.3, wp.z.mul(0.07))).mul(2.2)).add(time.mul(p.ripples.speed));
    const rfade = smoothstep(p.ripples.fadeDistance, p.ripples.fadeDistance * 0.25, camDist);
    const flat = smoothstep(p.rockSlope, 0, slope);
    const rwave = sin(rc.mul(Math.PI * 2));
    const tilt = cos(rc.mul(Math.PI * 2)).mul(u.ripple).mul(rfade).mul(flat);
    const nWorld = normalize(normalWorldGeometry.sub(vec3(wind.x, 0, wind.y).mul(tilt)));

    const low = colorUniform(p.colors.low);
    const high = colorUniform(p.colors.high);
    const rock = colorUniform(p.colors.rock);
    // Strata in rock faces; sand grain variation; ripple troughs slightly darker.
    const strata = sin(wp.y.mul(1.7).add(mx_noise_float(vec3(wp.x.mul(0.05), wp.z.mul(0.05), 1.7)).mul(2))).mul(0.5).add(0.5);
    const grain = mx_noise_float(vec3(wp.x.mul(0.9), 0, wp.z.mul(0.9))).mul(0.5).add(0.5);
    const sand = mix(low, high, smoothstep(0.05, 0.85, h01.add(grain.mul(0.08)))).mul(float(1).sub(rwave.mul(0.06).mul(rfade).mul(flat)));
    const rocky = rock.mul(float(0.75).add(strata.mul(0.35)));
    const rockMix = smoothstep(p.rockSlope, p.rockSlope + 0.18, slope.add(grain.mul(0.06)));
    let albedo = mix(sand, rocky, rockMix);
    if (p.colors.snow) {
      const snowAmt = smoothstep(p.colors.snowLine, p.colors.snowLine + 6, wp.y.add(grain.mul(3))).mul(smoothstep(0.75, 0.35, slope));
      albedo = mix(albedo, colorUniform(p.colors.snow), snowAmt);
    }

    // Glints: sparse cells that flash as the view moves, gone with distance.
    const cell = floor(wp.xz.mul(9));
    const seed = mx_cell_noise_float(vec3(cell, 0.5));
    const twinkle = sin(time.mul(2.2).add(seed.mul(60)).add(cameraPosition.x.mul(0.8))).mul(0.5).add(0.5);
    const glint = step(0.985, seed).mul(twinkle.pow(4)).mul(smoothstep(60, 8, camDist)).mul(flat).mul(u.sparkle);
    const crest = smoothstep(0.55, 1, h01).mul(u.glow).mul(float(0.6).add(u.music.mul(0.8)));
    let emissive = colorUniform(p.colors.sparkle).mul(glint.mul(1.6)).add(colorUniform(p.glow.color).mul(crest));
    if (p.caustics.strength > 0) {
      // Domain-warped Worley borders at two scales, multiplied: wavy, broken threads of focused light
      // rather than a regular cell network.
      const ct = time.mul(p.caustics.speed);
      const s1 = p.caustics.scale;
      const warp = vec3(mx_noise_float(vec3(wp.x.mul(s1 * 0.45), wp.z.mul(s1 * 0.45), ct.mul(0.5))), mx_noise_float(vec3(wp.z.mul(s1 * 0.45), wp.x.mul(s1 * 0.45), ct.mul(0.5).add(7))), 0).mul(1.1);
      const c1 = mx_worley_noise_vec2(vec3(wp.x.mul(s1), wp.z.mul(s1), ct).add(warp));
      const c2 = mx_worley_noise_vec2(vec3(wp.x.mul(s1 * 1.9).add(3.1), wp.z.mul(s1 * 1.9), ct.mul(1.4)).sub(warp.mul(0.7)));
      const lines = smoothstep(0.09, 0, c1.y.sub(c1.x)).mul(smoothstep(0.22, 0.02, c2.y.sub(c2.x)).mul(0.8).add(0.2)).mul(mx_noise_float(vec3(wp.x.mul(0.02), wp.z.mul(0.02), ct.mul(0.2))).mul(0.5).add(0.6));
      const fade = smoothstep(220, 30, camDist).mul(normalWorldGeometry.y.clamp(0, 1));
      emissive = emissive.add(colorUniform(p.caustics.color).mul(lines.mul(fade).mul(p.caustics.strength).mul(float(1).add(u.music.mul(0.5)))));
    }
    emissive = emissive.mul(u.presence);

    const material = new MeshStandardNodeMaterial();
    material.colorNode = vec4(albedo, 1);
    material.normalNode = transformNormalToView(nWorld);
    material.roughnessNode = mix(float(p.roughness), float(0.6), rockMix.mul(0.4));
    material.metalness = 0;
    material.emissiveNode = emissive;
    material.mrtNode = mrt({ emissive: vec4(emissive.mul(0.6), 1) });
    material.fog = true;
    // Stage crossfades reveal the ground outward from the playfield instead of fading it to black.
    material.opacityNode = revealMask(u.presence);
    material.alphaTest = 0.5;
    if (p.heatHaze > 0) {
      // Heat shimmer: distant ground wavers slightly, strongest low on the horizon.
      const far01 = smoothstep(60, 400, length(positionLocal.xz.sub(vec2(apex[0], apex[1]))));
      const wobble = sin(time.mul(3.1).add(positionLocal.x.mul(0.35)).add(positionLocal.z.mul(0.21))).mul(far01).mul(p.heatHaze * 0.35);
      material.positionNode = positionLocal.add(vec3(0, wobble, 0));
    }
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = -8;
    ctx.ground.provide(height);
    return {
      object: mesh,
      reactive: u,
      update(frame) {
        u.music.value = frame.audio.bass * 0.6 + frame.audio.beatPulse * 0.4;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        ctx.ground.provide(null);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
