"use strict";
// Gravity – Downhill-Tracker (PWA). Alles wird lokal auf dem Gerät gespeichert.

const $ = (s) => document.querySelector(s);
const G = 9.81;

// ---------- Speicher ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* voll oder gesperrt */ } }
};
let runs = store.get("dh_runs", []);
let settings = Object.assign({ crashOn: true, crashG: 4, cName: "", cPhone: "", sel: null, favs: [], custom: {} }, store.get("dh_settings", {}));
let setup = store.get("dh_setup", null) || {
  bike: "",
  notes: "",
  fork: { travel: "", sag: "", vals: { psi: 85, reb: 8, lsc: 6, hsc: 4, tok: 2 } },
  shock: { travel: "", sag: "", vals: { psi: 450, reb: 10, lsc: 6, hsc: 4 } }
};
if (!setup.tires) setup.tires = { front: 1.6, rear: 1.8 };
const saveRuns = () => store.set("dh_runs", runs);
const saveSettings = () => store.set("dh_settings", settings);
const saveSetup = () => store.set("dh_setup", setup);

// ---------- Hilfen ----------
const fmtTime = (ms) => {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
};
const de = (n, d) => n.toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const haversine = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const bestFor = (trail) => runs.filter((r) => r.trail === trail).reduce((b, r) => (!b || r.dur < b.dur ? r : b), null);

// ---------- Navigation ----------
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
function show(v) {
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  if (v === "runs") renderRuns();
  if (v === "parks") renderParks();
  if (v === "park") document.querySelector('.tab[data-view="parks"]').classList.add("on");
  window.scrollTo(0, 0);
}

// ---------- Live-Lauf ----------
const run = { active: false };
let watchId = null, timerId = null, wakeLock = null, audioCtx = null;
let lastFix = null; // letzte bekannte Position (auch für Notfall-SMS)

// Aktuell gewählte Strecke: { park, trail } – Schlüssel für Bestzeiten ist "Park · Strecke"
const selKey = () => settings.sel ? (settings.sel.park ? settings.sel.park + " · " + settings.sel.trail : settings.sel.trail) : "Ohne Strecke";
function renderSel() {
  const s = settings.sel;
  $("#pick-park").textContent = s && s.park ? s.park : "Bikepark wählen";
  $("#pick-name").textContent = s ? s.trail : "Strecke wählen";
  const hint = $("#near-hint");
  if (!s) { hint.hidden = false; hint.textContent = "Wähle Park und Strecke, dann zählen deine Bestzeiten pro Trail →"; }
  else hint.hidden = true;
  updateBest();
}
function updateBest() {
  const b = bestFor(selKey());
  $("#best").textContent = b ? fmtTime(b.dur) : "–";
}
function fillTrailList() {}
$("#pick-trail").addEventListener("click", () => {
  if (run.active) return;
  const s = settings.sel;
  const i = s && s.park ? PARKS_ALL().findIndex((p) => p.n === s.park) : -1;
  if (i >= 0) openPark(i); else show("parks");
});
$("#near-hint").addEventListener("click", () => show("parks"));

$("#btn-run").addEventListener("click", () => (run.active ? stopRun() : startRun()));

async function startRun() {
  if (!("geolocation" in navigator)) { alert("Dieses Gerät bietet kein GPS im Browser an."); return; }
  await askMotionPermission();
  unlockAudio();

  const trail = selKey();
  Object.assign(run, {
    active: true, trail, park: settings.sel && settings.sel.park || "", tname: settings.sel ? settings.sel.trail : "", start: Date.now(), dist: 0, vmax: 0, drop: 0, air: 0, jumps: 0,
    speed: 0, last: null, altRef: null, points: []
  });
  resetMotion();

  watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  timerId = setInterval(renderLive, 100);
  requestWakeLock();

  $("#btn-run").textContent = "Lauf beenden";
  $("#btn-run").className = "btn stop big-btn";
  $("#rec").hidden = false;
  $("#pick-trail").disabled = true;
  $("#gps-state").textContent = "GPS: suche Signal …";
  renderLive();
}

