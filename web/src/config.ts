// Device presets and user settings for the Cardboard stereo layout.

export type DevicePreset = {
  id: string;
  label: string;
  /** Physical length of the screen's long edge (landscape width), in mm. */
  screenWidthMm: number;
  /**
   * tan(half horizontal FOV) of the main rear camera at 1x zoom, 4:3 stream.
   * From diagonal FOV d: tan(d/2) * 0.8 (4:3 width share of the diagonal). Refine with the fov calibration.
   */
  cameraHalfTan1x: number;
  /** Matched against the device model (userAgentData) or the user agent string. */
  match?: RegExp;
};

// Long-edge lengths derived from diagonal + resolution:
//   Pixel 10:       6.3", 1080x2424 -> ~146 mm
//   Galaxy S22+:    6.6", 1080x2340 -> ~152 mm
//   iPhone 13 mini: 5.4", 1080x2340 -> ~125 mm
export const PRESETS: DevicePreset[] = [
  // Main camera diagonal FOV: Pixel ~82°, S22+ ~85°, iPhone 13 mini ~84°.
  { id: 'pixel10', label: 'Pixel 10', screenWidthMm: 146, cameraHalfTan1x: 0.7, match: /Pixel 10/i },
  { id: 's22plus', label: 'Galaxy S22+', screenWidthMm: 152, cameraHalfTan1x: 0.73, match: /SM-S906/i },
  { id: 'iphone13mini', label: 'iPhone 13 mini', screenWidthMm: 125, cameraHalfTan1x: 0.72 },
  { id: 'generic', label: 'Other / iPhone (calibrate size + FOV)', screenWidthMm: 146, cameraHalfTan1x: 0.7 },
];

/** Typical Cardboard lens center-to-center distance. */
export const DEFAULT_IPD_MM = 64;

export type Settings = {
  presetId: string;
  ipdMm: number;
  /** Horizontal shift of both eyes (+ = right), for a phone that isn't centered in the headset. */
  offsetMm: number;
  /** Fraction of the available eye area the image fills. */
  viewScale: number;
  /** Rotation compensating for a phone sitting crooked in the headset (+ = clockwise). */
  tiltDeg: number;
  /** Multiplier on the estimated camera FOV, tuned until labels line up with the real scene. */
  fovScale: number;
  /** Hardware camera zoom; null = widest available (ultrawide on most phones). */
  cameraZoom: number | null;
  /** '' = auto (rear-facing). */
  cameraId: string;
  /**
   * Where plane data comes from:
   *   demo    - flight-service demo snapshot (fixed location, no GPS); falls back to the fixture if unreachable
   *   live    - flight-service with real GPS
   *   fixture - shared/fixtures/demo-planes.json, no backend
   */
  dataMode: DataMode;
  viewMode: ViewMode;
  /** "Hey Gemini" voice assistant (inherited module in src/voice/). */
  voiceEnabled: boolean;
  /** Plane search radius. null = flight-service's defaults (15 km live, 40 km demo). */
  radiusKm: number | null;
  compassDistanceMiles?: number | null;
  /** Stream the view (camera + HUD) to /cast.html on a laptop over WebRTC. */
  castEnabled: boolean;
  /** Include aircraft on the ground (taxiing/parked, shown grey). Off = airborne only. */
  showGrounded: boolean;
  /** Capture the first set of aircraft and hold it (no movement, no more polling). */
  freezePlanes: boolean;
};

export type DataMode = 'demo' | 'live' | 'fixture' | 'sim';

/** 'ar' = camera passthrough; 'vr' = virtual Atlanta scene rendered in 3D (src/vr/). */
export type ViewMode = 'ar' | 'vr';

export const DEFAULT_SETTINGS: Settings = {
  presetId: 'generic',
  ipdMm: DEFAULT_IPD_MM,
  offsetMm: 0,
  viewScale: 0.95,
  tiltDeg: 0,
  fovScale: 1,
  cameraZoom: null,
  cameraId: '',
  dataMode: 'demo',
  viewMode: 'ar',
  voiceEnabled: true,
  radiusKm: null,
  castEnabled: false,
  showGrounded: true,
  freezePlanes: true,
};

export const TRANSIT_SETTINGS: Settings = { ...DEFAULT_SETTINGS, dataMode: 'live', viewMode: 'ar', voiceEnabled: true, radiusKm: 5, compassDistanceMiles: 1, freezePlanes: false };

const STORAGE_KEY = 'ar-plane-settings-v4';

export function loadSettings(key = STORAGE_KEY): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

export function saveSettings(s: Settings, key = STORAGE_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    // Storage unavailable; settings just won't persist.
  }
}

export function getPreset(id: string): DevicePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
}

/** Best-effort model detection. Android Chrome hides the model in the UA string, so ask userAgentData. */
export async function detectPreset(): Promise<DevicePreset> {
  let model = navigator.userAgent;
  const uad = (navigator as any).userAgentData;
  if (uad?.getHighEntropyValues) {
    try {
      const v = await uad.getHighEntropyValues(['model']);
      if (v.model) model = v.model;
    } catch {
      // Fall back to the UA string.
    }
  }
  return PRESETS.find((p) => p.match?.test(model)) ?? getPreset('generic');
}

/** CSS pixels per physical millimeter, using the screen's long edge. */
export function pxPerMm(preset: DevicePreset): number {
  const longEdgeCssPx = Math.max(screen.width, screen.height);
  return longEdgeCssPx / preset.screenWidthMm;
}
