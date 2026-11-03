import type { DataTexture, InstancedBufferAttribute, MeshStandardNodeMaterial, Texture } from 'three/webgpu';
import { abs, dot, exp, float, instancedBufferAttribute, mix, mx_noise_float, normalGeometry, normalize, positionGeometry, sin, smoothstep, step, vec3 } from 'three/tsl';
import type { ShadeOptions } from './shared';
import { hash, lin, shadeMaterial, triplanar, type F, type Haze, type V3, type World } from './shared';

/**
 * Shading for the rigged machines: one material for every part, chosen per vertex by its Blender
 * material id (see rig.ts MAT_IDS). Painted gunmetal armour carries the scanned plate's scratches
 * and seams (triplanar in the model's rest space, so the detail rides on the moving parts),
 * blackened frames, bare machined joints, chrome rams, rubber hoses, dark sensor glass, and the
 * lenses lit by the optical-sensor controller through a per-instance `optic` attribute:
 * (intensity, focus, slit scan -1..1, variant 0/1/2).
 */
export interface MachineLook {
  armour: string;
  armourB: string;
  frame: string;
  joint: string;
  steel: string;
  lens: string;
  dust: string;
  /** Texture scale (repeats per metre in rest space). */
  scale: number;
  /** Dust on the lower parts up to this rest height (metres). */
  dustHeight: number;
  /** How strongly lenses glow (they also get glint sprites). */
  lensGlow: number;
  bloom: number;
  /** Slit visors: half-length of the bar the hot spot travels along (rest x, metres) and its width. */
  slitHalf?: number;
  slitWidth?: number;
}

export const SENTINEL_LOOK: MachineLook = {
  armour: '#4a5058',
  armourB: '#585048',
  frame: '#24262a',
  joint: '#6e6a66',
  steel: '#26282c',
  lens: '#ff1a0a',
  dust: '#4a3a30',
  scale: 0.9,
  dustHeight: 0.55,
  lensGlow: 2.2,
  bloom: 0.25,
};

