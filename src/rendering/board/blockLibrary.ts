import { Mesh, type BufferGeometry } from 'three/webgpu';
import { assetCache } from '../assets/AssetCache';
import { normaliseBlockGeometry } from './blockGeometry';

/** Blender-authored block designs (assets/blender/scripts/blocks.py), resolved to hashed URLs by Vite. */
const BLOCK_URLS = import.meta.glob('/content/shared/blocks/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export const BLOCK_GEOMETRIES = ['soft', 'chamfer', 'faceted', 'pillow', 'framed', 'procedural', 'orb', 'tile'] as const;
export type BlockGeometryId = (typeof BLOCK_GEOMETRIES)[number];

export function blockUrl(id: string): string | null {
  return BLOCK_URLS[`/content/shared/blocks/${id}.glb`] ?? null;
}

/** Loads a block design and returns its geometry normalised to the board's cell size. */
export async function loadBlockGeometry(id: string): Promise<BufferGeometry | null> {
  const url = blockUrl(id);
  if (!url) return null;
  try {
    const gltf = await assetCache.load(url);
    let geometry: BufferGeometry | null = null;
    gltf.scene.traverse((obj) => {
      if (!geometry && obj instanceof Mesh) geometry = obj.geometry as BufferGeometry;
    });
    const result = geometry ? normaliseBlockGeometry(geometry) : null;
    // The normalised clone is independent; the cached source can be released.
    assetCache.release(url);
    return result;
  } catch (err) {
    console.warn(`[blocks] could not load block design "${id}", using the procedural block`, err);
    return null;
  }
}
