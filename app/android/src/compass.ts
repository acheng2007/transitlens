// Native compass plugin (CompassPlugin.java) + Earth's magnetic field model at the user's position.
//
// The field model gives the local declination (magnetic → true north). web/src/orientation.ts adds a
// fixed Atlanta value (MAG_DECLINATION_DEG) to every heading; declinationCorrectionDeg() is what to
// add on top of that so headings are right anywhere (e.g. +15° in Seattle, -14° in Maine).
// It also gives the field strength a well-calibrated compass should read there.

import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { MAG_DECLINATION_DEG } from '@web/orientation';
import { haversineKm } from './flights/geo';
import { isNative } from './native';

export type CompassReading = { x: number; y: number; z: number; accuracy: number; headingAccuracyDeg?: number };
type ModelResult = { declinationDeg: number; inclinationDeg: number; fieldStrengthUT: number };

export const Compass = registerPlugin<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
  fieldModel: (opts: { lat: number; lon: number }) => Promise<ModelResult>;
  addListener: (event: 'reading', cb: (r: CompassReading) => void) => Promise<PluginListenerHandle>;
}>('Compass');

export type FieldModel = ModelResult & {
  lat: number;
  lon: number;
  /** 'gps' = computed from this session's GPS fix; 'saved' = from the last session (until GPS locks). */
  source: 'gps' | 'saved';
};

const STORAGE_KEY = 'skylens-field-model-v1';
/** Declination changes slowly with distance (well under 1° per 20 km almost everywhere). */
const RECOMPUTE_AFTER_KM = 20;

let current: FieldModel | null = loadSaved();
let inFlight = false;

function loadSaved(): FieldModel | null {
  try {
    const m = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as FieldModel | null;
    return m && Number.isFinite(m.declinationDeg) ? { ...m, source: 'saved' } : null;
  } catch {
    return null;
  }
}

/** The field model in use: this session's GPS position, else the last session's, else null. */
export const fieldModel = (): FieldModel | null => current;

/** Degrees to add to web/src/orientation.ts headings (which assume Atlanta's declination). */
export function declinationCorrectionDeg(): number {
  return current ? current.declinationDeg - MAG_DECLINATION_DEG : 0;
}

/** Call on every GPS fix: (re)computes the model on the first fix and after moving 20 km. Never throws. */
export function updateFieldModel(lat: number, lon: number): void {
  if (!isNative || inFlight) return;
  if (current?.source === 'gps' && haversineKm(current.lat, current.lon, lat, lon) < RECOMPUTE_AFTER_KM) return;
  inFlight = true;
  Compass.fieldModel({ lat, lon })
    .then((r) => {
      current = { ...r, lat, lon, source: 'gps' };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      } catch {
        // Not fatal: it's recomputed on the next GPS fix.
      }
    })
    .catch(() => {})
    .finally(() => (inFlight = false));
}
