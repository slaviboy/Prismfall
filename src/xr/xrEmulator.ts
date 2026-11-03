import { XRDevice, metaQuest3 } from 'iwer';

/**
 * Test-only: installs Meta's Immersive Web Emulation Runtime as `navigator.xr` with an emulated
 * Quest 3 and two Touch controllers. Loaded through the dev/test debug hooks, never by the game.
 */
export function installXREmulator(): XRDevice {
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  aimControllers(device, -80);
  return device;
}

/** Tilts both controllers (degrees about X; negative points at the floor, away from the panels). */
export function aimControllers(device: XRDevice, pitchDeg: number): void {
  const a = (pitchDeg * Math.PI) / 360;
  for (const hand of ['left', 'right'] as const) device.controllers[hand]?.quaternion.set(Math.sin(a), 0, 0, Math.cos(a));
}

type Hand = 'left' | 'right';

/** Holds a controller button for `ms`, then releases it (button ids as in IWER's Touch profile). */
export async function pressButton(device: XRDevice, hand: Hand, id: string, ms = 140): Promise<void> {
  const c = device.controllers[hand];
  if (!c) throw new Error(`no ${hand} controller`);
  c.updateButtonValue(id, 1);
  await new Promise((r) => setTimeout(r, ms));
  c.updateButtonValue(id, 0);
  await new Promise((r) => setTimeout(r, 80));
}

/** Pushes a thumbstick in a direction for `ms`, then centres it. */
export async function pushStick(device: XRDevice, hand: Hand, x: number, y: number, ms = 140): Promise<void> {
  const c = device.controllers[hand];
  if (!c) throw new Error(`no ${hand} controller`);
  c.updateAxes('thumbstick', x, y);
  await new Promise((r) => setTimeout(r, ms));
  c.updateAxes('thumbstick', 0, 0);
  await new Promise((r) => setTimeout(r, 80));
}
