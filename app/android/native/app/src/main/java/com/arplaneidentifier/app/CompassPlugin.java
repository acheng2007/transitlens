package com.arplaneidentifier.app;

import android.content.Context;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Magnetometer readings for the compass calibration tool (Settings → Calibrate compass).
 *
 * Android calibrates the magnetometer itself while the sensor runs and the phone is turned through
 * many orientations (the "figure 8"). Apps can't trigger that, but they can keep the sensor running,
 * guide the motion, and show the accuracy Android reports, which browsers don't expose.
 * Emits "reading" events: field x/y/z (µT, device axes), accuracy (SensorManager.SENSOR_STATUS_*:
 * 0 unreliable … 3 high) and, when the rotation vector reports it, headingAccuracyDeg.
 *
 * fieldModel({lat, lon}) returns Earth's expected field at a position from Android's built-in World
 * Magnetic Model: the declination (magnetic → true north correction for the heading) and the
 * field strength (what a well-calibrated compass should read there).
 */
@CapacitorPlugin(name = "Compass")
public class CompassPlugin extends Plugin implements SensorEventListener {

    /** ~15 Hz to the web layer; the sensors themselves run faster. */
    private static final long EMIT_EVERY_MS = 66;

    private SensorManager sensors;
    private boolean running = false;
    private float[] field;
    private int fieldAccuracy = -1;
    private float headingAccuracyDeg = -1;
    private long lastEmit = 0;

    @Override
    public void load() {
        sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) == null) {
            call.reject("This phone has no compass (magnetometer).");
            return;
        }
        running = true;
        field = null;
        register();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        sensors.unregisterListener(this);
        call.resolve();
    }

    @PluginMethod
    public void fieldModel(PluginCall call) {
        Double lat = call.getDouble("lat");
        Double lon = call.getDouble("lon");
        if (lat == null || lon == null) {
            call.reject("lat and lon are required");
            return;
        }
        double altitudeM = call.getDouble("altitudeM", 0.0);
        GeomagneticField model = new GeomagneticField(lat.floatValue(), lon.floatValue(), (float) altitudeM, System.currentTimeMillis());
        JSObject result = new JSObject();
        // Degrees east of true north (Atlanta ≈ -5).
        result.put("declinationDeg", model.getDeclination());
        result.put("inclinationDeg", model.getInclination());
        result.put("fieldStrengthUT", model.getFieldStrength() / 1000f); // nT → µT
        call.resolve(result);
    }

    private void register() {
        sensors.registerListener(this, sensors.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD), SensorManager.SENSOR_DELAY_GAME);
        Sensor rotation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        if (rotation != null) sensors.registerListener(this, rotation, SensorManager.SENSOR_DELAY_GAME);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        sensors.unregisterListener(this);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (running) register();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        sensors.unregisterListener(this);
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        int type = e.sensor.getType();
        if (type == Sensor.TYPE_MAGNETIC_FIELD) {
            field = e.values.clone();
            fieldAccuracy = e.accuracy;
        } else if (type == Sensor.TYPE_ROTATION_VECTOR && e.values.length > 4 && e.values[4] >= 0) {
            // values[4] = estimated heading accuracy in radians (not reported by every phone).
            headingAccuracyDeg = (float) Math.toDegrees(e.values[4]);
        }
        long now = System.currentTimeMillis();
        if (field == null || now - lastEmit < EMIT_EVERY_MS) return;
        lastEmit = now;

        JSObject data = new JSObject();
        data.put("x", field[0]);
        data.put("y", field[1]);
        data.put("z", field[2]);
        data.put("accuracy", fieldAccuracy);
        if (headingAccuracyDeg >= 0) data.put("headingAccuracyDeg", headingAccuracyDeg);
        notifyListeners("reading", data);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        if (sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) fieldAccuracy = accuracy;
    }
}
