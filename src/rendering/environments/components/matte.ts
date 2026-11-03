import { CylinderGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';

const schema = z.object({
  /** Ring centre (x, z): where the viewer stands. */
  center: z.tuple([z.number(), z.number()]).default([0, 30]),
  radius: z.number().positive().default(1480),
  /** World heights the ring spans. */
  y: z.tuple([z.number(), z.number()]).default([-16, 1]),
});

/**
 * An invisible depth-only ring around the viewer: it hides 3D geometry beyond it (a water plane
 * running on towards the horizon) while the panorama drawn before it stays visible. Use it with a
 * photographic sky whose `occlude` leaves gaps (bright pixels read as sky), so 3D water ends at a
 * clean line in front of the photo's far shore. One draw call, no colour writes.
 */
export const matteComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'matte',
  version: 1,
  description: 'Invisible depth-only ring that ends 3D geometry (water) in front of a panorama.',
  schema,
  create(_ctx, p) {
    const height = Math.max(0.01, p.y[1] - p.y[0]);
    const geometry = new CylinderGeometry(p.radius, p.radius, height, 192, 1, true);
    const material = new MeshBasicNodeMaterial();
    material.colorWrite = false;
    material.depthWrite = true;
    material.side = DoubleSide;
    const mesh = new Mesh(geometry, material);
    mesh.position.set(p.center[0], (p.y[0] + p.y[1]) / 2, p.center[1]);
    mesh.frustumCulled = false;
    // After the sky (-20), before the water (-8).
    mesh.renderOrder = -19;
    return {
      object: mesh,
      // Only while this world is (mostly) on screen, so it never cuts into a world fading in.
      setPresence(v) {
        mesh.visible = v > 0.5;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
