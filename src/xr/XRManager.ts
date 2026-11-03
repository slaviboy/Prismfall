import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicNodeMaterial, MathUtils, Matrix4, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, PMREMGenerator, Ray, SphereGeometry, BackSide, Vector3, WebGPURenderer, type Object3D, type Texture } from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { InputManager } from '../input/inputManager';
import type { ActionEvent, MenuAction } from '../input/types';
import type { RenderSystem } from '../rendering/renderer/RenderSystem';
import { getSettings, settingsStore } from '../settings/store';
import type { Settings } from '../settings/schema';
import { mrt, output } from 'three/tsl';
import { createStore } from 'zustand/vanilla';
import { XRControllerInput } from './xrInput';
import { VRHud, VRPanel, type PanelItem } from './vrPanel';

/** What the VR system can do in this browser right now. */
export type XRAvailability = 'checking' | 'available' | 'no-headset' | 'unsupported' | 'insecure';

/** VR state for the page UI (menu entry, settings status, presenting overlay). */
export const xrStore = createStore<{ availability: XRAvailability; presenting: boolean; starting: boolean }>(() => ({
  availability: 'checking',
  presenting: false,
  starting: false,
}));

/** The game the XR manager drives: kept as a narrow interface so XR never reaches into the shell. */
export interface XRHost {
  renderSystem(): RenderSystem | null;
  readonly input: InputManager;
  beginExternalFrames(): void;
  endExternalFrames(): void;
  externalFrame(now: number): void;
  /** Where the app is (menu, game, results) and whether play is paused. */
  appState(): { screen: string; paused: boolean; running: boolean };
  hud(): { score: number; level: number; lines: number; timeMs: number; callout: string; combo: number };
  results(): { score: number; lines: number; title: string } | null;
  startMode(mode: 'marathon' | 'zen' | 'voyage'): void;
  pause(): void;
  resume(): void;
  restart(): void;
  quitToMenu(): void;
  stages(): { id: string; name: string }[];
  currentStage(): string;
  chooseStage(id: string): void;
  /** Haptic hooks: the shell reports big moments so controllers can answer. */
  onHaptic(listener: (kind: 'drop' | 'clear' | 'quad' | 'lock') => void): () => void;
}

const PROFILES = {
  performance: { framebuffer: 0.8, foveation: 1, particles: 0.5 },
  balanced: { framebuffer: 1, foveation: 0.5, particles: 0.8 },
  quality: { framebuffer: 1.2, foveation: 0.2, particles: 1 },
} as const;

/**
 * Emulators (IWER, the WebXR polyfill) hand out an XRWebGLLayer whose framebuffer is `null`, the
 * canvas's default framebuffer, which the spec reserves for inline sessions. three's WebGL state
 * cache keys draw buffers by framebuffer object and throws on `null`. For such layers only, skip
 * draw-buffer setup for the default framebuffer. Headsets provide a real framebuffer and never
 * take this path.
 */
function patchDefaultFramebufferLayer(r: WebGPURenderer): void {
  // The session's renderState only picks the layer up on the next frame; ask three for it.
  const layer = r.xr.getBaseLayer() as XRWebGLLayer | null;
  if (!layer || layer.framebuffer !== null) return;
  const backend = r.backend as unknown as { gl?: WebGL2RenderingContext; state?: { drawBuffers(ctx: unknown, fb: WebGLFramebuffer | null): void; __xrPatched?: boolean } };
  const { gl, state } = backend;
  if (!gl || !state || state.__xrPatched) return;
  const original = state.drawBuffers.bind(state);
  // The default framebuffer's draw buffer is BACK unless changed, so there is nothing to set.
  state.drawBuffers = (ctx, fb) => {
    if (fb !== null) original(ctx, fb);
  };
  state.__xrPatched = true;
}

/** Board units per metre: the playfield is 20 cells tall and about one metre tall at scale 1. */
const BOARD_UNITS_PER_METRE = 20;
const SEATED_EYE = 1.2;
const STANDING_EYE = 1.6;

/**
 * WebXR "immersive-vr" mode. The desktop renderer (WebGPU or WebGL 2) keeps running untouched;
 * VR uses a dedicated WebGL 2 renderer (the reliable WebXR path in three r187) that draws the same
 * scene graph. Game state never changes when entering or leaving: only the presentation does.
 *
 * Layout: the world stays at full scale around the player standing on the stage ground; the
 * playfield (board space) shrinks to about a metre and floats at a comfortable distance.
 */
