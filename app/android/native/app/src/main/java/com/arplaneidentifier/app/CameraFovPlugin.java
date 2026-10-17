package com.arplaneidentifier.app;

import android.content.Context;
import android.graphics.Rect;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.util.Size;
import android.util.SizeF;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exact horizontal field of view of each camera, from its focal length and sensor size.
 *
 * The browser can't report camera FOV, so the web app estimates it from a per-phone preset. That
 * breaks when the WebView opens a different lens than the preset assumes (e.g. the Galaxy S22+ WebView
 * defaults to the 104° ultrawide and exposes no zoom). The WebView's track label ("camera 2, facing
 * back") contains the Camera2 id, so the app can look up the lens it actually got.
 */
@CapacitorPlugin(name = "CameraFov")
public class CameraFovPlugin extends Plugin {

    @PluginMethod
    public void list(PluginCall call) {
        CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
        JSArray cameras = new JSArray();
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics c = manager.getCameraCharacteristics(id);
                float[] focal = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                SizeF physical = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                Size pixels = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
                Rect active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (focal == null || focal.length == 0 || physical == null || pixels == null || active == null) continue;

                // Active pixel area in mm, landscape (long side = width, like the landscape stream).
                float w = physical.getWidth() * active.width() / pixels.getWidth();
                float h = physical.getHeight() * active.height() / pixels.getHeight();
                float longSide = Math.max(w, h);
                float shortSide = Math.min(w, h);
                // A 4:3 stream uses the full width of a 4:3 sensor; on a wider sensor it crops the sides.
                float streamWidth = Math.min(longSide, shortSide * 4f / 3f);

                JSObject cam = new JSObject();
                cam.put("id", id);
                cam.put("facing", facing == null ? "unknown" : facing == CameraCharacteristics.LENS_FACING_BACK ? "back" : facing == CameraCharacteristics.LENS_FACING_FRONT ? "front" : "external");
                cam.put("focalLengthMm", focal[0]);
                // tan(half horizontal FOV) of a 4:3 landscape stream at 1x zoom.
                cam.put("halfTan4x3", (streamWidth / 2f) / focal[0]);
                cameras.put(cam);
            }
        } catch (CameraAccessException | RuntimeException e) {
            call.reject("Could not read camera characteristics: " + e.getMessage());
            return;
        }
        JSObject result = new JSObject();
        result.put("cameras", cameras);
        call.resolve(result);
    }
}
