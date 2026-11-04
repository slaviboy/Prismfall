/** Shared synthesis buffers per audio context (noise sources, impulse responses). */

const cache = new WeakMap<BaseAudioContext, { white: AudioBuffer; pink: AudioBuffer }>();

function fillNoise(ctx: BaseAudioContext, pink: boolean): AudioBuffer {
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = pink ? 0x2f6b9c1d : 0x51ed270b;
  const rnd = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  // Paul Kellet's refined pink filter.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = rnd();
    if (!pink) {
      data[i] = w * 0.5;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buffer;
}

export function noiseBuffers(ctx: BaseAudioContext): { white: AudioBuffer; pink: AudioBuffer } {
  let entry = cache.get(ctx);
  if (!entry) {
    entry = { white: fillNoise(ctx, false), pink: fillNoise(ctx, true) };
    cache.set(ctx, entry);
  }
  return entry;
}

const longCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/**
 * A long pink-noise loop (about 11 s, the seam crossfaded) for quiet, narrow-band beds where the
 * 2 s loop would be heard repeating. Layers reading it at different rates never line up.
 */
export function longPinkNoise(ctx: BaseAudioContext): AudioBuffer {
  let buffer = longCache.get(ctx);
  if (buffer) return buffer;
  const length = Math.round(ctx.sampleRate * 11.3);
  const fade = Math.round(ctx.sampleRate * 0.25);
  const raw = new Float32Array(length + fade);
  let seed = 0x6a09e667;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < raw.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const w = ((seed >>> 0) / 4294967296) * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  data.set(raw.subarray(0, length));
  // The tail beyond the loop fades into its start, so the seam is seamless.
  for (let i = 0; i < fade; i++) {
    const u = i / fade;
    data[i] = raw[i]! * Math.sqrt(u) + raw[length + i]! * Math.sqrt(1 - u);
  }
  longCache.set(ctx, buffer);
  return buffer;
}

/**
 * Procedural stereo impulse response: exponentially decaying noise whose high frequencies
 * fade faster (damping), giving a natural, original reverb tail.
 */
export function impulseResponse(ctx: BaseAudioContext, seconds: number, damping = 0.5, seed = 7): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let s = (seed * 2654435761 + ch * 97) >>> 0 || 1;
    let lp = 0;
    for (let i = 0; i < length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const white = ((s >>> 0) / 4294967296) * 2 - 1;
      const t = i / length;
      // Low-pass coefficient tightens over time: the tail darkens.
      const k = 0.92 - damping * 0.75 * t;
      lp = lp * (1 - k) + white * k;
      const env = Math.pow(1 - t, 2.2) * Math.exp(-t * 3);
      data[i] = lp * env * (i < rate * 0.004 ? i / (rate * 0.004) : 1);
    }
  }
  return buffer;
}
