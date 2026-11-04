import { describe, expect, it } from 'vitest';
import { compare, readSnapshot } from './protectedPlayfield.ts';

/*
 * The board, the seven pieces, their materials and lighting, the camera framing and the gameplay
 * feedback are protected (PROTECTED_PLAYFIELD.md). Background and world work must leave these files
 * and manifest fields exactly as they were. If a board change is deliberate, regenerate the snapshot
 * with `node scripts/protectedPlayfield.ts --update` in the same commit and say why.
 */
describe('protected playfield', () => {
  const changes = compare(readSnapshot());

  it('leaves the board, block, camera, light-rig, post and engine sources unchanged', () => {
    expect({ changed: changes.changedSources, missing: changes.missingSources, added: changes.addedSources }).toEqual({ changed: [], missing: [], added: [] });
  });

  it("leaves every world's palette, light rig, grade, fog, camera, blocks and board effects unchanged", () => {
    expect({ changed: changes.changedManifests, missing: changes.missingManifests }).toEqual({ changed: [], missing: [] });
  });
});
