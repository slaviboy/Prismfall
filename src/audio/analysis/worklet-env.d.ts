/** Globals of the AudioWorkletGlobalScope (not part of the standard TypeScript DOM lib). */
declare const sampleRate: number;
declare const currentTime: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(name: string, processorCtor: new (options: never) => AudioWorkletProcessor): void;
