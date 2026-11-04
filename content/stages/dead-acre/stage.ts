import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { crowsComponent } from './crows';
import { fogComponent } from './fog';
import { hordeComponent } from './horde';
import { lampsComponent } from './lamps';

/**
 * Dead Acre: a content-only world. A real photograph of a misty field at night (Poly Haven's
 * Kloppenheim 04, graded darker) with a horde of figures shambling out of the fog, drifting ground
 * fog, failing sodium yard lamps and crows circling over the tree line. Everything goes through the
 * public SDK; the components live in this folder.
 */
export default defineStage({
  sdkVersion: '1.5.0',
  register(sdk) {
    sdk.components.register(hordeComponent as unknown as ComponentFactory);
    sdk.components.register(fogComponent as unknown as ComponentFactory);
    sdk.components.register(lampsComponent as unknown as ComponentFactory);
    sdk.components.register(crowsComponent as unknown as ComponentFactory);
  },
});
