package de.preikschas.downhill;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Brücke zwischen App (JavaScript) und dem Sturzwächter-Dienst.
 * start(): Dienst mit Einstellungen starten, stop(): beenden, ok(): Alarm quittieren,
 * update(): Crew-Daten / Strecke / Grundstatus ändern. Ereignisse kommen als "guard".
 */
@CapacitorPlugin(name = "CrashGuard")
public class CrashGuardPlugin extends Plugin {

    private static CrashGuardPlugin current;

    @Override
    public void load() {
        current = this;
    }

    private Intent baseIntent(String action) {
        Intent i = new Intent(getContext(), CrashGuardService.class);
        i.setAction(action);
        return i;
    }

    private void putConfig(Intent i, PluginCall call) {
        i.putExtra("thresholdG", call.getDouble("thresholdG", 4.0));
        i.putExtra("countdown", call.getInt("countdown", 30));
        i.putExtra("url", call.getString("url", ""));
        i.putExtra("key", call.getString("key", ""));
        i.putExtra("member", call.getString("member", ""));
        i.putExtra("secret", call.getString("secret", ""));
        i.putExtra("trail", call.getString("trail", ""));
        i.putExtra("baseStatus", call.getString("baseStatus", "off"));
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent i = baseIntent(CrashGuardService.ACTION_START);
        putConfig(i, call);
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Sturzwächter konnte nicht starten: " + e.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        if (!CrashGuardService.isRunning()) { call.resolve(); return; }
        Intent i = baseIntent(CrashGuardService.ACTION_UPDATE);
        putConfig(i, call);
        try {
            getContext().startService(i);
        } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (CrashGuardService.isRunning()) {
            try { getContext().startService(baseIntent(CrashGuardService.ACTION_STOP)); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void ok(PluginCall call) {
        if (CrashGuardService.isRunning()) {
            try { getContext().startService(baseIntent(CrashGuardService.ACTION_OK)); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    /** Ereignis an die App melden (type: alarm | tick | sos | ok). */
    static void emit(String type, int left) {
        CrashGuardPlugin p = current;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("type", type);
        d.put("left", left);
        p.notifyListeners("guard", d, true);
    }
}