function stopRun() {
  if (!run.active) return;
  run.active = false;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(timerId);
  releaseWakeLock();

  $("#btn-run").textContent = "Lauf starten";
  $("#btn-run").className = "btn primary big-btn";
  $("#rec").hidden = true;
  $("#pick-trail").disabled = false;
  $("#speed").textContent = "0";

  const dur = Date.now() - run.start;
  if (dur < 5000) { $("#gps-state").textContent = "Lauf zu kurz – nicht gespeichert."; return; }
  const prevBest = bestFor(run.trail);
  const rec = {
    id: String(run.start), trail: run.trail, park: run.park, tname: run.tname, start: run.start, dur,
    dist: Math.round(run.dist), vmax: run.vmax, drop: Math.round(run.drop),
    air: run.air, jumps: run.jumps
  };
  runs.unshift(rec);
  saveRuns();
  fillTrailList();
  updateBest();
  $("#gps-state").textContent = "Lauf gespeichert.";
  openDetail(rec, !prevBest || dur < prevBest.dur ? (prevBest ? prevBest.dur - dur : -1) : null);
}

function onFix(p) {
  const c = p.coords;
  const now = p.timestamp || Date.now();
  const fix = { lat: c.latitude, lon: c.longitude, t: now, acc: c.accuracy };
  lastFix = fix;
  $("#gps-state").textContent = "GPS: ±" + Math.round(c.accuracy) + " m";
  if (!run.active) return;

  // Geschwindigkeit
  let v = (typeof c.speed === "number" && !isNaN(c.speed)) ? c.speed : null;
  if (run.last) {
    const d = haversine(run.last, fix);
    const dt = (now - run.last.t) / 1000;
    if (c.accuracy <= 30 && d > 1.5) run.dist += d;
    if (v === null && dt > 0) v = d / dt;
  }
  if (v !== null) {
    const kmh = v * 3.6;
    run.speed = run.speed ? run.speed * 0.4 + kmh * 0.6 : kmh; // leicht geglättet
    if (c.accuracy <= 25 && kmh < 130 && run.speed > run.vmax) run.vmax = run.speed;
  }

  // Tiefenmeter mit Schwelle gegen GPS-Rauschen
  if (typeof c.altitude === "number" && !isNaN(c.altitude)) {
    if (run.altRef === null) run.altRef = c.altitude;
    else if (c.altitude < run.altRef - 3) { run.drop += run.altRef - c.altitude; run.altRef = c.altitude; }
    else if (c.altitude > run.altRef + 3) run.altRef = c.altitude;
  }
  run.last = fix;
}
function onGpsError(e) {
  const msg = e.code === 1 ? "GPS: Zugriff verweigert – bitte in den Browser-Einstellungen erlauben." : "GPS: kein Signal";
  $("#gps-state").textContent = msg;
}

function renderLive() {
  if (!run.active) return;
  $("#speed").textContent = Math.round(run.speed || 0);
  $("#vmax").textContent = Math.round(run.vmax);
  $("#time").textContent = fmtTime(Date.now() - run.start);
  $("#drop").textContent = Math.round(run.drop) + " m";
  $("#dist").textContent = de(run.dist / 1000, 2) + " km";
  $("#air").textContent = de(run.air, 1) + " s";
  $("#jumps").textContent = run.jumps;
}

// ---------- Bildschirm anlassen ----------
async function requestWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* nicht erlaubt */ }
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (run.active && document.visibilityState === "visible") requestWakeLock(); });

// ---------- Bewegungssensor: Airtime & Sturz ----------
let motionOK = false;
const m = {};
function resetMotion() { Object.assign(m, { inAir: false, airStart: 0, impactAt: 0, stillSince: 0 }); }
resetMotion();

async function askMotionPermission() {
  if (motionOK) return;
  try {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== "granted") return;
    }
    window.addEventListener("devicemotion", onMotion);
    motionOK = true;
  } catch (e) { /* kein Sensor */ }
}

