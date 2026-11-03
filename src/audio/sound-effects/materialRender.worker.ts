import type { MaterialAudioProfile } from './materialAudio';
import { renderMaterialSet, type MaterialRenderResult } from './materialJobs';

export type MaterialWorkerRequest = { readonly profile: MaterialAudioProfile; readonly sampleRate: number };
export type MaterialWorkerResponse = { readonly results: MaterialRenderResult[] } | { readonly error: string };

/** Renders a world's material sounds off the main thread (stage changes happen mid-game). */
self.onmessage = (e: MessageEvent<MaterialWorkerRequest>) => {
  const post = (msg: MaterialWorkerResponse, transfer: Transferable[] = []): void => (self as unknown as { postMessage(m: MaterialWorkerResponse, t: Transferable[]): void }).postMessage(msg, transfer);
  try {
    const results = renderMaterialSet(e.data.profile, e.data.sampleRate);
    post({ results }, results.flatMap((r) => [r.left.buffer, r.right.buffer]));
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
