/**
 * Builds the placeholder tower of The Warden's Spire from the owner's Sketchfab download of
 * "Barad Dur_ No Base" by phillipRivers (CC BY 4.0), imported with
 *
 *   node scripts/fetch-sketchfab.ts b31c712a66d446b8880188c5f8047748 barad-dur --zip <downloaded zip> --source-only
 *   node scripts/build-spire-tower.ts [--source <scene.gltf>] [--preview <dir>] [--crag] [--height 560]
 *
 * 1. Flattens the scan's 69 meshes into three groups by source material: the architecture
 *    (`model`, `mordorMetal`), the crag it stands on (`AAbasalt_Hawaii`, `Rock006_*` and the
 *    hidden rock core `BaradDurMAT`) and the lit windows (`LightsMAT`). UVs are dropped: the
 *    game shades it triplanar.
 * 2. Converts to the citadel's frame (content/stages/wardens-spire/citadel.ts): Y up, the gate
 *    facing +Z, the tower's axis at x = z = 0, the plateau at y = 0, in "site units" (the site
 *    `scale` turns them into metres, 0.8 by default), so the horn tips stand HEIGHT units high.
 * 3. Welds, then sorts the rock out of the masonry by connected piece (a piece whose surface is
 *    mostly not axis-aligned is rock). The scan's crag, a pile of boulders behind and around the
 *    fortress up to the tower's foot, made the whole site read as a black lump on the horizon,
 *    so only the low rubble around the base is kept (pieces from the ground up to CRAG_MAX);
 *    `--crag` keeps all of it.
 * 4. Simplifies each group with meshoptimizer to its triangle budget (near and far levels), and
 *    rebuilds normals with a crease angle per group (hard edges on the stonework, smooth rock).
 * 5. Measures where the Warden fits (the largest free sphere on the axis between the horns) and
 *    a coarse height grid for the beam's reach, and stores them in the scene's extras
 *    (`prismfall.summit`, `cageRoom`, `heights`), which citadel.ts and warden.ts read.
 * 6. Writes models/tower.glb (near) and tower_lod1.glb (low detail): quantised,
 *    meshopt-compressed, materials spireStone / spireRock / spireGlow.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Document, NodeIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = resolve(import.meta.dirname, '..');
const opt = (flag: string, def: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const SOURCE = resolve(ROOT, opt('--source', 'assets/external/sketchfab/barad-dur/gltf/scene.gltf'));
/** Also write uncompressed copies here (for a look in Blender). */
const PREVIEW = opt('--preview', '');
const OUT = join(ROOT, 'content/stages/wardens-spire/models');
/** Height of the horn tips above the plateau, in site units (a little below the citadel's needle, about 590, so they clear the top of the view). */
const HEIGHT = Number(opt('--height', '560'));
/** Source height (glTF Y, source units) where the scan's ground is; anything lower is buried. */
const GROUND = -550;
/** Source height band (glTF Y) where the shaft is clean, for finding the tower's axis. */
const AXIS_BAND: [number, number] = [300, 450];
/** Keep the whole crag (otherwise only rock pieces touching the ground and lower than CRAG_MAX). */
const CRAG = process.argv.includes('--crag');
/** Rock pieces kept without --crag: from the ground (bottom below 30 units) up to this height (below the curtain wall's top). */
const CRAG_MAX = Number(opt('--crag-max', '115'));
/** Source material → output group. */
const GROUPS = [
  { name: 'spireStone', match: /^(model|mordorMetal)$/, crease: 40 },
  // BaradDurMAT is a coarse rock core hidden inside the crag, not a light.
  { name: 'spireRock', match: /^(AAbasalt|Rock006|BaradDurMAT)/, crease: 75 },
  { name: 'spireGlow', match: /^LightsMAT$/, crease: 40 },
] as const;
type GroupName = (typeof GROUPS)[number]['name'];
/** Triangle budgets per level. */
const LODS: { file: string; budget: Record<GroupName, number>; error: number }[] = [
  { file: 'tower.glb', budget: { spireStone: Number(opt('--stone', '150000')), spireRock: Number(opt('--rock', '36000')), spireGlow: 4000 }, error: 0.02 },
  { file: 'tower_lod1.glb', budget: { spireStone: Number(opt('--lod-stone', '32000')), spireRock: Number(opt('--lod-rock', '8000')), spireGlow: 1200 }, error: 0.05 },
];
/** Height grid for the beam's reach: cells across the footprint. */
const GRID = 40;