function onMotion(e) {
  if (!run.active) return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const now = performance.now();

  // Airtime: nahezu Schwerelosigkeit = Bike in der Luft
  if (mag < 0.35 * G) {
    if (!m.inAir) { m.inAir = true; m.airStart = now; }
  } else if (m.inAir && mag > 0.6 * G) {
    const dur = (now - m.airStart) / 1000;
    if (dur >= 0.18 && dur < 4) { run.air += dur; run.jumps++; }
    m.inAir = false;
  }

  // Sturz: harter Aufprall, danach Stillstand
  if (!settings.crashOn || alarm.on) return;
  if (mag > settings.crashG * G) { m.impactAt = now; m.stillSince = 0; return; }
  if (m.impactAt) {
    const since = now - m.impactAt;
    if (since > 30000) { m.impactAt = 0; return; }
    if (since > 2000) {
      if (Math.abs(mag - G) < 1.5) {
        if (!m.stillSince) m.stillSince = now;
        else if (now - m.stillSince > 8000 && (run.speed || 0) < 4) { m.impactAt = 0; startAlarm(); }
      } else m.stillSince = 0;
    }
  }
}

// ---------- Alarm ----------
const alarm = { on: false, left: 30, timer: null, beep: null };
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
function beep() {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square"; o.frequency.value = 1400;
    g.gain.value = 0.25;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.35);
  } catch (e) {}
}
function smsHref() {
  const pos = lastFix ? `https://maps.google.com/?q=${lastFix.lat.toFixed(6)},${lastFix.lon.toFixed(6)}` : "(Standort unbekannt)";
  const trail = run.trail ? ` Trail: ${run.trail}.` : "";
  const text = `Notfall: Ich bin beim Downhill vermutlich gestürzt und habe nicht reagiert.${trail} Mein letzter Standort: ${pos}`;
  return `sms:${(settings.cPhone || "").replace(/\s/g, "")}?&body=${encodeURIComponent(text)}`;
}
function startAlarm() {
  unlockAudio();
  alarm.on = true; alarm.left = 30;
  $("#alarm-count").textContent = alarm.left;
  $("#btn-sms").href = smsHref();
  $("#btn-sms").textContent = settings.cName ? `SMS an ${settings.cName}` : "SMS an Notfallkontakt";
  $("#alarm").hidden = false;
  $("#alarm").classList.add("alarm-flash");
  $("#btn-ok").focus();
  const tick = () => {
    beep();
    if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
    alarm.left--;
    $("#alarm-count").textContent = Math.max(0, alarm.left);
    if (alarm.left <= 0) {
      clearInterval(alarm.timer);
      $("#btn-sms").href = smsHref();
      if (settings.cPhone) location.href = $("#btn-sms").href;
    }
  };
  tick();
  alarm.timer = setInterval(tick, 1000);
}
function stopAlarm() {
  alarm.on = false;
  clearInterval(alarm.timer);
  if (navigator.vibrate) navigator.vibrate(0);
  $("#alarm").hidden = true;
  $("#alarm").classList.remove("alarm-flash");
  resetMotion();
}
$("#btn-ok").addEventListener("click", stopAlarm);
$("#btn-test").addEventListener("click", () => { unlockAudio(); startAlarm(); });

// ---------- Läufe ----------
function renderRuns() {
  fillTrailList();
  const byTrail = {};
  runs.forEach((r) => { (byTrail[r.trail] = byTrail[r.trail] || []).push(r); });
  const trails = Object.keys(byTrail);
  const bests = $("#bests");
  if (!trails.length) {
    bests.innerHTML = "";
    $("#run-list").innerHTML = `<p class="empty">Noch keine Läufe. Starte im Tab „Live“ deinen ersten Run.</p>`;
    return;
  }
  bests.innerHTML = `<div class="bests">` + trails.map((t) => {
    const b = bestFor(t);
    return `<div class="best-card"><span class="lbl">Bestzeit · ${byTrail[t].length} ${byTrail[t].length === 1 ? "Lauf" : "Läufe"}</span>
      <span class="strong">${esc(t)}</span><span class="huge">${fmtTime(b.dur)}</span></div>`;
  }).join("") + `</div>`;

  $("#run-list").innerHTML = runs.map((r) => {
    const isBest = bestFor(r.trail).id === r.id;
    const d = new Date(r.start);
    return `<button class="run" data-id="${esc(r.id)}">
      <span class="meta"><span class="name">${esc(r.trail)} ${isBest ? '<span class="badge">PB</span>' : ""}</span>
      <span class="lbl">${d.toLocaleDateString("de-DE")} · ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} · ${Math.round(r.vmax)} km/h</span></span>
      <span class="t">${fmtTime(r.dur)}</span></button>`;
  }).join("");
  document.querySelectorAll(".run").forEach((b) => b.addEventListener("click", () => {
    const r = runs.find((x) => x.id === b.dataset.id);
    if (r) openDetail(r, null);
  }));
}