export class XRManager {
  availability: XRAvailability = 'checking';
  presenting = false;
  starting = false;
  private session: XRSession | null = null;
  private renderer: WebGPURenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  readonly rig = new Group();
  readonly camera = new PerspectiveCamera(70, 1, 0.05, 4000);
  private readonly controllers: Group[] = [];
  private readonly rays: Line[] = [];
  private readonly input: XRControllerInput;
  private panel: VRPanel | null = null;
  private hud: VRHud | null = null;
  private dimmer: Mesh | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];
  private savedBoard: { position: Vector3; scale: Vector3; rotation: [number, number, number] } | null = null;
  private savedEnvironment: Texture | null = null;
  private stageIndex = 0;
  private readonly ray = new Ray();
  private readonly tmp = new Matrix4();
  private panelVisible = false;
  /** Pointing and pulling the trigger fires both "selectstart" and the confirm action: act once. */
  private lastActivate = -Infinity;
  /** The controller whose ray highlights menu rows: the last one to pull its trigger. */
  private pointer: Object3D | null = null;
  /** Head position in reference space, measured once tracking starts (and on recentre). */
  private head: Vector3 | null = null;
  private framesSinceAnchor = 0;
  private vrEnvironment: Texture | null = null;
  /** The world the layout was computed for; a new world has its own ground height. */
  private layoutWorld: unknown = null;

  constructor(private readonly host: XRHost) {
    this.input = new XRControllerInput((e) => host.input.handleXR(e));
    this.rig.name = 'xr-rig';
    this.rig.add(this.camera);
  }

  /** Whether the floating menu panel is showing (tests and diagnostics). */
  get panelShown(): boolean {
    return this.presenting && this.panelVisible;
  }

  /** The highlighted menu panel entry. */
  get panelItem(): string | null {
    return this.panelShown ? (this.panel?.current() ?? null) : null;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    xrStore.setState({ availability: this.availability, presenting: this.presenting, starting: this.starting });
    this.listeners.forEach((l) => l());
  }

  /** Checks for WebXR immersive-vr support (secure context, API, a runtime or headset). */
  async detect(): Promise<XRAvailability> {
    if (typeof window === 'undefined') return (this.availability = 'unsupported');
    if (!window.isSecureContext) this.availability = 'insecure';
    else if (!navigator.xr) this.availability = 'unsupported';
    else {
      try {
        this.availability = (await navigator.xr.isSessionSupported('immersive-vr')) ? 'available' : 'no-headset';
      } catch {
        this.availability = 'unsupported';
      }
    }
    this.changed();
    return this.availability;
  }

  /** Starts VR. Must be called from a user gesture (button press). */
  async enter(): Promise<boolean> {
    if (this.presenting || this.starting || !navigator.xr) return false;
    const settings = getSettings();
    const rs = this.host.renderSystem();
    if (!rs) return false;
    this.starting = true;
    this.changed();
    let session: XRSession;
    try {
      // Request first, while the click still counts as a user gesture; set up rendering after.
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    } catch (err) {
      console.warn('[xr] session request failed', err);
      this.starting = false;
      this.changed();
      return false;
    }
    try {
      await this.setUp(session, settings, rs);
    } catch (err) {
      console.error('[xr] could not start rendering', err);
      this.starting = false;
      await session.end().catch(() => undefined);
      this.changed();
      return false;
    }
    return true;
  }

  private async setUp(session: XRSession, settings: Settings, rs: RenderSystem): Promise<void> {
    const profile = PROFILES[settings.vr.graphics];
    if (!this.renderer) {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'xr-canvas';
      // Headsets size their layer themselves; emulators and some runtimes use the canvas size.
      this.canvas.width = Math.max(640, Math.round(window.innerWidth * Math.min(2, window.devicePixelRatio)));
      this.canvas.height = Math.max(360, Math.round(window.innerHeight * Math.min(2, window.devicePixelRatio)));
      this.renderer = new WebGPURenderer({ canvas: this.canvas, antialias: true, forceWebGL: true, alpha: false });
      await this.renderer.init();
      // Materials add an "emissive" MRT output for the desktop bloom pass. Without a renderer MRT
      // that output would replace the colour output entirely; this MRT keeps the colour output on
      // the (unnamed) XR target texture and drops the emissive one, which has no target here.
      const outputOnly = mrt({ '': output });
      // Only the "output" key defaults to the material's own blending; give the unnamed one the same.
      outputOnly.setBlendMode('', outputOnly.getBlendMode('output'));
      this.renderer.setMRT(outputOnly);
      // The desktop environment map lives on the other GPU device: build the same one here.
      const pmrem = new PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.vrEnvironment = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
    }
    const r = this.renderer;
    r.toneMapping = rs.renderer.toneMapping;
    r.toneMappingExposure = rs.renderer.toneMappingExposure;
    r.outputColorSpace = rs.renderer.outputColorSpace;
    r.shadowMap.enabled = false;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType(settings.vr.layout === 'standing' ? 'local-floor' : 'local');
    r.xr.setFramebufferScaleFactor(profile.framebuffer);
    r.xr.setFoveation(profile.foveation);
    // three captures the renderer's animation loop when the session starts and calls it from its
    // own XR frame handler (which updates the head pose and eye cameras). Setting the loop after
    // setSession() would replace that handler, so it must be installed first.
    await r.setAnimationLoop((time) => {
      if (!this.presenting || !this.session) return;
      this.input.poll(this.session.inputSources as unknown as Iterable<{ handedness: 'left' | 'right' | 'none'; gamepad?: Gamepad | null }>, performance.now());
      this.host.externalFrame(time);
    });
    await r.xr.setSession(session);
    this.session = session;
    patchDefaultFramebufferLayer(r);
    session.addEventListener('end', () => this.tearDown(), { once: true });

    this.savedEnvironment = rs.scene.environment;
    rs.scene.environment = this.vrEnvironment;
    this.head = null;
    this.framesSinceAnchor = 0;
    // Recentring in the headset moves the reference space: measure the head again.
    const space = r.xr.getReferenceSpace() as (XRReferenceSpace & EventTarget) | null;
    space?.addEventListener('reset', () => this.recenter());
    rs.scene.add(this.rig);
    this.buildControllers(r);
    this.panel = new VRPanel(12, 11);
    this.hud = new VRHud();
    rs.boardRoot.add(this.panel.mesh, this.hud.mesh);
    const stages = this.host.stages();
    this.stageIndex = Math.max(0, stages.findIndex((s) => s.id === this.host.currentStage()));
    this.savedBoard = { position: rs.boardRoot.position.clone(), scale: rs.boardRoot.scale.clone(), rotation: [rs.boardRoot.rotation.x, rs.boardRoot.rotation.y, rs.boardRoot.rotation.z] };
    this.applyLayout();
    this.unsubs.push(settingsStore.subscribe((s, prev) => s.settings.vr !== prev.settings.vr && this.applyLayout()));
    this.unsubs.push(this.host.input.onMenu((e) => this.handleMenu(e)));
    this.unsubs.push(this.host.onHaptic((kind) => this.haptic(kind)));
    rs.bursts.density = Math.min(rs.bursts.density, profile.particles);
    rs.boardBursts.density = Math.min(rs.boardBursts.density, profile.particles);
    rs.presenter = () => this.draw();
    this.presenting = true;
    this.starting = false;
    this.host.beginExternalFrames();
    this.changed();
  }

  /** Ends VR and returns to the desktop view (game state untouched). */
  async exit(): Promise<void> {
    await this.session?.end().catch(() => undefined);
  }

  private tearDown(): void {
    const rs = this.host.renderSystem();
    this.renderer?.setAnimationLoop(null);
    this.input.releaseAll(performance.now());
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (rs) {
      rs.presenter = null;
      if (this.savedBoard) {
        rs.boardRoot.position.copy(this.savedBoard.position);
        rs.boardRoot.scale.copy(this.savedBoard.scale);
        rs.boardRoot.rotation.set(...this.savedBoard.rotation);
      }
      rs.scene.environment = this.savedEnvironment;
      rs.scene.remove(this.rig);
      const g = getSettings().graphics;
      rs.bursts.density = Math.max(0.05, g.particleDensity);
      rs.boardBursts.density = rs.bursts.density;
    }
    for (const c of this.controllers) this.rig.remove(c);
    this.controllers.length = 0;
    this.rays.forEach((l) => {
      l.geometry.dispose();
      (l.material as LineBasicNodeMaterial).dispose();
    });
    this.rays.length = 0;
    this.panel?.mesh.removeFromParent();
    this.hud?.mesh.removeFromParent();
    this.panel?.dispose();
    this.hud?.dispose();
    this.panel = null;
    this.hud = null;
    this.dimmer?.removeFromParent();
    this.session = null;
    this.pointer = null;
    this.presenting = false;
    this.starting = false;
    this.host.endExternalFrames();
    this.changed();
  }

  /** Places the player on the stage ground and the playfield in front of them. */
  applyLayout(): void {
    const rs = this.host.renderSystem();
    if (!rs) return;
    const vr = getSettings().vr;
    this.layoutWorld = rs.environments.current;
    const ground = rs.environments.current?.ctx.ground.surface(0, 30) ?? -14;
    const standing = vr.layout === 'standing';
    // Runtimes disagree on where the "local" origin sits (head or floor), so the layout follows
    // the measured head: seated puts the eyes 1.2 m above the stage ground, standing uses the
    // player's real height above their floor. Either way the playfield is centred on the head.
    const head = this.head;
    const eye = standing ? ground + (head ? head.y : STANDING_EYE) : ground + SEATED_EYE;
    const headY = head ? head.y : standing ? STANDING_EYE : 0;
    this.rig.position.set(-(head?.x ?? 0), eye - headY, 30 - (head?.z ?? 0));
    const s = vr.boardScale / BOARD_UNITS_PER_METRE;
    rs.boardRoot.scale.setScalar(s);
    rs.boardRoot.position.set(0, eye + vr.boardHeight, 30 - vr.boardDistance);
    rs.boardRoot.rotation.set(MathUtils.degToRad(-vr.boardTilt), 0, 0);
    if (this.hud) {
      this.hud.mesh.position.set(-9.6, 3.5, vr.hudOffset / s);
      this.hud.mesh.scale.setScalar(vr.hudScale);
    }
    if (this.panel) this.panel.mesh.position.set(0, 0, 0.14 / s);
    // Optional dimming sphere around the player for focus.
    if (vr.dimWorld > 0) {
      if (!this.dimmer) {
        const m = new MeshBasicNodeMaterial({ color: 0x000000, transparent: true, side: BackSide, depthWrite: false });
        this.dimmer = new Mesh(new SphereGeometry(60, 24, 16), m);
        this.dimmer.renderOrder = 20;
      }
      (this.dimmer.material as MeshBasicNodeMaterial).opacity = vr.dimWorld;
      this.rig.add(this.dimmer);
    } else this.dimmer?.removeFromParent();
    for (const l of this.rays) l.visible = vr.showRays;
  }

  private buildControllers(r: WebGPURenderer): void {
    for (let i = 0; i < 2; i++) {
      const c = r.xr.getController(i) as unknown as Group;
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
      const line = new Line(geo, new LineBasicNodeMaterial({ color: 0xbfd4ff, transparent: true, opacity: 0.7 }));
      line.scale.z = 3;
      c.add(line);
      (c as unknown as { addEventListener(type: string, fn: () => void): void }).addEventListener('selectstart', () => {
        this.pointer = c;
        this.select(c);
      });
      this.rig.add(c);
      this.controllers.push(c);
      this.rays.push(line);
    }
  }

  private rayFrom(c: Object3D): Ray {
    c.updateMatrixWorld();
    this.tmp.identity().extractRotation(c.matrixWorld);
    this.ray.origin.setFromMatrixPosition(c.matrixWorld);
    this.ray.direction.set(0, 0, -1).applyMatrix4(this.tmp).normalize();
    return this.ray;
  }

  private select(c: Object3D): void {
    if (!this.panel || !this.panelVisible) return;
    const i = this.panel.hitTest(this.rayFrom(c));
    if (i < 0) return;
    this.panel.setHover(i);
    this.activate(this.panel.current());
  }

  private handleMenu(e: ActionEvent<MenuAction>): void {
    if (!this.presenting || e.device !== 'xr' || !e.down || !this.panel || !this.panelVisible) return;
    if (e.action === 'up') this.panel.move(-1);
    else if (e.action === 'down') this.panel.move(1);
    else if (e.action === 'confirm') this.activate(this.panel.current());
    else if (e.action === 'back' && this.host.appState().paused) this.host.resume();
    else if ((e.action === 'left' || e.action === 'right') && this.panel.current() === 'world') this.cycleStage(e.action === 'left' ? -1 : 1);
  }

  private cycleStage(delta: number): void {
    const stages = this.host.stages();
    if (stages.length === 0) return;
    this.stageIndex = (this.stageIndex + delta + stages.length) % stages.length;
    this.host.chooseStage(stages[this.stageIndex]!.id);
  }

  private activate(id: string | null): void {
    const now = performance.now();
    if (now - this.lastActivate < 250) return;
    this.lastActivate = now;
    switch (id) {
      case 'resume':
        this.host.resume();
        break;
      case 'restart':
        this.host.restart();
        break;
      case 'menu':
        this.host.quitToMenu();
        break;
      case 'exit':
        void this.exit();
        break;
      case 'marathon':
      case 'zen':
      case 'voyage':
        this.host.startMode(id);
        break;
      case 'world':
        this.cycleStage(1);
        break;
      case 'again':
        this.host.restart();
        break;
      case 'recenter':
        this.recenter();
        break;
      default:
        break;
    }
    this.input.pulse('right', 0.25 * getSettings().vr.hapticStrength, 30);
  }

  private haptic(kind: 'drop' | 'clear' | 'quad' | 'lock'): void {
    const vr = getSettings().vr;
    if (!vr.haptics || !this.presenting) return;
    const k = vr.hapticStrength;
    if (kind === 'drop') this.input.pulse('both', 0.45 * k, 40);
    else if (kind === 'lock') this.input.pulse('both', 0.15 * k, 18);
    else if (kind === 'clear') this.input.pulse('both', 0.55 * k, 90);
    else this.input.pulse('both', 0.9 * k, 220);
  }

  /** Per-frame VR drawing (called by the render system after the scene update). */
  private draw(): void {
    const rs = this.host.renderSystem();
    const r = this.renderer;
    if (!rs || !r) return;
    if (rs.environments.current !== this.layoutWorld) this.applyLayout();
    this.updateUi();
    r.render(rs.scene, this.camera);
    // After a render the eye cameras hold their poses in reference space; the head is their midpoint.
    const eyes = r.xr.getCamera().cameras;
    if (!this.head && ++this.framesSinceAnchor > 3 && eyes.length > 0) {
      const head = new Vector3();
      for (const c of eyes) head.add(c.position);
      this.head = head.divideScalar(eyes.length);
      this.applyLayout();
    }
  }

  /** Re-centres the playfield in front of the player's current head position. */
  recenter(): void {
    this.head = null;
    this.framesSinceAnchor = 0;
  }

  private updateUi(): void {
    if (!this.panel || !this.hud) return;
    const app = this.host.appState();
    const stages = this.host.stages();
    const stageName = stages[this.stageIndex]?.name ?? '';
    let items: PanelItem[] | null = null;
    let title = '';
    let lines: string[] = [];
    if (app.screen === 'game' || app.screen === 'loading') {
      if (app.paused) {
        title = 'Paused';
        items = [
          { id: 'resume', label: 'Resume' },
          { id: 'restart', label: 'Restart' },
          { id: 'recenter', label: 'Recentre view' },
          { id: 'menu', label: 'Quit to menu' },
          { id: 'exit', label: 'Exit VR' },
        ];
      }
    } else if (app.screen === 'results') {
      const res = this.host.results();
      title = res?.title ?? 'Results';
      lines = res ? [`Score ${res.score.toLocaleString()}`, `Lines ${res.lines}`] : [];
      items = [
        { id: 'again', label: 'Play again' },
        { id: 'menu', label: 'Menu' },
        { id: 'exit', label: 'Exit VR' },
      ];
    } else {
      title = 'Prismfall VR';
      lines = ['Point and pull the trigger, or use a thumbstick.'];
      items = [
        { id: 'marathon', label: 'Marathon' },
        { id: 'zen', label: 'Zen', detail: 'no game over' },
        { id: 'voyage', label: 'Voyage' },
        { id: 'world', label: 'World', detail: `${stageName}  ◀ ▶` },
        { id: 'recenter', label: 'Recentre view' },
        { id: 'exit', label: 'Exit VR' },
      ];
    }
    this.panelVisible = items !== null;
    this.panel.mesh.visible = this.panelVisible;
    if (items) {
      this.panel.set(title, items, lines);
      let hover = -1;
      // The pointing hand wins; the other hand's ray only highlights when the pointer is off the panel.
      const order = this.pointer ? [this.pointer, ...this.controllers.filter((c) => c !== this.pointer)] : [...this.controllers].reverse();
      for (const c of order) {
        hover = this.panel.hitTest(this.rayFrom(c));
        if (hover >= 0) break;
      }
      this.panel.setHover(hover);
      this.panel.redraw();
    }
    const h = this.host.hud();
    const playing = app.screen === 'game';
    this.hud.mesh.visible = playing;
    if (playing) {
      const t = Math.floor(h.timeMs / 1000);
      this.hud.update(
        [
          ['Score', h.score.toLocaleString()],
          ['Level', String(h.level)],
          ['Lines', String(h.lines)],
          ['Time', `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`],
        ],
        h.combo > 0 ? `Combo ×${h.combo}` : h.callout,
      );
    }
  }

  /** Camera the audio listener should follow while presenting. */
  listenerPose(out: { position: Vector3; forward: Vector3 }): boolean {
    if (!this.presenting || !this.renderer) return false;
    const cam = this.renderer.xr.getCamera();
    cam.getWorldPosition(out.position);
    cam.getWorldDirection(out.forward);
    return true;
  }

  /** Controller families seen in this session. */
  controllerProfiles(): string[] {
    return this.input.profiles();
  }
}
