import type { GameEvent } from '../game/core/types';
import { CLEAR_LABELS } from '../game/scoring/scoring';
import type { Callout } from './stores';

/** Translates engine events into HUD callouts (text feedback for notable moments). */
export function describeEvents(events: readonly GameEvent[]): Omit<Callout, 'id'>[] {
  const out: Omit<Callout, 'id'>[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'lineClear': {
        const spin = e.spin !== 'none';
        const intensity = Math.min(1.5, e.lines / 4 + (spin ? 0.35 : 0) + (e.backToBack ? 0.2 : 0) + (e.perfectClear ? 0.6 : 0));
        if (e.perfectClear) out.push({ title: 'Perfect Clear', detail: `+${e.score.perfectClearBonus.toLocaleString()}`, intensity: 1.5, tone: 'pc' });
        if (e.lines >= 2 || spin) {
          const detail = e.backToBack ? `Back-to-back${e.backToBackCount > 1 ? ` ×${e.backToBackCount}` : ''}` : `+${e.score.total.toLocaleString()}`;
          out.push({ title: CLEAR_LABELS[e.kind], detail, intensity, tone: spin ? 'spin' : e.backToBack ? 'b2b' : 'clear' });
        }
        if (e.combo >= 1) out.push({ title: `Combo ×${e.combo}`, detail: '', intensity: Math.min(1.2, 0.3 + e.combo * 0.08), tone: 'combo' });
        break;
      }
      case 'spinNoLines':
        out.push({ title: CLEAR_LABELS[e.kind], detail: `+${e.points.toLocaleString()}`, intensity: 0.4, tone: 'spin' });
        break;
      case 'levelUp':
        out.push({ title: `Level ${e.level}`, detail: '', intensity: 0.7, tone: 'level' });
        break;
      case 'boardReset':
        out.push({ title: 'Fresh start', detail: 'The board has been cleared', intensity: 0.4, tone: 'info' });
        break;
      default:
        break;
    }
  }
  return out;
}
