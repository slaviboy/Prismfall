import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { lostKingdomRuins } from './ruins';
import { jungleFoliage } from './foliage';
import { jungleWaterfall } from './waterfall';
import { lianas } from './lianas';
import { sunShafts } from './shafts';
import { canopyFall, jadeAwakening } from './effects';
import { horizonHaze } from './haze';

/**
 * The Lost Kingdom: a content-only world. A photographed rainforest (Poly Haven's rainforest_trail)
 * surrounds an original Classic Maya plaza modelled and path-traced in Blender (the Great Pyramid,
 * the outcrop with a spillway and pool, stelae, altars and a carved-panel wall) together with two
 * photogrammetry scans of real buildings (Palenque's Palace on the outcrop, Cahal Pech Structure B1
 * closing the plaza), overgrown with scanned plants, with a waterfall, lianas, light shafts and mist.
 * The bake and the live pieces share one canopy mask, so the sun comes through the same leaves
 * everywhere (see env.ts).
 */
export default defineStage({
  sdkVersion: '1.5.0',
  register(sdk) {
    sdk.components.register(lostKingdomRuins as unknown as ComponentFactory);
    sdk.components.register(jungleFoliage as unknown as ComponentFactory);
    sdk.components.register(jungleWaterfall as unknown as ComponentFactory);
    sdk.components.register(lianas as unknown as ComponentFactory);
    sdk.components.register(sunShafts as unknown as ComponentFactory);
    sdk.components.register(horizonHaze as unknown as ComponentFactory);
    sdk.lineClearEffects.register(jadeAwakening);
    sdk.transitions.register(canopyFall);
  },
});
