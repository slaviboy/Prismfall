import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { tradewindCove } from './cove';
import { coconutPalms } from './palms';

/**
 * Tradewind Cove: a content-only world. A photographed sea and sky (Poly Haven's Spiaggia di
 * Mondello) behind a 3D lagoon with sand islands, and coconut palms moving in the trade wind.
 * Both components are this stage's own (see cove.ts and palms.ts); they share the sun, the wind
 * and the palm shadows through env.ts.
 */
export default defineStage({
  sdkVersion: '1.5.0',
  register(sdk) {
    sdk.components.register(tradewindCove as unknown as ComponentFactory);
    sdk.components.register(coconutPalms as unknown as ComponentFactory);
  },
});
