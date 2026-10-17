// Android shell glue: runtime permissions, back button, pause/resume.
// On desktop (npm run dev) these fall back to browser behavior so the page still runs.

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';

export const isNative = Capacitor.isNativePlatform();

/**
 * Asks for location up front. The camera prompt comes from getUserMedia itself
 * (Capacitor's WebChromeClient turns it into the Android runtime permission request).
 * Returns whether location was granted; never throws.
 */
export async function requestLocationPermission(): Promise<boolean> {
  if (!isNative) return true;
  try {
    const status = await Geolocation.requestPermissions({ permissions: ['location'] });
    return status.location === 'granted';
  } catch {
    return false;
  }
}

/** Android back button / back gesture. Registering a handler replaces the default (exit the app). */
export function handleBackButton(onBack: () => void): void {
  if (!isNative) return;
  App.addListener('backButton', onBack);
}

export function exitApp(): void {
  if (isNative) App.exitApp();
}

/** App sent to the background / brought back: release the camera (and later, stop polling) while hidden. */
export function handlePauseResume(onPause: () => void, onResume: () => void): void {
  if (isNative) {
    App.addListener('pause', onPause);
    App.addListener('resume', onResume);
  } else {
    document.addEventListener('visibilitychange', () => (document.hidden ? onPause() : onResume()));
  }
}
