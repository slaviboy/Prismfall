import { Color, FogExp2, MathUtils } from 'three/webgpu';
import type { AudioFeatures, BeatEvent } from '../../audio/analysis/features';
import type { EnvironmentContext, GameSignals, QualityInfo, StageAssets, StageGameEvent } from '../../sdk/types';
import type { StageManifest } from '../../stages/schema';
import { resolveBlockPreset, type BlockMaterialPreset } from '../materials/blockPresets';
import { frameUniforms } from '../shaders/uniforms';
import type { RenderSystem } from '../renderer/RenderSystem';
import { emitWorldSound } from '../../audio/worldSounds';
import { createGround } from './ground';
import { StageEnvironment } from './StageEnvironment';
import type { ReactivitySettings } from './reactivity';

interface Active {
  readonly env: StageEnvironment;
  /** -1 fading out, +1 fading in, 0 steady. */
  direction: number;
}

const DEFAULT_FOG = { color: '#05040f', density: 0.002 };

/**
 * Owns stage environments in the scene: preparation (build + shader warm-up), activation with
 * a crossfade of world, lighting, camera, grade and fog, per-frame updates and disposal.
 */
export class EnvironmentHost {
  private readonly active: Active[] = [];
  private readonly prepared = new Map<string, StageEnvironment>();
  private transitionSeconds = 2.5;
  current: StageEnvironment | null = null;
  reactivity: ReactivitySettings = {
    enabled: true,
    preset: 'cinematic',
    strength: 1,
    bassSensitivity: 1,
    trebleSensitivity: 1,
    beatSensitivity: 1,
    particleResponse: 1,
    environmentResponse: 1,
    lightingResponse: 1,
  };
  private fog = new FogExp2(DEFAULT_FOG.color, DEFAULT_FOG.density);
  private fogFrom = { color: new Color(DEFAULT_FOG.color), density: DEFAULT_FOG.density };
  private fogTo = { color: new Color(DEFAULT_FOG.color), density: DEFAULT_FOG.density };
  private fogBlend = 1;
  /** Maximum number of built environments kept (current + preloaded). */
  cacheLimit = 2;

  constructor(private readonly render: RenderSystem) {
    render.scene.fog = this.fog;
  }

  /** Builds a stage environment off-scene and precompiles its shaders. Cached by stage id. */
  async prepare(manifest: StageManifest, assets: StageAssets, quality: QualityInfo, onProgress?: (fraction: number) => void): Promise<StageEnvironment> {
    const cached = this.prepared.get(manifest.id);
    if (cached) return cached;
    const ctx: EnvironmentContext = {
      stageId: manifest.id,
      scene: this.render.scene,
      quality,
      uniforms: frameUniforms,
      assets,
      bursts: this.render.bursts,
      palette: manifest.palette,
      ground: createGround(-14),
      sounds: { emit: emitWorldSound },
    };
    const env = await StageEnvironment.build(manifest, ctx, (f) => onProgress?.(f * 0.85));
    // Warm up: render one frame through the real pipeline (same MRT targets as play) with the
    // environment present but invisible, so its shaders compile before it is ever shown.
    env.setPresence(0.0001);
    this.render.worldRoot.add(env.group);
    try {
      this.render.warmUpFrame();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    } catch (err) {
      console.warn('[env] shader warm-up failed (will compile on first use)', err);
    }
    if (!this.active.some((a) => a.env === env)) {
      env.group.removeFromParent();
      env.setPresence(0);
    }
    onProgress?.(1);
    this.prepared.set(manifest.id, env);
    this.evict(manifest.id);
    return env;
  }

  private evict(keep: string): void {
    while (this.prepared.size > this.cacheLimit) {
      const victim = [...this.prepared.entries()].find(([id, env]) => id !== keep && !this.active.some((a) => a.env === env));
      if (!victim) break;
      victim[1].dispose();
      this.prepared.delete(victim[0]);
    }
  }

  /** Drops cached environments that aren't on screen (quality change, memory). */
  clearCache(): void {
    for (const [id, env] of this.prepared) {
      if (!this.active.some((a) => a.env === env)) {
        env.dispose();
        this.prepared.delete(id);
      }
    }
  }

  get preparedIds(): string[] {
    return [...this.prepared.keys()];
  }

