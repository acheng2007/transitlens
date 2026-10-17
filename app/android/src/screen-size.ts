// Physical screen size from the native ScreenSize plugin (ScreenSizePlugin.java), so the stereo layout
// works on any phone without per-phone presets. The in-headset "spacing" calibration fine-tunes it.

import { registerPlugin } from '@capacitor/core';
import { isNative } from './native';

const ScreenSize = registerPlugin<{ get: () => Promise<{ longEdgeMm: number; dpi: number }> }>('ScreenSize');

/** Phones are ~120–180 mm on the long edge; anything outside this means the reported dpi is bogus. */
const PLAUSIBLE_MM: [number, number] = [90, 220];

/** Long edge of the screen in mm, or null if unknown. Never throws. */
export async function measureScreenLongEdgeMm(): Promise<number | null> {
  if (!isNative) return null;
  try {
    const { longEdgeMm } = await ScreenSize.get();
    return longEdgeMm >= PLAUSIBLE_MM[0] && longEdgeMm <= PLAUSIBLE_MM[1] ? longEdgeMm : null;
  } catch {
    return null;
  }
}
