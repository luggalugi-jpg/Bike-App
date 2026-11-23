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
let settings = Object.assign({ crashOn: true, crashG: 4, cName: "", cPhone: "", lastTrail: "" }, store.get("dh_settings", {}));
let setup = store.get("dh_setup", null) || {
  bike: "",
  notes: "",
  fork: { travel: "", sag: "", vals: { psi: 85, reb: 8, lsc: 6, hsc: 4, tok: 2 } },
  shock: { travel: "", sag: "", vals: { psi: 450, reb: 10, lsc: 6, hsc: 4 } }
};
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
  window.scrollTo(0, 0);
}

// ---------- Live-Lauf ----------
const run = { active: false };
let watchId = null, timerId = null, wakeLock = null, audioCtx = null;
let lastFix = null; // letzte bekannte Position (auch für Notfall-SMS)

const trailInput = $("#trail");
trailInput.value = settings.lastTrail || "";
trailInput.addEventListener("change", () => { settings.lastTrail = trailInput.value.trim(); saveSettings(); updateBest(); });
function fillTrailList() {
  const names = [...new Set(runs.map((r) => r.trail).filter(Boolean))];
  $("#trail-list").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}
function updateBest() {
  const b = bestFor(trailInput.value.trim() || "Ohne Namen");
  $("#best").textContent = b ? fmtTime(b.dur) : "–";
}

$("#btn-run").addEventListener("click", () => (run.active ? stopRun() : startRun()));

async function startRun() {
  if (!("geolocation" in navigator)) { alert("Dieses Gerät bietet kein GPS im Browser an."); return; }
  await askMotionPermission();
  unlockAudio();

  const trail = trailInput.value.trim() || "Ohne Namen";
  settings.lastTrail = trailInput.value.trim(); saveSettings();
  Object.assign(run, {
    active: true, trail, start: Date.now(), dist: 0, vmax: 0, drop: 0, air: 0, jumps: 0,
    speed: 0, last: null, altRef: null, points: []
  });
  resetMotion();

  watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  timerId = setInterval(renderLive, 100);
  requestWakeLock();

  $("#btn-run").textContent = "Lauf beenden";
  $("#btn-run").className = "btn stop big-btn";
  $("#rec").hidden = false;
  trailInput.disabled = true;
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
  trailInput.disabled = false;
  $("#speed").textContent = "0";

  const dur = Date.now() - run.start;
  if (dur < 5000) { $("#gps-state").textContent = "Lauf zu kurz – nicht gespeichert."; return; }
  const prevBest = bestFor(run.trail);
  const rec = {
    id: String(run.start), trail: run.trail, start: run.start, dur,
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
    { k: "psi", label: "Luftdruck", hint: "psi", step: 1 },
    { k: "reb", label: "Zugstufe", hint: "Klicks von geschlossen", step: 1 },
    { k: "lsc", label: "Druckstufe Low", hint: "LSC · Klicks", step: 1 },
    { k: "hsc", label: "Druckstufe High", hint: "HSC · Klicks", step: 1 },
    { k: "tok", label: "Tokens", hint: "Volumenspacer", step: 1 }
  ],
  shock: [
    { k: "psi", label: "Feder / Luftdruck", hint: "lbs oder psi", step: 5 },
    { k: "reb", label: "Zugstufe", hint: "Klicks von geschlossen", step: 1 },
    { k: "lsc", label: "Druckstufe Low", hint: "LSC · Klicks", step: 1 },
    { k: "hsc", label: "Druckstufe High", hint: "HSC · Klicks", step: 1 }
  ]
};
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
    txt.textContent = "–";
    hint.textContent = `Typisch für Downhill: ${lo}–${hi} %`;
    $("#sag-ring").setAttribute("aria-label", "SAG noch nicht berechnet");
    return;
  }
  const pct = Math.min(100, (s / t) * 100);
  arc.setAttribute("stroke-dasharray", `${(pct / 100) * 289} 289`);
  txt.textContent = Math.round(pct) + " %";
  $("#sag-ring").setAttribute("aria-label", `SAG ${Math.round(pct)} Prozent`);
  const ok = pct >= lo && pct <= hi;
  arc.setAttribute("stroke", ok ? "#C6FF3D" : "#FF8A80");
  hint.textContent = ok ? `Im typischen Bereich (${lo}–${hi} %).`
    : pct < lo ? `Weniger als typisch (${lo}–${hi} %) → etwas weniger Druck/Feder.`
    : `Mehr als typisch (${lo}–${hi} %) → etwas mehr Druck/härtere Feder.`;
}
function renderRows() {
  const vals = setup[part].vals;
  $("#setup-rows").innerHTML = ROWS[part].map((r) => `
    <div class="srow">
      <span class="col"><span class="strong">${r.label}</span><span class="lbl">${r.hint}</span></span>
      <span class="stepper">
        <button data-k="${r.k}" data-d="-${r.step}" aria-label="${r.label} verringern">−</button>
        <span class="v" aria-live="polite">${vals[r.k] ?? 0}</span>
        <button data-k="${r.k}" data-d="${r.step}" aria-label="${r.label} erhöhen">+</button>
      </span>
    </div>`).join("");
  $("#setup-rows").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    vals[k] = Math.max(0, (vals[k] || 0) + Number(b.dataset.d));
    saveSetup();
    b.parentElement.querySelector(".v").textContent = vals[k];
  }));
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

// ---------- Start ----------
fillTrailList();
updateBest();
setPart("fork");
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
