import { RenderPipeline, Vector3, type Camera, type Node, type Object3D, type Scene, type WebGPURenderer } from 'three/webgpu';
import {
  convertToTexture,
  emissive,
  float,
  int,
  length,
  luminance,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';

export interface PostSettings {
  enabled: boolean;
  antialias: 'none' | 'fxaa' | 'smaa' | 'msaa';
  renderScale: number;
  upscaler: 'bilinear' | 'fsr1';
  bloom: number;
  ambientOcclusion: boolean;
  depthOfField: boolean;
  /** Background motion blur strength (0 = off). The playfield is never blurred. */
  motionBlur: number;
  screenEffects: number;
}

/** Stage colour grade (applied in linear space before tone mapping). */
export interface ColorGrade {
  exposure: number;
  saturation: number;
  contrast: number;
  tint: readonly [number, number, number];
  vignette: number;
  bloomThreshold: number;
  bloomRadius: number;
}

export const DEFAULT_GRADE: ColorGrade = { exposure: 1, saturation: 1.12, contrast: 1.04, tint: [1, 1, 1], vignette: 0.4, bloomThreshold: 0.2, bloomRadius: 0.4 };

/** Builds and owns the RenderPipeline graph; rebuilt only when structural settings change. */
export class PostPipeline {
  private pipeline: RenderPipeline | null = null;
  private structureKey = '';
  readonly u = {
    bloomStrength: uniform(1),
    bloomThreshold: uniform(DEFAULT_GRADE.bloomThreshold),
    bloomRadius: uniform(DEFAULT_GRADE.bloomRadius),
    exposure: uniform(1),
    saturation: uniform(DEFAULT_GRADE.saturation),
    contrast: uniform(DEFAULT_GRADE.contrast),
    tint: uniform(new Vector3(1, 1, 1)),
    vignette: uniform(DEFAULT_GRADE.vignette),
    focusDistance: uniform(30),
    screenEffects: uniform(1),
    motionBlur: uniform(0),
  };
  /** Effective MSAA sample count (0 when a depth-based pass makes MSAA unsuitable). */
  samples = 0;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {}

  configure(settings: PostSettings): void {
    const depthPasses = settings.enabled && (settings.ambientOcclusion || settings.depthOfField);
    const msaa = settings.antialias === 'msaa' && !depthPasses ? 4 : 0;
    const aa = settings.antialias === 'msaa' && depthPasses ? 'smaa' : settings.antialias;
    const upscale = settings.renderScale < 0.999 && settings.upscaler === 'fsr1';
    const blur = settings.motionBlur > 0;
    const key = JSON.stringify([settings.enabled, msaa, aa, upscale, settings.ambientOcclusion, settings.depthOfField, blur]);
    this.u.bloomStrength.value = settings.enabled ? settings.bloom : 0;
    this.u.motionBlur.value = settings.motionBlur;
    this.u.screenEffects.value = settings.screenEffects;
    if (key !== this.structureKey || !this.pipeline) {
      this.structureKey = key;
      this.build(settings, msaa, aa, upscale);
    }
    this.scenePassScale = settings.renderScale;
    this.applyScale();
  }

  private scenePassScale = 1;
  private scenePass: ReturnType<typeof pass> | null = null;

  /** Dynamic-resolution override (null = use the configured render scale). */
  private dynamicScale: number | null = null;

  private applyScale(): void {
    this.scenePass?.setResolutionScale(this.dynamicScale ?? this.scenePassScale);
  }

  setDynamicScale(scale: number | null): void {
    this.dynamicScale = scale;
    this.applyScale();
  }

  get effectiveScale(): number {
    return this.dynamicScale ?? this.scenePassScale;
  }

  setGrade(grade: ColorGrade): void {
    this.u.exposure.value = grade.exposure;
    this.u.saturation.value = grade.saturation;
    this.u.contrast.value = grade.contrast;
    this.u.tint.value.set(grade.tint[0], grade.tint[1], grade.tint[2]);
    this.u.vignette.value = grade.vignette;
    this.u.bloomThreshold.value = grade.bloomThreshold;
    this.u.bloomRadius.value = grade.bloomRadius;
  }

  setFocusDistance(d: number): void {
    this.u.focusDistance.value = d;
  }

  private build(settings: PostSettings, msaa: number, aa: PostSettings['antialias'], upscale: boolean): void {
    this.pipeline?.dispose();
    this.bloomPass = null;
    this.samples = msaa;
    const scenePass = pass(this.scene, this.camera, { samples: msaa });
    this.scenePass = scenePass;
    const blur = settings.enabled && settings.motionBlur > 0;
    // Motion vectors are only rendered when motion blur is on.
    scenePass.setMRT(blur ? mrt({ output, emissive, velocity }) : mrt({ output, emissive }));
    const pipeline = new RenderPipeline(this.renderer);
    const color = scenePass.getTextureNode('output');

    if (!settings.enabled) {
      pipeline.outputNode = color;
      this.pipeline = pipeline;
      return;
    }

    let lit: Node<'vec3'> = vec3(color.rgb);
    if (settings.ambientOcclusion) {
      // Normals are reconstructed from depth (no extra MRT target needed).
      // three documents normalNode as `?Node`; @types/three r187 omits the null case.
      const aoPass = ao(scenePass.getTextureNode('depth'), null as unknown as Node, this.camera);
      aoPass.resolutionScale = 0.5;
      lit = lit.mul(aoPass.getTextureNode().r);
    }

    const em = scenePass.getTextureNode('emissive');
    const bloomPass = bloom(em, 1, 0.45, 0.12);
    this.bloomPass = bloomPass;
    bloomPass.threshold = this.u.bloomThreshold;
    bloomPass.radius = this.u.bloomRadius;
    let combined: Node<'vec4'> = vec4(lit.add(bloomPass.rgb), 1);

    if (blur) {
      // Only the world well behind the playfield blurs: motion vectors fade in with depth beyond
      // the board (the focus distance), so blocks, the frame and the HUD pods stay crisp.
      const behind = smoothstep(this.u.focusDistance.add(4), this.u.focusDistance.add(14), scenePass.getViewZNode().negate());
      const raw = scenePass.getTextureNode('velocity').xy.mul(this.u.motionBlur.mul(behind));
      // Clamp the smear to 1.5% of the screen: very large vectors (sky, camera cuts) would otherwise
      // drag colour from far across the image.
      const len = length(raw);
      const motion = raw.mul(float(0.015).div(len.max(0.015)));
      // motionBlur samples its input at offsets, so the combined image is rendered to a texture first.
      combined = vec4((motionBlur(convertToTexture(combined), motion, int(12)) as unknown as Node<'vec4'>).rgb, 1);
    }

    if (settings.depthOfField) {
      const dofNode = dof(combined, scenePass.getViewZNode(), this.u.focusDistance, this.u.focusDistance.mul(0.45), float(1.2)) as unknown as Node<'vec4'>;
      combined = vec4(dofNode.rgb, 1);
    }

    // Colour grade: exposure, tint, saturation, contrast, vignette.
    const exposed = combined.rgb.mul(this.u.exposure).mul(this.u.tint);
    const lum = luminance(exposed);
    const saturated = mix(vec3(lum), exposed, this.u.saturation);
    const contrasted = saturated.sub(0.18).mul(this.u.contrast).add(0.18).max(0);
    const d = length(uv().sub(0.5).mul(vec2(1.15, 1)));
    const vig = mix(float(1), smoothstep(0.85, 0.25, d), this.u.vignette);
    const graded = vec4(contrasted.mul(vig), 1);

    let out = renderOutput(graded) as unknown as Node<'vec4'>;
    pipeline.outputColorTransform = false;
    if (aa === 'fxaa') out = fxaa(out) as unknown as Node<'vec4'>;
    else if (aa === 'smaa') out = smaa(out) as unknown as Node<'vec4'>;
    if (upscale) out = fsr1(out, 0.25) as unknown as Node<'vec4'>;
    pipeline.outputNode = out;
    this.pipeline = pipeline;
  }

  private bloomPass: ReturnType<typeof bloom> | null = null;

  /** Per-frame bloom strength (base setting × gameplay pulse, capped by flash reduction). */
  updateFrame(): void {
    if (this.bloomPass) {
      this.bloomPass.strength.value = this.u.bloomStrength.value * 0.85;
    }
  }

  render(): void {
    // A precompile in progress restores its own render state between slices; start clean.
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT(null);
    this.pipeline?.render();
  }

  /**
   * Compiles `root`'s materials for the scene pass (same target and MRT as play) without blocking:
   * three's compileAsync captures that state synchronously and then works in slices between frames.
   */
  async precompile(root: Object3D): Promise<void> {
    const pass = this.scenePass;
    if (!pass) return;
    this.renderer.setRenderTarget(pass.renderTarget);
    this.renderer.setMRT(pass.getMRT());
    const done = this.renderer.compileAsync(root, this.camera, this.scene);
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT(null);
    await done;
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.pipeline = null;
    this.structureKey = '';
  }
}