let detailRun = null;
function openDetail(r, gain) {
  detailRun = r;
  $("#detail-h").textContent = r.trail;
  let head = "";
  if (gain !== null && gain !== undefined) {
    head = `<div class="best-card"><span class="lbl">${gain < 0 ? "Erste Zeit auf diesem Trail" : "Neue Bestzeit"}</span>
      <span class="huge">${fmtTime(r.dur)}</span>${gain > 0 ? `<span>${de(gain / 1000, 1)} s schneller als dein Rekord</span>` : ""}</div>`;
  }
  const stat = (l, v) => `<div class="card stat"><span class="lbl">${l}</span><span class="val">${v}</span></div>`;
  $("#detail-body").innerHTML = head + `<div class="grid3" style="margin-top:12px">
    ${stat("Zeit", fmtTime(r.dur))}${stat("Vmax", Math.round(r.vmax) + " km/h")}${stat("Tiefenmeter", r.drop + " m")}
    ${stat("Strecke", de(r.dist / 1000, 2) + " km")}${stat("Airtime", de(r.air, 1) + " s")}${stat("Sprünge", r.jumps)}
  </div><p class="hint small" style="margin-top:10px">${new Date(r.start).toLocaleString("de-DE")}</p>`;
  $("#detail").hidden = false;
  $("#detail-close").focus();
}
$("#detail-close").addEventListener("click", () => { $("#detail").hidden = true; });
$("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") $("#detail").hidden = true; });
$("#detail-del").addEventListener("click", () => {
  if (!detailRun || !confirm("Diesen Lauf wirklich löschen?")) return;
  runs = runs.filter((r) => r.id !== detailRun.id);
  saveRuns(); updateBest(); renderRuns();
  $("#detail").hidden = true;
});
$("#detail-share").addEventListener("click", async () => {
  const r = detailRun; if (!r) return;
  const text = `${r.trail}: ${fmtTime(r.dur)} · Vmax ${Math.round(r.vmax)} km/h · ${r.jumps} Sprünge, ${de(r.air, 1)} s Airtime 🤘`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); alert("In die Zwischenablage kopiert."); }
  } catch (e) {}
});

// ---------- Setup ----------
const ROWS = {
  fork: [
    { k: "psi", label: "Air Pressure", hint: "psi", step: 1 },
    { k: "reb", label: "Rebound", hint: "Klicks von geschlossen", step: 1 },
    { k: "lsc", label: "LSC", hint: "Low-Speed Compression · Klicks", step: 1 },
    { k: "hsc", label: "HSC", hint: "High-Speed Compression · Klicks", step: 1 },
    { k: "tok", label: "Volume Spacers", hint: "Tokens", step: 1 }
  ],
  shock: [
    { k: "psi", label: "Spring Rate / Air Pressure", hint: "lbs oder psi", step: 5 },
    { k: "reb", label: "Rebound", hint: "Klicks von geschlossen", step: 1 },
    { k: "lsc", label: "LSC", hint: "Low-Speed Compression · Klicks", step: 1 },
    { k: "hsc", label: "HSC", hint: "High-Speed Compression · Klicks", step: 1 }
  ]
};
const TIRES = [
  { k: "front", label: "Front", hint: "bar", step: 0.1 },
  { k: "rear", label: "Rear", hint: "bar", step: 0.1 }
];
const SAG_TARGET = { fork: [20, 30], shock: [28, 35] };
let part = "fork";

$("#bike-name").value = setup.bike;
$("#bike-name").addEventListener("input", (e) => { setup.bike = e.target.value; saveSetup(); });
$("#setup-notes").value = setup.notes;
$("#setup-notes").addEventListener("input", (e) => { setup.notes = e.target.value; saveSetup(); });
$("#tab-fork").addEventListener("click", () => setPart("fork"));
$("#tab-shock").addEventListener("click", () => setPart("shock"));
$("#sag-travel").addEventListener("input", (e) => { setup[part].travel = e.target.value; saveSetup(); renderSag(); });
$("#sag-sag").addEventListener("input", (e) => { setup[part].sag = e.target.value; saveSetup(); renderSag(); });