if (!existsSync(SOURCE)) {
  console.error(`no source model at ${SOURCE}\nimport it first: node scripts/fetch-sketchfab.ts b31c712a66d446b8880188c5f8047748 barad-dur --zip <zip> --source-only`);
  process.exit(1);
}
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready]);

// ---- 1. Source triangles per group, in glTF world space.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const src = await io.read(SOURCE);
const raw = new Map<GroupName, { pos: number[]; tris: number }>(GROUPS.map((g) => [g.name, { pos: [], tris: 0 }]));
let sourceTris = 0;
for (const node of src.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const matName = prim.getMaterial()?.getName() ?? '';
    const group = GROUPS.find((g) => g.match.test(matName));
    if (!group) throw new Error(`unmapped source material "${matName}"`);
    const pa = prim.getAttribute('POSITION')!.getArray()!;
    const ia = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pa.length / 3 }, (_, k) => k);
    const out = raw.get(group.name)!;
    for (let k = 0; k < ia.length; k++) {
      const v = ia[k]! * 3;
      const x = pa[v]!, y = pa[v + 1]!, z = pa[v + 2]!;
      out.pos.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    }
    out.tris += ia.length / 3;
    sourceTris += ia.length / 3;
  }
}
console.log(`source: ${sourceTris} triangles (${[...raw].map(([k, v]) => `${k} ${v.tris}`).join(', ')})`);

// ---- 2. The citadel's frame: axis of the shaft at the origin, ground at 0, site units.
const stone = raw.get('spireStone')!.pos;
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity;
for (let k = 0; k < stone.length; k += 3) {
  const y = stone[k + 1]!;
  top = Math.max(top, y);
  if (y < AXIS_BAND[0] || y > AXIS_BAND[1]) continue;
  x0 = Math.min(x0, stone[k]!);
  x1 = Math.max(x1, stone[k]!);
  z0 = Math.min(z0, stone[k + 2]!);
  z1 = Math.max(z1, stone[k + 2]!);
}
const axis = [(x0 + x1) / 2, (z0 + z1) / 2] as const;
const f = HEIGHT / (top - GROUND);
console.log(`shaft axis (source) x ${axis[0].toFixed(2)} z ${axis[1].toFixed(2)}, tip ${top.toFixed(1)}, ground ${GROUND}; scale to site units ${f.toFixed(4)}`);
for (const g of raw.values()) {
  for (let k = 0; k < g.pos.length; k += 3) {
    g.pos[k] = (g.pos[k]! - axis[0]) * f;
    g.pos[k + 1] = (g.pos[k + 1]! - GROUND) * f;
    g.pos[k + 2] = (g.pos[k + 2]! - axis[1]) * f;
  }
}

// ---- 3. Weld (positions only; normals come back with creases after simplifying).
function weld(soup: number[], tol: number): { positions: Float32Array; indices: Uint32Array } {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < soup.length; k += 3) {
    const key = `${Math.round(soup[k]! / tol)},${Math.round(soup[k + 1]! / tol)},${Math.round(soup[k + 2]! / tol)}`;
    let i = map.get(key);
    if (i === undefined) {
      i = pos.length / 3;
      map.set(key, i);
      pos.push(soup[k]!, soup[k + 1]!, soup[k + 2]!);
    }
    idx.push(i);
  }
  // Drop triangles that collapsed in the weld.
  const tri: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tri) };
}

