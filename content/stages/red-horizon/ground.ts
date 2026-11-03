import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, PlaneGeometry, Quaternion, Vector3, Vector4 } from 'three/webgpu';
import {
  abs,
  atan,
  cameraPosition,
  dot,
  exp,
  float,
  int,
  length,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorldGeometry,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  step,
  texture,
  uniformArray,
  vec2,
  vec3,
} from 'three/tsl';
import { floatUniform, seeded, z, type ComponentFactory } from '@prismfall/sdk';
import { loadSceneryTextures } from './scenery';
import { GROUND_Y, MAX_LIGHTS, VIEWER, backdropTexture, bandDir, bandTexture, envTexture, release, revealMask, shadeMaterial, stageTexture, triplanar, world, zHaze, type F, type V3, type V4 } from './shared';

const zXZ = z.tuple([z.number(), z.number()]);

const schema = z.object({
  /** Ground rectangle (x0, x1, z0, z1) in world metres. */
  extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([-110, 110, -130, 28]),
  /** Distance (from the viewer) over which the 3D ground melts into the photo's own yard. */
  fade: z.tuple([z.number(), z.number()]).default([45, 105]),
  /** Azimuths (degrees) inside which the ground stays calm and dark, behind the board. */
  calm: z.tuple([z.number(), z.number()]).default([13, 25]),
  /** Share of wet ground (puddles) and texture scales (repeats per metre). */
  puddles: z.number().min(0).max(1).default(0.4),
  asphaltScale: z.number().positive().default(0.22),
  burntScale: z.number().positive().default(0.16),
  /** Craters and scorch marks: centre (x, z) and radius. */
  craters: z.array(z.tuple([z.number(), z.number(), z.number()])).max(8).default([]),
  /** Rail tracks of the freight yard (up to four straight runs, gauge 1.435 m). */
  tracks: z.array(z.object({ from: zXZ, to: zXZ })).max(4).default([]),
  exposure: z.number().min(0).default(0.62),
  haze: zHaze,
  seed: z.number().default(13),
});

type Params = z.infer<typeof schema>;

