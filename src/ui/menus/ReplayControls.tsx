import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { getMode, getVariant } from '../../game/modes/modes';
import { formatTime } from '../format';
import { useNavScope } from '../navigation/useNavScope';

const SPEEDS = [0.5, 1, 2, 4] as const;

/** Replay viewer: play/pause, skip ±10 s, speed, restart, progress. */
export function ReplayControls(): ReactNode {
  const close = (): void => shell.closeReplay();
  const ref = useNavScope<HTMLDivElement>({ onBack: close });
  const r = shell.replaySession;
  const [, setTick] = useState(0);
  const bar = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      shell.onFrame(() => {
        const s = shell.replaySession;
        if (!s) return;
        const p = s.durationMs > 0 ? Math.min(1, s.positionMs / s.durationMs) : 0;
        if (bar.current) bar.current.style.transform = `scaleX(${p})`;
        if (time.current) time.current.textContent = `${formatTime(s.positionMs)} / ${formatTime(s.durationMs)}`;
      }),
    [],
  );
  if (!r) return null;
  const refresh = (): void => setTick((t) => t + 1);
  const speedIndex = SPEEDS.indexOf(r.speed as (typeof SPEEDS)[number]);
  return (
    <div className="replay-bar" data-nav-scope ref={ref} data-testid="replay-bar">
      <span className="replay-title">
        Replay: {r.mode.name}, {getVariant(getMode(r.mode.id), r.replay.variantId).label}
      </span>
      <span className="replay-progress" aria-hidden>
        <span ref={bar} />
      </span>
      <span className="replay-time" ref={time} data-testid="replay-time" />
      <button type="button" className="btn" data-focusable onClick={() => (r.seek(r.positionMs - 10_000), refresh())} data-testid="replay-back">
        Back 10 s
      </button>
      <button type="button" className="btn" data-focusable data-autofocus onClick={() => (r.togglePause(performance.now()), refresh())} data-testid="replay-pause">
        {r.finished ? 'Finished' : r.paused ? 'Play' : 'Pause'}
      </button>
      <button type="button" className="btn" data-focusable onClick={() => (r.seek(r.positionMs + 10_000), refresh())} data-testid="replay-forward">
        Forward 10 s
      </button>
      <button type="button" className="btn" data-focusable onClick={() => ((r.speed = SPEEDS[(speedIndex + 1) % SPEEDS.length] as number), refresh())} data-testid="replay-speed">
        Speed {r.speed}×
      </button>
      <button type="button" className="btn" data-focusable onClick={() => (r.seek(0), refresh())} data-testid="replay-restart">
        Restart
      </button>
      <button type="button" className="btn" data-focusable onClick={close} data-testid="replay-close">
        Close
      </button>
    </div>
  );
}
