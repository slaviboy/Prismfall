import type { BufferGeometry, Object3D } from 'three/webgpu';
import {
  BoxGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { Engine } from '../../game/core/engine';
import type { GameEvent } from '../../game/core/types';
import { PIECE_TYPES, pieceCells, pieceTypeFromCell, type PieceType } from '../../game/pieces/pieces';
import { GARBAGE_COLOR, type PiecePalette } from '../../config/palette';
import { BLOCK_STRIDE, createBlockMaterial, type BlockMaterialHandle } from '../materials/blockMaterial';
import { createDimMaterial, createFrameMaterial, createGhostDepthMaterial, createGhostMaterial, createPlateMaterial } from '../materials/boardMaterials';
import type { BlockMaterialPreset } from '../materials/blockPresets';
import { createRoundedBlock } from './blockGeometry';

export const BOARD_W = 10;
export const BOARD_H = 20;
const MAX_ROWS = 24;
const POD_X = 7.6;
const POD_SCALE = 0.7;
const POD_SPACING = 2.75;
const POD_TOP = 7.9;

export interface BoardViewOptions {
  readonly palette: PiecePalette;
  readonly preset: BlockMaterialPreset;
}

/** World position of a cell centre in board space (board centred on the origin). */
/** Ghost cells are scaled so the 0.94-wide block geometry closes the gaps between cells. */
const GHOST_SCALE = 1.06;

export function cellToWorld(x: number, y: number, out = new Vector3()): Vector3 {
  return out.set(x - BOARD_W / 2 + 0.5, y - BOARD_H / 2 + 0.5, 0);
}

class InstanceSet {
  readonly data: Float32Array;
  readonly buffer: InstancedInterleavedBuffer;
  readonly mesh: InstancedMesh;
  handle: BlockMaterialHandle;

  constructor(geometry: BufferGeometry, capacity: number, preset: BlockMaterialPreset) {
    this.data = new Float32Array(capacity * BLOCK_STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, BLOCK_STRIDE, 1);
    this.handle = createBlockMaterial(this.buffer, preset);
    this.mesh = new InstancedMesh(geometry, this.handle.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  private prepared: BlockMaterialHandle | null = null;

  /** Builds and compiles the material for `preset` ahead of `setPreset`, so the switch doesn't stall. */
  async prepare(preset: BlockMaterialPreset, precompile: (root: Object3D) => Promise<void>): Promise<void> {
    if (preset.surface === this.handle.surface || this.prepared?.surface === preset.surface) return;
    this.prepared?.material.dispose();
    const next = createBlockMaterial(this.buffer, preset);
    this.prepared = next;
    const probe = this.mesh.clone();
    probe.material = next.material;
    probe.count = 1;
    this.mesh.parent?.add(probe);
    try {
      await precompile(probe);
    } finally {
      probe.removeFromParent();
    }
  }

  write(i: number, rgb: Color, glyph: number, ao: number, dropRows: number, dropTime: number, lockTime: number): void {
    const o = i * BLOCK_STRIDE;
    const d = this.data;
    d[o] = rgb.r;
    d[o + 1] = rgb.g;
    d[o + 2] = rgb.b;
    d[o + 3] = glyph;
    d[o + 4] = ao;
    d[o + 5] = dropRows;
    d[o + 6] = dropTime;
    d[o + 7] = lockTime;
  }

  /** Applies a preset; a different surface kind compiles a new material (keeping glow and glyph state). */
  setPreset(preset: BlockMaterialPreset): void {
    if (preset.surface === this.handle.surface) {
      this.handle.apply(preset);
      return;
    }
    const old = this.handle;
    const ready = this.prepared?.surface === preset.surface ? this.prepared : null;
    this.prepared = null;
    if (ready) ready.apply(preset);
    const next = ready ?? createBlockMaterial(this.buffer, preset);
    next.glowScale.value = old.glowScale.value;
    next.glyphs.value = old.glyphs.value;
    next.intensity.value = old.intensity.value;
    next.dropDuration.value = old.dropDuration.value;
    this.handle = next;
    this.mesh.material = next.material;
    old.material.dispose();
  }

  commit(count: number): void {
    this.mesh.count = count;
    this.buffer.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.handle.material.dispose();
    this.mesh.dispose();
  }
}

/**
 * The playfield in 3D: settled blocks, active piece, ghost, hold/next pods, frame and plates.
 * Reads engine state each frame; only rewrites GPU buffers when versions change.
 */
export class BoardView {
  readonly group = new Group();
  readonly podsGroup = new Group();
  private geometry: BufferGeometry;
  private readonly settled: InstanceSet;
  private readonly active: InstanceSet;
  private readonly pods: InstanceSet;
  private readonly ghostMesh: InstancedMesh;
  /** The ghost keeps a plain sharp box whatever the block style, so it never looks like a real block. */
  private readonly ghostGeometry = new BoxGeometry(1, 1, 1);
  private readonly ghostDepthMesh: InstancedMesh;
  private readonly ghostDepth = createGhostDepthMaterial();
  /** Per-cell neighbour mask of the ghost (outline on the outer silhouette only). */
  private readonly ghostMask = new InstancedBufferAttribute(new Float32Array(16), 4);
  private readonly ghost = createGhostMaterial(this.ghostMask);
  private readonly plate = createPlateMaterial();
  private readonly frame = createFrameMaterial();
  private readonly dim = createDimMaterial();
  private readonly frameMeshes: Mesh[] = [];
  private readonly plateMesh: Mesh;
  private readonly dimMesh: Mesh;

  private palette: PiecePalette;
  private readonly colors = new Map<number, Color>();
  private glyphsOn = false;
  showGhost = true;
  showHold = true;
  showNext = true;
  nextCount = 5;
  lockIndicator = true;

  // Per-cell animation state in board coordinates (index = y * W + x).
  private readonly lockTimes = new Float32Array(BOARD_W * MAX_ROWS).fill(-1000);
  private readonly dropRows = new Float32Array(BOARD_W * MAX_ROWS);
  private readonly dropTimes = new Float32Array(BOARD_W * MAX_ROWS).fill(-1000);
  private boardVersion = -1;
  private pieceVersion = -1;
  /** Level-up bundle: the frame tint shifts with the level and surges on each level up. */
  private readonly baseAccent = new Color(0.45, 0.55, 1);
  private readonly levelTint = new Color();
  private level = 0;
  private levelSurge = 0;
  private lastSync = 0;
  private podsKey = '';
  private engineRef: Engine | null = null;

  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);
  private readonly tmpColor = new Color();

  constructor(options: BoardViewOptions) {
    this.palette = options.palette;
    this.geometry = createRoundedBlock();
    this.settled = new InstanceSet(this.geometry, BOARD_W * MAX_ROWS, options.preset);
    this.active = new InstanceSet(this.geometry, 4, options.preset);
    this.pods = new InstanceSet(this.geometry, 4 * 7, options.preset);
    this.pods.mesh.castShadow = false;
    this.ghostMesh = new InstancedMesh(this.ghostGeometry, this.ghost.material, 4);
    this.ghostMesh.count = 0;
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.renderOrder = 1001;
    // Depth pre-pass sharing the ghost's instance matrices, drawn just before the ghost.
    this.ghostDepthMesh = new InstancedMesh(this.ghostGeometry, this.ghostDepth, 4);
    this.ghostDepthMesh.instanceMatrix = this.ghostMesh.instanceMatrix;
    this.ghostDepthMesh.count = 0;
    this.ghostDepthMesh.frustumCulled = false;
    this.ghostDepthMesh.renderOrder = 1000;

    this.plateMesh = new Mesh(new PlaneGeometry(BOARD_W, BOARD_H), this.plate.material);
    this.plateMesh.position.z = -0.52;
    this.plateMesh.receiveShadow = true;
    this.dimMesh = new Mesh(new PlaneGeometry(34, 30), this.dim.material);
    this.dimMesh.position.z = -1.6;
    this.dimMesh.renderOrder = -1;

    const rail = (w: number, h: number, d: number, x: number, y: number, z = 0): void => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), this.frame.material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.frameMeshes.push(mesh);
      this.group.add(mesh);
    };
    rail(0.2, BOARD_H + 0.5, 1.15, -BOARD_W / 2 - 0.12, -0.05);
    rail(0.2, BOARD_H + 0.5, 1.15, BOARD_W / 2 + 0.12, -0.05);
    rail(BOARD_W + 0.44, 0.34, 1.25, 0, -BOARD_H / 2 - 0.19);

    this.group.add(this.dimMesh, this.plateMesh, this.settled.mesh, this.active.mesh, this.ghostDepthMesh, this.ghostMesh, this.podsGroup);
    this.podsGroup.add(this.pods.mesh);
    this.applyPaletteColors();
  }

  // ------------------------------------------------------------------ configuration

  setPalette(palette: PiecePalette): void {
    this.palette = palette;
    this.applyPaletteColors();
    this.invalidate();
  }

  setGlyphs(on: boolean): void {
    this.glyphsOn = on;
    for (const set of [this.settled, this.active, this.pods]) set.handle.glyphs.value = on ? 1 : 0;
    this.invalidate();
  }

  setPreset(preset: BlockMaterialPreset): void {
    for (const set of [this.settled, this.active, this.pods]) set.setPreset(preset);
  }

  /** Compiles the block materials for an upcoming preset in the background. */
  async preparePreset(preset: BlockMaterialPreset, precompile: (root: Object3D) => Promise<void>): Promise<void> {
    for (const set of [this.settled, this.active, this.pods]) await set.prepare(preset, precompile);
  }

  setGhostOpacity(opacity: number): void {
    this.ghost.opacity.value = opacity;
  }

  /** Block glow setting: self-illumination of settled, active and preview blocks. */
  setBlockGlow(v: number): void {
    for (const set of [this.settled, this.active, this.pods]) set.handle.glowScale.value = v;
  }

  setGrid(on: boolean): void {
    this.plate.u.grid.value = on ? 1 : 0;
  }

  /** Background dimming also sets how much of the world shows through the plate: 0 → 45 %, default 0.25 → 60 %, 0.9 → 95 % opaque. */
  setBackgroundDim(strength: number): void {
    this.dim.strength.value = strength;
    this.plate.u.opacity.value = Math.min(0.95, 0.45 + strength * 0.6);
  }

  setAccent(rgb: readonly [number, number, number], plateTint: readonly [number, number, number]): void {
    this.baseAccent.setRGB(rgb[0], rgb[1], rgb[2]);
    this.plate.u.tint.value.set(plateTint[0], plateTint[1], plateTint[2]);
    this.applyLevelTint();
  }

  /** The stage accent, hue-shifted a step per level (a full turn every 20 levels). */
  private applyLevelTint(): void {
    const steps = Math.max(0, this.level - 1);
    this.levelTint.copy(this.baseAccent).offsetHSL((steps * 0.05) % 1, 0, 0);
    const c = this.levelTint;
    this.frame.accent.value.set(c.r, c.g, c.b);
    this.plate.u.accent.value.set(c.r, c.g, c.b);
  }

  /** Replaces the block geometry (Blender block library); keeps the procedural one as fallback. */
  setBlockGeometry(geometry: BufferGeometry): void {
    const old = this.geometry;
    this.geometry = geometry;
    for (const mesh of [this.settled.mesh, this.active.mesh, this.pods.mesh]) mesh.geometry = geometry;
    old.dispose();
  }

  setCollapseDuration(seconds: number): void {
    this.settled.handle.dropDuration.value = seconds;
  }

  invalidate(): void {
    this.boardVersion = -1;
    this.pieceVersion = -1;
    this.podsKey = '';
  }

  private applyPaletteColors(): void {
    this.colors.clear();
    PIECE_TYPES.forEach((t, i) => this.colors.set(i + 1, new Color(this.palette[t]).convertSRGBToLinear()));
    this.colors.set(8, new Color(GARBAGE_COLOR).convertSRGBToLinear());
    const g = this.colors.get(1);
    if (g) this.ghost.color.value.set(g.r, g.g, g.b);
  }

  private colorOf(cell: number): Color {
    return this.colors.get(cell) ?? (this.colors.get(8) as Color);
  }

  // ------------------------------------------------------------------ per frame

  /** Feeds engine events (lock/clear timing) and refreshes instances when state changed. */
  sync(engine: Engine | null, events: readonly GameEvent[], nowSec: number): void {
    if (engine !== this.engineRef) {
      this.engineRef = engine;
      this.lockTimes.fill(-1000);
      this.dropRows.fill(0);
      this.dropTimes.fill(-1000);
      this.invalidate();
    }
    this.group.visible = engine !== null;
    if (!engine) return;
    const dt = Math.min(0.1, Math.max(0, nowSec - (this.lastSync || nowSec)));
    this.lastSync = nowSec;
    if (engine.level !== this.level) {
      const up = this.level > 0 && engine.level > this.level;
      this.level = engine.level;
      this.applyLevelTint();
      if (up) this.levelSurge = 1;
    }
    this.levelSurge *= Math.exp(-dt / 0.45);
    this.frame.glow.value = 1 + this.levelSurge * 1.8;
    for (const e of events) this.handleEvent(engine, e, nowSec);
    if (engine.board.version !== this.boardVersion) {
      this.boardVersion = engine.board.version;
      this.rebuildSettled(engine);
    }
    if (engine.pieceVersion !== this.pieceVersion) {
      this.pieceVersion = engine.pieceVersion;
      this.rebuildActive(engine);
    }
    const key = `${engine.hold ?? '-'}${engine.holdUsed ? 1 : 0}|${engine.preview(this.nextCount).join('')}|${this.showHold}${this.showNext}${this.nextCount}`;
    if (key !== this.podsKey) {
      this.podsKey = key;
      this.rebuildPods(engine);
    }
    this.active.handle.intensity.value = this.lockIndicator ? 1 - engine.lockProgress * 0.45 : 1;
  }

  private handleEvent(engine: Engine, e: GameEvent, now: number): void {
    if (e.type === 'lock') {
      for (const c of e.cells) if (c.y < MAX_ROWS) this.lockTimes[c.y * BOARD_W + c.x] = now;
    } else if (e.type === 'lineClear') {
      const cleared = new Set(e.rows);
      const lock = new Float32Array(this.lockTimes.length).fill(-1000);
      this.dropRows.fill(0);
      this.dropTimes.fill(-1000);
      const delay = Math.min(engine.rules.lineClearDelayMs * 0.55, 140) / 1000;
      let below = 0;
      for (let r = 0; r < MAX_ROWS; r++) {
        if (cleared.has(r)) {
          below++;
          continue;
        }
        const nr = r - below;
        for (let x = 0; x < BOARD_W; x++) {
          lock[nr * BOARD_W + x] = this.lockTimes[r * BOARD_W + x] as number;
          if (below > 0) {
            this.dropRows[nr * BOARD_W + x] = below;
            this.dropTimes[nr * BOARD_W + x] = now + delay;
          }
        }
      }
      this.lockTimes.set(lock);
    } else if (e.type === 'spawn') {
      this.active.handle.spawnTime.value = now;
    } else if (e.type === 'boardReset') {
      this.lockTimes.fill(-1000);
      this.dropRows.fill(0);
    }
  }

  private aoMask(engine: Engine, x: number, y: number): number {
    const b = engine.board;
    let mask = 0;
    if (x > 0 && b.get(x - 1, y) !== 0) mask |= 1;
    if (x < BOARD_W - 1 && b.get(x + 1, y) !== 0) mask |= 2;
    if (y > 0 && b.get(x, y - 1) !== 0) mask |= 4;
    if (b.get(x, y + 1) !== 0) mask |= 8;
    return mask;
  }

  private rebuildSettled(engine: Engine): void {
    const board = engine.board;
    let n = 0;
    const rows = Math.min(board.height, MAX_ROWS);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const cell = board.get(x, y);
        if (cell === 0) continue;
        const idx = y * BOARD_W + x;
        const glyph = this.glyphsOn ? cell : 0;
        this.settled.write(n, this.colorOf(cell), glyph, this.aoMask(engine, x, y), this.dropRows[idx] as number, this.dropTimes[idx] as number, this.lockTimes[idx] as number);
        this.m.compose(cellToWorld(x, y, this.v), this.q.identity(), this.s.set(1, 1, 1));
        this.settled.mesh.setMatrixAt(n, this.m);
        n++;
      }
    }
    this.settled.commit(n);
  }

  private rebuildActive(engine: Engine): void {
    const p = engine.active;
    if (!p) {
      this.active.commit(0);
      this.ghostMesh.count = 0;
      this.ghostDepthMesh.count = 0;
      return;
    }
    const color = this.colorOf(PIECE_TYPES.indexOf(p.type) + 1);
    const glyph = this.glyphsOn ? PIECE_TYPES.indexOf(p.type) + 1 : 0;
    const cells = pieceCells(p.type, p.rotation);
    const gy = engine.ghostY();
    const has = (x: number, y: number): boolean => cells.some((o) => o.x === x && o.y === y);
    cells.forEach((c, i) => {
      this.active.write(i, color, glyph, 0, 0, -1000, -1000);
      this.m.compose(cellToWorld(p.x + c.x, p.y + c.y, this.v), this.q.identity(), this.s.set(1, 1, 1));
      this.active.mesh.setMatrixAt(i, this.m);
      // Enlarged in x/y so neighbouring ghost cells meet into one shape.
      this.m.compose(cellToWorld(p.x + c.x, gy + c.y, this.v), this.q.identity(), this.s.set(GHOST_SCALE, GHOST_SCALE, 0.96));
      this.ghostMesh.setMatrixAt(i, this.m);
      this.ghostMask.setX(i, (has(c.x - 1, c.y) ? 1 : 0) | (has(c.x + 1, c.y) ? 2 : 0) | (has(c.x, c.y - 1) ? 4 : 0) | (has(c.x, c.y + 1) ? 8 : 0));
    });
    this.ghostMask.needsUpdate = true;
    this.active.commit(cells.length);
    this.ghost.color.value.set(color.r, color.g, color.b);
    this.ghostMesh.count = this.showGhost && gy !== p.y ? cells.length : 0;
    this.ghostDepthMesh.count = this.ghostMesh.count;
    this.ghostMesh.instanceMatrix.needsUpdate = true;
  }

  private placeMini(type: PieceType, cx: number, cy: number, scale: number, start: number, dim: boolean): number {
    const cells = pieceCells(type, 0);
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const base = this.colorOf(PIECE_TYPES.indexOf(type) + 1);
    const color = dim ? this.tmpColor.copy(base).multiplyScalar(0.3) : base;
    const glyph = this.glyphsOn ? PIECE_TYPES.indexOf(type) + 1 : 0;
    cells.forEach((c, i) => {
      this.pods.write(start + i, color, glyph, 0, 0, -1000, -1000);
      this.v.set(cx + (c.x - midX) * scale, cy + (c.y - midY) * scale, 0);
      this.m.compose(this.v, this.q.identity(), this.s.set(scale, scale, scale));
      this.pods.mesh.setMatrixAt(start + i, this.m);
    });
    return start + cells.length;
  }

  private rebuildPods(engine: Engine): void {
    let n = 0;
    if (this.showHold && engine.hold) n = this.placeMini(engine.hold, -POD_X, POD_TOP, POD_SCALE, n, engine.holdUsed);
    if (this.showNext) {
      engine.preview(this.nextCount).forEach((t, i) => {
        const scale = i === 0 ? POD_SCALE * 1.08 : POD_SCALE * 0.94;
        n = this.placeMini(t, POD_X, POD_TOP - i * POD_SPACING, scale, n, false);
      });
    }
    this.pods.commit(n);
  }

  /** Board-space bounds including pods (for camera framing). */
  static readonly FRAME_WIDTH = POD_X * 2 + 4;
  static readonly FRAME_HEIGHT = BOARD_H + 1.2;

  dispose(): void {
    this.settled.dispose();
    this.active.dispose();
    this.pods.dispose();
    this.ghost.material.dispose();
    this.ghostDepth.dispose();
    this.ghostGeometry.dispose();
    this.plate.material.dispose();
    this.frame.material.dispose();
    this.dim.material.dispose();
    this.plateMesh.geometry.dispose();
    this.dimMesh.geometry.dispose();
    for (const m of this.frameMeshes) m.geometry.dispose();
    this.geometry.dispose();
  }
}

export { pieceTypeFromCell };
