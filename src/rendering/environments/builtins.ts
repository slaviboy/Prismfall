import { registries } from '../../sdk/registry';
import { auroraComponent } from './components/aurora';
import { beamsComponent } from './components/beams';
import { cityComponent } from './components/city';
import { cloudsComponent } from './components/clouds';
import { conifersComponent } from './components/conifers';
import { emitterComponent } from './components/emitter';
import { fishSchoolComponent } from './components/fishSchool';
import { firefliesComponent } from './components/fireflies';
import { dragonfliesComponent } from './components/dragonflies';
import { galaxyComponent } from './components/galaxy';
import { gltfSceneComponent } from './components/gltfScene';
import { jellyfishComponent } from './components/jellyfish';
import { creatureHerdComponent } from './components/creatureHerd';
import { lavaComponent } from './components/lava';
import { meteorsComponent } from './components/meteors';
import { modelComponent } from './components/model';
import { particlesComponent } from './components/particles';
import { particleShapesComponent } from './components/particleShapes';
import { planetComponent } from './components/planet';
import { ridgesComponent } from './components/ridges';
import { ringsComponent } from './components/rings';
import { scatterComponent } from './components/scatter';
import { skyComponent } from './components/sky';
import { swarmComponent } from './components/swarm';
import { terrainComponent } from './components/terrain';
import { waterComponent } from './components/water';
import type { ComponentFactory } from '../../sdk/types';

/** Built-in environment components every stage can combine. */
export const BUILTIN_COMPONENTS: readonly ComponentFactory[] = [
  skyComponent,
  particlesComponent,
  waterComponent,
  beamsComponent,
  planetComponent,
  ringsComponent,
  gltfSceneComponent,
  lavaComponent,
  emitterComponent,
  cloudsComponent,
  creatureHerdComponent,
  terrainComponent,
  scatterComponent,
  swarmComponent,
  auroraComponent,
  galaxyComponent,
  cityComponent,
  ridgesComponent,
  conifersComponent,
  modelComponent,
  particleShapesComponent,
  jellyfishComponent,
  fishSchoolComponent,
  meteorsComponent,
  firefliesComponent,
  dragonfliesComponent,
] as unknown as readonly ComponentFactory[];

let registered = false;
export function registerBuiltinComponents(): void {
  if (registered) return;
  registered = true;
  for (const c of BUILTIN_COMPONENTS) registries.components.register(c);
}
