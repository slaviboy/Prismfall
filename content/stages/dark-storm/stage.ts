import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { stormFront, stormSurge } from './effects';
import { grassComponent } from './grass';
import { landComponent } from './land';
import { lightningComponent } from './lightning';
import { propsComponent } from './props';
import { rainComponent } from './rain';
import { skyComponent } from './sky';

/**
 * Dark Storm: a content-only world. A night thunderstorm over a moorland ledge high above a glen
 * and its loch, ringed by dark mountains: a ray-marched cloud deck lit from within by procedural
 * branching lightning, heavy layered GPU rain with splashes and distant curtains, wet ground and
 * water that mirror the flashes, and standing stones whose shadows the nearest strikes throw. A
 * seeded storm director (director.ts) runs the weather and times every strike's crack and thunder
 * through the SDK's storm sounds (1.5). Everything goes through the public SDK.
 */
export default defineStage({
  sdkVersion: '1.5.0',
  register(sdk) {
    sdk.components.register(skyComponent as unknown as ComponentFactory);
    sdk.components.register(landComponent as unknown as ComponentFactory);
    sdk.components.register(propsComponent as unknown as ComponentFactory);
    sdk.components.register(grassComponent as unknown as ComponentFactory);
    sdk.components.register(lightningComponent as unknown as ComponentFactory);
    sdk.components.register(rainComponent as unknown as ComponentFactory);
    sdk.lineClearEffects.register(stormSurge);
    sdk.transitions.register(stormFront);
  },
});
