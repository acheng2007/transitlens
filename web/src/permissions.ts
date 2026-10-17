// Read-only permission status for the start screen. Never prompts: the real requests stay
// inside the Start tap (camera, motion and fullscreen need that user gesture).

export type PermState = 'granted' | 'prompt' | 'denied' | 'unavailable';
export type PermKey = 'camera' | 'location' | 'motion';

const LABELS: Record<PermState, string> = {
  granted: 'Ready',
  prompt: 'On Start',
  denied: 'Blocked',
  unavailable: 'Unavailable',
};

async function query(name: string): Promise<PermState> {
  try {
    const status = await navigator.permissions.query({ name } as PermissionDescriptor);
    return status.state as PermState;
  } catch {
    // Not queryable in this browser (e.g. camera in older Safari): it will ask on Start.
    return 'prompt';
  }
}

export async function checkPermissions(): Promise<Record<PermKey, PermState>> {
  const secure = window.isSecureContext;
  const camera: PermState = !secure || !navigator.mediaDevices?.getUserMedia ? 'unavailable' : await query('camera');
  const location: PermState = !secure || !navigator.geolocation ? 'unavailable' : await query('geolocation');
  // iOS gates motion behind requestPermission() (asked on Start); Android/desktop expose it freely.
  const needsMotionPrompt = typeof (DeviceOrientationEvent as any)?.requestPermission === 'function';
  const motion: PermState = !secure || !('DeviceOrientationEvent' in window) ? 'unavailable' : needsMotionPrompt ? 'prompt' : 'granted';
  return { camera, location, motion };
}

/** Fills the `.perm[data-perm]` chips in `root`. */
export async function renderPermissions(root: HTMLElement) {
  const states = await checkPermissions();
  for (const el of root.querySelectorAll<HTMLElement>('.perm[data-perm]')) {
    const state = states[el.dataset.perm as PermKey];
    if (!state) continue;
    el.dataset.state = state;
    el.querySelector('.perm-state')!.textContent = LABELS[state];
  }
}
