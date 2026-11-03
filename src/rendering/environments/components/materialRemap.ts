import { Color, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Material, type Node } from 'three/webgpu';
import { attribute, float, mix, mrt, sin, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { FloatUniform } from '../../shaders/uniforms';
import { colorUniform, zColor } from './common';
import { revealMask } from './reveal';

/** Maps a Blender material (by name) to a Prismfall look. Shared by gltfScene and scatter. */
export const materialRuleSchema = z.object({
  /** Regex tested against the Blender material name. */
  match: z.string(),
  preset: z.enum(['darkMetal', 'metal', 'hot', 'emissive', 'glass', 'stone', 'foliage', 'ice', 'keep']),
  color: zColor.optional(),
  emissive: zColor.optional(),
  emissiveIntensity: z.number().default(1),
  roughness: z.number().optional(),
  metalness: z.number().optional(),
  /** How strongly the emissive part follows the music (0..1). */
  musicGlow: z.number().default(0.5),
});

export type MaterialRule = z.infer<typeof materialRuleSchema>;

export interface RemapUniforms {
  readonly time: FloatUniform;
  readonly presence: FloatUniform;
  readonly music: FloatUniform;
  readonly emissive: FloatUniform;
}

const PRESETS: Record<MaterialRule['preset'], [number, number]> = {
  darkMetal: [0.45, 0.9],
  metal: [0.3, 1],
  hot: [0.6, 0.4],
  emissive: [0.5, 0.1],
  glass: [0.05, 0],
  stone: [0.85, 0],
  foliage: [0.78, 0],
  ice: [0.08, 0],
  keep: [0.5, 0],
};

/**
 * Builds remapped node materials. Every remapped material is revealed outward during stage
 * crossfades (alpha test) and may carry an extra vertex displacement (wind sway, current).
 */
export function createRemapper(rules: readonly MaterialRule[], u: RemapUniforms, vertexAO: boolean, convertUnmatched = false) {
  const compiled = rules.map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));
  const created: Material[] = [];
  return {
    created,
    remap(source: Material, hasAO: boolean, extra: { positionNode?: Node<'vec3'> } = {}): Material {
      const rule = compiled.find((r) => r.re.test(source.name));
      // Unmatched materials stay as authored unless conversion is requested (or a displacement is needed).
      if ((rule ? rule.preset === 'keep' : !convertUnmatched) && !extra.positionNode) return source;
      const preset = rule?.preset ?? 'stone';
      const baseColor = rule?.color ?? ('color' in source && source.color instanceof Color ? `#${source.color.getHexString()}` : '#808080');
      const physical = preset === 'glass' || preset === 'ice';
      const mat = physical ? new MeshPhysicalNodeMaterial() : new MeshStandardNodeMaterial();
      mat.name = source.name;
      mat.color = new Color(baseColor);
      const [rough, metal] = PRESETS[preset];
      mat.roughness = rule?.roughness ?? rough;
      mat.metalness = rule?.metalness ?? metal;
      if (physical) {
        (mat as MeshPhysicalNodeMaterial).clearcoat = 1;
        (mat as MeshPhysicalNodeMaterial).clearcoatRoughness = 0.08;
        (mat as MeshPhysicalNodeMaterial).transmission = 0;
      }
      const ao = hasAO && vertexAO ? mix(float(0.35), float(1), attribute<'vec4'>('color', 'vec4').r) : float(1);
      mat.colorNode = vec4(colorUniform(baseColor).mul(ao), 1);
      mat.opacityNode = revealMask(u.presence);
      mat.alphaTest = 0.5;
      if (extra.positionNode) mat.positionNode = extra.positionNode;
      if (rule?.emissive) {
        const flicker = preset === 'hot' ? sin(u.time.mul(2.3)).mul(0.08).add(0.92) : float(1);
        const glow = colorUniform(rule.emissive)
          .mul(rule.emissiveIntensity)
          .mul(flicker)
          .mul(float(1).add(u.music.mul(rule.musicGlow)))
          .mul(u.emissive)
          .mul(u.presence);
        mat.emissiveNode = glow;
        mat.mrtNode = mrt({ emissive: vec4(glow, 1) });
      }
      created.push(mat);
      return mat;
    },
    dispose(): void {
      created.forEach((m) => m.dispose());
    },
  };
}
