import { CanvasTexture, DoubleSide, Matrix4, Mesh, MeshBasicNodeMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Ray } from 'three/webgpu';
import { texture, vec4 } from 'three/tsl';

export interface PanelItem {
  readonly id: string;
  readonly label: string;
  /** Secondary text on the right (current value, shortcut). */
  readonly detail?: string;
}

function fontFamily(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

/**
 * A flat menu panel for VR: title, optional text lines and a column of buttons drawn into a canvas
 * texture. Controller rays hover and select buttons; thumbsticks move the highlight.
 */
export class VRPanel {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicNodeMaterial;
  private title = '';
  private lines: string[] = [];
  private items: PanelItem[] = [];
  hover = -1;
  selected = 0;
  private dirty = true;
  private readonly inv = new Matrix4();
  private readonly o = new Vector3();
  private readonly d = new Vector3();

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly px = 96,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * px);
    this.canvas.height = Math.round(height * px);
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new MeshBasicNodeMaterial();
    this.material.colorNode = vec4(texture(this.texture).rgb, texture(this.texture).a);
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.side = DoubleSide;
    this.material.fog = false;
    this.material.toneMapped = false;
    this.mesh = new Mesh(new PlaneGeometry(width, height), this.material);
    this.mesh.renderOrder = 50;
  }

  /** Replaces the content; keeps the highlight on the same item id when possible. */
  set(title: string, items: PanelItem[], lines: string[] = []): void {
    const key = JSON.stringify([title, items, lines]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const prevId = this.items[this.selected]?.id;
    this.title = title;
    this.items = items;
    this.lines = lines;
    const keep = items.findIndex((i) => i.id === prevId);
    this.selected = keep >= 0 ? keep : 0;
    this.dirty = true;
  }

  private lastKey = '';

  private rowRect(i: number): { y: number; h: number } {
    const top = this.canvas.height * 0.2 + this.lines.length * this.px * 0.42;
    const h = Math.min(this.px * 0.95, (this.canvas.height - top - this.px * 0.25) / Math.max(1, this.items.length));
    return { y: top + i * h, h };
  }

  /** Index of the item under a world-space ray (−1 if none). */
  hitTest(ray: Ray): number {
    this.mesh.updateMatrixWorld();
    this.inv.copy(this.mesh.matrixWorld).invert();
    this.o.copy(ray.origin).applyMatrix4(this.inv);
    this.d.copy(ray.direction).transformDirection(this.inv);
    if (Math.abs(this.d.z) < 1e-5) return -1;
    const t = -this.o.z / this.d.z;
    if (t < 0) return -1;
    const x = this.o.x + this.d.x * t;
    const y = this.o.y + this.d.y * t;
    if (Math.abs(x) > this.width / 2 || Math.abs(y) > this.height / 2) return -1;
    const py = (0.5 - y / this.height) * this.canvas.height;
    for (let i = 0; i < this.items.length; i++) {
      const r = this.rowRect(i);
      if (py >= r.y && py < r.y + r.h) return i;
    }
    return -1;
  }

  setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    if (i >= 0) this.selected = i;
    this.dirty = true;
  }

  move(delta: number): void {
    if (this.items.length === 0) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.dirty = true;
  }

  /** The highlighted item id. */
  current(): string | null {
    return this.items[this.selected]?.id ?? null;
  }

  redraw(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const display = fontFamily('--font-display', 'system-ui, sans-serif');
    const body = fontFamily('--font-body', 'system-ui, sans-serif');
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(8, 10, 22, 0.86)';
    const r = this.px * 0.25;
    c.beginPath();
    c.roundRect(0, 0, W, H, r);
    c.fill();
    c.strokeStyle = 'rgba(180, 200, 255, 0.35)';
    c.lineWidth = 3;
    c.stroke();
    c.fillStyle = '#f2f4ff';
    c.font = `500 ${Math.round(this.px * 0.55)}px ${display}`;
    c.textBaseline = 'middle';
    c.fillText(this.title, this.px * 0.4, H * 0.1);
    c.font = `400 ${Math.round(this.px * 0.3)}px ${body}`;
    c.fillStyle = 'rgba(220, 228, 255, 0.85)';
    this.lines.forEach((line, i) => c.fillText(line, this.px * 0.4, H * 0.2 + (i + 0.5) * this.px * 0.42));
    this.items.forEach((item, i) => {
      const row = this.rowRect(i);
      const active = i === this.selected;
      c.fillStyle = active ? 'rgba(120, 160, 255, 0.35)' : 'rgba(255, 255, 255, 0.06)';
      c.beginPath();
      c.roundRect(this.px * 0.3, row.y + row.h * 0.08, W - this.px * 0.6, row.h * 0.84, this.px * 0.12);
      c.fill();
      c.fillStyle = active ? '#ffffff' : 'rgba(230, 236, 255, 0.9)';
      c.font = `${active ? 600 : 500} ${Math.round(Math.min(row.h * 0.42, this.px * 0.4))}px ${body}`;
      c.fillText(item.label, this.px * 0.55, row.y + row.h / 2);
      if (item.detail) {
        c.textAlign = 'right';
        c.fillStyle = 'rgba(200, 214, 255, 0.8)';
        c.fillText(item.detail, W - this.px * 0.55, row.y + row.h / 2);
        c.textAlign = 'left';
      }
    });
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Score, level, lines, time and the latest callout, drawn next to the playfield in VR. */
export class VRHud {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicNodeMaterial;
  private last = '';

  constructor(
    readonly width = 6,
    readonly height = 9,
    private readonly px = 80,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * px);
    this.canvas.height = Math.round(height * px);
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new MeshBasicNodeMaterial();
    this.material.colorNode = vec4(texture(this.texture).rgb, texture(this.texture).a);
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.fog = false;
    this.material.toneMapped = false;
    this.mesh = new Mesh(new PlaneGeometry(width, height), this.material);
    this.mesh.renderOrder = 40;
  }

  update(rows: readonly [string, string][], callout: string): void {
    const key = JSON.stringify([rows, callout]);
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx;
    const W = this.canvas.width;
    const display = fontFamily('--font-display', 'system-ui, sans-serif');
    const body = fontFamily('--font-body', 'system-ui, sans-serif');
    c.clearRect(0, 0, W, this.canvas.height);
    c.textAlign = 'right';
    c.textBaseline = 'alphabetic';
    let y = this.px * 0.9;
    for (const [label, value] of rows) {
      c.fillStyle = 'rgba(200, 212, 255, 0.85)';
      c.font = `400 ${Math.round(this.px * 0.32)}px ${body}`;
      c.fillText(label, W - this.px * 0.3, y);
      y += this.px * 0.62;
      c.fillStyle = '#ffffff';
      c.font = `400 ${Math.round(this.px * (label === 'Score' ? 0.72 : 0.5))}px ${display}`;
      c.fillText(value, W - this.px * 0.3, y);
      y += this.px * 0.62;
    }
    if (callout) {
      c.fillStyle = '#ffe6a6';
      c.font = `600 ${Math.round(this.px * 0.42)}px ${display}`;
      c.fillText(callout, W - this.px * 0.3, y + this.px * 0.4);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
