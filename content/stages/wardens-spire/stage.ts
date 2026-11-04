import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { ashComponent } from './ash';
import { citadelComponent } from './citadel';
import { wardenRend } from './effects';
import { landComponent } from './land';
import { rocksComponent } from './rocks';
import { stormComponent } from './storm';
import { wardenComponent } from './warden';

/**
 * The Warden's Spire: a content-only world. A real photographic horizon (Poly Haven's Toposcope
 * Sunset, graded to a storm-lit dusk) behind a volcanic land built here: lava rivers in carved
 * channels and a ravine, ruins and a fallen bridge, a black citadel (for now a placeholder tower
 * from a Sketchfab model; the original Blender citadel is the citadel layer's default), and at its
 * summit the Warden, a molten core in a cage of turning stone rings whose searchlight sweeps the
 * land and lights the storm. Everything goes through the public SDK.
 */
export default defineStage({
  sdkVersion: '1.2.0',
  register(sdk) {
    sdk.components.register(landComponent as unknown as ComponentFactory);
    sdk.components.register(rocksComponent as unknown as ComponentFactory);
    sdk.components.register(citadelComponent as unknown as ComponentFactory);
    sdk.components.register(wardenComponent as unknown as ComponentFactory);
    sdk.components.register(stormComponent as unknown as ComponentFactory);
    sdk.components.register(ashComponent as unknown as ComponentFactory);
    sdk.lineClearEffects.register(wardenRend);
  },
});
