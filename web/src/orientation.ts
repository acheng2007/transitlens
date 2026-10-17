// Which way the rear camera is pointing: compass heading (true north) + pitch.
//
// The rear camera looks along the device's -Z axis. Given the rotation R that maps
// device coordinates to earth coordinates (East, North, Up), the camera direction in
// earth coordinates is -(third column of R). Heading = atan2(East, North).
// This works in any phone orientation (portrait, landscape, crooked in a headset),
// unlike the raw `alpha` value, which follows the top edge of the phone.

import { normalizeDeg, toDeg, toRad } from './geo';


/** Per-sample smoothing factor (0..1). Lower = smoother but laggier. */
const SMOOTHING = 0.2;

export type OrientationSource = 'sensor' | 'absolute-event' | 'relative-event' | 'safari-compass' | 'none';

export type OrientationReading = {
  headingDeg: number;
  pitchDeg: number;
  source: OrientationSource;
  northReference?: 'true' | 'magnetic';
};

export type OrientationTracker = {
  get: () => OrientationReading | null;
  /** Latest raw device->ENU rotation (row-major 3x3, magnetic north), for sensor diagnostics. Null until the first reading. */
  getRotation: () => number[] | null;
  stop: () => void;
};

type Vec3 = [number, number, number];

/** Quaternion [x, y, z, w] (device -> earth) to a row-major 3x3 rotation matrix. */
function rotationFromQuaternion([x, y, z, w]: number[]): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** W3C DeviceOrientation Euler angles (R = Rz(alpha) Rx(beta) Ry(gamma)) to a row-major 3x3 rotation matrix. */
export function rotationFromEuler(alpha: number, beta: number, gamma: number): number[] {
  const [sA, cA] = [Math.sin(toRad(alpha)), Math.cos(toRad(alpha))];
  const [sB, cB] = [Math.sin(toRad(beta)), Math.cos(toRad(beta))];
  const [sG, cG] = [Math.sin(toRad(gamma)), Math.cos(toRad(gamma))];
  return [
    cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG,
    cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB,
    -cB * sG, sB, cB * cG,
  ];
}

/** iOS only: motion access must be requested from a user gesture. Call first thing in the tap handler. */
export async function requestOrientationPermission(): Promise<boolean> {
  const DOE = (window as any).DeviceOrientationEvent;
  if (typeof DOE?.requestPermission === 'function') {
    try {
      return await DOE.requestPermission() === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Prefers the AbsoluteOrientationSensor (quaternion, Android Chrome), falls back to
 * `deviceorientationabsolute` events. `?orient=event` forces the event path for debugging.
 * If the sensor starts but never delivers a reading (it can go silent without an error, e.g. after
 * a permission prompt), the event path is started as well after 1.5 s.
 */
export function startOrientation(forceEvents = false, getDeclination: () => number | null = () => null): OrientationTracker {
  let smoothed: Vec3 | null = null;
  let rotation: number[] | null = null;
  let source: OrientationSource = 'none';
  let sensorReadings = 0;
  let eventsStarted = false;
  const stoppers: Array<() => void> = [];

  const push = (r: number[], src: OrientationSource) => {
    // Once the sensor delivers, ignore the event fallback if both are running.
    if (src !== 'sensor' && source === 'sensor') return;
    source = src;
    rotation = r;
    // Rear camera looks along device -Z: its direction in ENU is -(3rd column of R).
    const v: Vec3 = [-r[2], -r[5], -r[8]];
    // Smooth the direction vector (not the angle) so 359° -> 0° doesn't jump.
    smoothed = smoothed
      ? [
          smoothed[0] + (v[0] - smoothed[0]) * SMOOTHING,
          smoothed[1] + (v[1] - smoothed[1]) * SMOOTHING,
          smoothed[2] + (v[2] - smoothed[2]) * SMOOTHING,
        ]
      : v;
  };

  const useEvents = () => {
    if (eventsStarted) return;
    eventsStarted = true;
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    const handler = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
      const compass = (e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number });
      if (compass.webkitCompassHeading != null && Number.isFinite(compass.webkitCompassHeading) && compass.webkitCompassHeading >= 0 && (compass.webkitCompassAccuracy == null || compass.webkitCompassAccuracy >= 0)) {
        // Safari alpha has an arbitrary zero. Anchor the full Euler rotation to
        // its magnetic compass rather than treating alpha as geographic north.
        push(safariRotation(compass.webkitCompassHeading, e.beta, e.gamma), 'safari-compass');
      } else if (e.absolute && e.alpha != null && Number.isFinite(e.alpha)) {
        push(rotationFromEuler(e.alpha, e.beta, e.gamma), 'absolute-event');
      }
    };
    window.addEventListener(type, handler as EventListener);
    stoppers.push(() => window.removeEventListener(type, handler as EventListener));
  };

  const Sensor = (window as any).AbsoluteOrientationSensor;
  if (Sensor && !forceEvents) {
    try {
      const sensor = new Sensor({ frequency: 60, referenceFrame: 'device' });
      sensor.addEventListener('reading', () => {
        sensorReadings++;
        push(rotationFromQuaternion(sensor.quaternion), 'sensor');
      });
      sensor.addEventListener('error', () => {
        sensor.stop();
        useEvents();
      });
      sensor.start();
      stoppers.push(() => sensor.stop());
      const fallback = window.setTimeout(() => {
        if (sensorReadings === 0) useEvents();
      }, 1500);
      stoppers.push(() => clearTimeout(fallback));
    } catch {
      useEvents();
    }
  } else {
    useEvents();
  }

  return {
    get() {
      const declination = getDeclination();
      if (!smoothed) return null;
      const [e, n, u] = smoothed;
      const len = Math.hypot(e, n, u) || 1;
      return {
        headingDeg: normalizeDeg(toDeg(Math.atan2(e, n)) + (declination ?? 0)),
        pitchDeg: toDeg(Math.asin(Math.max(-1, Math.min(1, u / len)))),
        source,
        northReference: declination == null ? 'magnetic' : 'true',
      };
    },
    getRotation: () => rotation,
    stop: () => stoppers.forEach((f) => f()),
  };
}

/** Safari compass is clockwise from magnetic north; Euler alpha is counterclockwise.
 * Keeping beta/gamma projects the rear camera in either landscape direction.
 * The tracker adds location/date declination once, after smoothing magnetic vectors.
 */
export function safariRotation(compassHeading: number, beta: number, gamma: number): number[] {
  return rotationFromEuler(normalizeDeg(360 - compassHeading), beta, gamma);
}
