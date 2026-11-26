package de.preikschas.downhill;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Sturzwächter: läuft als Vordergrunddienst (auch bei gesperrtem Bildschirm).
 * Erkennt einen harten Aufprall mit anschließendem Stillstand, schlägt Alarm und meldet –
 * wenn nicht quittiert – nach dem Countdown einen SOS mit Standort an die Crew (Supabase).
 */
public class CrashGuardService extends Service implements SensorEventListener, LocationListener {

    static final String ACTION_START = "de.preikschas.downhill.guard.START";
    static final String ACTION_UPDATE = "de.preikschas.downhill.guard.UPDATE";
    static final String ACTION_STOP = "de.preikschas.downhill.guard.STOP";
    static final String ACTION_OK = "de.preikschas.downhill.guard.OK";

    private static final String CH_GUARD = "guard";
    private static final String CH_ALARM = "crash_alarm";
    private static final int NID_GUARD = 4101;
    private static final int NID_ALARM = 4102;
    private static final double G = 9.81;

    private static volatile boolean running = false;
    static boolean isRunning() { return running; }

    // Einstellungen
    private double thresholdG = 4.0;
    private int countdown = 30;
    private String url = "", key = "", member = "", secret = "", trail = "", baseStatus = "off";

    // Zustand
    private long impactAt = 0, stillSince = 0;
    private boolean alarm = false, sosSent = false;
    private int left = 0;
    private double lat = Double.NaN, lon = Double.NaN;
    private float speedKmh = 0f;