function setPart(p) {
  part = p;
  ["fork", "shock"].forEach((x) => {
    const b = $("#tab-" + x);
    b.classList.toggle("on", x === p);
    b.setAttribute("aria-selected", x === p);
  });
  $("#sag-travel").value = setup[p].travel;
  $("#sag-sag").value = setup[p].sag;
  renderSag();
  renderRows();
}
function renderSag() {
  const t = parseFloat(setup[part].travel), s = parseFloat(setup[part].sag);
  const [lo, hi] = SAG_TARGET[part];
  const arc = $("#sag-arc"), txt = $("#sag-txt"), hint = $("#sag-hint");
  if (!(t > 0) || !(s >= 0)) {
    arc.setAttribute("stroke-dasharray", "0 289");
    arc.setAttribute("stroke-opacity", "0");
    txt.textContent = "–";
    hint.textContent = `Typischer Sag für Downhill: ${lo}–${hi} %`;
    $("#sag-ring").setAttribute("aria-label", "Sag noch nicht berechnet");
    return;
  }
  const pct = Math.min(100, (s / t) * 100);
  arc.setAttribute("stroke-dasharray", `${(pct / 100) * 289} 289`);
  arc.setAttribute("stroke-opacity", pct > 0 ? "1" : "0");
  txt.textContent = Math.round(pct) + " %";
  $("#sag-ring").setAttribute("aria-label", `Sag ${Math.round(pct)} Prozent`);
  const ok = pct >= lo && pct <= hi;
  arc.setAttribute("stroke", ok ? "#C6FF3D" : "#FF8A80");
  hint.textContent = ok ? `Im typischen Bereich (${lo}–${hi} %).`
    : pct < lo ? `Weniger Sag als typisch (${lo}–${hi} %) → etwas weniger Air Pressure / weichere Feder.`
    : `Mehr Sag als typisch (${lo}–${hi} %) → etwas mehr Air Pressure / härtere Feder.`;
}
function stepRows(el, rows, vals, fmt) {
  el.innerHTML = rows.map((r) => `
    <div class="srow">
      <span class="col"><span class="strong">${r.label}</span><span class="lbl">${r.hint}</span></span>
      <span class="stepper">
        <button data-k="${r.k}" data-d="-${r.step}" aria-label="${r.label} verringern">−</button>
        <span class="v" aria-live="polite">${fmt(vals[r.k] ?? 0)}</span>
        <button data-k="${r.k}" data-d="${r.step}" aria-label="${r.label} erhöhen">+</button>
      </span>
    </div>`).join("");
  el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    vals[k] = Math.max(0, Math.round(((vals[k] || 0) + Number(b.dataset.d)) * 10) / 10);
    saveSetup();
    b.parentElement.querySelector(".v").textContent = fmt(vals[k]);
  }));
}
function renderRows() {
  stepRows($("#setup-rows"), ROWS[part], setup[part].vals, (v) => v);
  stepRows($("#tire-rows"), TIRES, setup.tires, (v) => de(v, 1));
}

// ---------- Sicherheit ----------
$("#crash-on").checked = settings.crashOn;
$("#crash-g").value = String(settings.crashG);
$("#c-name").value = settings.cName;
$("#c-phone").value = settings.cPhone;
$("#crash-on").addEventListener("change", (e) => { settings.crashOn = e.target.checked; saveSettings(); });
$("#crash-g").addEventListener("change", (e) => { settings.crashG = Number(e.target.value); saveSettings(); });
$("#c-name").addEventListener("input", (e) => { settings.cName = e.target.value.trim(); saveSettings(); });
$("#c-phone").addEventListener("input", (e) => { settings.cPhone = e.target.value.trim(); saveSettings(); });

