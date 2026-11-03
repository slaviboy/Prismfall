/**
 * Prismfall Content SDK — the only module stage content (content/**) may import, besides three.
 *
 * A stage's optional `stage.ts` default-exports `defineStage({ sdkVersion, register(sdk) { … } })`
 * to add its own environment components or line-clear effects. Everything else is data in
 * stage.json. See CONTENT_GUIDE.md.
 */
export { SDK_VERSION } from './version';
export type {
  BeatInfo,
  ClearInfo,
  ComponentFactory,
  EffectContext,
  EnvFrame,
  EnvironmentComponent,
  EnvironmentContext,
  GameSignals,
  LineClearEffect,
  QualityInfo,
  Registry,
  SdkRegistries,
  StageAssets,
  StageGameEvent,
  StageModule,
  StagePalette,
  GroundField,
  WorldSounds,
  WeatherSound,
  StormSound,
  TransitionContext,
  TransitionEffect,
} from './types';
export type { AudioFeatures } from '../audio/analysis/features';
export type { BurstParticle, ParticleShape } from '../rendering/particles/BurstSystem';
export { frameUniforms, noBloom, additiveFog } from '../rendering/shaders/uniforms';
export { colorUniform, floatUniform, linear, seeded, scaledCount, zColor, zVec3 } from '../rendering/environments/components/common';
export { runRecipe, makeRecipeEffect, BASE_RECIPE, type ClearRecipe } from '../rendering/fx/lineClearEffects';
export { resolveBlockPreset, BLOCK_PRESETS, type BlockMaterialPreset } from '../rendering/materials/blockPresets';
export { z } from 'zod';
export {
  composition,
  hold,
  arp,
  bassline,
  beat,
  melody,
  stab,
  once,
  type Composition,
  type InstrumentSpec,
  type SectionSpec,
  type PartGenerator,
} from '../audio/sequencer/composition';
export type { FileTrackMeta } from '../audio/music-director/tracks';

import type { StageModule } from './types';

/** Typed helper for stage modules. */
export function defineStage(module: StageModule): StageModule {
  return module;
}
