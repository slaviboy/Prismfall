import { useApp } from '../app/stores';
import { useSettings } from '../settings/store';
import { controlLabel } from '../input/mappings/bindings';

/** Labels for confirm/back on the device the player is currently using. */
export function useConfirmBackLabels(): { confirm: string; back: string } {
  const device = useApp((s) => s.device);
  const family = useApp((s) => s.padFamily);
  const keyboard = useSettings((s) => s.keyboard);
  const gamepad = useSettings((s) => s.gamepad);
  const swap = useSettings((s) => s.controller.swapConfirmBack);
  if (device === 'gamepad') {
    const confirm = (swap ? gamepad.back : gamepad.confirm)[0] ?? 'button:0';
    const back = (swap ? gamepad.confirm : gamepad.back)[0] ?? 'button:1';
    return { confirm: controlLabel(confirm, family), back: controlLabel(back, family) };
  }
  return { confirm: controlLabel(keyboard.confirm[0] ?? 'Enter'), back: controlLabel(keyboard.back[0] ?? 'Escape') };
}
