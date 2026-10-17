// Exact camera FOV from the native CameraFov plugin (CameraFovPlugin.java), so labels line up with
// whichever lens the WebView actually opened. main.ts falls back to a generic ~6.3" phone's main
// camera on desktop or if the lens can't be identified.

import { registerPlugin } from '@capacitor/core';
import { isNative } from './native';

type CameraInfo = { id: string; facing: string; focalLengthMm: number; halfTan4x3: number };

const CameraFov = registerPlugin<{ list: () => Promise<{ cameras: CameraInfo[] }> }>('CameraFov');

let cameras: Promise<CameraInfo[]> | null = null;

export type LensFov = { cameraId: string; halfTan1x: number };

/**
 * Lens behind a getUserMedia track: Chromium on Android labels tracks "camera <Camera2 id>, facing back".
 * null = unknown (not native, unexpected label, plugin error).
 */
export async function lensFov(track: MediaStreamTrack | undefined): Promise<LensFov | null> {
  const id = track?.label.match(/^camera (\d+)/)?.[1];
  if (!isNative || id == null) return null;
  cameras ??= CameraFov.list()
    .then((r) => r.cameras)
    .catch(() => []);
  const cam = (await cameras).find((c) => c.id === id);
  return cam ? { cameraId: cam.id, halfTan1x: cam.halfTan4x3 } : null;
}
