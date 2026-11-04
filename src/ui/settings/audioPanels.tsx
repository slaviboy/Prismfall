import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { toast } from '../../app/stores';
import { LatencyCalibrator, WARMUP_CLICKS, type CalibrationResult } from '../../audio/calibration/LatencyCalibrator';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import type { SfxId } from '../../audio/sound-effects/SfxBank';
import { Button, ChoiceRow, SliderRow, useTicker } from '../components/controls';
import { registerCustomPanel } from './customPanels';

type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: CalibrationResult | null };

const CLICKS = 20;

const offsetLabel = (ms: number): string => (ms === 0 ? 'No offset' : `${ms > 0 ? '+' : ''}${ms} ms`);

/**
 * Tap-along calibration: clicks play on the audio clock and the player taps along with any key,
 * pad button or the tap area. The median difference becomes the audio latency offset.
 */
function LatencyCalibration(): ReactNode {
  const offset = useSettings((s) => s.audio.latencyOffsetMs);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [taps, setTaps] = useState(0);
  const [click, setClick] = useState(-1);
  const calRef = useRef<LatencyCalibrator | null>(null);
  const padRef = useRef<HTMLButtonElement>(null);

  const finish = (cancelled: boolean): void => {
    const cal = calRef.current;
    calRef.current = null;
    shell.input.endCapture();
    shell.audio.engine.setCalibrating(false);
    cal?.stop();
    setPhase(cancelled ? { kind: 'idle' } : { kind: 'done', result: cal?.result() ?? null });
  };

  const start = async (): Promise<void> => {
    shell.unlockAudio();
    await shell.audio.unlock();
    const cal = new LatencyCalibrator(shell.audio.engine, getSettings().audio.latencyOffsetMs, 100, CLICKS);
    shell.audio.engine.setCalibrating(true);
    if (!cal.start()) {
      shell.audio.engine.setCalibrating(false);
      toast('Sound is off or blocked, so calibration can’t run.', 'warning');
      return;
    }
    calRef.current = cal;
    setTaps(0);
    setClick(-1);
    setPhase({ kind: 'running' });
    // Every key and pad button counts as a tap; Escape or the pad's Start/Select cancels.
    shell.input.beginCapture((e) => {
      if (e.control === 'Escape' || (e.device === 'gamepad' && (e.control === 'button:8' || e.control === 'button:9'))) {
        finish(true);
        return;
      }
      if (cal.tap(e.time)) setTaps(cal.taps);
    });
  };

  // Progress display and automatic finish.
  useEffect(() => {
    if (phase.kind !== 'running') return;
    // The tap area appears below the offset slider: bring it into view and focus.
    padRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    padRef.current?.focus({ preventScroll: true });
    let raf = 0;
    const loop = (): void => {
      const cal = calRef.current;
      if (!cal) return;
      setClick(cal.currentClick());
      if (cal.finished) {
        finish(false);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase.kind]);

  // Leaving the screen mid-calibration releases capture and the music duck.
  useEffect(
    () => () => {
      if (calRef.current) {
        shell.input.endCapture();
        shell.audio.engine.setCalibrating(false);
        calRef.current.stop();
        calRef.current = null;
      }
    },
    [],
  );

  const apply = (r: CalibrationResult): void => {
    const next = Math.max(-250, Math.min(250, offset + r.offsetMs));
    updateSection('audio', { latencyOffsetMs: next });
    toast(`Audio offset set to ${offsetLabel(next)}`, 'success');
    setPhase({ kind: 'idle' });
  };

  const total = CLICKS;
  return (
    <div className="calibration" data-testid="latency-calibration">
      {phase.kind === 'idle' && (
        <div className="settings-actions">
          <Button onClick={() => void start()} testId="calibration-start">
            Calibrate by tapping along
          </Button>
          {offset !== 0 && (
            <Button onClick={() => updateSection('audio', { latencyOffsetMs: 0 })} testId="calibration-clear">
              Clear offset
            </Button>
          )}
        </div>
      )}
      {phase.kind === 'running' && (
        <div className="calibration-run" role="status">
          <p>Tap any key or pad button with each click. The first {WARMUP_CLICKS} clicks are for finding the pulse. Escape or Start cancels.</p>
          <div className="calibration-dots" aria-hidden>
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={`calibration-dot${i <= click ? ' is-past' : ''}${i < WARMUP_CLICKS ? ' is-warmup' : ''}`} />
            ))}
          </div>
          <button
            ref={padRef}
            type="button"
            className="calibration-pad"
            data-focusable
            data-testid="calibration-pad"
            onPointerDown={(e) => {
              const cal = calRef.current;
              if (cal?.tap(e.timeStamp)) setTaps(cal.taps);
            }}
          >
            Tap here, or press any key — {taps} taps
          </button>
        </div>
      )}
      {phase.kind === 'done' && (
        <div className="calibration-result" role="status" data-testid="calibration-result">
          {phase.result ? (
            <>
              <p>
                Your taps landed {Math.abs(phase.result.offsetMs)} ms {phase.result.offsetMs >= 0 ? 'after' : 'before'} the clicks (steadiness ±{phase.result.spreadMs} ms
                over {phase.result.count} taps).
                {phase.result.spreadMs > 40 ? ' The taps were uneven; another try will give a more reliable result.' : ''}
              </p>
              <div className="settings-actions">
                <Button tone="primary" onClick={() => apply(phase.result as CalibrationResult)} testId="calibration-apply">
                  Apply {offsetLabel(Math.max(-250, Math.min(250, offset + phase.result.offsetMs)))}
                </Button>
                <Button onClick={() => void start()}>Try again</Button>
                <Button onClick={() => setPhase({ kind: 'idle' })}>Keep current</Button>
              </div>
            </>
          ) : (
            <>
              <p>Not enough taps matched the clicks. Tap once per click, starting after the first few.</p>
              <div className="settings-actions">
                <Button onClick={() => void start()}>Try again</Button>
                <Button onClick={() => setPhase({ kind: 'idle' })}>Close</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PATH_LABEL = { worklet: 'Audio worklet (fixed 10.7 ms hop)', analyser: 'Analyser node (per frame)', none: 'Not running' } as const;

/** Live status of the Music Analysis Engine. */
function AnalysisInfo(): ReactNode {
  const audio = shell.audio;
  const path = useTicker(() => PATH_LABEL[audio.analysisPath], 500);
  const rate = useTicker(() => (audio.engine.ctx ? `${(audio.engine.ctx.sampleRate / 1000).toFixed(1)} kHz, output latency ${Math.round(audio.engine.outputLatency * 1000)} ms` : 'Audio not started'), 500);
  const load = useTicker(() => `${Math.round(audio.analysis.framesPerSecond)} frames/s, ${audio.analysis.processMs.toFixed(2)} ms per update`, 500);
  const tempo = useTicker(() => {
    const t = audio.analysis.processor.tempo;
    const track = audio.director.current;
    const detected = t.bpm > 0 ? `${t.bpm.toFixed(1)} BPM detected (confidence ${Math.round(t.confidence * 100)}%)` : 'No tempo detected yet';
    return track ? `${detected}; track grid ${track.bpm} BPM` : detected;
  }, 500);
  return (
    <dl className="info-grid" data-testid="analysis-info">
      <div>
        <dt>Analysis</dt>
        <dd>
          <span ref={path} />
        </dd>
      </div>
      <div>
        <dt>Audio device</dt>
        <dd>
          <span ref={rate} />
        </dd>
      </div>
      <div>
        <dt>Processing</dt>
        <dd>
          <span ref={load} />
        </dd>
      </div>
      <div>
        <dt>Tempo</dt>
        <dd>
          <span ref={tempo} />
        </dd>
      </div>
    </dl>
  );
}

const SOUND_GROUPS: readonly { label: string; sounds: readonly [SfxId, string][] }[] = [
  { label: 'Piece', sounds: [['spawn', 'Spawn'], ['move', 'Move'], ['rotate', 'Rotate right'], ['rotateCcw', 'Rotate left'], ['softDrop', 'Soft drop'], ['hold', 'Hold']] },
  { label: 'Impacts', sounds: [['land', 'Land'], ['lock', 'Lock'], ['hardDrop', 'Hard drop'], ['hardDropHeavy', 'Hard drop (full height)'], ['impactResponse', 'World response']] },
  { label: 'Clears', sounds: [['clear1', 'Single'], ['clear2', 'Double'], ['clear3', 'Triple'], ['clear4', 'Quad'], ['signature', 'World quad answer'], ['tspin', 'Spin'], ['b2b', 'Back-to-back'], ['perfect', 'Perfect clear']] },
  { label: 'Combos', sounds: [['combo', 'Combo 1–2'], ['comboMid', 'Combo 3–5'], ['comboHigh', 'Combo 6+']] },
  { label: 'Moments', sounds: [['levelUp', 'Level up'], ['stageComplete', 'Goal reached'], ['unlock', 'World unlocked'], ['danger', 'Danger'], ['gameOver', 'Game over'], ['pause', 'Pause'], ['resume', 'Resume']] },
];

/** Sound test: the selected world's music and every gameplay sound, one button each. */
function AudioTest(): ReactNode {
  const [stageId, setStageId] = useState<string>(() => shell.audio.stageId ?? shell.stageManager?.stages()[0]?.id ?? '');
  const [intensity, setIntensity] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const stages = shell.stageManager?.stages() ?? [];
  const info = useTicker(() => {
    const d = shell.audio.director;
    const section = d.current ? shell.audio.features.features.section || 'playing' : 'stopped';
    return `${shell.audio.stage?.materialKey ?? 'glass'} blocks · music: ${section}`;
  }, 300);

  const ensure = async (): Promise<void> => {
    shell.unlockAudio();
    await shell.audio.unlock();
  };
  const choose = async (id: string): Promise<void> => {
    setStageId(id);
    setLoading(true);
    await ensure();
    await shell.auditionStage(id);
    setLoading(false);
  };
  const play = async (id: SfxId): Promise<void> => {
    await ensure();
    shell.audio.play(id);
  };
  const footsteps = async (): Promise<void> => {
    await ensure();
    // A creature walking from left to right in front of the listener.
    for (let i = 0; i < 8; i++) window.setTimeout(() => shell.audio.sfx.playAt('footstep', -60 + i * 17, -14, -40, { gain: 0.8 }), i * 380);
  };
  const spiders = async (): Promise<void> => {
    await ensure();
    // A small spider dashing past on the left, a large one walking right to left behind the
    // board, a strand creaking overhead and a web humming: through the same budget as in a world.
    const at = (ms: number, play: () => void): void => void window.setTimeout(play, ms);
    [0, 500, 1300].forEach((ms, i) => at(ms, () => shell.audio.playWorldSound('skitter', -30 + i * 6, -12, -20, 0.5 - i * 0.1)));
    for (let i = 0; i < 7; i++) at(1900 + i * 520, () => shell.audio.playWorldSound('crawl', 50 - i * 16, -14, -60, 1));
    at(5800, () => shell.audio.playWorldSound('silk', 10, 20, -25, 0.8));
    at(6900, () => shell.audio.playWorldSound('webHum', -20, 10, -40, 0.8));
  };

  return (
    <div className="audio-test" data-testid="audio-test">
      <h3 className="settings-group">Sound test</h3>
      <ChoiceRow label="World" value={stageId} options={stages.map((s) => ({ value: s.id, label: s.manifest?.name ?? s.id }))} onChange={(v) => void choose(v)} testId="audio-test-world" />
      <p className="menu-note">
        <span ref={info} />
        {loading ? ' · loading…' : ''}
      </p>
      <div className="settings-actions">
        <Button
          onClick={async () => {
            await ensure();
            await shell.audio.setOverride(null);
          }}
          testId="audio-test-music"
        >
          Play world music
        </Button>
        <Button onClick={() => shell.audio.director.stop(1.2)}>Stop music</Button>
      </div>
      <SliderRow
        label="Preview intensity"
        description="How far the arrangement builds (layers join as it rises)."
        value={intensity}
        min={0.1}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => {
          setIntensity(v);
          shell.audio.director.setIntensity(v);
        }}
      />
      {SOUND_GROUPS.map((g) => (
        <div key={g.label} className="audio-test-group">
          <span className="setting-label">{g.label}</span>
          <div className="settings-actions">
            {g.sounds.map(([id, label]) => (
              <Button key={id} onClick={() => void play(id)} testId={`sfx-${id}`}>
                {label}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <div className="audio-test-group">
        <span className="setting-label">World</span>
        <div className="settings-actions">
          <Button onClick={() => void footsteps()} testId="sfx-footsteps">
            Creature passing (spatial)
          </Button>
          <Button onClick={() => void spiders()} testId="sfx-spiders">
            Spiders in the dark (spatial)
          </Button>
        </div>
      </div>
    </div>
  );
}

registerCustomPanel('latencyCalibration', LatencyCalibration);
registerCustomPanel('audioTest', AudioTest);
registerCustomPanel('analysisInfo', AnalysisInfo);
