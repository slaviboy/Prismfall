/**
 * Small, fast, deterministic PRNG (sfc32) seeded via splitmix32.
 * Identical sequences on every JS engine — only 32-bit integer arithmetic is used.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform integer in [0, n) without modulo bias. */
  nextInt(n: number): number {
    if (n <= 1) return 0;
    const limit = Math.floor(0x100000000 / n) * n;
    let v = this.nextUint32();
    while (v >= limit) v = this.nextUint32();
    return v % n;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  getState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  setState(state: readonly [number, number, number, number]): void {
    [this.a, this.b, this.c, this.d] = state;
  }
}

/** Produces a random 32-bit seed for new sessions (not used inside the engine). */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] as number;
}

/** Stable 32-bit hash (FNV-1a) of a string, e.g. to turn a seed phrase into a seed. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
