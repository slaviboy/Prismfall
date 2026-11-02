import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { onCue } from '../../audio/cues';

interface Caption {
  readonly id: number;
  readonly text: string;
  readonly tone: 'info' | 'warn' | 'music';
}

const CAPTION_MS = 2200;
let captionId = 0;

/**
 * Visual cues for sounds (accessibility): a lamp that pulses with the music's beat (stronger on
 * downbeats), a heartbeat marker for the danger sound, and short captions for sounds that carry
 * information. The lamp animates directly on the element, so beats never re-render React.
 */
export function SoundCues(props: { style: CSSProperties; align: 'start' | 'end'; reducedMotion: boolean }): ReactNode {
  const lamp = useRef<HTMLSpanElement>(null);
  const heart = useRef<HTMLSpanElement>(null);
  const [captions, setCaptions] = useState<readonly Caption[]>([]);
  const reduced = props.reducedMotion;

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onCue((cue) => {
      if (cue.kind === 'beat') {
        // Reduced motion keeps the cue as a brightness change without the scale pop.
        const peak = cue.downbeat ? 1 : 0.6;
        lamp.current?.animate(
          reduced
            ? [{ opacity: peak }, { opacity: 0.25 }]
            : [
                { opacity: peak, transform: `scale(${cue.downbeat ? 1.5 : 1.25})` },
                { opacity: 0.25, transform: 'scale(1)' },
              ],
          { duration: cue.downbeat ? 420 : 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
      } else if (cue.kind === 'heartbeat') {
        heart.current?.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'scale(1.3)' }, { opacity: 0, transform: 'scale(1)' }], { duration: 900, easing: 'ease-out' });
      } else {
        const c: Caption = { id: ++captionId, text: cue.text, tone: cue.tone };
        setCaptions((list) => [...list, c].slice(-3));
        const t = setTimeout(() => {
          timers.delete(t);
          setCaptions((list) => list.filter((x) => x.id !== c.id));
        }, CAPTION_MS);
        timers.add(t);
      }
    });
    return () => {
      off();
      timers.forEach(clearTimeout);
    };
  }, [reduced]);

  return (
    <div className={`sound-cues align-${props.align}`} style={props.style} data-testid="sound-cues">
      <div className="sound-cue-meters" aria-hidden>
        <span className="sound-cue-lamp" ref={lamp} title="Music beat" />
        <span className="sound-cue-heart" ref={heart} title="Danger heartbeat">
          ♥
        </span>
      </div>
      <ul className="sound-cue-captions" aria-live="polite">
        {captions.map((c) => (
          <li key={c.id} className={`sound-cue-caption tone-${c.tone}`}>
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
