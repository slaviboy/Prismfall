import { Material, Mesh, type BufferGeometry, type Object3D, type Texture } from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

interface Entry {
  promise: Promise<GLTF>;
  refs: number;
  gltf: GLTF | null;
}

/** Disposes every geometry, material and texture under an object. */
export function disposeObject(root: Object3D): void {
  const textures = new Set<Texture>();
  root.traverse((obj) => {
    if (obj instanceof Mesh) {
      (obj.geometry as BufferGeometry).dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!(m instanceof Material)) continue;
        for (const value of Object.values(m)) {
          if (value && typeof value === 'object' && (value as Texture).isTexture) textures.add(value as Texture);
        }
        m.dispose();
      }
    }
  });
  textures.forEach((t) => t.dispose());
}

/**
 * Ref-counted GLB cache. Loading the same URL twice shares one parse; releasing the last
 * reference disposes all GPU resources of that asset.
 */
export class AssetCache {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly entries = new Map<string, Entry>();

  load(url: string, onProgress?: (fraction: number) => void): Promise<GLTF> {
    let entry = this.entries.get(url);
    if (!entry) {
      const created: Entry = {
        refs: 0,
        gltf: null,
        promise: new Promise<GLTF>((resolve, reject) => {
          this.loader.load(
            url,
            (gltf) => {
              created.gltf = gltf;
              resolve(gltf);
            },
            (ev) => {
              if (onProgress && ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
            },
            (err) => {
              this.entries.delete(url);
              reject(err instanceof Error ? err : new Error(`Failed to load ${url}`));
            },
          );
        }),
      };
      entry = created;
      this.entries.set(url, entry);
    }
    entry.refs++;
    return entry.promise;
  }

  release(url: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      this.entries.delete(url);
      if (entry.gltf) disposeObject(entry.gltf.scene);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): { url: string; refs: number }[] {
    return [...this.entries.entries()].map(([url, e]) => ({ url, refs: e.refs }));
  }
}

export const assetCache = new AssetCache();
