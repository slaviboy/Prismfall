import { describe, expect, it } from 'vitest';
import { BLOCK_GEOMETRIES } from '../board/blockLibrary';
import { BLOCK_DESIGNS, getBlockDesign } from './blockDesigns';
import { BLOCK_PRESETS } from './blockPresets';
import { BLOCK_SURFACES } from './blockSurfaces';

describe('block designs', () => {
  it('have unique ids and point at real presets, surfaces and shapes', () => {
    const ids = new Set(BLOCK_DESIGNS.map((d) => d.id));
    expect(ids.size).toBe(BLOCK_DESIGNS.length);
    for (const d of BLOCK_DESIGNS) {
      const preset = BLOCK_PRESETS[d.material];
      expect(preset, d.id).toBeDefined();
      expect(BLOCK_SURFACES).toContain(preset.surface);
      expect(BLOCK_GEOMETRIES).toContain(d.geometry);
      expect(d.name.length).toBeGreaterThan(0);
    }
  });

  it('cover every world design and every library surface', () => {
    const used = new Set(BLOCK_DESIGNS.map((d) => BLOCK_PRESETS[d.material].surface));
    for (const s of BLOCK_SURFACES) if (s !== 'plain') expect(used, s).toContain(s);
    expect(getBlockDesign('marble')?.geometry).toBe('orb');
    expect(getBlockDesign('nope')).toBeNull();
  });
});