    private SensorManager sensors;
    private LocationManager locations;
    private Vibrator vibrator;
    private Ringtone ringtone;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!alarm) return;
            left--;
            if (left > 0) {
                CrashGuardPlugin.emit("tick", left);
                showAlarmNotification();
                handler.postDelayed(this, 1000);
            } else if (!sosSent) {
                sosSent = true;
                sendStatus("sos");
                CrashGuardPlugin.emit("sos", 0);
                showAlarmNotification();
                // Ton nach einer Minute beenden, Vibration alle 10 s weiter
                handler.postDelayed(() -> stopSound(), 60000);
                handler.postDelayed(vibrateLoop, 10000);
            }
        }
    };

    private final Runnable vibrateLoop = new Runnable() {
        @Override
        public void run() {
            if (!alarm) return;
            vibrate(new long[]{0, 600, 200, 600});
            handler.postDelayed(this, 10000);
        }
    };

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) {
            readConfig(intent);
            createChannels();
            Notification n = guardNotification();
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NID_GUARD, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                } else {
                    startForeground(NID_GUARD, n);
                }
            } catch (Exception e) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (!running) startSensing();
            running = true;
        } else if (ACTION_UPDATE.equals(action)) {
            readConfig(intent);
        } else if (ACTION_OK.equals(action)) {
            cancelAlarm();
        } else if (ACTION_STOP.equals(action)) {
            shutdown();
        }
        return START_NOT_STICKY;
    }

    private void readConfig(Intent i) {
        thresholdG = i.getDoubleExtra("thresholdG", thresholdG);
        countdown = i.getIntExtra("countdown", countdown);
        url = nz(i.getStringExtra("url"));
        key = nz(i.getStringExtra("key"));
        member = nz(i.getStringExtra("member"));
        secret = nz(i.getStringExtra("secret"));
        trail = nz(i.getStringExtra("trail"));
        baseStatus = nz(i.getStringExtra("baseStatus"));
        if (baseStatus.isEmpty()) baseStatus = "off";
    }

    private static String nz(String s) { return s == null ? "" : s; }

    // ---------- Sensoren ----------
    private void startSensing() {
        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensors != null) {
            Sensor acc = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (acc != null) sensors.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME);
        }
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (locations != null && ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            try {
                locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000, 0, this, Looper.getMainLooper());
            } catch (Exception ignored) { }
        }
        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Gravity:CrashGuard");
            wakeLock.acquire(6 * 60 * 60 * 1000L); // höchstens 6 Stunden
        }
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        float x = e.values[0], y = e.values[1], z = e.values[2];
        double mag = Math.sqrt(x * x + y * y + z * z);
        long now = System.currentTimeMillis();
        if (alarm) return;
        if (mag > thresholdG * G) { impactAt = now; stillSince = 0; return; }
        if (impactAt == 0) return;
        long since = now - impactAt;
        if (since > 30000) { impactAt = 0; return; }
        if (since > 2000) {
            if (Math.abs(mag - G) < 1.5) {
                if (stillSince == 0) stillSince = now;
                else if (now - stillSince > 8000 && speedKmh < 4) { impactAt = 0; startAlarm(); }
            } else {
                stillSince = 0;
            }
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    @Override
    public void onLocationChanged(@NonNull Location l) {
        lat = l.getLatitude();
        lon = l.getLongitude();
        if (l.hasSpeed()) speedKmh = l.getSpeed() * 3.6f;
    }

    @Override public void onProviderEnabled(@NonNull String provider) { }
    @Override public void onProviderDisabled(@NonNull String provider) { }

    // ---------- Alarm ----------
    private void startAlarm() {
        alarm = true;
        sosSent = false;
        left = countdown;
        sendStatus("alarm");
        CrashGuardPlugin.emit("alarm", left);
        showAlarmNotification();
        vibrate(new long[]{0, 500, 200, 500, 200, 500});
        playSound();
        handler.postDelayed(tick, 1000);
    }

    private void cancelAlarm() {
        if (!alarm) return;
        alarm = false;
        handler.removeCallbacks(tick);
        handler.removeCallbacks(vibrateLoop);
        stopSound();
        if (vibrator != null) vibrator.cancel();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NID_ALARM);
        sendStatus(baseStatus);
        CrashGuardPlugin.emit("ok", 0);
    }

    private void vibrate(long[] pattern) {
        if (vibrator == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
            else vibrator.vibrate(pattern, -1);
        } catch (Exception ignored) { }
    }

    private void playSound() {
        try {
            Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            ringtone = RingtoneManager.getRingtone(this, u);
            if (ringtone != null) {
                ringtone.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
                ringtone.play();
            }
        } catch (Exception ignored) { }
    }

    private void stopSound() {
        try { if (ringtone != null) ringtone.stop(); } catch (Exception ignored) { }
        ringtone = null;
    }

    // ---------- Server ----------
    private void sendStatus(final String status) {
        if (url.isEmpty() || member.isEmpty() || secret.isEmpty()) return;
        final double la = lat, lo = lon;
        final float sp = speedKmh;
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                JSONObject b = new JSONObject();
                b.put("p_member", member);
                b.put("p_secret", secret);
                boolean pos = !"off".equals(status) && !Double.isNaN(la);
                b.put("p_lat", pos ? la : JSONObject.NULL);
                b.put("p_lon", pos ? lo : JSONObject.NULL);
                b.put("p_speed", "off".equals(status) ? JSONObject.NULL : Math.round(sp));
                b.put("p_status", status);
                b.put("p_trail", trail.isEmpty() ? JSONObject.NULL : trail);
                c = (HttpURLConnection) new URL(url + "/rest/v1/rpc/crew_update").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("apikey", key);
                c.setRequestProperty("Authorization", "Bearer " + key);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(b.toString().getBytes(StandardCharsets.UTF_8));
                }
                c.getResponseCode();
            } catch (Exception ignored) {
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    // ---------- Benachrichtigungen ----------
    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel g = new NotificationChannel(CH_GUARD, "Sturzwächter", NotificationManager.IMPORTANCE_LOW);
        g.setDescription("Zeigt an, dass die Sturzerkennung aktiv ist");
        nm.createNotificationChannel(g);
        NotificationChannel a = new NotificationChannel(CH_ALARM, "Sturz-Alarm", NotificationManager.IMPORTANCE_HIGH);
        a.setDescription("Alarm nach einem erkannten Sturz");
        a.enableVibration(true);
        a.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        a.setSound(null, null); // Ton spielt der Dienst selbst (als Wecker-Ton)
        nm.createNotificationChannel(a);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification guardNotification() {
        return new NotificationCompat.Builder(this, CH_GUARD)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Sturzwächter aktiv")
            .setContentText("Gravity achtet während deines Laufs auf Stürze.")
            .setOngoing(true)
            .setContentIntent(openApp())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void showAlarmNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Intent ok = new Intent(this, CrashGuardService.class);
        ok.setAction(ACTION_OK);
        PendingIntent okPi = PendingIntent.getService(this, 2, ok, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = sosSent
            ? "SOS wurde an deine Crew gesendet. Tippe auf „Mir geht's gut“, um Entwarnung zu geben."
            : "Keine Reaktion? In " + left + " s geht ein SOS mit deinem Standort an deine Crew.";
        Notification n = new NotificationCompat.Builder(this, CH_ALARM)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(sosSent ? "SOS gesendet" : "Sturz erkannt?")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .addAction(0, "Mir geht's gut", okPi)
            .build();
        try { nm.notify(NID_ALARM, n); } catch (SecurityException ignored) { }
    }

    // ---------- Ende ----------
    private void shutdown() {
        if (alarm) {
            // Läuft ein Alarm, beendet nur „Mir geht's gut“ ihn – nicht das Stoppen des Laufs.
            return;
        }
        running = false;
        handler.removeCallbacksAndMessages(null);
        if (sensors != null) sensors.unregisterListener(this);
        if (locations != null) try { locations.removeUpdates(this); } catch (Exception ignored) { }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopSound();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        if (sensors != null) sensors.unregisterListener(this);
        if (locations != null) try { locations.removeUpdates(this); } catch (Exception ignored) { }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopSound();
        super.onDestroy();
    }
}
