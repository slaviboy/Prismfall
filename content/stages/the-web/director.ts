/**
 * The Web's creature director: a pure, seeded scheduler (no three.js) deciding when the world's
 * setpieces happen. Quiet periods matter as much as events: the opening is still, starts are spaced
 * by irregular gaps, only a couple run at once and never two of a kind, each setpiece rests after it
 * ran, and a rise in the music's section intensity may bring the next one forward (never on the
 * beat). Comfort 'calm' doubles the gaps, allows one at a time and skips sudden setpieces; 'off'
 * keeps only the quietest ones (eyes far away, webs trembling).
 */
import type { Comfort } from './shared';

export type SetpieceKind = 'eyes' | 'emerge' | 'wall' | 'ceiling' | 'hang' | 'webwalk' | 'silhouette' | 'cross' | 'tremble';

export interface SetpieceSpec {
  id: string;
  kind: SetpieceKind;
  /** Relative chance when the director picks. */
  weight: number;
  /** Seconds this setpiece rests after it ends. */
  cooldown: number;
  /** An appearance that might startle (skipped in calm comfort). */
  sudden?: boolean;
}

export interface DirectorOptions {
  seed: number;
  comfort: Comfort;
  /** Seconds of stillness before the first setpiece. */
  opening?: [number, number];
  /** Seconds between setpiece starts. */
  gap?: [number, number];
  /** At most this many setpieces at once. */
  concurrent?: number;
}

/** Kinds that remain with comfort 'off'. */
const QUIET: SetpieceKind[] = ['eyes', 'tremble'];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Director {
  private readonly rand: () => number;
  private readonly specs: SetpieceSpec[];
  private readonly restUntil = new Map<string, number>();
  private readonly running = new Map<string, SetpieceKind>();
  private next: number;
  private lastSection = 0;
  private readonly gap: [number, number];
  private readonly concurrent: number;
  comfort: Comfort;

  constructor(specs: SetpieceSpec[], o: DirectorOptions) {
    this.rand = mulberry(o.seed * 2654435761 + 1);
    this.specs = specs;
    this.comfort = o.comfort;
    const open = o.opening ?? [10, 18];
    this.gap = o.gap ?? [9, 24];
    this.concurrent = o.concurrent ?? 2;
    this.next = open[0] + this.rand() * (open[1] - open[0]);
  }

  /** Setpieces currently running. */
  get active(): ReadonlyMap<string, SetpieceKind> {
    return this.running;
  }

  /** Call when a setpiece has finished (its creature left, its eyes closed). */
  finish(id: string, now: number): void {
    if (!this.running.delete(id)) return;
    const spec = this.specs.find((s) => s.id === id);
    this.restUntil.set(id, now + (spec?.cooldown ?? 30));
  }

  private allowed(s: SetpieceSpec): boolean {
    if (this.comfort === 'off') return QUIET.includes(s.kind);
    if (this.comfort === 'calm' && s.sudden) return false;
    return true;
  }

  /**
   * Advances to `now` (seconds); returns the ids of setpieces to start. `section` is the music's
   * section intensity (0..1): a clear rise pulls the next start forward a little.
   */
  update(now: number, section = 0): string[] {
    const started: string[] = [];
    if (section > this.lastSection + 0.25 && this.next - now > 4) this.next = now + 2 + this.rand() * 3;
    this.lastSection = this.lastSection + (section - this.lastSection) * 0.05;
    if (now < this.next) return started;
    const calm = this.comfort !== 'full';
    const limit = calm ? 1 : this.concurrent;
    const busyKinds = new Set(this.running.values());
    const pool = this.specs.filter((s) => this.allowed(s) && !this.running.has(s.id) && !busyKinds.has(s.kind) && (this.restUntil.get(s.id) ?? -1) <= now);
    if (this.running.size < limit && pool.length > 0) {
      const total = pool.reduce((t, s) => t + s.weight, 0);
      let r = this.rand() * total;
      let pick = pool[pool.length - 1]!;
      for (const s of pool) {
        r -= s.weight;
        if (r <= 0) {
          pick = s;
          break;
        }
      }
      this.running.set(pick.id, pick.kind);
      started.push(pick.id);
    }
    const [g0, g1] = this.gap;
    this.next = now + (g0 + this.rand() * (g1 - g0)) * (calm ? 2 : 1);
    return started;
  }
}
