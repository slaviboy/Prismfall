import { analyzeTrack, downmix, type TrackAnalysis } from './trackAnalysis';

export type TrackWorkerRequest = { readonly channels: Float32Array[]; readonly sampleRate: number };
export type TrackWorkerResponse = { readonly progress: number } | { readonly result: TrackAnalysis } | { readonly error: string };

const post = (msg: TrackWorkerResponse): void => (self as unknown as { postMessage(m: TrackWorkerResponse): void }).postMessage(msg);

/** Offline analysis of a decoded audio file, off the main thread. */
self.onmessage = (e: MessageEvent<TrackWorkerRequest>) => {
  try {
    const mono = downmix(e.data.channels);
    post({ result: analyzeTrack(mono, e.data.sampleRate, (progress) => post({ progress })) });
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
