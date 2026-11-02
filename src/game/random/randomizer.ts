import { PIECE_TYPES, type PieceType } from '../pieces/pieces';
import { Rng } from './rng';

export type RandomizerConfig =
  | { readonly kind: 'bag7' }
  | { readonly kind: 'random' }
  /** Practice drill: random choice among a fixed subset of tetrominoes. */
  | { readonly kind: 'drill'; readonly pieces: readonly PieceType[] };

/** Infinite deterministic piece stream with a look-ahead queue. */
export class PieceQueue {
  private readonly rng: Rng;
  private readonly config: RandomizerConfig;
  private readonly items: PieceType[] = [];
  private static readonly MIN_LOOKAHEAD = 14;

  constructor(seed: number, config: RandomizerConfig = { kind: 'bag7' }) {
    this.rng = new Rng(seed);
    this.config = config;
    this.refill();
  }

  private refill(): void {
    while (this.items.length < PieceQueue.MIN_LOOKAHEAD) {
      switch (this.config.kind) {
        case 'bag7': {
          const bag = [...PIECE_TYPES];
          for (let i = bag.length - 1; i > 0; i--) {
            const j = this.rng.nextInt(i + 1);
            [bag[i], bag[j]] = [bag[j] as PieceType, bag[i] as PieceType];
          }
          this.items.push(...bag);
          break;
        }
        case 'random':
          this.items.push(PIECE_TYPES[this.rng.nextInt(PIECE_TYPES.length)] as PieceType);
          break;
        case 'drill': {
          const pool = this.config.pieces.length > 0 ? this.config.pieces : PIECE_TYPES;
          this.items.push(pool[this.rng.nextInt(pool.length)] as PieceType);
          break;
        }
      }
    }
  }

  next(): PieceType {
    const piece = this.items.shift() as PieceType;
    this.refill();
    return piece;
  }

  /** The upcoming `count` pieces without consuming them. */
  peek(count: number): readonly PieceType[] {
    return this.items.slice(0, count);
  }

  snapshot(): { items: PieceType[]; rng: [number, number, number, number] } {
    return { items: [...this.items], rng: this.rng.getState() };
  }

  restore(snap: { items: readonly PieceType[]; rng: readonly [number, number, number, number] }): void {
    this.items.length = 0;
    this.items.push(...snap.items);
    this.rng.setState(snap.rng);
  }
}