/** Splits vertices where faces meet at more than `crease` degrees; area-weighted smooth normals elsewhere. */
function creaseNormals(positions: Float32Array, indices: Uint32Array, crease: number): { positions: Float32Array<ArrayBuffer>; normals: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const nt = indices.length / 3;
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3]! * 3, b = indices[t * 3 + 1]! * 3, c = indices[t * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    fn[t * 3] = uy * vz - uz * vy;
    fn[t * 3 + 1] = uz * vx - ux * vz;
    fn[t * 3 + 2] = ux * vy - uy * vx;
  }
  const nv = positions.length / 3;
  const start = new Uint32Array(nv + 1);
  for (let k = 0; k < indices.length; k++) start[indices[k]! + 1]!++;
  for (let v = 0; v < nv; v++) start[v + 1]! += start[v]!;
  const fill = start.slice(0, nv);
  const corners = new Uint32Array(indices.length);
  for (let k = 0; k < indices.length; k++) corners[fill[indices[k]!]!++] = k;
  const cosC = Math.cos((crease * Math.PI) / 180);
  const outPos: number[] = [];
  const outNrm: number[] = [];
  const outIdx = new Uint32Array(indices.length);
  const unit = (t: number): [number, number, number] => {
    const x = fn[t * 3]!, y = fn[t * 3 + 1]!, z = fn[t * 3 + 2]!;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  for (let v = 0; v < nv; v++) {
    const clusters: { ref: [number, number, number]; sum: [number, number, number]; corners: number[] }[] = [];
    for (let s = start[v]!; s < start[v + 1]!; s++) {
      const k = corners[s]!;
      const t = (k / 3) | 0;
      const u = unit(t);
      let cl = clusters.find((c) => c.ref[0] * u[0] + c.ref[1] * u[1] + c.ref[2] * u[2] >= cosC);
      if (!cl) {
        cl = { ref: u, sum: [0, 0, 0], corners: [] };
        clusters.push(cl);
      }
      cl.sum[0] += fn[t * 3]!;
      cl.sum[1] += fn[t * 3 + 1]!;
      cl.sum[2] += fn[t * 3 + 2]!;
      cl.corners.push(k);
    }
    for (const cl of clusters) {
      const i = outPos.length / 3;
      outPos.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
      const l = Math.hypot(cl.sum[0], cl.sum[1], cl.sum[2]) || 1;
      outNrm.push(cl.sum[0] / l, cl.sum[1] / l, cl.sum[2] / l);
      for (const k of cl.corners) outIdx[k] = i;
    }
  }
  return { positions: new Float32Array(outPos), normals: new Float32Array(outNrm), indices: outIdx };
}

const welded = new Map<GroupName, { positions: Float32Array; indices: Uint32Array }>();
for (const [name, g] of raw) {
  const w = weld(g.pos, 0.004);
  welded.set(name, w);
  console.log(`  ${name}: ${g.tris} source triangles, ${w.positions.length / 3} welded vertices, ${w.indices.length / 3} triangles after weld`);
}

interface Piece {
  tris: number[];
  y0: number;
  y1: number;
  /** Share of the surface that is neither level nor vertical. */
  rocky: number;
}

/** Connected pieces of a welded mesh: triangle lists with their height range and how much of their surface is not axis-aligned. */
function pieces(w: { positions: Float32Array; indices: Uint32Array }): Piece[] {
  const nv = w.positions.length / 3;
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  for (let t = 0; t < w.indices.length; t += 3) {
    const a = find(w.indices[t]!);
    parent[find(w.indices[t + 1]!)] = a;
    parent[find(w.indices[t + 2]!)] = a;
  }
  const out = new Map<number, { tris: number[]; y0: number; y1: number; area: number; off: number }>();
  const p = w.positions;
  for (let t = 0; t < w.indices.length; t += 3) {
    const ia = w.indices[t]! * 3, ib = w.indices[t + 1]! * 3, ic = w.indices[t + 2]! * 3;
    const ux = p[ib]! - p[ia]!, uy = p[ib + 1]! - p[ia + 1]!, uz = p[ib + 2]! - p[ia + 2]!;
    const vx = p[ic]! - p[ia]!, vy = p[ic + 1]! - p[ia + 1]!, vz = p[ic + 2]! - p[ia + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const up = Math.abs(ny) / len;
    const r = find(w.indices[t]!);
    let c = out.get(r);
    if (!c) out.set(r, (c = { tris: [], y0: Infinity, y1: -Infinity, area: 0, off: 0 }));
    c.tris.push(t / 3);
    c.area += len;
    if (up > 0.12 && up < 0.97) c.off += len;
    c.y0 = Math.min(c.y0, p[ia + 1]!, p[ib + 1]!, p[ic + 1]!);
    c.y1 = Math.max(c.y1, p[ia + 1]!, p[ib + 1]!, p[ic + 1]!);
  }
  return [...out.values()].map((c) => ({ tris: c.tris, y0: c.y0, y1: c.y1, rocky: c.off / (c.area || 1) }));
}

/** A welded mesh made of some of another's triangles (vertices compacted). */
function subset(w: { positions: Float32Array; indices: Uint32Array }, tris: number[]): { positions: Float32Array; indices: Uint32Array } {
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, k) => {
    for (let c = 0; c < 3; c++) {
      const v = w.indices[t * 3 + c]!;
      let i = remap.get(v);
      if (i === undefined) {
        i = pos.length / 3;
        remap.set(v, i);
        pos.push(w.positions[v * 3]!, w.positions[v * 3 + 1]!, w.positions[v * 3 + 2]!);
      }
      idx[k * 3 + c] = i;
    }
  });
  return { positions: new Float32Array(pos), indices: idx };
}

