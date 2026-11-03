import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { frontierClutter } from './clutter';
import { frontierDust } from './dust';
import { dustAndTimber } from './effects';
import { frontierGround } from './ground';
import { frontierRail } from './rail';
import { frontierRocks, frontierScatter } from './scatter';
import { frontierSky } from './sky';
import { frontierTown } from './town';

/**
 * The Last Frontier: a content-only world. A real photograph of golden-hour desert mountains
 * (Poly Haven's Goegap Road) with an original Blender town and steam train, scanned rocks and
 * shrubs, horses, riders and wagons drawn as particles from real models (the built-in `model`
 * component), and sunlit dust; the day turns to night as the game progresses. Everything goes
 * through the public SDK; the components live in this folder.
 */
export default defineStage({
  sdkVersion: '1.2.0',
  register(sdk) {
    sdk.components.register(frontierSky as unknown as ComponentFactory);
    sdk.components.register(frontierGround as unknown as ComponentFactory);
    sdk.components.register(frontierTown as unknown as ComponentFactory);
    sdk.components.register(frontierRail as unknown as ComponentFactory);
    sdk.components.register(frontierScatter as unknown as ComponentFactory);
    sdk.components.register(frontierRocks as unknown as ComponentFactory);
    sdk.components.register(frontierDust as unknown as ComponentFactory);
    sdk.components.register(frontierClutter as unknown as ComponentFactory);
    sdk.lineClearEffects.register(dustAndTimber);
  },
});
