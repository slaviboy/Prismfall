import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { toast } from '../../app/stores';
import { DEFAULT_TUNING, type ProcessorTuning } from '../../audio/analysis/dsp/featureProcessor';
import { ExternalCapture } from '../../audio/analysis/externalCapture';
import { AudioDashboard } from '../../devtools/AudioDashboard';
import { getSettings, updateSection } from '../../settings/store';

const BANDS = ['Sub', 'Bass', 'Low mid', 'Mid', 'High mid', 'Treble'];

function Range(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }): ReactNode {
  return (
    <label className="dash-range">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <output>
        {props.value}
        {props.unit ?? ''}
      </output>
    </label>
  );
}

/** Floating developer panel: the canvas dashboard plus live analysis tuning. */
export default function AudioDashboardPanel(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tuning, setTuning] = useState<ProcessorTuning>(() => shell.audio.tuning);
  const [sharing, setSharing] = useState(false);
  const capture = useRef<ExternalCapture | null>(null);
  // Closing the dashboard ends any capture and gives analysis back to the game music.
  useEffect(() => () => capture.current?.stop(), []);

  const toggleCapture = async (): Promise<void> => {
    if (capture.current?.active) {
      capture.current.stop();
      setSharing(false);
      return;
    }
    shell.unlockAudio();
    capture.current ??= new ExternalCapture(shell.audio.engine, () => setSharing(false));
    const result = await capture.current.start();
    setSharing(result === 'ok');
    if (result === 'no-audio') toast('Nothing to analyse: share a tab with "Share tab audio" ticked, or a screen with "Share system audio".', 'warning', 6000);
    else if (result === 'unsupported') toast('This browser cannot share audio from other tabs or apps.', 'warning');
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dash = new AudioDashboard(canvas, {
      audio: shell.audio,
      features: () => shell.audio.features.features,
      bindings: () => shell.renderSystem?.environments.current?.reactivity.inspect() ?? [],
      stageName: () => shell.renderSystem?.environments.current?.manifest.name ?? '',
    });
    dash.start();
    return () => dash.stop();
  }, []);

  const apply = (t: ProcessorTuning): void => {
    setTuning(t);
    shell.audio.setTuningOverride(t);
  };

  const setEnvelope = (band: number, which: 0 | 1, v: number): void => {
    const envs = tuning.bandEnvelopes.map((e, i) => (i === band ? (which === 0 ? ([v, e[1]] as const) : ([e[0], v] as const)) : e));
    apply({ ...tuning, bandEnvelopes: envs });
  };

  const copy = (): void => {
    const s = getSettings();
    const json = JSON.stringify({ analysisTuning: tuning, reactivity: s.reactivity, latencyOffsetMs: s.audio.latencyOffsetMs }, null, 2);
    void navigator.clipboard.writeText(json).then(
      () => toast('Analysis tuning copied as JSON', 'success'),
      () => toast('The browser blocked clipboard access.', 'warning'),
    );
  };

  const reset = (): void => {
    shell.audio.setTuningOverride(null);
    setTuning(shell.audio.tuning);
  };

  return (
    <aside className="audio-dashboard" data-testid="audio-dashboard" aria-label="Audio analysis dashboard">
      <canvas ref={canvasRef} />
      <div className="dash-controls">
        <Range label="Sensitivity" value={tuning.sensitivity} min={0.25} max={2} step={0.05} onChange={(v) => apply({ ...tuning, sensitivity: v })} />
        <Range label="Treble scale" value={tuning.trebleScale} min={0.2} max={1.5} step={0.05} onChange={(v) => apply({ ...tuning, trebleScale: v })} />
        <div className="dash-envelopes">
          <span />
          <span>Attack</span>
          <span>Release</span>
          {BANDS.map((name, b) => (
            <div key={name} className="dash-envelope-row">
              <span>{name}</span>
              <input
                type="range"
                aria-label={`${name} attack`}
                min={1}
                max={200}
                step={1}
                value={tuning.bandEnvelopes[b]?.[0] ?? DEFAULT_TUNING.bandEnvelopes[b]?.[0] ?? 30}
                onChange={(e) => setEnvelope(b, 0, Number(e.target.value))}
              />
              <input
                type="range"
                aria-label={`${name} release`}
                min={20}
                max={1200}
                step={10}
                value={tuning.bandEnvelopes[b]?.[1] ?? DEFAULT_TUNING.bandEnvelopes[b]?.[1] ?? 200}
                onChange={(e) => setEnvelope(b, 1, Number(e.target.value))}
              />
            </div>
          ))}
        </div>
        <div className="dash-buttons">
          <button type="button" onClick={copy} data-testid="dashboard-copy">
            Copy as JSON
          </button>
          <button type="button" onClick={reset}>
            Reset tuning
          </button>
          {ExternalCapture.supported() ? (
            <button type="button" onClick={() => void toggleCapture()} data-testid="dashboard-capture" aria-pressed={sharing}>
              {sharing ? 'Stop shared audio' : 'Analyse shared audio (experimental)'}
            </button>
          ) : null}
          <button type="button" onClick={() => updateSection('developer', { audioDashboard: false })} data-testid="dashboard-close">
            Close (F9)
          </button>
        </div>
        {sharing ? <p className="dash-note">Analysing shared audio instead of the game music. It is not played back here; stop sharing to return to the game music.</p> : null}
      </div>
    </aside>
  );
}