export function machineMaterial(
  w: World,
  skin: { position: V3; normal: V3; rest: V3; tag: { x: F; y: F } },
  optic: InstancedBufferAttribute,
  seedOf: F,
  look: MachineLook,
  tex: { armour: [Texture | null, Texture | null]; steel: [Texture | null, Texture | null] },
  env: Texture | null,
  backdrop: DataTexture | null,
  haze: Haze,
  presence: F,
  time: F,
  extra?: Partial<ShadeOptions>,
): MeshStandardNodeMaterial {
  const io = instancedBufferAttribute<'vec4'>(optic, 'vec4');
  const mat = skin.tag.y;
  const is = (k: number) => float(1).sub(step(0.5, abs(mat.sub(k))));
  const rest = positionGeometry;
  const restN = normalGeometry;
  const tA = triplanar(tex.armour[0], tex.armour[1], rest as unknown as V3, restN as unknown as V3, look.scale);
  const tS = triplanar(tex.steel[0], tex.steel[1], rest.mul(0.35) as unknown as V3, restN as unknown as V3, look.scale);
  const lumA = dot(tA.albedo, vec3(0.2126, 0.7152, 0.0722));
  // Painted armour: the scan's luminance shapes wear; bright scratches become bare metal.
  const scratch = smoothstep(0.17, 0.32, lumA);
  const seedTone = hash(seedOf, 3.7);
  const paint = mix(lin(look.armour), lin(look.armourB), seedTone.mul(0.6)).mul(lumA.mul(2.2).add(0.55));
  const armourAlb = mix(paint, lin('#8a8784'), scratch.mul(0.55));
  const armourRough = mix(float(0.5), float(0.28), scratch).add(tA.rough.sub(0.5).mul(0.25));
  const armourMetal = mix(float(0.55), float(1), scratch);
  const steelAlb = lin(look.steel).mul(dot(tS.albedo, vec3(0.33)).mul(2.4).add(0.35));
  // Dust and soot on feet and shins; oil streaks under the joints.
  const dustK = smoothstep(look.dustHeight, 0.0, rest.y).mul(0.7).mul(mx_noise_float(rest.mul(7)).mul(0.3).add(0.7));
  let albedo: V3 = lin(look.frame) as V3;
  albedo = mix(albedo, armourAlb, is(0)) as V3;
  albedo = mix(albedo, lin(look.joint), is(2)) as V3;
  albedo = mix(albedo, lin('#9a9a9c'), is(3)) as V3;
  albedo = mix(albedo, lin('#0d0d0e'), is(4)) as V3;
  albedo = mix(albedo, lin('#050506'), is(5)) as V3;
  albedo = mix(albedo, lin('#2a0402'), is(6).add(is(7)).clamp(0, 1)) as V3;
  albedo = mix(albedo, lin('#bdb6a8'), is(8)) as V3;
  albedo = mix(albedo, lin('#101012'), is(9)) as V3;
  albedo = mix(albedo, steelAlb, is(10)) as V3;
  albedo = mix(albedo, lin('#3a1606'), is(11)) as V3;
  albedo = mix(albedo, lin('#4a0604'), is(12)) as V3;
  albedo = mix(albedo, albedo.mul(lin('#9a8070')).add(lin(look.dust).mul(0.25)), dustK.mul(float(1).sub(is(6)))) as V3;
  let rough: F = float(0.48) as F;
  rough = mix(rough, armourRough, is(0)) as F;
  rough = mix(rough, float(0.26), is(2)) as F;
  rough = mix(rough, float(0.22), is(3)) as F;
  rough = mix(rough, float(0.72), is(4)) as F;
  rough = mix(rough, float(0.05), is(5).add(is(6)).clamp(0, 1)) as F;
  rough = mix(rough, tS.rough.mul(0.5).add(0.3), is(10)) as F;
  rough = rough.add(dustK.mul(0.3)).clamp(0.04, 1) as F;
  let metal: F = float(0.85) as F;
  metal = mix(metal, armourMetal, is(0)) as F;
  metal = mix(metal, float(1), is(2).add(is(3)).clamp(0, 1)) as F;
  metal = mix(metal, float(0), is(4).add(is(6)).add(is(7)).add(is(8)).clamp(0, 1)) as F;
  metal = mix(metal, float(0.3), is(5)) as F;
  metal = metal.mul(float(1).sub(dustK.mul(0.6))) as F;
  // Normal detail: the armour scan's dents and seams, only on armour and steel parts.
  const detail = tA.normal.sub(restN).mul(is(0)).add(tS.normal.sub(restN).mul(is(10)).mul(0.6));
  const normal = normalize(skin.normal.add(detail.mul(0.8))) as V3;
  // Optics: lens glow from the sensor controller. Variant 0 (slit visor) shows one moving hot spot
  // along its bar; 1 (three lenses) breathes with focus; 2 (single lens) brightens as it racks in.
  const intensity = io.x;
  const focus = io.y;
  const scan = io.z;
  const variant = io.w;
  const sx = rest.x.sub(scan.mul(look.slitHalf ?? 0.1)).div(look.slitWidth ?? 0.03);
  const slit = exp(sx.mul(sx).negate()).mul(1.4).add(0.22);
  const optics = mix(mix(slit, focus.mul(0.4).add(0.8), step(0.5, variant)), focus.mul(0.6).add(0.7), step(1.5, variant));
  const lensGlow = lin(look.lens).mul(intensity).mul(optics).mul(look.lensGlow).mul(is(6));
  // Status lamps blink slowly, each machine at its own rate; furnace ports flicker; searchlights.
  const blink = smoothstep(0.55, 0.62, sin(time.mul(hash(seedOf, 5.3).mul(0.6).add(0.9)).add(seedOf.mul(17))).mul(0.5).add(0.5));
  const lampGlow = lin('#ff2a10').mul(blink.mul(0.9).add(0.1)).mul(is(7).add(is(12)).clamp(0, 1)).mul(1.6);
  const hot = lin('#ff6a20').mul(mx_noise_float(vec3(time.mul(1.3), seedOf.mul(3), rest.y.mul(0.2))).mul(0.25).add(0.75)).mul(is(11)).mul(1.4);
  const search = lin('#fff0d8').mul(intensity).mul(is(8)).mul(3.0);
  const glow = lensGlow.add(lampGlow).add(hot).add(search) as V3;
  return shadeMaterial(w, {
    albedo,
    roughness: rough,
    metalness: metal,
    normal,
    position: skin.position,
    glow,
    bloom: look.bloom,
    presence,
    haze,
    backdrop,
    env,
    envIntensity: 2.0,
    rim: 0.7,
    local: 1,
    ...extra,
  });
}
