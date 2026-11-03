import { SphereGeometry, type BufferGeometry } from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** Block edge length; 1 - BLOCK_SIZE is the visible gap between neighbours. */
export const BLOCK_SIZE = 0.94;

/**
 * Procedural bevelled block used until (and as a fallback for) the Blender block library.
 * Geometry is centred on the origin, spanning ±BLOCK_SIZE/2.
 */
export function createRoundedBlock(segments = 4, radius = 0.12): BufferGeometry {
  const g = new RoundedBoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE, segments, radius);
  g.computeBoundingSphere();
  return g;
}

/** A round bead or marble in place of a cube (orb designs). */
export function createOrbBlock(): BufferGeometry {
  const g = new SphereGeometry(BLOCK_SIZE * 0.48, 40, 28);
  g.computeBoundingSphere();
  return g;
}

/** A slim rounded tile: full face, half the depth (tile designs). */
export function createTileBlock(): BufferGeometry {
  const g = new RoundedBoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE * 0.55, 4, 0.07);
  g.computeBoundingSphere();
  return g;
}

/** Procedural block shapes that need no Blender file, by design id. */
export function proceduralBlock(id: string): BufferGeometry | null {
  if (id === 'procedural') return createRoundedBlock();
  if (id === 'orb') return createOrbBlock();
  if (id === 'tile') return createTileBlock();
  return null;
}

/** Normalises an imported block mesh to the board's cell size (centred, BLOCK_SIZE wide). */
export function normaliseBlockGeometry(source: BufferGeometry): BufferGeometry {
  const g = source.clone();
  g.computeBoundingBox();
  const box = g.boundingBox;
  if (!box) return g;
  const sx = box.max.x - box.min.x;
  const sy = box.max.y - box.min.y;
  const sz = box.max.z - box.min.z;
  const scale = BLOCK_SIZE / Math.max(sx, sy, sz);
  g.translate(-(box.min.x + sx / 2), -(box.min.y + sy / 2), -(box.min.z + sz / 2));
  g.scale(scale, scale, scale);
  g.computeBoundingSphere();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}
