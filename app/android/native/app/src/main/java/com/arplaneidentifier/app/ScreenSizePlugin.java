package com.arplaneidentifier.app;

import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Physical size of the screen, so the stereo layout can put each eye under its Cardboard lens on
 * any phone (lens spacing is in mm). Replaces the per-phone presets the web app uses.
 */
@CapacitorPlugin(name = "ScreenSize")
public class ScreenSizePlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        WindowManager wm = getActivity().getWindowManager();
        int w;
        int h;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Rect bounds = wm.getMaximumWindowMetrics().getBounds();
            w = bounds.width();
            h = bounds.height();
        } else {
            DisplayMetrics real = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(real);
            w = real.widthPixels;
            h = real.heightPixels;
        }
        DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
        // xdpi/ydpi can refer to the natural (portrait) axes regardless of rotation, and are equal
        // on practically every phone, so use their average for both edges.
        float dpi = (dm.xdpi + dm.ydpi) / 2f;

        JSObject result = new JSObject();
        result.put("longEdgePx", Math.max(w, h));
        result.put("shortEdgePx", Math.min(w, h));
        result.put("dpi", dpi);
        result.put("longEdgeMm", Math.max(w, h) / dpi * 25.4f);
        result.put("shortEdgeMm", Math.min(w, h) / dpi * 25.4f);
        call.resolve(result);
    }
}
