import { AdditiveBlending, Color, InstancedInterleavedBuffer, InstancedMesh, MeshBasicNodeMaterial, type BufferGeometry } from 'three/webgpu';
import { clamp, exp, float, instancedBufferAttribute, max, mrt, positionGeometry, smoothstep, vec4 } from 'three/tsl';
import type { Engine } from '../../game/core/engine';
import type { GameEvent } from '../../game/core/types';
import { PIECE_TYPES, pieceTypeFromCell } from '../../game/pieces/pieces';
import { registries } from '../../sdk/registry';
import type { ClearInfo, EffectContext, StageGameEvent, StagePalette } from '../../sdk/types';
import type { PiecePalette } from '../../config/palette';
import type { BurstSystem } from '../particles/BurstSystem';
import type { CameraRig } from '../camera/CameraRig';
import { cellToWorld } from '../board/BoardView';
import { frameUniforms } from '../shaders/uniforms';

const GHOST_CAP = 160;
const GHOST_STRIDE = 8; // [x y z t0] [r g b dur]

export interface FeedbackSettings {
  intensity: number;
  reducedMotion: boolean;
  screenEffects: number;
}

/**
 * Turns gameplay events into visual feedback: particles, clear ghosts, camera emphasis,
 * global pulses and stage events. Purely presentational — never touches the engine.
 */
export class FeedbackDirector {
  readonly ghosts: InstancedMesh;
  private readonly ghostData = new Float32Array(GHOST_CAP * GHOST_STRIDE);
  private readonly ghostBuffer: InstancedInterleavedBuffer;
  private ghostCursor = 0;
  palette: StagePalette = { accent: '#6e8bff', secondary: '#b57cff', highlight: '#eef0ff', fog: '#05040f' };
  piecePalette: PiecePalette | null = null;
  lineClearEffect = { effect: 'prismBurst', params: {} as Record<string, unknown> };
  settings: FeedbackSettings = { intensity: 1, reducedMotion: false, screenEffects: 1 };
  onStageEvent: ((e: StageGameEvent) => void) | null = null;
  private dangerActive = false;
  private readonly tmp = new Color();

  constructor(
    private readonly bursts: BurstSystem,
    private readonly camera: CameraRig,
    geometry: BufferGeometry,
  ) {
    for (let i = 0; i < GHOST_CAP; i++) this.ghostData[i * GHOST_STRIDE + 3] = -1e6;
    this.ghostBuffer = new InstancedInterleavedBuffer(this.ghostData, GHOST_STRIDE, 1);
    const a0 = instancedBufferAttribute<'vec4'>(this.ghostBuffer, 'vec4', GHOST_STRIDE, 0);
    const a1 = instancedBufferAttribute<'vec4'>(this.ghostBuffer, 'vec4', GHOST_STRIDE, 4);
    const age = frameUniforms.time.sub(a0.w);
    const k = clamp(age.div(max(a1.w, 0.01)), 0, 1);
    const alive = smoothstep(0, 0.001, age).mul(float(1).sub(smoothstep(0.98, 1, k)));
    // Flash to white, then shrink away while glowing in the piece colour.
    const scale = float(1).sub(k.pow(1.6)).mul(alive).add(k.mul(0.15).mul(alive));
    const flash = exp(k.mul(-6)).mul(2.5);
    const color = a1.xyz.mul(float(1.2).add(flash)).add(flash.mul(0.6)).mul(alive).mul(float(1).sub(k.mul(0.6)));
    const material = new MeshBasicNodeMaterial();
    material.positionNode = positionGeometry.mul(scale).add(a0.xyz);
    material.colorNode = vec4(color, 1);
    material.mrtNode = mrt({ emissive: vec4(color.mul(0.9), 1) });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    this.ghosts = new InstancedMesh(geometry, material, GHOST_CAP);
    this.ghosts.frustumCulled = false;
    this.ghosts.renderOrder = 3;
  }

  setGeometry(geometry: BufferGeometry): void {
    this.ghosts.geometry = geometry;
  }

  private effectContext(): EffectContext {
    return {
      bursts: this.bursts,
      uniforms: frameUniforms,
      palette: this.palette,
      cellToWorld: (x, y) => {
        const v = cellToWorld(x, y);
        return { x: v.x, y: v.y, z: v.z };
      },
      intensityScale: this.settings.intensity,
      reducedMotion: this.settings.reducedMotion,
    };
  }

  private cellColor(cell: number): [number, number, number] {
    const type = pieceTypeFromCell(cell);
    const hex = type && this.piecePalette ? this.piecePalette[type] : '#9aa0c0';
    this.tmp.set(hex).convertSRGBToLinear();
    return [this.tmp.r, this.tmp.g, this.tmp.b];
  }

