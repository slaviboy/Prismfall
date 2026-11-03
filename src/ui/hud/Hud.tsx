import type { CSSProperties, ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { useHud } from '../../app/stores';
import { reducedMotion, useSettings } from '../../settings/store';
import { SoundCues } from './SoundCues';
import { formatScore, formatTime } from '../format';
import { useTicker } from '../components/controls';

function Stat(props: { label: string; children: ReactNode; testId?: string; big?: boolean }): ReactNode {
  return (
    <div className={`hud-stat ${props.big ? 'big' : ''}`}>
      <span className="hud-label">{props.label}</span>
      <span className="hud-value" data-testid={props.testId}>
        {props.children}
      </span>
    </div>
  );
}

function Timer(props: { limitMs: number | null }): ReactNode {
  const ref = useTicker(() => {
    const t = shell.elapsedMs;
    return formatTime(props.limitMs !== null ? Math.max(0, props.limitMs - t) : t);
  }, 50);
  return <span ref={ref} data-testid="hud-time" />;
}

function PracticeStats(): ReactNode {
  const ref = useTicker(() => {
    const e = shell.session?.engine;
    if (!e) return '';
    const secs = Math.max(0.001, e.tick / 1000);
    const pps = e.stats.pieces / secs;
    const kpp = e.stats.pieces > 0 ? e.stats.inputs / e.stats.pieces : 0;
    return `${pps.toFixed(2)} pieces/s, ${kpp.toFixed(2)} inputs/piece`;
  }, 250);
  return <span ref={ref} className="hud-practice" />;
}

export function Hud(): ReactNode {
  const hud = useHud((s) => s);
  const ui = useSettings((s) => s.interface);
  const showHold = useSettings((s) => s.gameplay.showHold);
  const showNext = useSettings((s) => s.gameplay.showNext);
  const soundCues = useSettings((s) => s.accessibility.visualAudioCues);
  const calm = useSettings(reducedMotion);
  if (!hud.visible || !hud.boardRect) return null;
  const r = hud.boardRect;
  const scale = ui.hudScale;
  const leftStyle: CSSProperties = { top: r.y, right: `calc(100vw - ${r.x}px + ${24 * scale}px)`, opacity: ui.hudOpacity };
  const rightStyle: CSSProperties = { top: r.y, left: r.x + r.w + 24 * scale, opacity: ui.hudOpacity };
  const leftSide = ui.mirrored ? rightStyle : leftStyle;
  const rightSide = ui.mirrored ? leftStyle : rightStyle;
  const timeMetric = hud.modeId === 'sprint';
  return (
    <div className="hud" style={{ '--hud-scale': scale } as CSSProperties} data-testid="hud">
      <div className={`hud-column ${ui.mirrored ? 'start' : 'end'}`} style={leftSide}>
        {showHold ? <span className="hud-label pod-label">Hold</span> : null}
        <div className="hud-stats">
          {hud.voyage ? (
            <span className="hud-voyage" data-testid="hud-voyage">
              Leg {hud.voyage.leg} of {hud.voyage.legs}: {hud.voyage.stage}
            </span>
          ) : null}
          {ui.showScore ? (
            <Stat label="Score" testId="hud-score" big>
              {formatScore(hud.score)}
            </Stat>
          ) : null}
          {hud.best !== null && ui.showScore ? <Stat label="Best">{timeMetric ? formatTime(hud.best) : formatScore(hud.best)}</Stat> : null}
          {ui.showLevel ? <Stat label="Level" testId="hud-level">{hud.level}</Stat> : null}
          {ui.showLines ? (
            <Stat label="Lines" testId="hud-lines">
              {hud.linesGoal !== null ? `${hud.lines} / ${hud.linesGoal}` : hud.lines}
            </Stat>
          ) : null}
          {ui.showTime && hud.modeId !== 'zen' ? (
            <Stat label={hud.timeLimitMs !== null ? 'Remaining' : 'Time'}>
              <Timer limitMs={hud.timeLimitMs} />
            </Stat>
          ) : null}
          {ui.showCombo && hud.combo >= 1 ? <Stat label="Combo">{hud.combo}</Stat> : null}
          {ui.showCombo && hud.backToBack >= 1 ? <Stat label="Back-to-back">{hud.backToBack}</Stat> : null}
        </div>
      </div>
      <div className={`hud-column ${ui.mirrored ? 'end' : 'start'}`} style={rightSide}>
        {showNext ? <span className="hud-label pod-label">Next</span> : null}
        {hud.modeId === 'practice' && ui.showPracticeStats ? <PracticeStats /> : null}
      </div>
      {ui.showCallouts ? (
        <div className="hud-callouts" style={{ left: r.x + r.w / 2, top: r.y + r.h * 0.22 }}>
          {hud.callouts.map((c) => (
            <div key={c.id} className={`callout tone-${c.tone}`} style={{ '--intensity': c.intensity } as CSSProperties}>
              <span className="callout-title">{c.title}</span>
              {c.detail ? <span className="callout-detail">{c.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {hud.intro || hud.countdown !== null ? (
        <div className="hud-intro" style={{ left: r.x + r.w / 2, top: r.y + r.h * 0.42 }} data-testid="hud-intro">
          {hud.countdown !== null ? hud.countdown : hud.intro === 'ready' ? 'Ready' : 'Go'}
        </div>
      ) : null}
      {soundCues ? (
        // In the stats column, below the numbers: always on screen at any aspect ratio.
        <SoundCues style={{ ...leftSide, top: r.y + r.h * 0.55 }} align={ui.mirrored ? 'start' : 'end'} reducedMotion={calm} />
      ) : null}
      {hud.danger ? <div className="hud-danger" style={{ left: r.x - 6, top: r.y - 6, width: r.w + 12, height: r.h + 12 }} aria-hidden /> : null}
      <button type="button" className="hud-pause" onClick={() => shell.togglePause()} aria-label="Pause" data-testid="hud-pause">
        <span />
        <span />
      </button>
    </div>
  );
}
