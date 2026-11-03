import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { shell } from '../../app/GameShell';
import { toast } from '../../app/stores';
import { xrStore, type XRAvailability } from '../../xr/XRManager';
import { Button, MenuItem } from '../components/controls';
import { registerCustomPanel } from '../settings/customPanels';

/** Live VR availability and presenting state. */
export function useXR(): { availability: XRAvailability; presenting: boolean; starting: boolean } {
  return useStore(xrStore);
}

async function enterVR(): Promise<void> {
  shell.unlockAudio();
  const ok = await shell.xr?.enter();
  if (!ok) toast('Could not start VR. Check that the headset is connected and awake.', 'warning', 5000);
}

/** Main-menu / pause-menu entry, shown only when a headset is ready. */
export function VRMenuItem(): ReactNode {
  const { availability, starting } = useXR();
  if (availability !== 'available') return null;
  return <MenuItem label={starting ? 'Starting VR…' : 'Play in VR'} description="Put on your headset: the playfield floats in front of you inside the world." onSelect={() => void enterVR()} testId="menu-vr" />;
}

/** Shown on the page while the headset is presenting. */
export function VRPresentingOverlay(): ReactNode {
  const { presenting } = useXR();
  if (!presenting) return null;
  return (
    <div className="vr-overlay" role="status" data-testid="vr-overlay">
      <p className="vr-overlay-title">Playing in VR</p>
      <p className="vr-overlay-text">Your game continues in the headset. Exit VR there, or here, to come back.</p>
      <Button onClick={() => void shell.xr?.exit()} testId="vr-exit">
        Exit VR
      </Button>
    </div>
  );
}

const MESSAGES: Record<XRAvailability, string> = {
  checking: 'Checking for a VR headset…',
  available: 'A VR headset is ready.',
  'no-headset': 'This browser supports VR, but no headset is connected. Connect one (for example a Quest with Link or Air Link, or a SteamVR headset) and it will appear here.',
  unsupported: 'This browser has no WebXR support. Use a current Chrome or Edge on the PC, or the headset’s own browser.',
  insecure: 'VR needs a secure page: open the game from localhost on this PC, or over HTTPS with real access control when playing from another device. See DEPLOYMENT.md.',
};

function VRStatusPanel(): ReactNode {
  const { availability, presenting } = useXR();
  // Input profile names reported by the runtime, e.g. "oculus-touch-v3" or "htc-vive".
  const profiles = shell.xr?.controllerProfiles() ?? [];
  return (
    <div className="vr-status" data-testid="vr-status">
      <p className="menu-note">{presenting ? 'VR is running.' : MESSAGES[availability]}</p>
      {profiles.length > 0 ? <p className="menu-note" data-testid="vr-controllers">Controllers seen: {profiles.join(', ')}</p> : null}
      <div className="settings-actions">
        {availability === 'available' && !presenting ? (
          <Button onClick={() => void enterVR()} testId="vr-enter" tone="primary">
            Enter VR
          </Button>
        ) : null}
        {presenting ? (
          <Button onClick={() => void shell.xr?.exit()} testId="vr-exit-settings">
            Exit VR
          </Button>
        ) : null}
        <Button onClick={() => void shell.xr?.detect()} testId="vr-recheck">
          Check again
        </Button>
      </div>
    </div>
  );
}

registerCustomPanel('vrStatus', VRStatusPanel);
