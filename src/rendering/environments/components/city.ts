import { AdditiveBlending, BoxGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry, Quaternion, Vector3, type Node } from 'three/webgpu';
import { abs, float, floor, fract, hash, instancedBufferAttribute, max, mix, mrt, normalGeometry, positionGeometry, sin, smoothstep, step, uv, vec2, vec3, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { additiveFog } from '../../shaders/uniforms';
import { colorUniform, floatUniform, seeded, zColor } from './common';
import { revealMask } from './reveal';

/** Exported so components that follow the street grid (traffic) can read the same layout. */
export const citySchema = z.object({
  count: z.number().int().min(1).max(4000).default(600),
  /** Wedge band behind the playfield (distance from the board plane). */
  near: z.number().default(50),
  far: z.number().default(520),
  spread: z.number().default(1.35),
  /** Street grid: buildings snap to blocks of this size, leaving avenues between them. */
  grid: z.number().positive().default(28),
  street: z.number().min(0).default(8),
  height: z.tuple([z.number(), z.number()]).default([18, 150]),
  width: z.tuple([z.number(), z.number()]).default([10, 24]),
  /** Taller towers further away (0..1) for a skyline that climbs. */
  skyline: z.number().min(0).max(1).default(0.6),
  ground: z.number().default(-15),
  exclude: z.array(z.object({ center: z.tuple([z.number(), z.number()]), radius: z.number() })).default([{ center: [0, 0], radius: 40 }]),
  facade: zColor.default('#0b0d16'),
  windows: z.array(zColor).min(1).default(['#ffd9a0', '#8ad8ff', '#ff9ad8']),
  neon: z.array(zColor).min(1).default(['#ff2fd0', '#2ff6ff', '#ffe02f', '#7a5cff']),
  windowDensity: z.number().min(0).max(1).default(0.42),
  windowBrightness: z.number().min(0).default(0.7),
  floorHeight: z.number().positive().default(3.2),
  windowWidth: z.number().positive().default(2.4),
  /** Fraction of buildings with neon edge strips. */
  neonShare: z.number().min(0).max(1).default(0.35),
  billboards: z.number().int().min(0).max(200).default(36),
  seed: z.number().default(9),
});

type Params = z.infer<typeof citySchema>;

export interface Tower {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly seed: number;
}

/**
 * Tower footprints on the street grid: each snaps to a grid point (gx·grid, gz·grid), so the
 * streets run along the half-grid lines between them. `detail` is the quality scale (0.5 low,
 * 0.75 medium, 1 otherwise); `rand` continues afterwards (the billboards draw from it).
 */
export function placeTowers(p: Params, detail: number, rand: () => number): Tower[] {
  const target = Math.round(p.count * detail);
  const towers: Tower[] = [];
  const used = new Set<string>();
  for (let attempt = 0; attempt < target * 8 && towers.length < target; attempt++) {
    const dist = p.near + (p.far - p.near) * Math.pow(rand(), 0.8);
    const z0 = -dist;
    const x0 = (rand() * 2 - 1) * (dist * p.spread + 40);
    // Snap to the street grid so avenues stay open and towers line up.
    const gx = Math.round(x0 / p.grid);
    const gz = Math.round(z0 / p.grid);
    const key = `${gx},${gz}`;
    if (used.has(key)) continue;
    const x = gx * p.grid;
    const zz = gz * p.grid;
    if (p.exclude.some((e) => Math.hypot(x - e.center[0], zz - e.center[1]) < e.radius)) continue;
    used.add(key);
    const far = Math.min(1, dist / p.far);
    const maxW = Math.min(p.width[1], p.grid - p.street);
    const w = p.width[0] + (maxW - p.width[0]) * rand();
    const d = p.width[0] + (maxW - p.width[0]) * rand();
    const tall = p.height[0] + (p.height[1] - p.height[0]) * Math.pow(rand(), 1.6) * (1 - p.skyline + p.skyline * far * 1.4);
    const h = Math.max(p.height[0], tall);
    towers.push({ x, z: zz, w, d, h, seed: rand() });
  }
  return towers;
}

/** Quality scale the city uses for its tower count. */
export const cityDetail = (detail: 'low' | 'medium' | 'high' | 'ultra'): number => (detail === 'low' ? 0.5 : detail === 'medium' ? 0.75 : 1);

/**
 * A night city: instanced towers on a street grid with procedural lit windows, neon edge strips,
 * rooftop beacons and animated holographic billboards (original abstract designs, no text).
 */
export const cityComponent: ComponentFactory<Params> = {
  type: 'city',
  version: 1,
  description: 'Instanced night-city skyline with procedural windows, neon strips and holographic billboards.',
  schema: citySchema,
  create(ctx, p) {
    const rand = seeded(p.seed * 271 + 3);
    const detail = cityDetail(ctx.quality.detail);
    const towers = placeTowers(p, detail, rand);
    const matrices = towers.map((t) => new Matrix4().compose(new Vector3(t.x, p.ground, t.z), new Quaternion(), new Vector3(t.w, t.h, t.d)));
    const dims = towers.flatMap((t) => [t.w, t.h, t.d, t.seed]);
    const fronts = towers;
    const count = Math.max(1, matrices.length);
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const u = { presence: floatUniform(1), windows: floatUniform(p.windowBrightness), neon: floatUniform(1), music: floatUniform(0) };
    const time = ctx.uniforms.time;
    const dimAttr = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(dims.length ? dims : [1, 1, 1, 0]), 4), 'vec4');
    const seed = dimAttr.w;
    // Face-local coordinates in metres: horizontal along the face, vertical up the tower.
    const n = normalGeometry;
    const side = step(abs(n.y), 0.5);
    const horiz = mix(positionGeometry.z.mul(dimAttr.z), positionGeometry.x.mul(dimAttr.x), step(abs(n.x), 0.5));
    const vert = positionGeometry.y.mul(dimAttr.y);
    const cellU = horiz.div(p.windowWidth);
    const cellV = vert.div(p.floorHeight);
    const cell = vec2(floor(cellU), floor(cellV));
    const r = hash(cell.x.mul(13.1).add(cell.y.mul(71.7)).add(seed.mul(997)));
    const lit = step(float(1).sub(p.windowDensity), r);
    const pane = smoothstep(0.08, 0.16, fract(cellU)).mul(smoothstep(0.92, 0.84, fract(cellU))).mul(smoothstep(0.15, 0.25, fract(cellV))).mul(smoothstep(0.85, 0.75, fract(cellV)));
    const winCols = p.windows.map((c) => colorUniform(c));
    let winColor: Node<'vec3'> = winCols[0]!;
    for (let i = 1; i < winCols.length; i++) winColor = mix(winColor, winCols[i]!, step(i / winCols.length, hash(seed.mul(31.7).add(cell.y.mul(0.13)))));
    const flicker = sin(time.mul(0.7).add(r.mul(40))).mul(0.12).add(0.88);
    const groundFloor = step(vert, 6).mul(0.6);
    const windows = winColor.mul(lit.mul(pane).mul(flicker).add(groundFloor.mul(pane))).mul(side).mul(u.windows);
    // Neon edge strips on the corners of some towers, pulsing with the beat.
    const neonCols = p.neon.map((c) => colorUniform(c));
    let neonColor: Node<'vec3'> = neonCols[0]!;
    for (let i = 1; i < neonCols.length; i++) neonColor = mix(neonColor, neonCols[i]!, step(i / neonCols.length, fract(seed.mul(7.31))));
    const hasNeon = step(float(1).sub(p.neonShare), fract(seed.mul(3.17)));
    const edgeX = smoothstep(0.47, 0.5, abs(positionGeometry.x));
    const edgeZ = smoothstep(0.47, 0.5, abs(positionGeometry.z));
    const corner = edgeX.mul(edgeZ);
    const crown = step(0.985, positionGeometry.y).mul(max(edgeX, edgeZ));
    const neon = neonColor.mul(max(corner, crown)).mul(hasNeon).mul(float(1.2).add(u.music.mul(1.2))).mul(u.neon);
    // Rooftop beacons blinking slowly.
    const beacon = step(0.5, n.y).mul(smoothstep(0.12, 0, abs(positionGeometry.x)).mul(smoothstep(0.12, 0, abs(positionGeometry.z)))).mul(step(0.5, sin(time.mul(2).add(seed.mul(30))))).mul(step(0.6, seed));
    const emissive = windows.add(neon).add(vec3(1, 0.2, 0.15).mul(beacon.mul(2))).mul(u.presence);
    const material = new MeshStandardNodeMaterial();
    material.colorNode = vec4(colorUniform(p.facade).mul(float(0.8).add(seed.mul(0.4))), 1);
    material.roughness = 0.35;
    material.metalness = 0.3;
    material.emissiveNode = emissive;
    material.mrtNode = mrt({ emissive: vec4(emissive.mul(0.7), 1) });
    material.opacityNode = revealMask(u.presence);
    material.alphaTest = 0.5;
    const mesh = new InstancedMesh(box, material, count);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    const group = new Group();
    group.add(mesh);

    // Holographic billboards: abstract animated panels hung on tower fronts facing the viewer.
    let boardMat: MeshBasicNodeMaterial | null = null;
    let boards: InstancedMesh | null = null;
    const boardCount = Math.min(p.billboards, fronts.length);
    if (boardCount > 0) {
      const plane = new PlaneGeometry(1, 1);
      const bm: Matrix4[] = [];
      const bdata: number[] = [];
      const order = fronts.map((f) => ({ f, k: rand() })).sort((a, b) => a.k - b.k).slice(0, boardCount);
      for (const { f } of order) {
        const bw = Math.min(f.w * 0.8, 6 + rand() * 10);
        const bh = bw * (0.4 + rand() * 1.4);
        const by = p.ground + Math.min(f.h - bh / 2 - 2, 10 + rand() * f.h * 0.7);
        bm.push(new Matrix4().compose(new Vector3(f.x + (rand() - 0.5) * (f.w - bw) * 0.5, by, f.z + f.d / 2 + 0.6), new Quaternion(), new Vector3(bw, bh, 1)));
        bdata.push(rand(), rand(), rand(), rand());
      }
      const bd = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(bdata), 4), 'vec4');
      const q = uv();
      const stripes = sin(q.y.mul(40).add(time.mul(bd.y.mul(4).add(1)))).mul(0.5).add(0.5);
      const blocksPat = step(0.5, hash(floor(q.mul(vec2(6, 10))).add(floor(time.mul(bd.z.mul(2).add(0.5))).mul(7.3)).add(bd.x.mul(91))));
      const pattern = mix(stripes, blocksPat, step(0.5, bd.w));
      const frame = max(step(q.x, 0.04), max(step(0.96, q.x), max(step(q.y, 0.04), step(0.96, q.y))));
      let bColor: Node<'vec3'> = neonCols[0]!;
      for (let i = 1; i < neonCols.length; i++) bColor = mix(bColor, neonCols[i]!, step(i / neonCols.length, bd.x));
      const light = bColor.mul(pattern.mul(0.55).add(0.15).add(frame.mul(0.8))).mul(float(0.9).add(u.music.mul(0.8))).mul(u.neon).mul(u.presence);
      boardMat = new MeshBasicNodeMaterial();
      boardMat.colorNode = vec4(additiveFog(light), 1);
      boardMat.transparent = true;
      boardMat.depthWrite = false;
      boardMat.blending = AdditiveBlending;
      boardMat.side = DoubleSide;
      boardMat.fog = false;
      boardMat.mrtNode = mrt({ emissive: vec4(light.mul(0.6), 1) });
      boards = new InstancedMesh(plane, boardMat, bm.length);
      bm.forEach((m, i) => boards!.setMatrixAt(i, m));
      boards.instanceMatrix.needsUpdate = true;
      boards.computeBoundingSphere();
      group.add(boards);
    }
    return {
      object: group,
      reactive: { windows: u.windows, neon: u.neon },
      update(frame) {
        u.music.value = frame.audio.bass * 0.5 + frame.audio.beatPulse * 0.5;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        box.dispose();
        material.dispose();
        mesh.dispose();
        boards?.geometry.dispose();
        boardMat?.dispose();
        boards?.dispose();
      },
    };
  },
};
