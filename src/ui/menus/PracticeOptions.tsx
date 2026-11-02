import type { ReactNode } from 'react';
import { PIECE_TYPES, type PieceType } from '../../game/pieces/pieces';
import { updateSection, useSettings } from '../../settings/store';
import { ChoiceRow, SliderRow, ToggleRow } from '../components/controls';
import { ms } from '../format';

/** Practice rules (Settings → practice section), edited on the Practice setup screen. */
export function PracticeOptions(): ReactNode {
  const p = useSettings((s) => s.practice);
  const set = (patch: Partial<typeof p>): void => updateSection('practice', patch);
  const toggleDrill = (t: PieceType, on: boolean): void => {
    const next = on ? [...new Set([...p.drillPieces, t])] : p.drillPieces.filter((x) => x !== t);
    // At least one piece must remain in the drill.
    if (next.length > 0) set({ drillPieces: PIECE_TYPES.filter((x) => next.includes(x)) });
  };
  return (
    <div className="practice-options" data-testid="practice-options">
      <ChoiceRow
        label="Gravity"
        description="Level speeds follow the usual curve; Custom sets a fixed fall rate; None keeps pieces still until you drop them."
        value={p.gravityMode}
        options={[
          { value: 'level', label: 'By level' },
          { value: 'custom', label: 'Custom' },
          { value: 'none', label: 'None' },
        ]}
        onChange={(v) => set({ gravityMode: v })}
        testId="practice-gravity"
      />
      {p.gravityMode === 'level' ? <SliderRow label="Level" value={p.level} min={1} max={20} step={1} onChange={(v) => set({ level: v })} testId="practice-level" /> : null}
      {p.gravityMode === 'custom' ? (
        <SliderRow label="Time per row" value={p.msPerRow} min={16} max={3000} step={1} format={ms} onChange={(v) => set({ msPerRow: v })} testId="practice-msperrow" />
      ) : null}
      <ChoiceRow
        label="Lock delay"
        description="Move reset: moving or rotating restarts the timer (up to 15 times). Step reset: only falling a row restarts it."
        value={p.lockMode}
        options={[
          { value: 'move', label: 'Move reset' },
          { value: 'step', label: 'Step reset' },
          { value: 'infinite', label: 'Infinite' },
        ]}
        onChange={(v) => set({ lockMode: v })}
        testId="practice-lockmode"
      />
      {p.lockMode !== 'infinite' ? (
        <SliderRow label="Lock time" value={p.lockDelayMs} min={100} max={5000} step={10} format={ms} onChange={(v) => set({ lockDelayMs: v })} testId="practice-lockdelay" />
      ) : null}
      <SliderRow label="Entry delay" description="Pause before each new piece appears." value={p.areMs} min={0} max={1000} step={10} format={ms} onChange={(v) => set({ areMs: v })} testId="practice-are" />
      <SliderRow label="Line clear delay" value={p.lineClearDelayMs} min={0} max={1000} step={10} format={ms} onChange={(v) => set({ lineClearDelayMs: v })} testId="practice-clear-delay" />
      <SliderRow label="Next pieces" value={p.previewCount} min={0} max={6} step={1} onChange={(v) => set({ previewCount: v })} testId="practice-previews" />
      <ChoiceRow
        label="Hold"
        value={p.holdMode}
        options={[
          { value: 'normal', label: 'Once per piece' },
          { value: 'infinite', label: 'Unlimited' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(v) => set({ holdMode: v })}
        testId="practice-hold"
      />
      <ChoiceRow
        label="Piece order"
        description="7-bag deals each of the seven pieces once per bag; Random can repeat; Drill repeats only the pieces you choose."
        value={p.randomizer}
        options={[
          { value: 'bag7', label: '7-bag' },
          { value: 'random', label: 'Random' },
          { value: 'drill', label: 'Drill' },
        ]}
        onChange={(v) => set({ randomizer: v })}
        testId="practice-randomizer"
      />
      {p.randomizer === 'drill' ? (
        <div className="practice-drill" role="group" aria-label="Drill pieces">
          {PIECE_TYPES.map((t) => (
            <ToggleRow key={t} label={`${t} piece`} value={p.drillPieces.includes(t)} onChange={(on) => toggleDrill(t, on)} testId={`practice-drill-${t}`} />
          ))}
        </div>
      ) : null}
      <ToggleRow label="All-spin" description="Score spins of every piece that can't move in any direction, not only T-spins." value={p.allSpin} onChange={(v) => set({ allSpin: v })} testId="practice-allspin" />
      <p className="setup-desc">During play: Backspace undoes the last piece and R resets the board (rebindable in Controls). Both are also in the pause menu.</p>
    </div>
  );
}