  private ghost(x: number, y: number, color: [number, number, number], now: number, duration: number): void {
    const i = this.ghostCursor;
    this.ghostCursor = (this.ghostCursor + 1) % GHOST_CAP;
    const p = cellToWorld(x, y);
    const o = i * GHOST_STRIDE;
    this.ghostData.set([p.x, p.y, p.z, now, color[0], color[1], color[2], duration], o);
    this.ghostBuffer.needsUpdate = true;
  }

  private puff(x: number, y: number, z: number, count: number, color: [number, number, number], now: number, opts: { speed?: number; size?: number; up?: number; life?: number; shape?: 'soft' | 'spark' | 'star' } = {}): void {
    const n = this.bursts.budget(count * this.settings.intensity);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (opts.speed ?? 2) * (0.4 + Math.random());
      this.bursts.emit(
        {
          x: x + (Math.random() - 0.5) * 0.6,
          y,
          z: z + (Math.random() - 0.5) * 0.5,
          vx: Math.cos(a) * s,
          vy: (opts.up ?? 0.6) * s + Math.random(),
          vz: Math.sin(a) * s * 0.4,
          r: color[0],
          g: color[1],
          b: color[2],
          size: (opts.size ?? 0.22) * (0.6 + Math.random() * 0.8),
          life: (opts.life ?? 0.55) * (0.6 + Math.random() * 0.8),
          gravity: -2,
          drag: 2.4,
          shape: opts.shape ?? 'soft',
          swirl: 0.4,
        },
        now,
      );
    }
  }

  /** Expanding ring of light around the board centre (perfect clear, level up, stage change). */
  private shockwave(color: [number, number, number], size: number, now: number, life = 0.9): void {
    if (this.settings.screenEffects <= 0.01) return;
    const k = this.settings.screenEffects;
    this.bursts.emit({ x: 0, y: 0, z: 1.5, vx: 0, vy: 0, vz: 0, r: color[0] * 1.6 * k, g: color[1] * 1.6 * k, b: color[2] * 1.6 * k, size, life, drag: 1, shape: 'ring' }, now);
  }

  private hex(hex: string, scale = 1): [number, number, number] {
    this.tmp.set(hex).convertSRGBToLinear();
    return [this.tmp.r * scale, this.tmp.g * scale, this.tmp.b * scale];
  }

  handle(events: readonly GameEvent[], engine: Engine | null, nowSec: number): void {
    for (const e of events) {
      switch (e.type) {
        case 'spawn': {
          const p = cellToWorld(e.x + 1, Math.min(e.y + 1, 20));
          this.puff(p.x, p.y, 0.6, 5, this.cellColor(PIECE_TYPES.indexOf(e.piece) + 1).map((c) => c * 1.5) as [number, number, number], nowSec, { speed: 1.2, size: 0.18, up: 0.2, life: 0.35, shape: 'star' });
          break;
        }
        case 'rotate':
          if (e.kick > 0 && engine?.active) {
            const cells = engine.activeCells();
            const c = cells[0];
            if (c) {
              const p = cellToWorld(c.x, c.y);
              this.puff(p.x, p.y, 0.6, 4, [1.4, 1.4, 1.6], nowSec, { speed: 1.5, size: 0.14, life: 0.3, shape: 'spark' });
            }
          }
          break;
        case 'hardDrop': {
          const color = this.cellColor(PIECE_TYPES.indexOf(e.piece) + 1);
          const n = this.bursts.budget(Math.min(40, 6 + e.rows * 2) * this.settings.intensity);
          for (const c of e.cells) {
            const p = cellToWorld(c.x, c.y);
            for (let i = 0; i < n / 4; i++) {
              const off = Math.random() * e.rows;
              this.bursts.emit({ x: p.x + (Math.random() - 0.5) * 0.7, y: p.y + off, z: 0.4, vx: 0, vy: 4 + Math.random() * 3, vz: 0, r: color[0] * 1.8, g: color[1] * 1.8, b: color[2] * 1.8, size: 0.16, life: 0.28 + Math.random() * 0.2, drag: 3, shape: 'spark' }, nowSec);
            }
          }
          const low = e.cells.reduce((m, c) => Math.min(m, c.y), 99);
          for (const c of e.cells.filter((cc) => cc.y === low)) {
            const p = cellToWorld(c.x, c.y);
            this.puff(p.x, p.y - 0.5, 0.5, 6, color.map((v) => v * 1.2) as [number, number, number], nowSec, { speed: 3, size: 0.25, up: 0.3 });
          }
          this.camera.addTrauma(Math.min(0.35, 0.08 + e.rows * 0.012));
          this.onStageEvent?.({ kind: 'hardDrop', rows: e.rows });
          break;
        }
        case 'lock': {
          const low = e.cells.reduce((m, c) => Math.min(m, c.y), 99);
          for (const c of e.cells.filter((cc) => cc.y === low)) {
            const p = cellToWorld(c.x, c.y);
            this.puff(p.x, p.y - 0.5, 0.5, 2, [0.6, 0.65, 0.9], nowSec, { speed: 1.6, size: 0.2, up: 0.2, life: 0.45 });
          }
          this.onStageEvent?.({ kind: 'lock' });
          break;
        }
        case 'lineClear': {
          const intensity = Math.min(1.6, e.lines / 4 + (e.spin !== 'none' ? 0.35 : 0) + (e.backToBack ? 0.2 : 0) + (e.perfectClear ? 0.6 : 0) + Math.min(0.3, Math.max(0, e.combo) * 0.04));
          const cells = e.clearedCells.map((c) => ({ x: c.x, y: c.y, color: this.cellColor(c.cell) }));
          for (const c of cells) this.ghost(c.x, c.y, c.color, nowSec + Math.abs(c.x - 4.5) * 0.008, 0.32 + intensity * 0.12);
          const info: ClearInfo = { rows: e.rows, cells, lines: e.lines, intensity, spin: e.spin !== 'none', perfectClear: e.perfectClear, combo: e.combo, backToBack: e.backToBack, time: nowSec };
          const effect = registries.lineClearEffects.get(this.lineClearEffect.effect) ?? registries.lineClearEffects.get('prismBurst');
          try {
            effect?.trigger(this.effectContext(), info, this.lineClearEffect.params);
          } catch (err) {
            console.warn('[fx] line-clear effect failed', err);
          }
          frameUniforms.clearPulse.value = Math.min(1.6, frameUniforms.clearPulse.value + intensity * 0.8 * frameUniforms.flashLimit.value);
          this.camera.addTrauma(0.12 + intensity * 0.3);
          if (e.lines >= 4 || e.perfectClear || e.spin !== 'none') this.camera.addPush(0.5 + intensity * 0.4);
          if (e.perfectClear) {
            this.shockwave(this.hex(this.palette.highlight), 40, nowSec, 1.2);
            this.shockwave(this.hex(this.palette.accent), 26, nowSec + 0.12, 1);
          } else if (e.lines >= 4) this.shockwave(this.hex(this.palette.accent), 24, nowSec, 0.8);
          this.onStageEvent?.({ kind: 'clear', lines: e.lines, intensity, spin: e.spin !== 'none', perfectClear: e.perfectClear, combo: e.combo, backToBack: e.backToBack });
          break;
        }
        case 'levelUp':
          this.shockwave(this.hex(this.palette.secondary), 30, nowSec, 1.1);
          this.onStageEvent?.({ kind: 'levelUp', level: e.level });
          break;
        case 'boardReset':
        case 'gameOver':
          if (engine) this.dissolveStack(engine, nowSec);
          if (e.type === 'gameOver') this.onStageEvent?.({ kind: 'gameOver' });
          break;
        default:
          break;
      }
    }
    if (engine) {
      const danger = engine.board.stackHeight() >= 16;
      if (danger !== this.dangerActive) {
        this.dangerActive = danger;
        this.onStageEvent?.({ kind: 'danger', active: danger });
      }
    }
    this.bursts.flush();
  }

  /** The whole stack bursts into light (Zen board reset, game over). */
  private dissolveStack(engine: Engine, now: number): void {
    const b = engine.board;
    for (let y = 0; y < Math.min(b.height, 22); y++) {
      for (let x = 0; x < b.width; x++) {
        const cell = b.get(x, y);
        if (cell === 0) continue;
        const color = this.cellColor(cell);
        this.ghost(x, y, color, now + y * 0.02, 0.6);
        const p = cellToWorld(x, y);
        this.puff(p.x, p.y, 0.4, 2, color.map((c) => c * 1.6) as [number, number, number], now + y * 0.02, { speed: 3, size: 0.3, up: 0.5, life: 1.1, shape: 'star' });
      }
    }
  }

  /** Warp streaks rushing past the camera while one world gives way to the next. */
  stageTransition(accentHex: string): void {
    const now = frameUniforms.time.value;
    const c = this.hex(accentHex, 2.5);
    const n = this.bursts.budget(500 * this.settings.intensity * (this.settings.reducedMotion ? 0.3 : 1));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * 30;
      this.bursts.emit({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.6, z: -60 - Math.random() * 80, vx: 0, vy: 0, vz: 70 + Math.random() * 60, r: c[0], g: c[1], b: c[2], size: 0.3 + Math.random() * 0.5, life: 1.2 + Math.random() * 0.6, delay: Math.random() * 0.8, drag: 0.1, shape: 'spark' }, now);
    }
    this.shockwave(this.hex(accentHex), 50, now + 0.3, 1.6);
    frameUniforms.clearPulse.value = Math.min(1.6, frameUniforms.clearPulse.value + 0.6 * frameUniforms.flashLimit.value);
    this.bursts.flush();
  }

  dispose(): void {
    (this.ghosts.material as MeshBasicNodeMaterial).dispose();
  }
}
