import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { sandsFarDunes } from './farDunes';
import { sandsNightSky } from './nightSky';

/** Moving Sands: the generated far background (night sky and far dune sea). */
export default defineStage({
  sdkVersion: '1.0.0',
  register(sdk) {
    sdk.components.register(sandsNightSky as unknown as ComponentFactory);
    sdk.components.register(sandsFarDunes as unknown as ComponentFactory);
  },
});
