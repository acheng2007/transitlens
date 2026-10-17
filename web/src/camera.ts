// Rear camera access.

export async function startCamera(deviceId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable. The page must be served over HTTPS (or localhost).');
  }
  // Ask for 4:3 (the sensor's native shape). A 16:9 stream would lose ~37% of its width
  // when cropped to fill the near-square eye, which looks very zoomed in.
  const video: MediaTrackConstraints = {
    aspectRatio: { ideal: 4 / 3 },
    width: { ideal: 1440 },
    height: { ideal: 1080 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video });
  } catch (err) {
    // A saved camera id can go stale; fall back to the default rear camera.
    if (!deviceId) throw err;
    return startCamera();
  }
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  } catch {
    return [];
  }
}

export type ZoomRange = { min: number; max: number; step: number };

/** Hardware zoom range, or null if the camera doesn't support zoom. zoom < 1 = ultrawide lens. */
export function getZoomRange(stream: MediaStream): ZoomRange | null {
  const zoom = (stream.getVideoTracks()[0]?.getCapabilities?.() as any)?.zoom;
  if (!zoom || zoom.max <= zoom.min) return null;
  return { min: zoom.min, max: zoom.max, step: zoom.step || 0.1 };
}

export function getZoom(stream: MediaStream): number | null {
  return (stream.getVideoTracks()[0]?.getSettings() as any)?.zoom ?? null;
}

/** Best-effort and time-limited: never let a zoom change block or break the camera. */
export async function setZoom(stream: MediaStream, zoom: number): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  const apply = track.applyConstraints({ advanced: [{ zoom } as any] }).catch(() => {});
  await Promise.race([apply, timeout]);
}

export function describeStream(stream: MediaStream): string {
  const s = stream.getVideoTracks()[0]?.getSettings();
  if (!s) return 'no video track';
  const range = getZoomRange(stream);
  const zoom = range ? ` z${getZoom(stream) ?? '?'} (${range.min}-${range.max})` : ' no zoom';
  return `${s.width}x${s.height}${zoom}`;
}