// ---------- Bikeparks ----------
const COUNTRY = { DE: "Deutschland", AT: "Österreich", IT: "Italien", FR: "Frankreich", ES: "Spanien", PT: "Portugal", SI: "Slowenien", CZ: "Tschechien", SK: "Slowakei", PL: "Polen", SE: "Schweden", FI: "Finnland", BG: "Bulgarien", RO: "Rumänien", HR: "Kroatien", BE: "Belgien", NL: "Niederlande", DK: "Dänemark", GR: "Griechenland", IE: "Irland", HU: "Ungarn", LU: "Luxemburg", EE: "Estland", LV: "Lettland", LT: "Litauen", SVK: "Slowakei" };
const PARKS_ALL = () => (window.PARKS || []);
let parkFilter = { q: "", cc: "ALL" };
let userPos = null;
let curPark = -1;
let addingTrail = false;
// Schwierigkeit: offizielle Bikepark-Farbe (grün/blau/rot/schwarz), sonst aus der MTB-Skala abgeleitet
const COL = { green: "s0", blue: "s1", red: "s2", orange: "s2", black: "s3", yellow: "s0" };
const COL_NAME = { s0: "leicht", s1: "mittel", s2: "schwer", s3: "sehr schwer", sx: "" };
const S_CLASS = (t) => (t.col && COL[t.col]) || (t.s === null || t.s === undefined ? "sx" : t.s <= 0 ? "s0" : t.s === 1 ? "s1" : t.s === 2 ? "s2" : "s3");
const TYPE = { downhill: "DH", freeride: "FR", enduro: "EN", flow: "FL", dirt: "JL", jump: "JL", slopestyle: "SL", pump: "PT", gravity: "DH" };
const S_LABEL = (t) => (t.ty && TYPE[t.ty.toLowerCase()]) || (t.s === null || t.s === undefined ? "–" : "S" + t.s);
const trailsOf = (p) => ((settings.osm && settings.osm[p.n]) || p.t || []).concat((settings.custom[p.n] || []).map((t) => Object.assign({ custom: true }, t)));

function renderChips() {
  const ccs = [...new Set(PARKS_ALL().map((p) => p.c))];
  const order = ["DE", "AT", "IT", "FR"];
  ccs.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || (COUNTRY[a] || a).localeCompare(COUNTRY[b] || b));
  const chips = [["ALL", "Alle"], ["FAV", "★ Favoriten"]].concat(ccs.map((c) => [c, COUNTRY[c] || c]));
  $("#country-chips").innerHTML = chips.map(([k, l]) =>
    `<button class="chip ${parkFilter.cc === k ? "on" : ""}" data-cc="${k}" aria-pressed="${parkFilter.cc === k}">${esc(l)}</button>`).join("");
  $("#country-chips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { parkFilter.cc = b.dataset.cc; renderParks(); }));
}
function distKm(p) { return userPos && p.lat !== null ? haversine(userPos, { lat: p.lat, lon: p.lon }) / 1000 : null; }

