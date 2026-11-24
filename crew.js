"use strict";
// Gravity – Crew: Live-Karte, Positionen teilen, Sturz-Alarm an die Crew.
// Server: Supabase (Frankfurt). Die Tabellen sind gesperrt; die App spricht nur über
// abgesicherte Funktionen (RPC), die bei jedem Aufruf den geheimen Mitgliedsschlüssel prüfen.

window.Crew = (() => {
  const URL_ = "https://prynqxludruspngvhunc.supabase.co";
  const KEY = "sb_publishable_mXDH94sAWPU2jLzZyGMflw_joBmcDrB";
  const POLL_MS = 5000, PUSH_MS = 5000;

  let me = store.get("dh_crew", null);      // { code, crew, member, secret, name }
  let state = null;                          // letzter Stand vom Server
  let shareWatch = null, pollTimer = null, lastPush = 0, pushTimer = null;
  let myFix = null, mySpeed = null;
  let alarmStatus = null;                    // null | "alarm" | "sos"
  let manualSos = false;
  let map = null, markers = {}, meetMarker = null, fitted = false;
  const seenAlarm = store.get("dh_crew_seen", {}); // Alarme anderer, die ich schon gesehen habe
  let showingAlert = null;

  // ---------- Server ----------
  async function rpc(fn, body) {
    const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    if (!r.ok) {
      let msg = txt;
      try { msg = JSON.parse(txt).message || txt; } catch (e) {}
      throw new Error(msg);
    }
    const j = txt ? JSON.parse(txt) : null;
    if (j && j.error) throw new Error(j.error);
    return j;
  }
  const auth = () => ({ p_member: me.member, p_secret: me.secret });

  // ---------- eigener Status ----------
  function myStatus() {
    if (manualSos || alarmStatus === "sos") return "sos";
    if (alarmStatus === "alarm") return "alarm";
    if (!settings.crewShare) return "off";
    return run.active ? "riding" : "live";
  }
  async function push(force) {
    if (!me) return;
    const now = Date.now();
    if (!force && now - lastPush < PUSH_MS) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => push(true), PUSH_MS - (now - lastPush));
      return;
    }
    lastPush = now;
    const st = myStatus();
    const f = myFix || lastFix;
    // Ohne „Live teilen“ wird die Position nur bei Alarm/SOS übertragen
    const sendPos = st !== "off" && f;
    try {
      await rpc("crew_update", Object.assign(auth(), {
        p_lat: sendPos ? f.lat : null, p_lon: sendPos ? f.lon : null,
        p_speed: st === "off" ? null : (mySpeed !== null && mySpeed !== undefined ? Math.round(mySpeed) : null),
        p_status: st, p_trail: run.active ? run.trail : (settings.sel ? selKey() : null)
      }));
      setSync("");
    } catch (e) {
      if (/not_member/.test(e.message)) { lostMembership(); return; }
      setSync("offline");
    }
  }
  function setSync(t) { const el = $("#crew-sync"); if (el) el.textContent = t === "offline" ? "keine Verbindung" : ""; }

  // ---------- Position ----------
  function fix(f, speed) {
    myFix = f;
    if (speed !== null && speed !== undefined) mySpeed = speed;
    if (me && (settings.crewShare || alarmStatus || manualSos)) push(false);
  }
  function startShareWatch() {
    if (shareWatch !== null || !("geolocation" in navigator)) return;
    shareWatch = navigator.geolocation.watchPosition((p) => {
      const c = p.coords;
      const f = { lat: c.latitude, lon: c.longitude, t: p.timestamp, acc: c.accuracy };
      lastFix = f;
      const sp = typeof c.speed === "number" && !isNaN(c.speed) ? c.speed * 3.6 : null;
      fix(f, run.active ? run.speed : sp);
    }, () => {
      $("#crew-share-hint").textContent = "Standort nicht verfügbar – bitte Standortzugriff erlauben.";
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  function stopShareWatch() {
    if (shareWatch !== null) navigator.geolocation.clearWatch(shareWatch);
    shareWatch = null;
  }

  // ---------- Alarm-Brücke (aus app.js) ----------
  function setAlarm(st) {
    alarmStatus = st;
    if (!me) return;
    if (st && !shareWatch) startShareWatch();
    if (!st && !settings.crewShare) stopShareWatch();
    push(true);
  }

  // ---------- Abfrage ----------
  let lastPoll = 0;
  async function poll() {
    if (!me) return;
    // im Hintergrund seltener abfragen (Akku), aber nicht ganz aufhören
    if (document.visibilityState !== "visible" && Date.now() - lastPoll < 15000) return;
    lastPoll = Date.now();
    try {
      state = await rpc("crew_state", auth());
      setSync("");
      render();
      checkAlerts();
    } catch (e) {
      if (/not_member/.test(e.message)) lostMembership();
      else setSync("offline");
    }
  }
  function startPolling() {
    stopPolling();
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && me) { poll(); push(true); } });

  // ---------- Alarme anderer ----------
  function checkAlerts() {
    if (!state) return;
    const others = state.members.filter((m) => !m.me && (m.status === "alarm" || m.status === "sos"));
    // Erledigte Alarme vergessen
    for (const id of Object.keys(seenAlarm)) {
      const m = state.members.find((x) => x.id === id);
      if (!m || (m.status !== "alarm" && m.status !== "sos")) delete seenAlarm[id];
    }
    store.set("dh_crew_seen", seenAlarm);
    const fresh = others.find((m) => seenAlarm[m.id] !== m.status_at + m.status);
    if (fresh) showAlert(fresh);
    else if (showingAlert && !others.some((m) => m.id === showingAlert)) hideAlert();
  }
  function showAlert(m) {
    showingAlert = m.id;
    const sos = m.status === "sos";
    $("#ca-h").textContent = sos ? `SOS von ${m.name}` : `Möglicher Sturz bei ${m.name}`;
    const where = m.trail ? ` (${m.trail})` : "";
    const dist = myFix && m.lat !== null ? ` · ${de(haversine(myFix, m) / 1000, 1)} km entfernt` : "";
    $("#ca-p").textContent = (sos
      ? `${m.name} hat nicht reagiert oder Hilfe angefordert${where}. Fahr hin oder ruf Hilfe.`
      : `Das Handy von ${m.name} hat einen harten Aufprall erkannt${where}. Wenn ${m.name} nicht reagiert, kommt gleich ein SOS.`) + dist;
    const nav = $("#ca-nav");
    if (m.lat !== null) { nav.hidden = false; nav.href = `https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lon}&travelmode=walking`; }
    else nav.hidden = true;
    $("#crew-alert").hidden = false;
    $("#crew-alert").classList.toggle("alarm-flash", sos);
    unlockAudio(); beep();
    if (navigator.vibrate) navigator.vibrate(sos ? [600, 200, 600, 200, 600] : [400, 200, 400]);
  }
  function hideAlert() {
    showingAlert = null;
    $("#crew-alert").hidden = true;
    $("#crew-alert").classList.remove("alarm-flash");
  }
  $("#ca-ok").addEventListener("click", () => {
    const m = state && state.members.find((x) => x.id === showingAlert);
    if (m) seenAlarm[m.id] = m.status_at + m.status;
    store.set("dh_crew_seen", seenAlarm);
    hideAlert();
    checkAlerts();
  });

  // ---------- Darstellung ----------
  const STATUS = {
    riding: ["fährt", "#C6FF3D"], live: ["online", "#60A5FA"], alarm: ["möglicher Sturz", "#F59E0B"],
    sos: ["SOS", "#EF4444"], off: ["teilt nicht", "#6B7280"]
  };
  function ago(iso) {
    if (!state || !iso) return "";
    const s = Math.max(0, (new Date(state.now) - new Date(iso)) / 1000);
    return s < 60 ? "gerade eben" : s < 3600 ? `vor ${Math.round(s / 60)} Min.` : `vor ${Math.round(s / 3600)} Std.`;
  }
  function render() {
    const inCrew = !!me;
    $("#crew-none").hidden = inCrew;
    $("#crew-in").hidden = !inCrew;
    if (!inCrew) return;
    $("#crew-name").textContent = (state && state.crew) || me.crew;
    $("#crew-code").textContent = me.code;
    $("#crew-share").checked = !!settings.crewShare;
    $("#crew-sos-banner").hidden = !(manualSos || alarmStatus === "sos");
    $("#crew-sos").hidden = manualSos;
    if (!state) return;

    $("#crew-list").innerHTML = state.members.map((m) => {
      const [label, color] = STATUS[m.status] || STATUS.off;
      const bits = [label];
      if (m.status !== "off" && m.speed !== null && m.speed > 1) bits.push(`${m.speed} km/h`);
      if (m.trail && m.status !== "off") bits.push(m.trail);
      if (m.status !== "off") bits.push(ago(m.updated_at));
      const dist = !m.me && myFix && m.lat !== null ? de(haversine(myFix, m) / 1000, 1) + " km" : "";
      const nav = !m.me && m.lat !== null
        ? `<a class="nav-btn" href="https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lon}&travelmode=walking" target="_blank" rel="noopener" aria-label="Navigation zu ${esc(m.name)}">${dist || "Hin"}</a>` : "";
      return `<div class="member ${m.status === "sos" || m.status === "alarm" ? "warn-row" : ""}">
        <span class="avatar" style="background:${color}">${esc(m.name.slice(0, 2).toUpperCase())}</span>
        <span class="meta"><span class="name">${esc(m.name)}${m.me ? " (du)" : ""}</span><span class="lbl">${esc(bits.join(" · "))}</span></span>
        ${nav}</div>`;
    }).join("");

    renderMap();
  }

  function loadLeaflet() {
    return new Promise((resolve, reject) => {
      if (window.L) return resolve();
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      css.integrity = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="; css.crossOrigin = "";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      js.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="; js.crossOrigin = "";
      js.onload = resolve; js.onerror = reject;
      document.head.appendChild(js);
    });
  }
  async function renderMap() {
    const box = $("#crew-map");
    if (!box || $("#view-safety").classList.contains("active") === false) return;
    try { await loadLeaflet(); } catch (e) { box.innerHTML = '<p class="empty">Karte konnte nicht geladen werden (offline?).</p>'; return; }
    if (!map) {
      map = L.map(box, { zoomControl: true, attributionControl: true }).setView([47.3, 11.4], 6);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "© OpenStreetMap-Mitwirkende"
      }).addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 50);
    const pts = [];
    const ids = new Set();
    for (const m of state.members) {
      if (m.lat === null || m.lon === null) continue;
      ids.add(m.id);
      const [label, color] = STATUS[m.status] || STATUS.off;
      const ll = [m.lat, m.lon];
      pts.push(ll);
      const html = `<span class="pin" style="background:${color}">${esc(m.name.slice(0, 2).toUpperCase())}</span>`;
      const icon = L.divIcon({ className: "pin-wrap" + (m.status === "sos" ? " pin-sos" : ""), html, iconSize: [34, 34], iconAnchor: [17, 17] });
      if (!markers[m.id]) markers[m.id] = L.marker(ll, { icon, title: m.name }).addTo(map).bindTooltip("", { direction: "top", offset: [0, -16] });
      markers[m.id].setLatLng(ll).setIcon(icon);
      markers[m.id].setTooltipContent(`${esc(m.name)}${m.me ? " (du)" : ""} · ${label}`);
    }
    for (const id of Object.keys(markers)) if (!ids.has(id)) { map.removeLayer(markers[id]); delete markers[id]; }
    if (state.meet) {
      const ll = [state.meet.lat, state.meet.lon];
      pts.push(ll);
      const icon = L.divIcon({ className: "pin-wrap", html: '<span class="pin meet">T</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
      if (!meetMarker) meetMarker = L.marker(ll, { icon, title: "Treffpunkt" }).addTo(map).bindTooltip("Treffpunkt", { direction: "top", offset: [0, -14] });
      meetMarker.setLatLng(ll);
    } else if (meetMarker) { map.removeLayer(meetMarker); meetMarker = null; }
    if (!fitted && pts.length) {
      fitted = true;
      if (pts.length === 1) map.setView(pts[0], 15); else map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
    }
  }

  // ---------- Beitreten / Erstellen / Verlassen ----------
  function saveMe() { store.set("dh_crew", me); }
  function friendly(e) {
    const m = e.message || "";
    if (/crew_not_found/.test(m)) return "Diesen Crew-Code gibt es nicht. Bitte prüfen.";
    if (/crew_full/.test(m)) return "Die Crew ist voll (max. 30).";
    if (/rate_limited/.test(m)) return "Zu viele Versuche. Bitte warte etwas und probier es dann nochmal.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Keine Verbindung zum Server.";
    return "Das hat nicht geklappt: " + m;
  }
  async function enter(res) {
    me = { code: res.code, crew: res.crew, member: res.member, secret: res.secret, name: res.name };
    saveMe();
    fitted = false;
    $("#crew-err").textContent = "";
    render();
    startPolling();
    push(true);
  }
  $("#crew-join-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#join-code").value.trim().toUpperCase(), name = $("#join-name").value.trim();
    if (!code || !name) return;
    try { const r = await rpc("crew_join", { p_code: code, p_member_name: name }); r.name = name; await enter(r); history.replaceState(null, "", location.pathname); }
    catch (err) { $("#crew-err").textContent = friendly(err); }
  });
  $("#crew-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const crew = $("#create-crew").value.trim(), name = $("#create-name").value.trim();
    if (!crew || !name) return;
    try { const r = await rpc("crew_create", { p_crew_name: crew, p_member_name: name }); r.name = name; await enter(r); }
    catch (err) { $("#crew-err").textContent = friendly(err); }
  });
  function lostMembership() {
    me = null; state = null; saveMe(); stopPolling(); stopShareWatch();
    settings.crewShare = false; saveSettings();
    render();
    $("#crew-err").textContent = "Du bist nicht mehr in der Crew (vielleicht wurde sie gelöscht).";
  }
  $("#crew-leave").addEventListener("click", async () => {
    if (!confirm("Crew wirklich verlassen? Deine Position wird für die Crew gelöscht.")) return;
    try { await rpc("crew_leave", auth()); } catch (e) {}
    me = null; state = null; saveMe(); stopPolling(); stopShareWatch();
    settings.crewShare = false; saveSettings(); manualSos = false;
    for (const id of Object.keys(markers)) { map && map.removeLayer(markers[id]); delete markers[id]; }
    render();
  });
  $("#crew-invite").addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}?crew=${me.code}`;
    const text = `Fahr mit mir in der Crew „${me.crew}“ in Gravity. Code: ${me.code}`;
    try {
      if (navigator.share) await navigator.share({ title: "Gravity Crew", text, url: link });
      else { await navigator.clipboard.writeText(`${text}\n${link}`); alert("Einladungslink kopiert."); }
    } catch (e) {}
  });
  $("#crew-share").addEventListener("change", (e) => {
    settings.crewShare = e.target.checked; saveSettings();
    if (settings.crewShare) startShareWatch(); else if (!alarmStatus && !manualSos) stopShareWatch();
    push(true);
  });
  $("#crew-meet").addEventListener("click", async () => {
    const f = myFix || lastFix;
    const go = async (pos) => {
      try { await rpc("crew_meet", Object.assign(auth(), { p_lat: pos.lat, p_lon: pos.lon, p_note: null })); fitted = false; poll(); }
      catch (e) { alert(friendly(e)); }
    };
    if (f) return go(f);
    navigator.geolocation.getCurrentPosition((p) => go({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => alert("Standort nicht verfügbar."), { enableHighAccuracy: true, timeout: 15000 });
  });
  $("#crew-sos").addEventListener("click", () => {
    if (!confirm("SOS an deine Crew senden? Alle sehen deinen Standort und einen Alarm.")) return;
    manualSos = true; startShareWatch(); render(); push(true);
  });
  $("#crew-sos-off").addEventListener("click", () => {
    manualSos = false;
    if (alarmStatus === "sos") { alarmStatus = null; if (typeof stopAlarm === "function" && alarm.on) stopAlarm(); }
    if (!settings.crewShare) stopShareWatch();
    render(); push(true);
  });

  // ---------- Start ----------
  function onShow() { if (me) { fitted = false; render(); poll(); } }
  const params = new URLSearchParams(location.search);
  const invite = params.get("crew");
  if (invite) {
    $("#join-code").value = invite.toUpperCase().slice(0, 6);
    if (!me) setTimeout(() => { show("safety"); $("#join-name").focus(); }, 0);
  }
  render();
  if (me) { startPolling(); if (settings.crewShare) startShareWatch(); push(true); }

  return { fix, alarm: setAlarm, onShow, push, get me() { return me; } };
})();
