import { BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { abs, attribute, cameraPosition, clamp, dot, float, mix, mx_noise_float, normalize, normalWorld, positionWorld, smoothstep, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { noBloom } from '../../shaders/uniforms';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';

const groupSchema = z.object({
  /** Centre of the stand on the ground plane (x, z). */
  center: z.tuple([z.number(), z.number()]),
  /** Half-extent of the stand in x and z. */
  spread: z.tuple([z.number(), z.number()]).default([20, 20]),
  count: z.number().int().min(1).max(4000),
  /** Tree height range (world units). */
  height: z.tuple([z.number(), z.number()]).default([12, 24]),
  seed: z.number().default(1),
});

const schema = z.object({
  groups: z.array(groupSchema).min(1),
  needles: zColor.default('#03070a'),
  snow: zColor.default('#3a4a5c'),
  snowAmount: z.number().min(0).max(1).default(0.35),
  rimColor: zColor.default('#6affc0'),
  rim: z.number().min(0).default(0.35),
  /** Direction the rim light comes from (towards the brightest part of the sky). */
  rimDirection: zVec3.default([0, 0.4, -1]),
});

type Params = z.infer<typeof schema>;

/**
 * Builds one spruce of unit height: a thin trunk and stacked, drooping skirts with a ragged rim
 * of branch tips, narrowing to a spike. Attribute `tree` = (height fraction, tip factor).
 */
function spruce(seed: number, tiers: number, tips: number): BufferGeometry {
  const rand = seeded(seed);
  const pos: number[] = [];
  const info: number[] = [];
  const push = (x: number, y: number, z: number, tip: number) => {
    pos.push(x, y, z);
    info.push(y, tip);
  };
  // Trunk: a narrow square column, mostly hidden by the skirts.
  const tr = 0.012;
  const corners: [number, number][] = [
    [tr, tr],
    [-tr, tr],
    [-tr, -tr],
    [tr, -tr],
  ];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i] as [number, number];
    const [bx, bz] = corners[(i + 1) % 4] as [number, number];
    push(ax, 0, az, 0);
    push(bx, 0, bz, 0);
    push(bx, 0.3, bz, 0);
    push(ax, 0, az, 0);
    push(bx, 0.3, bz, 0);
    push(ax, 0.3, az, 0);
  }
  for (let k = 0; k < tiers; k++) {
    const f = k / tiers;
    const y = 0.1 + Math.pow(f, 0.92) * 0.8;
    const radius = 0.27 * Math.pow(1 - f, 1.05) + 0.025;
    const apexY = y + 0.11 + 0.04 * (1 - f);
    const turn = rand() * Math.PI * 2;
    const ring: [number, number, number, number][] = [];
    for (let i = 0; i < tips * 2; i++) {
      const a = turn + (i / (tips * 2)) * Math.PI * 2 + (rand() - 0.5) * 0.25;
      const isTip = i % 2 === 0;
      const r = radius * (isTip ? 0.85 + rand() * 0.35 : 0.45 + rand() * 0.2);
      const droop = isTip ? 0.03 + rand() * 0.05 : 0.0;
      ring.push([Math.cos(a) * r, y - droop, Math.sin(a) * r, isTip ? 1 : 0.4]);
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as [number, number, number, number];
      const b = ring[(i + 1) % ring.length] as [number, number, number, number];
      push(0, apexY, 0, 0);
      push(b[0], b[1], b[2], b[3]);
      push(a[0], a[1], a[2], a[3]);
    }
  }
  // Leader spike.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const b = ((i + 1) / 5) * Math.PI * 2;
    push(0, 1, 0, 1);
    push(Math.cos(b) * 0.02, 0.9, Math.sin(b) * 0.02, 0.5);
    push(Math.cos(a) * 0.02, 0.9, Math.sin(a) * 0.02, 0.5);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('tree', new BufferAttribute(new Float32Array(info), 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Spruce stands: instanced conifers with ragged silhouettes, for treelines and for dark framing
 * trees near the camera. Night shading: near-black needles, snow on upward faces, and a rim of
 * sky light on the side facing `rimDirection`. Trees are planted on the terrain and skip water.
 */
export const conifersComponent: ComponentFactory<Params> = {
  type: 'conifers',
  version: 1,
  description: 'Instanced spruce stands with ragged silhouettes, snow and sky rim light.',
  schema,
  create(ctx, p) {
    const detail = ctx.quality.detail;
    const tiers = detail === 'low' ? 9 : 14;
    const tips = detail === 'low' ? 7 : 10;
    const variants = [spruce(11, tiers, tips), spruce(29, tiers + 2, tips), spruce(47, tiers - 2, tips + 1)];
    const presence = floatUniform(1);
    const tree = attribute<'vec2'>('tree', 'vec2');
    const n = normalize(normalWorld);
    const view = normalize(cameraPosition.sub(positionWorld));
    const rimDir = normalize(vec3(...p.rimDirection));
    const grain = mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5);
    const snowMask = smoothstep(0.35, 0.8, n.y).mul(smoothstep(0.35, 0.75, grain.add(p.snowAmount * 0.6))).mul(p.snowAmount > 0 ? 1 : 0);
    const fresnel = float(1).sub(clamp(abs(dot(n, view)), 0, 1)).pow(2.5);
    const facingSky = clamp(dot(n, rimDir).mul(0.6).add(0.4), 0, 1);
    const body = colorUniform(p.needles).mul(tree.x.mul(0.5).add(0.6)).mul(tree.y.mul(0.35).add(0.75));
    const color = mix(body, colorUniform(p.snow), snowMask).add(colorUniform(p.rimColor).mul(fresnel.mul(facingSky).mul(p.rim)));
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color.mul(presence), 1);
    noBloom(material);

    const group = new Group();
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const placed: Matrix4[][] = variants.map(() => []);
    for (const g of p.groups) {
      const rand = seeded(g.seed * 7919);
      let made = 0;
      for (let tries = 0; made < g.count && tries < g.count * 6; tries++) {
        // Denser towards the centre of the stand.
        const rx = (rand() + rand() - 1) * g.spread[0];
        const rz = (rand() + rand() - 1) * g.spread[1];
        const x = g.center[0] + rx;
        const zz = g.center[1] + rz;
        const ground = ctx.ground.height(x, zz);
        if (ctx.ground.surface(x, zz) > ground + 0.05) continue;
        const h = g.height[0] + (g.height[1] - g.height[0]) * Math.pow(rand(), 1.4);
        const w = h * (0.8 + rand() * 0.35);
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        m.compose(new Vector3(x, ground - 0.3, zz), q, new Vector3(w, h, w));
        (placed[Math.floor(rand() * variants.length)] as Matrix4[]).push(m.clone());
        made++;
      }
    }
    variants.forEach((geometry, i) => {
      const list = placed[i] as Matrix4[];
      if (list.length === 0) return;
      const mesh = new InstancedMesh(geometry, material, list.length);
      list.forEach((mat, k) => mesh.setMatrixAt(k, mat));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = false;
      group.add(mesh);
    });
    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const g of variants) g.dispose();
        material.dispose();
      },
    };
  },
};
