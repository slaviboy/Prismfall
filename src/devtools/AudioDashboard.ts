import type { AudioFeatures } from '../audio/analysis/features';
import { DEFAULT_BANDS } from '../audio/analysis/dsp/bands';
import type { AudioSystem } from '../audio/AudioSystem';
import type { Binding } from '../stages/schema';

export interface DashboardSource {
  readonly audio: AudioSystem;
  features(): Readonly<AudioFeatures>;
  /** Live reactivity bindings of the current stage (empty without one). */
  bindings(): readonly { binding: Binding; env: number; value: number }[];
  stageName(): string;
}

const C = {
  bg: 'rgba(18, 15, 42, 0.92)',
  grid: 'rgba(158, 163, 201, 0.14)',
  text: '#eef0ff',
  dim: '#9ea3c9',
  aqua: '#5cf2c8',
  violet: '#b57cff',
  rose: '#ff5e87',
  amber: '#ffc85c',
  blue: '#6e8bff',
};
const BAND_LABELS = ['Sub', 'Bass', 'Low mid', 'Mid', 'High mid', 'Treble'];
const BAND_KEYS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'treble'] as const;
const HISTORY_S = 4;
const HISTORY = 1024;
const WIDTH = 540;
const BASE_HEIGHT = 744;
const ROW = 17;
const MAX_ROWS = 14;
const FONT = '12px "Atkinson Hyperlegible Next Variable", system-ui, sans-serif';

/**
 * Developer audio analysis dashboard (brief §24): spectrum, band meters, waveform, flux with
 * onsets, tempo and beat phase, levels and the stage's live reactivity bindings. Plain canvas,
 * outside React, reusing its typed arrays every frame.
 */
