import { defineStage, type ComponentFactory } from '@prismfall/sdk';
import { silkUnravel, webArrival } from './effects';
import { webMist } from './mist';
import { webRuins } from './ruins';
import { webSpiders } from './spiders';
import { webWebs } from './webs';

/**
 * The Web: a content-only world. A collapsed gothic chapel and the caves beneath it under a broken
 * roof and a cold moon, enormous procedural orb webs, and giant spiders (real rigged models) that
 * crawl the walls and ceilings, hang on silk, cross the far ledges as shadows on the fog, and watch
 * from the dark with clusters of eyes. Everything goes through the public SDK; the components live
 * in this folder.
 */
export default defineStage({
  sdkVersion: '1.4.0',
  register(sdk) {
    const components = [webRuins, webWebs, webSpiders, webMist];
    for (const c of components) sdk.components.register(c as unknown as ComponentFactory);
    sdk.lineClearEffects.register(silkUnravel);
    sdk.transitions.register(webArrival);
  },
});
