import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { explosionsComponent, firesComponent, smokeComponent, sparksComponent } from './atmosphere';
import { colossusComponent } from './colossus';
import { dronesComponent } from './drones';
import { arrival, shearSparks } from './effects';
import { factoryComponent } from './factory';
import { groundComponent } from './ground';
import { sceneryComponent } from './scenery';
import { sentinelsComponent } from './sentinels';
import { skyComponent } from './sky';

/**
 * Red Horizon: a content-only world. A real photograph of an abandoned freight yard at sunset
 * (Poly Haven's Freight Station), graded to a smoke-filled red dusk, beyond which a machine
 * civilisation works a ruined city: original Blender-built humanoid machines patrolling with
 * planted-foot gaits and scanning optical sensors, hexapod walking refineries, recon drones with
 * searchlights, a working assembly factory, burning ruins and distant explosions. Everything goes
 * through the public SDK; the components live in this folder.
 */
export default defineStage({
  sdkVersion: '1.2.0',
  register(sdk) {
    const components = [skyComponent, groundComponent, sceneryComponent, smokeComponent, firesComponent, explosionsComponent, sparksComponent, factoryComponent, sentinelsComponent, dronesComponent, colossusComponent];
    for (const c of components) sdk.components.register(c as unknown as ComponentFactory);
    sdk.lineClearEffects.register(shearSparks);
    sdk.transitions.register(arrival);
  },
});
