import { registries } from '../../sdk/registry';
import { beamsComponent } from './components/beams';
import { cloudsComponent } from './components/clouds';
import { emitterComponent } from './components/emitter';
import { gltfSceneComponent } from './components/gltfScene';
import { creatureHerdComponent } from './components/creatureHerd';
import { lavaComponent } from './components/lava';
import { particlesComponent } from './components/particles';
import { planetComponent } from './components/planet';
import { ringsComponent } from './components/rings';
import { skyComponent } from './components/sky';
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
] as unknown as readonly ComponentFactory[];

let registered = false;
export function registerBuiltinComponents(): void {
  if (registered) return;
  registered = true;
  for (const c of BUILTIN_COMPONENTS) registries.components.register(c);
}
