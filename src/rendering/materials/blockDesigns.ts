import type { BlockGeometryId } from '../board/blockLibrary';
import type { BlockPresetId } from './blockPresets';

/** A named block design: a surface preset on a block shape. Players pick these for any world. */
export interface BlockDesign {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly material: BlockPresetId;
  readonly geometry: BlockGeometryId;
}

/**
 * The block design library: the library designs first, then the designs the worlds use. Ids are
 * stored in settings and custom levels, so keep them stable.
 */
export const BLOCK_DESIGNS: readonly BlockDesign[] = [
  { id: 'prism', name: 'Prism', description: 'Polished glass with a softly lit core.', material: 'prism', geometry: 'framed' },
  { id: 'lumen', name: 'Lumen', description: 'Dark smoked tiles, each outlined by one crisp lit line.', material: 'lumenFrame', geometry: 'chamfer' },
  { id: 'dichroic', name: 'Dichroic', description: 'Glass with a thin-film sheen that shifts hue as you look across it.', material: 'dichroicGlass', geometry: 'chamfer' },
  { id: 'ingot', name: 'Ingot', description: 'Polished anodised metal with a brushed grain and an engraved panel.', material: 'polishedIngot', geometry: 'chamfer' },
  { id: 'ribbon', name: 'Ribbon', description: 'Candy glass banded with diagonal ribbons of colour.', material: 'ribbonGlass', geometry: 'soft' },
  { id: 'gel', name: 'Gel', description: 'Deep jelly cubes that squash and rebound as they land.', material: 'jellyGel', geometry: 'pillow' },
  { id: 'rosette', name: 'Rosette', description: 'Lacquered tiles pressed with a gilded eight-petal rosette.', material: 'rosetteLacquer', geometry: 'soft' },
  { id: 'marble', name: 'Marble', description: 'Glass marbles with a twist of colour inside.', material: 'glassMarble', geometry: 'orb' },
  { id: 'lantern', name: 'Lantern', description: 'Paper lanterns on bamboo ribs, lit warmly from inside.', material: 'paperLantern', geometry: 'soft' },
  { id: 'pearl', name: 'Pearl', description: 'Smooth pearl glass (Luminous Tide).', material: 'pearlGlass', geometry: 'soft' },
  { id: 'frost', name: 'Frost', description: 'Frosted ice with fractures lit from within (Frozen Kingdom).', material: 'frozenCrystal', geometry: 'faceted' },
  { id: 'wood', name: 'Carved wood', description: 'Ringed grain with a carved inset line (Ancient Garden).', material: 'carvedWood', geometry: 'chamfer' },
  { id: 'sandstone', name: 'Sandstone', description: 'Wind-laid strata with the odd golden glint (Moving Sands).', material: 'desertSandstone', geometry: 'chamfer' },
  { id: 'cosmic', name: 'Cosmic', description: 'A drifting nebula and stars inside each block (Deep Cosmos).', material: 'cosmicCrystal', geometry: 'faceted' },
  { id: 'stone', name: 'Alpine stone', description: 'Polished stone with flowing veins (Alpine Horizon).', material: 'alpineStone', geometry: 'chamfer' },
  { id: 'ocean', name: 'Ocean glass', description: 'Water glass with rising bubbles and caustics (The Abyss).', material: 'oceanGlass', geometry: 'soft' },
  { id: 'emerald', name: 'Emerald', description: 'Faceted crystal with organic veins (Enchanted Wilderness).', material: 'forestEmerald', geometry: 'faceted' },
  { id: 'obsidian', name: 'Obsidian', description: 'Black volcanic glass with glowing cracks (Ember Core).', material: 'volcanicObsidian', geometry: 'faceted' },
  { id: 'aurora', name: 'Aurora', description: 'Crystal whose inner light drifts between hues (Northern Lights).', material: 'auroraCrystal', geometry: 'faceted' },
  { id: 'neon', name: 'Neon', description: 'Smoked glass with a fine lit grid (Future Nights).', material: 'neonGlass', geometry: 'framed' },
  { id: 'forged', name: 'Forged metal', description: 'Hammered metal with hot seams (Ember Foundry).', material: 'forgedMetal', geometry: 'chamfer' },
  { id: 'washi', name: 'Washi', description: 'Soft fibrous paper (Folded Sky).', material: 'washiSheet', geometry: 'chamfer' },
  { id: 'basalt', name: 'Basalt', description: "Dark volcanic stone veined with molten light, on iron-dark edges (The Warden's Spire).", material: 'wardenBasalt', geometry: 'chamfer' },
  { id: 'veil', name: 'Veil glass', description: 'Smoked glass holding a slow drift of mist, each edge traced by a fine lit line (The Veil).', material: 'smokedVeil', geometry: 'chamfer' },
  { id: 'jade', name: 'Carved jade', description: 'Polished jade with a carved border, a thin gold inlay and a faint inner light (The Lost Kingdom).', material: 'carvedJade', geometry: 'chamfer' },
  { id: 'gunmetal', name: 'Gunmetal', description: 'Machined dark metal in the piece colour: bright chamfers, an engraved red-lit line and a small corner lamp (Red Horizon).', material: 'machinedGunmetal', geometry: 'chamfer' },
  { id: 'frontier', name: 'Frontier timber', description: 'Painted oak planks worn back to bare wood, with forged-iron corner straps and brass rivets (The Last Frontier).', material: 'frontierTimber', geometry: 'chamfer' },
  { id: 'storm', name: 'Storm crystal', description: 'Deep polished crystal over graphite with faint charge filaments inside, fine silver edges and beads of rain on the faces (Dark Storm).', material: 'stormCrystal', geometry: 'chamfer' },
  { id: 'silk', name: 'Silk obsidian', description: 'Jewel-toned obsidian under smoky glass, with an orb web engraved in silver-violet silk on every face (The Web).', material: 'silkObsidian', geometry: 'chamfer' },
];

export function getBlockDesign(id: string): BlockDesign | null {
  return BLOCK_DESIGNS.find((d) => d.id === id) ?? null;
}
