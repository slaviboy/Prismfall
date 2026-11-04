import { AdditiveBlending, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, NormalBlending, PlaneGeometry, Vector3 } from 'three/webgpu';
import { abs, cameraPosition, dot, exp, float, length, mx_noise_float, normalWorld, normalize, positionWorld, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { FLOOR, MOON_DIR, comfortOf, fogDepth, fogTint, release, revealMask, tick, world, type F, type V3 } from './shared';

const schema = z.object({
  /** Horizontal mist banks over the floor: centre, size (x, z), height above the floor, density. */
  banks: z
    .array(z.object({ center: zVec3, size: z.tuple([z.number(), z.number()]), height: z.number().default(1.5), density: z.number().default(0.6) }))
    .default([]),
  /** Vertical fog veils that layer the depth. */
  veils: z.array(z.object({ center: zVec3, size: z.tuple([z.number(), z.number()]), density: z.number().default(0.35) })).default([]),
  /** Moon shafts through the broken roof: where they meet the floor, top height, radius at the floor. */
  shafts: z.array(z.object({ at: zVec3, top: z.number().default(70), radius: z.number().default(9), strength: z.number().default(1) })).default([]),
});

type Params = z.infer<typeof schema>;

/**
 * The world's mist: banks that drift over the floor and swallow its far reaches, vertical veils that
 * stack the depth into layers, and moon shafts falling through the broken roof onto bright pools
 * (light scattered by the fog, brightest where you look through most of it). The mist breathes a
 * little with the music's low end; calm comfort thins it.
 */
export const webMist: ComponentFactory<Params> = {
  type: 'webMist',
  version: 1,
  description: 'Ground mist banks, layered fog veils and moon shafts with pools.',
  schema,
  create(ctx, p) {
    const w = world(ctx);
    const presence = floatUniform(1);
    const density = floatUniform(comfortOf(ctx) === 'full' ? 1 : 0.75);
    const group = new Group();
    const time = w.u.time as unknown as F;
    const bass = w.u.bass as unknown as F;
    const geos: (PlaneGeometry | CylinderGeometry)[] = [];
    const mats: MeshBasicNodeMaterial[] = [];
    const reveal = revealMask(presence as unknown as F, 900);

    // ---- Banks: soft, drifting density lit by the fog's own colour (brighter towards the moon).
    const bankMat = new MeshBasicNodeMaterial();
    {
      const pw = positionWorld;
      const drift = vec3(time.mul(0.6), 0, time.mul(0.25));
      const n1 = mx_noise_float(pw.mul(0.022).add(drift.mul(0.02))).mul(0.5).add(0.5);
      const n2 = mx_noise_float(pw.mul(0.07).add(drift.mul(0.05)).add(vec3(3, 0, 7))).mul(0.5).add(0.5);
      const q = uv().sub(0.5).mul(2);
      const edge = smoothstep(1, 0.6, length(q));
      const dens = smoothstep(0.35, 0.85, n1.mul(0.7).add(n2.mul(0.35))).mul(edge).mul(density).mul(bass.mul(0.25).add(0.9));
      const dir = normalize(pw.sub(cameraPosition)) as unknown as V3;
      // Seen edge-on the bank thickens; seen from above it thins.
      const graze = float(1).sub(abs(dir.y)).pow(2).mul(0.7).add(0.3);
      const col = fogTint(w, dir).mul(1.6).add(vec3(0.015, 0.018, 0.022));
      const keep = exp(fogDepth(w, pw as unknown as V3).mul(-0.4));
      bankMat.colorNode = vec4(col, dens.mul(graze).mul(keep).mul(reveal).mul(0.85).clamp(0, 0.85));
      bankMat.transparent = true;
      bankMat.blending = NormalBlending;
      bankMat.depthWrite = false;
      bankMat.side = DoubleSide;
      bankMat.fog = false;
      mats.push(bankMat);
    }
    for (const b of p.banks) {
      const geo = new PlaneGeometry(b.size[0], b.size[1]);
      geo.rotateX(-Math.PI / 2);
      geos.push(geo);
      for (let k = 0; k < 3; k++) {
        // Three thin sheets give the bank a little thickness.
        const mesh = new Mesh(geo, bankMat);
        mesh.position.set(b.center[0] + k * 3, FLOOR + b.height * (0.4 + k * 0.45), b.center[2] - k * 4);
        mesh.renderOrder = 2;
        mesh.frustumCulled = false;
        group.add(mesh);
      }
    }

    // ---- Veils: vertical fog sheets facing the viewer.
    const veilMat = new MeshBasicNodeMaterial();
    {
      const pw = positionWorld;
      const n1 = mx_noise_float(pw.mul(0.015).add(vec3(time.mul(0.012), time.mul(0.004), 0))).mul(0.5).add(0.5);
      const n2 = mx_noise_float(pw.mul(0.05).add(vec3(0, time.mul(0.01), time.mul(0.008)))).mul(0.5).add(0.5);
      const q = uv().sub(0.5).mul(2);
      const edge = smoothstep(1, 0.55, abs(q.x)).mul(smoothstep(1, 0.3, q.y).mul(smoothstep(-1, -0.6, q.y)));
      const dens = smoothstep(0.3, 0.9, n1.mul(0.75).add(n2.mul(0.3))).mul(edge).mul(density);
      const dir = normalize(pw.sub(cameraPosition)) as unknown as V3;
      const col = fogTint(w, dir).mul(1.4).add(vec3(0.01, 0.012, 0.016));
      veilMat.colorNode = vec4(col, dens.mul(reveal).mul(0.6).clamp(0, 0.6));
      veilMat.transparent = true;
      veilMat.blending = NormalBlending;
      veilMat.depthWrite = false;
      veilMat.side = DoubleSide;
      veilMat.fog = false;
      mats.push(veilMat);
    }
    const eye = new Vector3(0, 0, 30);
    for (const v of p.veils) {
      const geo = new PlaneGeometry(v.size[0], v.size[1]);
      geos.push(geo);
      const mesh = new Mesh(geo, veilMat);
      mesh.position.set(...v.center);
      mesh.lookAt(eye.x, v.center[1], eye.z);
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      group.add(mesh);
    }

    // ---- Moon shafts: cones of scattered moonlight, soft at their rims, dust drifting through them.
    const shaftMat = new MeshBasicNodeMaterial();
    {
      const pw = positionWorld;
      // Height along the shaft (0 at the floor, 1 at the roof opening): fades out at both ends.
      const h = uv().y;
      const along = smoothstep(0, 0.15, h).mul(smoothstep(1, 0.72, h));
      const dust = mx_noise_float(pw.mul(0.08).add(vec3(0, time.mul(-0.15), time.mul(0.05)))).mul(0.35).add(0.75);
      const dir = normalize(pw.sub(cameraPosition));
      // Brightest looking up the shaft towards the moon (forward scattering).
      const forward = dot(dir, vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).max(0).pow(3).mul(1.2).add(0.35);
      const keep = exp(fogDepth(w, pw as unknown as V3).mul(-0.5));
      // Thickest (brightest) where the view crosses the middle of the shaft; the rims fade to nothing.
      const across = abs(dot(normalize(normalWorld), dir)).pow(2.5);
      const col = vec3(0.042, 0.052, 0.068).mul(along).mul(across).mul(dust).mul(forward).mul(keep).mul(reveal).mul(float(1).add(bass.mul(0.15)));
      shaftMat.colorNode = vec4(col, 1);
      shaftMat.transparent = true;
      shaftMat.blending = AdditiveBlending;
      shaftMat.depthWrite = false;
      shaftMat.side = DoubleSide;
      shaftMat.fog = false;
      mats.push(shaftMat);
    }
    const poolMat = new MeshBasicNodeMaterial();
    {
      const q = uv().sub(0.5).mul(2);
      const d = length(q);
      const n = mx_noise_float(positionWorld.mul(0.2)).mul(0.3).add(0.85);
      const keep = exp(fogDepth(w, positionWorld as unknown as V3).mul(-0.6));
      poolMat.colorNode = vec4(vec3(0.09, 0.105, 0.13).mul(smoothstep(1, 0.2, d)).mul(n).mul(keep).mul(reveal), 1);
      poolMat.transparent = true;
      poolMat.blending = AdditiveBlending;
      poolMat.depthWrite = false;
      poolMat.fog = false;
      poolMat.polygonOffset = true;
      poolMat.polygonOffsetFactor = -2;
      poolMat.polygonOffsetUnits = -4;
      mats.push(poolMat);
    }
    for (const s of p.shafts) {
      const height = s.top - s.at[1];
      // Slanted along the moon direction: narrow at the roof opening, widest at the floor pool.
      const geo = new CylinderGeometry(s.radius * 0.55, s.radius, height, 28, 1, true);
      geos.push(geo);
      const mesh = new Mesh(geo, shaftMat);
      const axis = new Vector3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z).normalize();
      const mid = new Vector3(...s.at).addScaledVector(axis, height / (2 * axis.y));
      mesh.position.copy(mid);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), axis);
      mesh.scale.set(1, 1 / axis.y, 1);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      group.add(mesh);
      const pg = new PlaneGeometry(s.radius * 2.6, s.radius * 2.6);
      pg.rotateX(-Math.PI / 2);
      geos.push(pg);
      const pool = new Mesh(pg, poolMat);
      pool.position.set(s.at[0], FLOOR + 0.03, s.at[2]);
      pool.renderOrder = 1;
      group.add(pool);
    }

    return {
      object: group,
      reactive: { density },
      update(frame) {
        tick(w, frame.time, frame.dt, frame.audio);
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const g of geos) g.dispose();
        for (const m of mats) m.dispose();
        release(w);
      },
    };
  },
};