  /** Makes `env` the visible stage. `seconds` = crossfade length (0 = cut). */
  activate(env: StageEnvironment, seconds = 2.5, blockGeometry?: (id: string) => void): void {
    if (this.current === env) return;
    this.transitionSeconds = Math.max(0.0001, seconds);
    for (const a of this.active) if (a.env !== env) a.direction = -1;
    const existing = this.active.find((a) => a.env === env);
    if (existing) existing.direction = 1;
    else {
      this.render.worldRoot.add(env.group);
      this.active.push({ env, direction: 1 });
    }
    if (seconds <= 0.001) {
      env.setPresence(1);
      for (const a of this.active) if (a.env !== env) a.env.setPresence(0);
    }
    this.current = env;
    this.applyLook(env.manifest, seconds > 0.001);
    void blockGeometry;
    if (seconds > 0.6) this.render.feedback.stageTransition(env.manifest.palette.accent);
  }

  private applyLook(m: StageManifest, smooth: boolean): void {
    const r = this.render;
    r.lights.transitionTo(m.lighting);
    if (!smooth) r.lights.update(10, 0, 0, 0);
    r.cameraRig.transitionTo({ pitch: m.camera.pitch, yaw: m.camera.yaw, sway: m.camera.sway, targetY: m.camera.targetY });
    r.post.setGrade({ exposure: m.grade.exposure, saturation: m.grade.saturation, contrast: m.grade.contrast, tint: m.grade.tint, vignette: m.grade.vignette, bloomThreshold: m.grade.bloomThreshold, bloomRadius: m.grade.bloomRadius });
    r.setToneMapping(m.grade.toneMapping, m.grade.exposure);
    r.scene.environmentIntensity = m.grade.envIntensity;
    const preset: BlockMaterialPreset = resolveBlockPreset(m.blocks.material, m.blocks.overrides as Partial<BlockMaterialPreset>);
    r.setStageBlocks(preset, m.blocks.palette ?? null, m.blocks.geometry);
    const accent = new Color(m.palette.accent).convertSRGBToLinear();
    const plate = new Color(m.palette.plate).convertSRGBToLinear();
    r.board.setAccent([accent.r, accent.g, accent.b], [plate.r, plate.g, plate.b]);
    this.fogFrom = { color: this.fog.color.clone(), density: this.fog.density };
    const target = m.fog ?? { color: m.palette.fog, density: DEFAULT_FOG.density };
    this.fogTo = { color: new Color(target.color), density: target.density };
    this.fogBlend = smooth ? 0 : 1;
    if (!smooth) {
      this.fog.color.copy(this.fogTo.color);
      this.fog.density = this.fogTo.density;
    }
    if (m.backdrop) {
      const t = new Color(m.backdrop.top).convertSRGBToLinear();
      const b = new Color(m.backdrop.bottom).convertSRGBToLinear();
      const g = new Color(m.backdrop.glow).convertSRGBToLinear();
      r.backdrop.setColors([t.r, t.g, t.b], [b.r, b.g, b.b], [g.r, g.g, g.b]);
    }
  }

  /** Returns to the neutral backdrop (no stage). */
  deactivate(seconds = 1): void {
    this.transitionSeconds = Math.max(0.0001, seconds);
    for (const a of this.active) a.direction = -1;
    this.current = null;
  }

  update(dt: number, time: number, audio: Readonly<AudioFeatures>, beats: readonly BeatEvent[], game: GameSignals): void {
    const step = dt / this.transitionSeconds;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i] as Active;
      if (a.direction !== 0) {
        const next = MathUtils.clamp(a.env.presence + step * a.direction, 0, 1);
        a.env.setPresence(MathUtils.smoothstep(next, 0, 1) === next ? next : next);
        if (next >= 1 && a.direction > 0) a.direction = 0;
        if (next <= 0 && a.direction < 0) {
          a.env.group.removeFromParent();
          this.active.splice(i, 1);
          continue;
        }
      }
      const frame = { time, dt, audio, game, presence: a.env.presence };
      a.env.update(frame, this.reactivity);
      for (const b of beats) a.env.onBeat({ beat: b.beat, bar: b.bar, beatInBar: b.beatInBar, downbeat: b.downbeat, time: b.time });
    }
    if (this.fogBlend < 1) {
      this.fogBlend = Math.min(1, this.fogBlend + dt / Math.max(0.3, this.transitionSeconds));
      this.fog.color.copy(this.fogFrom.color).lerp(this.fogTo.color, this.fogBlend);
      this.fog.density = MathUtils.lerp(this.fogFrom.density, this.fogTo.density, this.fogBlend);
    }
    const stagePresence = this.current?.presence ?? 0;
    this.render.backdrop.group.visible = stagePresence < 0.999;
  }

  onGameEvent(event: StageGameEvent): void {
    for (const a of this.active) a.env.onGameEvent(event);
  }

  dispose(): void {
    for (const env of this.prepared.values()) env.dispose();
    for (const a of this.active) if (![...this.prepared.values()].includes(a.env)) a.env.dispose();
    this.prepared.clear();
    this.active.length = 0;
  }
}