// Rock out of the masonry; the crag down to its low rubble.
{
  const keepRock = (pc: { y0: number; y1: number }) => CRAG || (pc.y0 < 30 && pc.y1 <= CRAG_MAX);
  const stoneW = welded.get('spireStone')!;
  const rockW = welded.get('spireRock')!;
  const stonePieces = pieces(stoneW);
  const masonryPieces: Piece[] = [];
  const rockA: number[] = [];
  const rockBPieces: Piece[] = [];
  let dropped = 0;
  for (const pc of stonePieces) {
    if (pc.tris.length > 500 && pc.rocky > 0.5) {
      if (keepRock(pc)) rockA.push(...pc.tris);
      else dropped += pc.tris.length;
    } else masonryPieces.push(pc);
  }
  for (const pc of pieces(rockW)) {
    if (keepRock(pc)) rockBPieces.push(pc);
    else dropped += pc.tris.length;
  }
  // Masonry the dropped crag held up (a turret standing on a boulder) would float: keep only
  // what stands on the ground or, piece by piece, on or against something already standing.
  let floating = 0;
  if (!CRAG) {
    const cell = 4;
    const grid = new Map<string, { x: number; y: number; z: number; id: number }[]>();
    const vertsOf = (w: { positions: Float32Array; indices: Uint32Array }, pc: Piece): number[] => {
      const set = new Set<number>();
      for (const t of pc.tris) for (let c = 0; c < 3; c++) set.add(w.indices[t * 3 + c]!);
      return [...set];
    };
    const add = (w: { positions: Float32Array; indices: Uint32Array }, pc: Piece, id: number) => {
      for (const v of vertsOf(w, pc)) {
        const key = `${Math.floor(w.positions[v * 3]! / cell)},${Math.floor(w.positions[v * 3 + 2]! / cell)}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push({ x: w.positions[v * 3]!, y: w.positions[v * 3 + 1]!, z: w.positions[v * 3 + 2]!, id });
      }
    };
    masonryPieces.forEach((pc, i) => add(stoneW, pc, i));
    const rockId = masonryPieces.length;
    add(stoneW, { tris: rockA, y0: 0, y1: 0, rocky: 1 }, rockId);
    for (const pc of rockBPieces) add(rockW, pc, rockId);
    /** Does any vertex of the piece lie within a unit of a vertex of a standing piece? */
    const touches = (w: { positions: Float32Array; indices: Uint32Array }, pc: Piece, self: number, ok: Set<number>): boolean => {
      for (const v of vertsOf(w, pc)) {
        const px = w.positions[v * 3]!, py = w.positions[v * 3 + 1]!, pz = w.positions[v * 3 + 2]!;
        const x = Math.floor(px / cell);
        const zz = Math.floor(pz / cell);
        for (let a = -1; a <= 1; a++)
          for (let b = -1; b <= 1; b++)
            for (const e of grid.get(`${x + a},${zz + b}`) ?? []) if (e.id !== self && ok.has(e.id) && Math.hypot(e.x - px, e.y - py, e.z - pz) < 1) return true;
      }
      return false;
    };
    const standing = new Set<number>([rockId]);
    masonryPieces.forEach((pc, i) => pc.y0 < 20 && standing.add(i));
    const bottoms = masonryPieces.map((pc) => vertsOf(stoneW, pc).filter((v) => stoneW.positions[v * 3 + 1]! < pc.y0 + 2));
    for (let changed = true; changed; ) {
      changed = false;
      masonryPieces.forEach((_, i) => {
        if (standing.has(i)) return;
        const bottom = bottoms[i]!;
        let held = 0;
        for (const v of bottom) {
          const x = Math.floor(stoneW.positions[v * 3]! / cell);
          const zz = Math.floor(stoneW.positions[v * 3 + 2]! / cell);
          const y = stoneW.positions[v * 3 + 1]!;
          search: for (let a = -1; a <= 1; a++)
            for (let b = -1; b <= 1; b++)
              for (const e of grid.get(`${x + a},${zz + b}`) ?? [])
                if (e.id !== i && standing.has(e.id) && e.y > y - 10 && e.y < y + 2) {
                  held++;
                  break search;
                }
        }
        if (held >= bottom.length * 0.15 || touches(stoneW, masonryPieces[i]!, i, standing)) {
          standing.add(i);
          changed = true;
        }
      });
    }
    // Windows go with the walls they are set in.
    const glowW = welded.get('spireGlow')!;
    const lit = pieces(glowW).filter((pc) => {
      for (const v of vertsOf(glowW, pc)) {
        const px = glowW.positions[v * 3]!, py = glowW.positions[v * 3 + 1]!, pz = glowW.positions[v * 3 + 2]!;
        const x = Math.floor(px / cell);
        const zz = Math.floor(pz / cell);
        for (let a = -1; a <= 1; a++)
          for (let b = -1; b <= 1; b++) for (const e of grid.get(`${x + a},${zz + b}`) ?? []) if (standing.has(e.id) && Math.hypot(e.x - px, e.y - py, e.z - pz) < 2) return true;
      }
      floating += pc.tris.length;
      return false;
    });
    welded.set('spireGlow', subset(glowW, lit.flatMap((pc) => pc.tris)));
    for (let i = masonryPieces.length - 1; i >= 0; i--)
      if (!standing.has(i)) {
        floating += masonryPieces[i]!.tris.length;
        masonryPieces.splice(i, 1);
      }
  }
  const masonry = masonryPieces.flatMap((pc) => pc.tris);
  const rockB = rockBPieces.flatMap((pc) => pc.tris);
  const a = subset(stoneW, rockA);
  const b = subset(rockW, rockB);
  const off = a.positions.length / 3;
  const rockIdx = new Uint32Array(a.indices.length + b.indices.length);
  rockIdx.set(a.indices);
  for (let k = 0; k < b.indices.length; k++) rockIdx[a.indices.length + k] = b.indices[k]! + off;
  const rockPos = new Float32Array(a.positions.length + b.positions.length);
  rockPos.set(a.positions);
  rockPos.set(b.positions, a.positions.length);
  welded.set('spireStone', subset(stoneW, masonry));
  welded.set('spireRock', { positions: rockPos, indices: rockIdx });
  console.log(`  sorted: masonry ${masonry.length} triangles, rock ${rockIdx.length / 3} (${rockA.length} of them from the masonry's materials), crag dropped ${dropped}${CRAG ? '' : ` (pieces above ${CRAG_MAX} units), masonry left floating dropped ${floating}`}`);
}

// ---- 4. Where the Warden fits, and the height grid (from the welded full-detail stone).
const all = welded.get('spireStone')!.positions;
const tip = HEIGHT;
let best = { y: 0, r: 0 };
const near: number[] = [];
for (let k = 0; k < all.length; k += 3) if (all[k + 1]! > tip * 0.8) near.push(all[k]!, all[k + 1]!, all[k + 2]!);
const room: string[] = [];
for (let y = tip * 0.86; y <= tip; y += tip * 0.004) {
  let r = Infinity;
  for (let k = 0; k < near.length; k += 3) r = Math.min(r, Math.hypot(near[k]!, near[k + 1]! - y, near[k + 2]!));
  // The cage sits between the horns: its whole sphere below their tips.
  if (y + r <= tip && r > best.r) best = { y, r };
  room.push(`${y.toFixed(0)}:${r.toFixed(1)}`);
}
console.log(`free radius on the axis (height:radius) ${room.join(' ')}`);
console.log(`Warden's place: ${best.y.toFixed(1)} units up, ${best.r.toFixed(1)} units of room`);

/**
 * Top of the tower's mass over a GRID x GRID grid across its footprint (for where the beam meets
 * it). Nothing above `ceiling` counts: the horns stand beside the Warden and the beam passes them.
 */
function heightGrid(groups: { positions: Float32Array }[], ceiling: number): { half: number; n: number; h: number[] } {
  let half = 0;
  for (const g of groups) for (let k = 0; k < g.positions.length; k += 3) half = Math.max(half, Math.abs(g.positions[k]!), Math.abs(g.positions[k + 2]!));
  half = Math.ceil(half);
  const h = new Array<number>(GRID * GRID).fill(0);
  for (const g of groups)
    for (let k = 0; k < g.positions.length; k += 3) {
      if (g.positions[k + 1]! > ceiling) continue;
      const i = Math.min(GRID - 1, Math.floor(((g.positions[k]! + half) / (2 * half)) * GRID));
      const j = Math.min(GRID - 1, Math.floor(((g.positions[k + 2]! + half) / (2 * half)) * GRID));
      h[j * GRID + i] = Math.max(h[j * GRID + i]!, Math.round(g.positions[k + 1]!));
    }
  return { half, n: GRID, h };
}

// ---- 5. Levels of detail.
for (const lod of LODS) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('tower');
  const root = doc.createNode('tower');
  scene.addChild(root);
  const parts: { positions: Float32Array }[] = [];
  let total = 0;
  const report: string[] = [];
  for (const g of GROUPS) {
    const w = welded.get(g.name)!;
    const target = Math.min(w.indices.length, lod.budget[g.name] * 3);
    let out = w.indices;
    let err = 0;
    if (target < w.indices.length) {
      [out, err] = MeshoptSimplifier.simplify(w.indices, w.positions, 3, target, lod.error, []);
      if (out.length > target * 1.15) [out, err] = MeshoptSimplifier.simplify(w.indices, w.positions, 3, target, lod.error, ['Permissive']);
      if (out.length > target * 1.15) [out, err] = MeshoptSimplifier.simplify(w.indices, w.positions, 3, target, 1, ['Permissive']);
    }
    // Compact vertices, then crease normals.
    const remap = new Int32Array(w.positions.length / 3).fill(-1);
    const pos: number[] = [];
    const idx = new Uint32Array(out.length);
    for (let k = 0; k < out.length; k++) {
      const v = out[k]!;
      if (remap[v] === -1) {
        remap[v] = pos.length / 3;
        pos.push(w.positions[v * 3]!, w.positions[v * 3 + 1]!, w.positions[v * 3 + 2]!);
      }
      idx[k] = remap[v]!;
    }
    const mesh = creaseNormals(new Float32Array(pos), idx, g.crease);
    parts.push(mesh);
    total += mesh.indices.length / 3;
    report.push(`${g.name} ${mesh.indices.length / 3} tris (${mesh.positions.length / 3} verts, error ${(err * 100).toFixed(2)}%)`);
    const prim: Primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(mesh.positions))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(mesh.normals))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(mesh.positions.length / 3 > 65535 ? mesh.indices : new Uint16Array(mesh.indices)))
      .setMaterial(doc.createMaterial(g.name).setBaseColorFactor([0.2, 0.2, 0.2, 1]).setRoughnessFactor(0.9).setMetallicFactor(0));
    root.addChild(doc.createNode(`tower_${g.name.replace('spire', '').toLowerCase()}`).setMesh(doc.createMesh(`tower_${g.name}`).addPrimitive(prim)));
  }
  const grid = heightGrid(parts, best.y - best.r);
  scene.setExtras({
    prismfall: {
      source: 'scripts/build-spire-tower.ts from Sketchfab "Barad Dur_ No Base" by phillipRivers (CC BY 4.0)',
      unit: 'site units (the site scale turns them into metres)',
      summit: Math.round(best.y * 10) / 10,
      cageRoom: Math.round(best.r * 10) / 10,
      heights: grid,
    },
  });
  if (PREVIEW) await io.write(join(PREVIEW, lod.file.replace('.glb', '.preview.glb')), doc);
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 14, quantizeNormal: 8 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const file = join(OUT, lod.file);
  writeFileSync(file, await io.writeBinary(doc));
  console.log(`${lod.file}: ${total} triangles, ${(statSync(file).size / 1024).toFixed(0)} KB: ${report.join('; ')}`);
}
