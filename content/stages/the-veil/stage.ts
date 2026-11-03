import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { atmosphereComponent } from './atmosphere';
import { creaturesComponent } from './creatures';
import { veilDissolve } from './effects';
import { landComponent } from './land';
import { marshComponent } from './marsh';
import { sceneryComponent } from './scenery';

/**
 * The Veil: a content-only world. A real photograph of a hilltop lost in fog with the sun veiled
 * (Poly Haven's Kloofendal 28d Misty, graded to cold moonlight) over a 3D lowland of mud, marsh
 * and dead forest, filled with layered, ray-marched fog. Original creatures move out in the mist,
 * casting shadows through it, on a director's irregular schedule. Everything goes through the
 * public SDK; the components live in this folder.
 */
export default defineStage({
  sdkVersion: '1.2.0',
  register(sdk) {
    sdk.components.register(atmosphereComponent as unknown as ComponentFactory);
    sdk.components.register(landComponent as unknown as ComponentFactory);
    sdk.components.register(sceneryComponent as unknown as ComponentFactory);
    sdk.components.register(marshComponent as unknown as ComponentFactory);
    sdk.components.register(creaturesComponent as unknown as ComponentFactory);
    sdk.lineClearEffects.register(veilDissolve);
  },
});
