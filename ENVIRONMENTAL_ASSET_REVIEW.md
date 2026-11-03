# Environmental asset review

Per-world status of what is on screen, judged from in-game screenshots and recordings (`npm run content:shots`, `npm run content:record`). "Real" means photography or photogrammetry; "procedural" means generated in code or by script.

## Status by world

| World | Background | 3D elements | Real | Still procedural | Open issues |
|---|---|---|---|---|---|
| Frozen Kingdom | Photo (Lago d'Isola, 20k detail) | Lake with mirror reflection, snow shore | Mountains, forest, frozen lake | Aurora, stars, particle snowflakes | None known; day turns to an aurora night with progress |
| Moving Sands | Photo night sky (Rogland Clear Night, 16k) | Moonlit dunes | Milky Way, hills, scanned boulders, quiver trees, cliff | Dunes, blowing sand | No camels or pyramids until a real scan or model is supplied |
| Alpine Horizon | Photo (Alps Field, 20k), whole surroundings | Three soaring eagles | Everything around the board | Eagles circling thermals (slotted primaries, banking, rare flap bouts) | The eagles are small at play size against the forest |
| Ancient Garden | Photo (Ninomaru Teien, 16k), whole surroundings | Red darter dragonflies | Garden, fences, rock garden | Drifting petals, dragonflies (anatomical, veined wings, darting flight) | Dragonflies only hover and glide; there is nothing in the photo to perch on |
| Enchanted Wilderness | Photo (Misty Pines, 16k), whole surroundings | Fireflies | Forest, fog, ferns | Fireflies (real flash patterns, synchronous waves) | Fireflies are faint over the brightest fog |
| Northern Lights | Procedural night sky | Mirror lake, dark ridge silhouettes, spruce silhouettes, meteors | None | Everything | Elk drawn as particles from a licensed rigged model (needs a Sketchfab download, see REAL_ASSET_PIPELINE.md); candidate for a real night panorama with snow and mountains (none found on Poly Haven) |
| The Abyss | Procedural deep water | Seafloor, light shafts, moon jellyfish, silver fish schools | None | Everything | Jellyfish (pulsing bell, canals, oral arms, trailing tentacles) and herring schools (swimming body wave, countershading, silver flash) are anatomical procedural models; no licensed animated sea life found |
| Luminous Tide | Procedural moonlit sea | Ocean with glitter path, headland silhouettes | None | Everything | Candidate for a real moonlit-sea panorama |
| Deep Cosmos (`celestial-drift`) | Photo all-sky Milky Way (ESO/S. Brunier) with crisp shader stars | Ringed gas giant, scanned asteroids | Milky Way and its dust lanes, the giant's surface (Cassini's Jupiter maps), moon-rock scans | Ring system (from Saturn's measured radii), stars | None known; the hidden sun swings round the giant with progress, from a thin crescent to a broad lit face |
| Future Nights | Procedural night city | Instanced towers, reflective wet street, rain | None | Everything | Candidate for a real night-city panorama |
| Ember Core | Procedural volcanic night | Lava plain, volcano cone, embers | None | Everything | No volcanic panorama found |
| Ember Foundry | Procedural industrial hall | Blender hall kit, molten channel, sparks | None | Everything | No suitable CC0 interior |
| Folded Sky | Photo (Montorfano, 16k), whole surroundings | Drifting seeds, a starling murmuration (boids: 7 nearest neighbours, falcon dives, escape waves) | Granite summit, forested ridges, lake, cirrus sky | Seeds | The paper theme lives on in its washi blocks and fold-into-cranes line clear |
| Dead Acre | Photo (Kloppenheim 04, 16k, night-graded), whole surroundings | Shambling figures, ground fog banks, sodium yard lamps on poles, crows | Misty field, tree line, lit farm buildings, fog glow | Figures (anatomical cross-section bodies in coats, jackets and hoods; GPU walk with planted feet, limps, dragged feet, hunches, lolling heads), fog sheets, lamp poles and halos, crows | The figures convince as silhouettes in fog and from the player's viewpoint, but they are procedural, not scanned people: lit up close they read as smooth mannequins (no facial detail, simple hands, cloth without real folds). The fog is stacked sheets, so thin steps can show on light verticals at grazing angles; the photo ground does not receive the lamps' light |
| Tradewind Cove | Photo (Spiaggia di Mondello, 20k): sea horizon and sky; the photo's beach is covered by the 3D lagoon | Sand islands, lagoon (depth colour over a sand floor, caustics, reef surf, photo reflections), coconut palms in the wind, frigatebirds | Sky, the sea at the horizon, the rippled-sand normal map (Poly Haven Aerial Beach 01) | Palms (curved ringed trunks, pinnate fronds, GPU wind with travelling gusts), islands, water | The reef surf is a flat white band with no breaking crest; the palm crowns are geometric leaflets lit by a custom shader and read slightly stiff in a close-up; the photo is a Sicilian bay, so the far shore hidden behind the outer islets and palms is Mediterranean |

## Removed after review

These looked primitive or gimmicky in game and were taken out:

- **Ring and column effects:** the column of light that crawled across the board on clears, and the generic accent ring on QUADs and level-ups.
- **Northern Lights:** ice arches, glowing crystals, birds of light, light streams and motes.
- **Frozen Kingdom:** the citadel pieces, icebergs and mist sprites.
- **The Abyss:** tiled caustics, sunken ruins, reef and kelp scatter, rays, turtles, bubbles, the blob whale, and the old dome jellyfish and flat fish swarm.
- **Luminous Tide:** light pillars and star motes.
- **Deep Cosmos (Celestial Drift):** the orbit rings, beat pulsars, energy streams, the particle whale, then the procedural spiral galaxy, the blob nebula clouds, the drifting star streaks and the cartoon banded planet.
- **Future Nights:** the drones and data motes.
- **Ember Core:** the obsidian spires and fire birds.
- **Moving Sands:** the mesas, arch, particle camels and the script-built pyramids.
- **Northern Lights:** the script-built reindeer (they read as four sticks).
- **Folded Sky:** the paper hills, the paper-crane flocks, the lantern and cherry grove, paper scraps and paper clouds (the world became a real summit under cirrus).
- **Alpine, Garden and Forest:** the procedural ranges, low-poly tree scatter, particle birds and creatures, and haze sprites.

## Needed from outside the project

These cannot be produced to a realistic standard without licensed source material. The integration path exists in each case (see [REAL_ASSET_PIPELINE.md](REAL_ASSET_PIPELINE.md)):

- A rigged, animated realistic dromedary camel, for the Moving Sands caravan.
- Photogrammetry of pyramids or desert monuments.
- Rigged realistic marine animals (fish, rays, a whale), for The Abyss.
- Night panoramas with snowy mountains (Northern Lights), a moonlit sea (Luminous Tide) and a city at night (Future Nights), if CC0 sources are found.