export class AudioDashboard {
  private readonly ctx: CanvasRenderingContext2D;
  private raf = 0;
  private freq: Float32Array<ArrayBuffer> = new Float32Array(0);
  private wave: Float32Array<ArrayBuffer> = new Float32Array(0);
  private readonly histT = new Float64Array(HISTORY);
  private readonly histFlux = new Float32Array(HISTORY);
  private readonly histTransient = new Float32Array(HISTORY);
  private readonly histOnset = new Uint8Array(HISTORY);
  private histIdx = 0;
  private lastOnsets = 0;
  private height = BASE_HEIGHT;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly src: DashboardSource,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  start(): void {
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private resize(rows: number): void {
    const h = BASE_HEIGHT + 22 + Math.min(rows, MAX_ROWS) * ROW + 8;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (h !== this.height || this.canvas.width !== Math.round(WIDTH * dpr)) {
      this.height = h;
      this.canvas.width = Math.round(WIDTH * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${WIDTH}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(): void {
    const { audio } = this.src;
    const f = this.src.features();
    const proc = audio.analysis.processor;
    const bindings = this.src.bindings();
    this.resize(bindings.length);
    const g = this.ctx;
    g.clearRect(0, 0, WIDTH, this.height);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, WIDTH, this.height);
    g.font = FONT;
    g.textBaseline = 'alphabetic';

    // History (time-based, so it looks the same at any refresh rate).
    const now = performance.now();
    const onset = proc.onsetCount !== this.lastOnsets;
    this.lastOnsets = proc.onsetCount;
    this.histT[this.histIdx] = now;
    this.histFlux[this.histIdx] = f.spectralFlux;
    this.histTransient[this.histIdx] = f.transientIntensity;
    this.histOnset[this.histIdx] = onset ? 1 : 0;
    this.histIdx = (this.histIdx + 1) % HISTORY;

    this.header(f);
    this.spectrum(14, 52, WIDTH - 28, 150);
    this.bands(14, 222, WIDTH - 28, 128);
    this.waveform(14, 370, WIDTH - 28, 70);
    this.flux(14, 460, WIDTH - 60, 100, now);
    this.transient(WIDTH - 36, 460, 22, 100, f.transientIntensity);
    this.beat(14, 580, f);
    this.levels(180, 580, f);
    this.bindingRows(14, BASE_HEIGHT - 6, bindings);
  }

  private label(text: string, x: number, y: number, color = C.dim, align: CanvasTextAlign = 'left'): void {
    const g = this.ctx;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(text, x, y);
  }

  private header(f: Readonly<AudioFeatures>): void {
    const a = this.src.audio;
    const path = a.analysisPath === 'worklet' ? 'Worklet' : a.analysisPath === 'analyser' ? 'Analyser' : 'Off';
    this.label('Audio analysis', 14, 20, C.text);
    this.label(`${this.src.stageName() || 'No stage'}  |  ${path}, ${Math.round(a.analysis.framesPerSecond)} frames/s, ${a.analysis.processMs.toFixed(2)} ms`, 14, 38);
    const quiet = f.quiet ? 'Quiet passage' : f.section ? `Section: ${f.section}` : '';
    this.label(quiet, WIDTH - 14, 20, f.quiet ? C.amber : C.dim, 'right');
  }

  /** Log-frequency spectrum (20 Hz–20 kHz, −100…−10 dBFS) from the analyser, with band edges. */
  private spectrum(x: number, y: number, w: number, h: number): void {
    const g = this.ctx;
    const node = this.src.audio.analysis.analyserNode;
    g.strokeStyle = C.grid;
    g.strokeRect(x, y, w, h);
    const fx = (hz: number): number => x + (Math.log10(hz / 20) / Math.log10(1000)) * w;
    for (const band of DEFAULT_BANDS) {
      const bx = fx(band.lo);
      g.beginPath();
      g.moveTo(bx, y);
      g.lineTo(bx, y + h);
      g.stroke();
    }
    for (const hz of [100, 1000, 10000]) this.label(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, fx(hz) + 3, y + h - 4);
    if (!node) {
      this.label('Analyser not running', x + w / 2, y + h / 2, C.dim, 'center');
      return;
    }
    if (this.freq.length !== node.frequencyBinCount) this.freq = new Float32Array(node.frequencyBinCount);
    node.getFloatFrequencyData(this.freq);
    const sr = this.src.audio.engine.ctx?.sampleRate ?? 48000;
    const binHz = sr / node.fftSize;
    const grad = g.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, C.rose);
    grad.addColorStop(0.3, C.amber);
    grad.addColorStop(0.55, C.aqua);
    grad.addColorStop(0.8, C.blue);
    grad.addColorStop(1, C.violet);
    g.beginPath();
    g.moveTo(x, y + h);
    // One point per pixel column: the loudest bin that falls into it.
    let k = 1;
    for (let px = 0; px <= w; px++) {
      const hiHz = 20 * Math.pow(1000, (px + 1) / w);
      let peak = -140;
      while (k < this.freq.length && k * binHz < hiHz) {
        peak = Math.max(peak, this.freq[k] as number);
        k++;
      }
      if (peak <= -140 && px > 0) continue;
      const v = Math.max(0, Math.min(1, (peak + 100) / 90));
      g.lineTo(x + px, y + h - v * h);
    }
    g.lineTo(x + w, y + h);
    g.closePath();
    g.globalAlpha = 0.35;
    g.fillStyle = grad;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = grad;
    g.stroke();
  }

  /** Six band meters: smoothed (bar), raw normalised (thin bar), peak hold (tick) and dBFS. */
  private bands(x: number, y: number, w: number, h: number): void {
    const g = this.ctx;
    const f = this.src.features();
    const proc = this.src.audio.analysis.processor;
    const col = w / 6;
    for (let b = 0; b < 6; b++) {
      const cx = x + b * col + 8;
      const bw = col - 16;
      const meterH = h - 34;
      const top = y + 4;
      g.fillStyle = C.grid;
      g.fillRect(cx, top, bw, meterH);
      const smooth = f[BAND_KEYS[b] as (typeof BAND_KEYS)[number]];
      g.fillStyle = C.aqua;
      g.fillRect(cx, top + meterH * (1 - smooth), bw * 0.62, meterH * smooth);
      const raw = Math.min(1, proc.rawBands[b] as number);
      g.fillStyle = C.violet;
      g.fillRect(cx + bw * 0.7, top + meterH * (1 - raw), bw * 0.3, meterH * raw);
      const peak = Math.min(1, proc.peakBands[b] as number);
      g.fillStyle = C.rose;
      g.fillRect(cx, top + meterH * (1 - peak) - 1, bw, 2);
      this.label(BAND_LABELS[b] as string, cx + bw / 2, y + h - 16, C.text, 'center');
      this.label(`${Math.round(proc.bandDb[b] as number)} dB`, cx + bw / 2, y + h - 2, C.dim, 'center');
    }
  }

  private waveform(x: number, y: number, w: number, h: number): void {
    const g = this.ctx;
    const node = this.src.audio.analysis.analyserNode;
    g.strokeStyle = C.grid;
    g.strokeRect(x, y, w, h);
    this.label('Waveform', x + 4, y + 13);
    if (!node) return;
    if (this.wave.length !== node.fftSize) this.wave = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(this.wave);
    g.strokeStyle = C.blue;
    g.beginPath();
    const n = Math.min(this.wave.length, 2048);
    for (let i = 0; i < n; i++) {
      const px = x + (i / (n - 1)) * w;
      const py = y + h / 2 - (this.wave[i] as number) * (h / 2);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }

  /** Spectral flux (normalised) over the last seconds, with detected onsets marked. */
  private flux(x: number, y: number, w: number, h: number, now: number): void {
    const g = this.ctx;
    g.strokeStyle = C.grid;
    g.strokeRect(x, y, w, h);
    this.label('Spectral flux and onsets', x + 4, y + 13);
    const t0 = now - HISTORY_S * 1000;
    g.strokeStyle = C.aqua;
    g.beginPath();
    let started = false;
    for (let j = 0; j < HISTORY; j++) {
      const i = (this.histIdx + j) % HISTORY;
      const t = this.histT[i] as number;
      if (t < t0) continue;
      const px = x + ((t - t0) / (HISTORY_S * 1000)) * w;
      const py = y + h - (this.histFlux[i] as number) * (h - 18);
      if (!started) {
        g.moveTo(px, py);
        started = true;
      } else g.lineTo(px, py);
      if (this.histOnset[i]) {
        g.save();
        g.strokeStyle = C.rose;
        g.beginPath();
        g.moveTo(px, y + 16);
        g.lineTo(px, y + h);
        g.stroke();
        g.restore();
        g.moveTo(px, py);
      }
    }
    g.stroke();
  }

  private transient(x: number, y: number, w: number, h: number, v: number): void {
    const g = this.ctx;
    g.fillStyle = C.grid;
    g.fillRect(x, y, w, h);
    g.fillStyle = C.rose;
    g.fillRect(x, y + h * (1 - v), w, h * v);
    this.label('Hit', x + w / 2, y + h + 13, C.dim, 'center');
  }

  /** Beat dial: track grid (aqua hand) vs. the estimated beat (violet hand); arc = confidence. */
  private beat(x: number, y: number, f: Readonly<AudioFeatures>): void {
    const g = this.ctx;
    const tempo = this.src.audio.analysis.processor.tempo;
    const r = 46;
    const cx = x + r + 6;
    const cy = y + r + 8;
    g.strokeStyle = C.grid;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = C.violet;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(cx, cy, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * tempo.confidence);
    g.stroke();
    g.lineWidth = 1;
    const hand = (phase: number, color: string, len: number): void => {
      const a = -Math.PI / 2 + phase * Math.PI * 2;
      g.strokeStyle = color;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.stroke();
      g.lineWidth = 1;
    };
    if (f.bpm > 0) hand(f.beatPhase, C.aqua, r - 6);
    if (tempo.bpm > 0) hand(tempo.phase, C.violet, r - 16);
    g.fillStyle = f.beatPulse > 0.5 ? C.aqua : C.grid;
    g.beginPath();
    g.arc(cx, cy, 5, 0, Math.PI * 2);
    g.fill();
    this.label(`Track ${f.bpm > 0 ? `${f.bpm} BPM` : 'none'}`, cx, cy + r + 24, C.aqua, 'center');
    this.label(`Detected ${tempo.bpm > 0 ? `${tempo.bpm.toFixed(1)}` : '—'} (${Math.round(tempo.confidence * 100)}%)`, cx, cy + r + 40, C.violet, 'center');
  }

  /** Level meters: RMS, energy, brightness, anticipation, section intensity. */
  private levels(x: number, y: number, f: Readonly<AudioFeatures>): void {
    const g = this.ctx;
    const proc = this.src.audio.analysis.processor;
    const rows: [string, number, string, string][] = [
      ['RMS', f.waveformRms, C.blue, `${Math.round(proc.rmsDb)} dBFS`],
      ['Energy', f.overallEnergy, C.aqua, ''],
      ['Brightness', f.spectralCentroid, C.amber, ''],
      ['Dynamic range', Math.min(1, f.dynamicRange / 40), C.violet, `${Math.round(f.dynamicRange)} dB`],
      ['Anticipation', f.anticipation, C.rose, f.nextEvent ? `${f.nextEvent} in ${f.timeToNextEvent.toFixed(1)} s` : ''],
      ['Section intensity', f.sectionIntensity, C.text, ''],
    ];
    const w = WIDTH - x - 14;
    rows.forEach(([name, v, color, note], i) => {
      const ry = y + 6 + i * 20;
      this.label(name, x, ry + 10, C.dim);
      g.fillStyle = C.grid;
      g.fillRect(x + 118, ry + 2, w - 210, 10);
      g.fillStyle = color;
      g.fillRect(x + 118, ry + 2, (w - 210) * Math.max(0, Math.min(1, v)), 10);
      this.label(note, x + w, ry + 10, C.dim, 'right');
    });
  }

  /** The stage's reactivity bindings with their live envelope and driven value. */
  private bindingRows(x: number, y: number, rows: readonly { binding: Binding; env: number; value: number }[]): void {
    const g = this.ctx;
    this.label(rows.length ? `Stage reactivity (${rows.length} bindings)` : 'No reactivity bindings on this stage', x, y + 12, C.text);
    rows.slice(0, MAX_ROWS).forEach((r, i) => {
      const ry = y + 22 + i * ROW;
      const b = r.binding;
      this.label(`${b.target} ← ${b.feature}`, x, ry + 10, C.dim);
      g.fillStyle = C.grid;
      g.fillRect(x + 300, ry + 2, 120, 9);
      g.fillStyle = b.category === 'lighting' ? C.amber : b.category === 'particles' ? C.violet : C.aqua;
      g.fillRect(x + 300, ry + 2, 120 * Math.max(0, Math.min(1, r.env)), 9);
      this.label(r.value.toFixed(2), WIDTH - 14, ry + 10, C.text, 'right');
    });
  }
}