/** Appends a box (centre, size, yaw) to position/normal/index arrays. */
function pushBox(pos: number[], nrm: number[], idx: number[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number): void {
  const m = new Matrix4().compose(new Vector3(cx, cy, cz), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), new Vector3(sx, sy, sz));
  const nm = new Matrix4().makeRotationY(yaw);
  const faces: [number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0]],
    [[-1, 0, 0], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [0, 0, 1]],
    [[0, 0, 1], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0]],
  ];
  const v = new Vector3();
  for (const [n, u] of faces) {
    const nn = new Vector3(...(n as [number, number, number]));
    const uu = new Vector3(...(u as [number, number, number]));
    const ww = new Vector3().crossVectors(nn, uu);
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.copy(nn).multiplyScalar(0.5).addScaledVector(uu, a! * 0.5).addScaledVector(ww, b! * 0.5).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      v.copy(nn).applyMatrix4(nm);
      nrm.push(v.x, v.y, v.z);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function geometryOf(pos: number[], nrm: number[], idx: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * The yard in the foreground and mid-ground: cracked asphalt and scorched earth (photographed
 * Poly Haven textures, planar-mapped), rain-filled puddles that mirror the burning sky and glint
 * with the fires, wet margins, craters with charred floors and soot halos, ballast and rails of
 * the freight tracks with their sleepers. It melts into the photo's own yard with distance, and
 * stays calm and darker behind the board so the stack reads.
 */
export const groundComponent: ComponentFactory<Params> = {
  type: 'redHorizonGround',
  version: 1,
  description: 'Foreground yard: cracked asphalt, scorched earth, puddles reflecting the fires and sky, craters, rail tracks.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
    const [env, backdrop, band, aAlb, aNr, bAlb, bNr, tex] = await Promise.all([
      envTexture(w),
      backdropTexture(w),
      bandTexture(w),
      stageTexture(w, 'textures/asphalt_albedo.webp'),
      stageTexture(w, 'textures/asphalt_nr.webp', false),
      stageTexture(w, 'textures/burnt_albedo.webp'),
      stageTexture(w, 'textures/burnt_nr.webp', false),
      loadSceneryTextures(w),
    ]);
    const presence = floatUniform(1);
    const time = ctx.uniforms.time as unknown as F;
    const P = positionWorld as unknown as V3;
    const xz = vec2(P.x, P.z);
    // ---- Where we are relative to the viewer: distance (fade into the photo) and azimuth (calm).
    const rel = vec2(P.x.sub(VIEWER.x), P.z.sub(VIEWER.z));
    const dist = length(rel);
    const az = abs(atan(rel.x, rel.y.negate())).mul(180 / Math.PI);
    const calm = smoothstep(p.calm[0], p.calm[1], az);
    const photo = smoothstep(p.fade[0], p.fade[1], dist);
    // ---- Materials: asphalt and burnt earth, mixed by a broad mask.
    const sample = (alb: typeof aAlb, nr: typeof aNr, k: number) => {
      const uv = xz.mul(k);
      const c = alb ? (texture(alb, uv).rgb as unknown as V3) : (vec3(0.2, 0.2, 0.2) as V3);
      const n = nr ? texture(nr, uv) : null;
      return { c, nx: n ? n.x.mul(2).sub(1) : float(0), nz: n ? n.y.mul(2).sub(1) : float(0), r: n ? n.z : float(0.8) };
    };
    const A = sample(aAlb, aNr, p.asphaltScale);
    const Bt = sample(bAlb, bNr, p.burntScale);
    const broad = mx_fractal_noise_float(vec3(xz.mul(0.028), 1.7), 3, 2, 0.5).mul(0.5).add(0.5);
    const burntK = smoothstep(0.4, 0.56, broad);
    let albedo: V3 = mix(A.c.mul(0.55), Bt.c.mul(0.6), burntK) as V3;
    let rough: F = mix(A.r, Bt.r, burntK).mul(0.25).add(0.75) as F;
    let nx: F = mix(A.nx, Bt.nx, burntK) as F;
    let nz: F = mix(A.nz, Bt.nz, burntK) as F;
    // ---- Rail tracks: gravel ballast in a band either side of each run.
    const segs = p.tracks.map((t) => new Vector4(t.from[0], t.from[1], t.to[0], t.to[1]));
    while (segs.length < 4) segs.push(new Vector4(1e5, 1e5, 1e5 + 1, 1e5));
    const segU = uniformArray(segs, 'vec4');
    let ballast: F = float(0) as F;
    for (let i = 0; i < 4; i++) {
      const s = segU.element(int(i)) as unknown as V4;
      const a = vec2(s.x, s.y);
      const ab = vec2(s.z, s.w).sub(a);
      const tt = dot(xz.sub(a), ab).div(dot(ab, ab)).clamp(0, 1);
      const d = length(xz.sub(a.add(ab.mul(tt))));
      ballast = max(ballast, smoothstep(2.6, 1.6, d)) as F;
    }
    const grit = mx_noise_float(vec3(xz.mul(9), 3.3)).mul(0.5).add(0.5);
    albedo = mix(albedo, vec3(0.11, 0.1, 0.095).mul(grit.mul(0.8).add(0.6)), ballast.mul(0.85)) as V3;
    rough = mix(rough, float(0.9), ballast) as F;
    // ---- Craters and scorch: charred floor, a raised rim, a soot halo.
    let scorch: F = float(0) as F;
    for (const [cx, cz, r] of p.craters) {
      const d = length(xz.sub(vec2(cx, cz))).div(r);
      scorch = max(scorch, smoothstep(2.2, 0.6, d).mul(0.75).add(smoothstep(1.0, 0.7, d).mul(0.25))) as F;
      const rim = exp(d.sub(1).mul(d.sub(1)).mul(-18));
      const g = d.sub(1).mul(-6).mul(rim).mul(0.35);
      nx = nx.add(xz.x.sub(cx).div(r).mul(g)) as F;
      nz = nz.add(xz.y.sub(cz).div(r).mul(g)) as F;
    }
    scorch = scorch.mul(calm.mul(0.6).add(0.4)) as F;
    albedo = albedo.mul(float(1).sub(scorch.mul(0.75))) as V3;
    // ---- Puddles: the lowest patches hold water; margins are damp and darker.
    const wetField = mx_fractal_noise_float(vec3(xz.mul(0.24), 5.1), 3, 2, 0.5).mul(0.5).add(0.5).add(mx_noise_float(vec3(xz.mul(1.1), 2)).mul(0.05));
    const lvl = float(0.72).sub(float(p.puddles).mul(0.25));
    const water = smoothstep(lvl, lvl.add(0.03), wetField).mul(float(1).sub(ballast)).mul(calm.mul(0.7).add(0.3)).mul(float(1).sub(photo));
    // Shallow at the shore, deeper (a clearer mirror) towards the middle.
    const deep = smoothstep(lvl, lvl.add(0.2), wetField);
    const damp = smoothstep(lvl.sub(0.06), lvl, wetField).mul(float(1).sub(ballast));
    albedo = mix(albedo, albedo.mul(0.55), damp) as V3;
    // Muddy water shows its reflection, not the ground under it, and takes no highlight of its own.
    albedo = mix(albedo, vec3(0.006, 0.0055, 0.005), water) as V3;
    rough = mix(rough, float(0.5), damp) as F;
    rough = mix(rough, float(1), water) as F;
    const k = float(1).sub(water.mul(0.92));
    const normal = normalize(vec3(nx.mul(k), 1, nz.mul(k))) as V3;
    // Wind ripples: a slow, shallow wobble of the water's normal.
    const rip = vec2(mx_noise_float(vec3(xz.mul(1.7), time.mul(0.3))), mx_noise_float(vec3(xz.mul(1.7).add(31), time.mul(0.3))))
      .mul(0.014)
      .add(vec2(mx_noise_float(vec3(xz.mul(6.5), time.mul(0.55))), mx_noise_float(vec3(xz.mul(6.5).add(7), time.mul(0.55)))).mul(0.005));
    const wn = normalize(vec3(rip.x, 1, rip.y)) as V3;
    // The mirror: the photographed sky band in the reflected direction (the smoke, the red glow and
    // the dark skyline silhouettes), weighted by water's Fresnel (dark close by, brighter towards
    // grazing distances) and dulled by the muddy water.
    const view = normalize(cameraPosition.sub(P));
    const R = reflect(view.negate(), wn) as V3;
    const cosT = max(dot(view, wn), 0);
    const fres = float(0.02).add(pow(float(1).sub(cosT), 5).mul(0.98));
    // Where the film of water is thin, the asphalt's grit breaks through and the mirror crumbles.
    const film = mix(float(1), smoothstep(0.35, 0.8, float(1).sub(A.r)), float(1).sub(deep).mul(0.75));
    // Gusts roughen patches of the water, which then mirror a duller, darker sky.
    const gust = smoothstep(0.1, 0.7, mx_noise_float(vec3(xz.mul(0.45), time.mul(0.06))));
    const mirror = bandDir(band, normalize(vec3(R.x, R.y.max(0.003), R.z)) as V3)
      .mul(fres)
      .mul(deep.mul(0.6).add(0.15))
      .mul(film)
      .mul(mix(float(1), float(0.5), gust))
      .mul(vec3(0.85, 0.78, 0.72))
      .mul(2.0);
    // Fire reflections: a sharp image of every local light with a soft streak around it.
    let glint: V3 = vec3(0, 0, 0) as V3;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const lp = w.lightPos.element(int(i)) as unknown as V4;
      const lc = w.lightCol.element(int(i)) as unknown as V4;
      const L = lp.xyz.sub(P);
      const d2 = dot(L, L);
      const ld = L.div(d2.sqrt().max(1e-3));
      const a = max(dot(R, ld), 0);
      const spec = pow(a, 160).mul(0.45).add(pow(a, 40).mul(0.012)).mul(lp.w).div(d2.add(30));
      glint = glint.add(lc.rgb.mul(spec)) as V3;
    }
    glint = glint.mul(fres.mul(0.8).add(0.2)).mul(water.add(damp.mul(0.05))) as V3;
    const reflection = mirror.mul(water).add(glint) as V3;
    // Behind the board: calmer and darker.
    albedo = albedo.mul(mix(float(0.5), float(1), calm)).mul(p.exposure) as V3;
    const material = shadeMaterial(w, {
      albedo,
      roughness: rough,
      metalness: float(0) as F,
      normal,
      glow: reflection,
      bloom: 0.03,
      local: float(1).sub(water.mul(0.9)) as F,
      presence: presence as unknown as F,
      haze: p.haze,
      backdrop,
      env,
      envIntensity: 0.45,
      rim: 0,
      noSun: true,
    });
    // The far ground fades out over the photo's own yard, which continues beyond it.
    material.transparent = true;
    material.depthWrite = true;
    // Never in front of the board: ground between the eye and the playfield (where the ray through
    // this fragment would reach the board's plane inside the board and pods) is discarded, since
    // the board stands in a void below the yard's level.
    const toP = P.sub(cameraPosition);
    const reach = cameraPosition.z.div(cameraPosition.z.sub(P.z).max(1e-3));
    const hit = cameraPosition.add(toP.mul(reach));
    const inFront = step(0.3, P.z).mul(smoothstep(24, 15, abs(hit.x))).mul(step(-12.5, hit.y));
    material.opacityNode = float(1).sub(photo).mul(revealMask(presence as unknown as F)).mul(float(1).sub(inFront));
    material.alphaTest = 0.01;
    const [x0, x1, z0, z1] = p.extent;
    const plane = new PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
    plane.rotateX(-Math.PI / 2);
    plane.translate((x0 + x1) / 2, GROUND_Y, (z0 + z1) / 2);
    const mesh = new Mesh(plane, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    const group = new Group();
    group.add(mesh);
    // ---- Rails and sleepers: dull rusty steel and weathered concrete, without the sun. The polished
    // rail head only catches the sky in a thin, soft line (its reflection of the band).
    const nW = normalWorldGeometry as unknown as V3;
    const tRail = triplanar(tex.rust[0], tex.rust[1], P, nW, 1.4);
    const head = smoothstep(0.7, 0.95, nW.y);
    const railR = reflect(view.negate(), tRail.normal) as V3;
    const railF = pow(float(1).sub(max(dot(view, nW), 0)), 5);
    const sheen = bandDir(band, normalize(vec3(railR.x, railR.y.max(0.003), railR.z)) as V3)
      .mul(head)
      .mul(railF.mul(0.3).add(0.02))
      .mul(0.5) as V3;
    const common = { presence: presence as unknown as F, haze: p.haze, backdrop, env, rim: 0, noSun: true };
    const railMat = shadeMaterial(w, {
      ...common,
      albedo: tRail.albedo.mul(0.3).mul(float(1).sub(head.mul(0.3))) as V3,
      roughness: mix(tRail.rough.mul(0.15).add(0.82), float(0.6), head) as F,
      metalness: mix(float(0.2), float(0.5), head) as F,
      normal: tRail.normal,
      glow: sheen,
      bloom: 0,
      envIntensity: 0.3,
    });
    const tSleeper = triplanar(tex.concrete[0], tex.concrete[1], P, nW, 0.9);
    const sleeperMat = shadeMaterial(w, {
      ...common,
      albedo: tSleeper.albedo.mul(0.09).add(vec3(0.01, 0.009, 0.008)) as V3,
      roughness: float(0.95) as F,
      metalness: float(0) as F,
      normal: tSleeper.normal,
      envIntensity: 0.45,
    });
    const rand = seeded(p.seed * 331 + 5);
    const sp: number[] = [], sn: number[] = [], si: number[] = [];
    const rp: number[] = [], rn: number[] = [], ri: number[] = [];
    for (const t of p.tracks) {
      const dx = t.to[0] - t.from[0];
      const dz = t.to[1] - t.from[1];
      const L = Math.hypot(dx, dz);
      const ux = dx / L, uz = dz / L;
      const yaw = Math.atan2(ux, uz);
      for (let s = 0; s < L; s += 0.68) {
        if (rand() < 0.07) continue;
        const cx = t.from[0] + ux * s + (rand() - 0.5) * 0.06;
        const cz = t.from[1] + uz * s + (rand() - 0.5) * 0.06;
        pushBox(sp, sn, si, cx, GROUND_Y + 0.06, cz, 2.5, 0.14, 0.24, yaw + (rand() - 0.5) * 0.08);
      }
      for (let s = 0; s < L; s += 6) {
        const len = Math.min(6, L - s);
        const kink = (rand() - 0.5) * 0.01;
        for (const side of [-0.7175, 0.7175]) {
          const cx = t.from[0] + ux * (s + len / 2) + uz * side;
          const cz = t.from[1] + uz * (s + len / 2) - ux * side;
          pushBox(rp, rn, ri, cx, GROUND_Y + 0.2, cz, 0.07, 0.14, len - 0.02, yaw + kink);
        }
      }
    }
    const owned: BufferGeometry[] = [plane];
    if (si.length > 0) {
      const g = geometryOf(sp, sn, si);
      owned.push(g);
      const m = new Mesh(g, sleeperMat);
      m.frustumCulled = false;
      group.add(m);
    }
    if (ri.length > 0) {
      const g = geometryOf(rp, rn, ri);
      owned.push(g);
      const m = new Mesh(g, railMat);
      m.frustumCulled = false;
      group.add(m);
    }
    return {
      object: group,
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const g of owned) g.dispose();
        material.dispose();
        railMat.dispose();
        sleeperMat.dispose();
        release(w);
      },
    };
  },
};
