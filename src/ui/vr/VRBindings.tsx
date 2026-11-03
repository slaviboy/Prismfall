import type { ReactNode } from 'react';
import { toast } from '../../app/stores';
import { ACTION_LABELS, assignBinding, clearBinding, controlLabel, REQUIRED_ACTIONS, XR_CONTROLS } from '../../input/mappings/bindings';
import { DEFAULT_XR, type InputAction } from '../../settings/schema';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import { Button, ChoiceRow } from '../components/controls';
import { registerCustomPanel } from '../settings/customPanels';

const ACTIONS: readonly InputAction[] = ['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'rotate180', 'hold', 'pause', 'practiceUndo', 'confirm', 'back'];

const NONE = '';
const OPTIONS: readonly { value: string; label: string }[] = [{ value: NONE, label: 'None' }, ...XR_CONTROLS.map((c) => ({ value: c, label: controlLabel(c) }))];

/**
 * VR controller remapping. Controllers only report input inside a VR session, so instead of
 * "press a button" capture each slot cycles through the controls every supported controller has.
 * A control already used in the same context is swapped, never duplicated.
 */
function VRBindings(): ReactNode {
  const xr = useSettings((s) => s.xr);

  const set = (action: InputAction, slot: number, control: string): void => {
    const current = getSettings().xr;
    if (control === NONE) {
      const next = clearBinding(current, action, slot);
      if (next) updateSection('xr', next);
      else toast(`${ACTION_LABELS[action]} needs at least one control.`, 'warning');
      return;
    }
    // A second slot can't be filled before the first.
    const s = Math.min(slot, current[action].length);
    const next = assignBinding(current, action, s, control, 'swap');
    const stripped = REQUIRED_ACTIONS.find((a) => next[a].length === 0);
    if (stripped) {
      toast(`${controlLabel(control)} is the only control for ${ACTION_LABELS[stripped]}; choose another.`, 'warning');
      return;
    }
    updateSection('xr', next);
  };

  return (
    <section className="binding-group vr-bindings-panel" data-testid="vr-bindings">
      <h3 className="settings-group">Controller buttons</h3>
      <p className="menu-note">
        The same names are used on every controller. Touchpads act as sticks when pressed near an edge; a press in the middle is the stick press. Vive and Windows Mixed Reality controllers have no A, B, X or Y buttons, so keep the stick press on Pause.
      </p>
      {ACTIONS.map((action) =>
        [0, 1].map((slot) =>
          slot === 1 && !xr[action][0] ? null : (
            <ChoiceRow
              key={`${action}-${slot}`}
              label={slot === 0 ? ACTION_LABELS[action] : `${ACTION_LABELS[action]} (second)`}
              value={xr[action][slot] ?? NONE}
              options={OPTIONS}
              onChange={(v) => set(action, slot, v)}
              testId={`vr-bind-${action}-${slot}`}
            />
          ),
        ),
      )}
      <div className="settings-actions">
        <Button
          onClick={() => {
            updateSection('xr', structuredClone(DEFAULT_XR));
            toast('VR controller buttons restored', 'success');
          }}
          testId="vr-bindings-reset"
        >
          Restore default buttons
        </Button>
      </div>
    </section>
  );
}

registerCustomPanel('vrBindings', VRBindings);
