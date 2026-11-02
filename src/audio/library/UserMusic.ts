import TrackWorker from '../analysis/trackAnalysis.worker.ts?worker';
import type { TrackAnalysis } from '../analysis/trackAnalysis';
import type { TrackWorkerResponse } from '../analysis/trackAnalysis.worker';
import type { SaveBackend } from '../../storage/backend';

/** A music file the player added, with its offline beat analysis. */
export interface UserTrack {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly addedAt: string;
  readonly analysis: TrackAnalysis;
}

/** Largest file accepted (the decoded audio is held in memory while analysed). */
export const MAX_TRACK_BYTES = 80 * 1024 * 1024;

const dataKey = (id: string): string => `track-data:${id}`;

/**
 * The player's own music: files are decoded, analysed once in a worker (tempo, beat grid,
 * sections) and stored in IndexedDB (metadata in `userTracks`, bytes in the key-value store).
 */
export class UserMusicLibrary {
  private readonly urls = new Map<string, string>();

  constructor(private readonly backend: () => SaveBackend | null) {}

  get supported(): boolean {
    return this.backend()?.kind === 'indexeddb';
  }

  async list(): Promise<UserTrack[]> {
    const b = this.backend();
    if (!b || !this.supported) return [];
    const all = await b.getAll<UserTrack>('userTracks');
    return all.sort((a, c) => a.addedAt.localeCompare(c.addedAt));
  }

  async add(file: File, ctx: BaseAudioContext, onProgress?: (fraction: number) => void): Promise<UserTrack> {
    const b = this.backend();
    if (!b || !this.supported) throw new Error('Your own music needs browser storage (IndexedDB), which is unavailable here.');
    if (file.size > MAX_TRACK_BYTES) throw new Error(`That file is larger than ${Math.round(MAX_TRACK_BYTES / 1048576)} MB.`);
    const bytes = await file.arrayBuffer();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      throw new Error('That file could not be decoded as audio.');
    }
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i).slice());
    const analysis = await analyseInWorker(channels, decoded.sampleRate, onProgress);
    const track: UserTrack = {
      id: `u-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: file.name.replace(/\.[^.]+$/, ''),
      size: file.size,
      addedAt: new Date().toISOString(),
      analysis,
    };
    await b.putKV(dataKey(track.id), bytes);
    await b.put('userTracks', track);
    return track;
  }

  /** An object URL for the stored file (cached for the session). */
  async url(id: string): Promise<string | null> {
    const cached = this.urls.get(id);
    if (cached) return cached;
    const bytes = await this.backend()?.getKV<ArrayBuffer>(dataKey(id));
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes]));
    this.urls.set(id, url);
    return url;
  }

  async remove(id: string): Promise<void> {
    const b = this.backend();
    if (!b) return;
    await b.delete('userTracks', id);
    await b.deleteKV(dataKey(id));
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
  }
}

function analyseInWorker(channels: Float32Array[], sampleRate: number, onProgress?: (fraction: number) => void): Promise<TrackAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new TrackWorker();
    worker.onmessage = (e: MessageEvent<TrackWorkerResponse>) => {
      const msg = e.data;
      if ('progress' in msg) onProgress?.(msg.progress);
      else {
        worker.terminate();
        if ('result' in msg) resolve(msg.result);
        else reject(new Error(msg.error));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'analysis failed'));
    };
    worker.postMessage({ channels, sampleRate }, channels.map((c) => c.buffer));
  });
}
