import { Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { clamp, mix, mrt, mx_fractal_noise_float, positionWorld, smoothstep, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';

const schema = z.object({
  position: zVec3.default([0, -14, -30]),
  rotation: zVec3.default([-Math.PI / 2, 0, 0]),
  width: z.number().default(200),
  depth: z.number().default(120),
  crust: zColor.default('#120604'),
  hot: zColor.default('#ff5a14'),
  white: zColor.default('#ffd27a'),
  heat: z.number().default(1),
  scale: z.number().default(0.06),
  flow: zVec3.default([0.0, 0, 0.6]),
});

/** Flowing molten surface: crusted fractal noise with hot seams that brighten with the music. */
export const lavaComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'lava',
  version: 1,
  description: 'Animated molten metal / lava surface with emissive seams.',
  schema,
  create(ctx, p) {
    const u = { heat: floatUniform(p.heat), presence: floatUniform(1) };
    const t = ctx.uniforms.time;
    const pw = positionWorld.mul(p.scale).add(vec3(...p.flow).mul(t).mul(p.scale));
    const n = mx_fractal_noise_float(pw, 5, 2.1, 0.55).mul(0.5).add(0.5);
    const n2 = mx_fractal_noise_float(pw.mul(2.7).add(vec3(0, t.mul(0.07), 0)), 3, 2, 0.5).mul(0.5).add(0.5);
    const seams = smoothstep(0.52, 0.72, n).mul(smoothstep(0.35, 0.75, n2));
    const glow = mix(colorUniform(p.hot), colorUniform(p.white), smoothstep(0.62, 0.85, n)).mul(seams).mul(u.heat).mul(u.presence);
    const base = colorUniform(p.crust).mul(clamp(n.mul(1.5), 0.2, 1)).add(glow);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(base.mul(u.presence), 1);
    material.mrtNode = mrt({ emissive: vec4(glow, 1) });
    const geometry = new PlaneGeometry(p.width, p.depth, 1, 1);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(...p.position);
    mesh.rotation.set(...p.rotation);
    mesh.renderOrder = -7;
    return {
      object: mesh,
      reactive: { heat: u.heat },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