function renderParks() {
  renderChips();
  const q = parkFilter.q.toLowerCase();
  let list = PARKS_ALL().map((p, i) => ({ p, i, d: distKm(p) }));
  if (parkFilter.cc === "FAV") list = list.filter((x) => settings.favs.includes(x.p.n));
  else if (parkFilter.cc !== "ALL") list = list.filter((x) => x.p.c === parkFilter.cc);
  if (q) list = list.filter((x) => x.p.n.toLowerCase().includes(q) || trailsOf(x.p).some((t) => t.n.toLowerCase().includes(q)));
  if (userPos) list.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
  else list.sort((a, b) => (settings.favs.includes(b.p.n) - settings.favs.includes(a.p.n)) || a.p.n.localeCompare(b.p.n));
  $("#park-count").textContent = PARKS_ALL().length + " Parks";
  if (!list.length) {
    $("#park-list").innerHTML = `<p class="empty">${parkFilter.cc === "FAV" ? "Noch keine Favoriten. Tippe im Park auf den Stern." : "Kein Park gefunden."}</p>`;
    return;
  }
  $("#park-list").innerHTML = list.map(({ p, i, d }) => {
    const n = trailsOf(p).length;
    const fav = settings.favs.includes(p.n) ? '<span class="star" aria-label="Favorit">★</span> ' : "";
    const hit = q && !p.n.toLowerCase().includes(q) ? trailsOf(p).filter((t) => t.n.toLowerCase().includes(q)).map((t) => t.n).slice(0, 2).join(", ") : "";
    return `<button class="park" data-i="${i}">
      <span class="cc">${esc(p.c)}</span>
      <span class="meta"><span class="name">${fav}${esc(p.n)}</span>
      <span class="lbl">${hit ? "Strecke: " + esc(hit) : (n ? n + (n === 1 ? " Strecke" : " Strecken") : "Strecken noch nicht erfasst")}${d !== null ? " · " + de(d, d < 10 ? 1 : 0) + " km" : ""}</span></span>
      <svg viewBox="0 0 24 24" class="chev" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`;
  }).join("");
  $("#park-list").querySelectorAll(".park").forEach((b) => b.addEventListener("click", () => openPark(Number(b.dataset.i))));
}
$("#park-q").addEventListener("input", (e) => { parkFilter.q = e.target.value.trim(); renderParks(); });
$("#btn-near").addEventListener("click", () => {
  if (!("geolocation" in navigator)) return;
  $("#btn-near").textContent = "Suche …";
  navigator.geolocation.getCurrentPosition((p) => {
    userPos = { lat: p.coords.latitude, lon: p.coords.longitude };
    $("#btn-near").innerHTML = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/></svg>Nähe';
    parkFilter.cc = "ALL";
    renderParks();
  }, () => {
    $("#btn-near").innerHTML = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/></svg>Nähe';
    alert("Standort nicht verfügbar. Bitte Standortzugriff erlauben.");
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
});

function openPark(i) {
  curPark = i; addingTrail = false;
  const p = PARKS_ALL()[i];
  if (!p) return;
  show("park");
  $("#park-h").textContent = p.n;
  $("#park-sub").textContent = COUNTRY[p.c] || p.c;
  const fav = settings.favs.includes(p.n);
  $("#park-fav").setAttribute("aria-pressed", fav);
  $("#park-fav").setAttribute("aria-label", fav ? "Favorit entfernen" : "Als Favorit merken");
  const map = $("#park-map");
  if (p.lat !== null) { map.href = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=13/${p.lat}/${p.lon}`; map.hidden = false; }
  else map.hidden = true;
  renderTrails();
}
function renderTrails() {
  const p = PARKS_ALL()[curPark];
  const ts = trailsOf(p);
  const s = settings.sel;
  let html = "";
  if (addingTrail) {
    html += `<form id="add-form" class="card col gap8">
      <label class="mini">Name der Strecke<input id="add-name" required maxlength="60" autocomplete="off"></label>
      <label class="mini">Schwierigkeit<select id="add-s"><option value="">unbekannt</option><option value="0">Grün · leicht</option><option value="1">Blau · mittel</option><option value="2">Rot · schwer</option><option value="3">Schwarz · sehr schwer</option></select></label>
      <div class="row gap8"><button type="button" id="add-cancel" class="btn ghost flex1">Abbrechen</button><button class="btn primary flex1">Hinzufügen</button></div>
    </form>`;
  }
  if (!ts.length) html += `<p class="empty">Für diesen Park sind noch keine Strecken in OpenStreetMap erfasst. Leg deine Strecken mit „+ Eigene Strecke“ an.</p>`;
  const upd = settings.osmAt && settings.osmAt[p.n];
  const tail = p.lat !== null ? `<button id="osm-refresh" class="more">Strecken aus OpenStreetMap aktualisieren</button>
    <p class="hint small">${upd ? "Zuletzt aktualisiert: " + new Date(upd).toLocaleDateString("de-DE") + ". " : ""}Lädt alle in OpenStreetMap eingetragenen Bike-Strecken im Umkreis von 6 km neu.</p>` : "";
  html += ts.map((t, k) => {
    const key = p.n + " · " + t.n;
    const b = bestFor(key);
    const cnt = runs.filter((r) => r.trail === key).length;
    const isSel = s && s.park === p.n && s.trail === t.n;
    const cls = S_CLASS(t);
    const meta = [COL_NAME[cls], t.s !== null && t.s !== undefined && t.ty ? "S" + t.s : "", t.l ? de(t.l / 1000, t.l < 10000 ? 1 : 0) + " km" : "", t.custom ? "eigene" : "", b ? "PB " + fmtTime(b.dur) : "", cnt ? cnt + (cnt === 1 ? " Lauf" : " Läufe") : ""].filter(Boolean).join(" · ");
    return `<div class="trail ${isSel ? "sel" : ""}">
      <span class="sbadge ${cls}" title="Schwierigkeit: ${COL_NAME[cls] || "unbekannt"}">${S_LABEL(t)}</span>
      <span class="meta"><span class="name">${esc(t.n)}</span><span class="lbl">${meta || "&nbsp;"}</span></span>
      <button class="pick-btn" data-k="${k}">${isSel ? "Gewählt" : "Wählen"}</button></div>`;
  }).join("") + tail;
  $("#trail-list").innerHTML = html;
  const rb = $("#osm-refresh");
  if (rb) rb.addEventListener("click", () => refreshOsm(p, rb));
  $("#trail-list").querySelectorAll(".pick-btn").forEach((b) => b.addEventListener("click", () => {
    const t = ts[Number(b.dataset.k)];
    settings.sel = { park: p.n, trail: t.n };
    saveSettings(); renderSel(); show("live");
  }));
  const f = $("#add-form");
  if (f) {
    $("#add-name").focus();
    $("#add-cancel").addEventListener("click", () => { addingTrail = false; renderTrails(); });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const n = $("#add-name").value.trim(); if (!n) return;
      const sv = $("#add-s").value;
      (settings.custom[p.n] = settings.custom[p.n] || []).push({ n, s: sv === "" ? null : Number(sv), l: 0 });
      saveSettings(); addingTrail = false; renderTrails();
    });
  }
}
// Strecken live aus OpenStreetMap (Overpass) nachladen
const OVERPASS = ["https://overpass.openstreetmap.fr/api/interpreter", "https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
async function refreshOsm(p, btn) {
  if (!navigator.onLine) { alert("Keine Internetverbindung."); return; }
  btn.disabled = true; btn.textContent = "Lade Strecken … (bis zu 1 Minute)";
  const q = `[out:json][timeout:60];
way(around:5000,${p.lat},${p.lon})["highway"~"^(path|track)$"]["name"]["piste:type"!~"."]->.w;
(way.w["highway"="path"]["bicycle"="designated"]; way.w["highway"="path"]["mtb"~"^(yes|designated)$"]; way.w["mtb:type"]; way.w["highway"="path"]["mtb:scale"]["foot"="no"]; way.w["name"~"line|trail|downhill|freeride|flow|gravity|enduro|fourcross|4x|dual|jump|slope|bikepark|bike park",i];);
out tags geom;`;
  let j = null;
  for (const u of OVERPASS) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
      const r = await fetch(u, { method: "POST", body: "data=" + encodeURIComponent(q), signal: c.signal });
      clearTimeout(t);
      if (r.ok) { j = await r.json(); break; }
    } catch (e) { /* nächster Server */ }
  }
  if (!j) { btn.disabled = false; btn.textContent = "Server ausgelastet – nochmal versuchen"; return; }
  const g = {};
  for (const e of j.elements || []) {
    const tg = e.tags || {}, gm = e.geometry || [];
    let len = 0;
    for (let k = 1; k < gm.length; k++) len += haversine(gm[k - 1], gm[k]);
    const key = tg.name.trim();
    const sc = parseInt(tg["mtb:scale"]);
    if (!g[key]) g[key] = { n: key, s: null, l: 0, d: 1e9 };
    g[key].l += len;
    if (!isNaN(sc)) g[key].s = Math.max(g[key].s ?? -1, sc);
    if (gm.length) { const m = gm[Math.floor(gm.length / 2)]; g[key].d = Math.min(g[key].d, haversine(p, m)); }
  }
  const list = Object.values(g).filter((x) => x.l >= 150).sort((a, b) => a.d - b.d).slice(0, 45)
    .map((x) => ({ n: x.n, s: x.s, l: Math.round(x.l) }));
  settings.osm = settings.osm || {}; settings.osmAt = settings.osmAt || {};
  settings.osm[p.n] = list; settings.osmAt[p.n] = Date.now();
  saveSettings(); renderTrails();
}
$("#park-back").addEventListener("click", () => show("parks"));
$("#park-add").addEventListener("click", () => { addingTrail = true; renderTrails(); });
$("#park-fav").addEventListener("click", () => {
  const p = PARKS_ALL()[curPark]; if (!p) return;
  const i = settings.favs.indexOf(p.n);
  if (i >= 0) settings.favs.splice(i, 1); else settings.favs.push(p.n);
  saveSettings(); openPark(curPark);
});

// ---------- Start ----------
renderSel();
setPart("fork");
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
