"use strict";
// Gravity – Brücke zur Android-App (Capacitor). Im Browser ist alles inaktiv und die Web-Funktionen greifen.

window.Native = (() => {
  const C = window.Capacitor;
  const isNative = !!(C && typeof C.isNativePlatform === "function" && C.isNativePlatform());
  const cfg = window.GRAVITY_BUILD || {};
  const plug = (n) => (isNative && C.registerPlugin ? C.registerPlugin(n) : null);
  const BG = plug("BackgroundGeolocation");
  const LN = plug("LocalNotifications");
  const PN = plug("PushNotifications");
  const CG = plug("CrashGuard");

  // ---------- Standort: im Hintergrund weiterlaufend ----------
  // Gleiche Form wie navigator.geolocation, damit app.js/crew.js nichts anpassen müssen.
  const watchers = new Map();
  let nextId = 1;
  function toPosition(l) {
    return {
      coords: {
        latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy ?? 50,
        altitude: l.altitude ?? null, speed: (typeof l.speed === "number" && l.speed >= 0) ? l.speed : null
      },
      timestamp: l.time || Date.now()
    };
  }
  function watchPosition(ok, err, _opts, label) {
    if (!isNative || !BG) return navigator.geolocation.watchPosition(ok, err, _opts);
    const id = "n" + nextId++;
    watchers.set(id, null);
    BG.addWatcher({
      backgroundTitle: "Gravity",
      backgroundMessage: label || "Standort wird für deinen Lauf genutzt.",
      requestPermissions: true, stale: false, distanceFilter: 0
    }, (loc, e) => {
      if (e) { if (e.code === "NOT_AUTHORIZED") err && err({ code: 1, message: e.message }); else err && err({ code: 2, message: e.message }); return; }
      if (loc) ok(toPosition(loc));
    }).then((wid) => {
      if (watchers.has(id)) watchers.set(id, wid); else BG.removeWatcher({ id: wid });
    }).catch((e) => err && err({ code: 2, message: String(e) }));
    return id;
  }
  function clearWatch(id) {
    if (!isNative || !BG || typeof id !== "string") { try { navigator.geolocation.clearWatch(id); } catch (e) {} return; }
    const wid = watchers.get(id);
    watchers.delete(id);
    if (wid) BG.removeWatcher({ id: wid }).catch(() => {});
  }

  // ---------- Benachrichtigungen erlauben (Android 13+) ----------
  async function askNotify() {
    if (!LN) return;
    try { const p = await LN.checkPermissions(); if (p.display !== "granted") await LN.requestPermissions(); } catch (e) {}
  }

  // ---------- Sturzwächter (nativer Android-Dienst) ----------
  let guardActive = false;
  const guardHandlers = [];
  if (CG) CG.addListener("guard", (ev) => guardHandlers.forEach((h) => { try { h(ev); } catch (e) {} }));
  async function guardStart(opts) {
    if (!CG) return false;
    await askNotify();
    try { await CG.start(opts); guardActive = true; return true; } catch (e) { guardActive = false; return false; }
  }
  async function guardStop() { if (!CG) return; guardActive = false; try { await CG.stop(); } catch (e) {} }
  async function guardOk() { if (CG) try { await CG.ok(); } catch (e) {} }
  async function guardUpdate(opts) { if (CG && guardActive) try { await CG.update(opts); } catch (e) {} }

  // ---------- Push (Crew-Alarm) ----------
  const pushReady = isNative && !!PN && !!cfg.push;
  async function registerPush(onToken, onMessage) {
    if (!pushReady) return false;
    try {
      let p = await PN.checkPermissions();
      if (p.receive !== "granted") p = await PN.requestPermissions();
      if (p.receive !== "granted") return false;
      await PN.createChannel({ id: "crew_alarm", name: "Crew-Alarm", description: "Sturz-Alarm und SOS aus deiner Crew", importance: 5, visibility: 1, vibration: true, lights: true });
      PN.addListener("registration", (t) => onToken && onToken(t.value));
      PN.addListener("pushNotificationReceived", (n) => onMessage && onMessage(n));
      PN.addListener("pushNotificationActionPerformed", (a) => onMessage && onMessage(a.notification));
      await PN.register();
      return true;
    } catch (e) { return false; }
  }

  return {
    isNative, pushReady, watchPosition, clearWatch, askNotify,
    guardStart, guardStop, guardOk, guardUpdate, onGuard: (h) => guardHandlers.push(h),
    get guardActive() { return guardActive; },
    registerPush
  };
})();
