"use strict";
// Gravity – Konto, Cloud-Sicherung und Ranglisten (Supabase, Frankfurt).
// Ablauf wie bei GainPilot: zuerst ein anonymes Konto (reicht für die Rangliste),
// optional später E-Mail + Passwort für Cloud-Sicherung und Anmeldung auf anderen Geräten.

window.Account = (() => {
  const SB_URL = "https://prynqxludruspngvhunc.supabase.co";
  const SB_KEY = "sb_publishable_mXDH94sAWPU2jLzZyGMflw_joBmcDrB";
  const SITE = location.origin + location.pathname;

  const K = Object.assign({ status: "keins", email: "", cloud: false, nick: "", ranked: false }, store.get("dh_konto", {}));
  // status: keins | anon | wartet | passwort | aktiv | abgemeldet
  const saveK = () => store.set("dh_konto", K);
  let Q = store.get("dh_q", []);          // Warteschlange für Uploads/Löschungen
  const saveQ = () => store.set("dh_q", Q);
  let RECOV = null;                        // Tokens aus einem Passwort-Link

  // ---------- Tokens ----------
  const tok = () => store.get("dh_sb", null);
  const tokSet = (t) => { if (t) store.set("dh_sb", t); else { try { localStorage.removeItem("dh_sb"); } catch (e) {} } };
  function remember(j, old) {
    const t = { at: j.access_token, rt: j.refresh_token, exp: j.expires_at || (Date.now() / 1000 + (j.expires_in || 3600)), uid: (j.user && j.user.id) || (old && old.uid) };
    tokSet(t); return t;
  }
  async function req(path, body, at, method, extra) {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000), m = method || "POST";
    try {
      return await fetch(SB_URL + path, {
        method: m, signal: ctl.signal,
        headers: Object.assign({ apikey: SB_KEY, "Content-Type": "application/json" }, at ? { Authorization: "Bearer " + at } : {}, extra || {}),
        ...(m === "GET" || m === "DELETE" ? {} : { body: JSON.stringify(body || {}) })
      });
    } finally { clearTimeout(to); }
  }
  async function js(r) { try { return await r.json(); } catch (e) { return {}; } }
  // gültiges Token holen; legt bei Bedarf ein anonymes Konto an
  async function auth(createAnon) {
    let t = tok();
    if (t && t.exp > Date.now() / 1000 + 60) return t;
    if (t && t.rt) {
      const r = await req("/auth/v1/token?grant_type=refresh_token", { refresh_token: t.rt });
      if (r.ok) return remember(await r.json(), t);
      if (r.status >= 500 || r.status === 429) throw new Error("server");
      if (K.status === "aktiv" || K.status === "passwort") { K.status = "abgemeldet"; saveK(); render(); throw new Error("abgemeldet"); }
    }
    if (!createAnon || K.status === "abgemeldet") throw new Error("kein_konto");
    const r = await req("/auth/v1/signup", { data: {} });
    if (!r.ok) throw new Error("signup " + r.status);
    const j = await r.json();
    if (K.status === "keins") { K.status = "anon"; saveK(); }
    return remember(j);
  }
  async function api(path, body, method, extra, createAnon) {
    const t = await auth(createAnon);
    let r = await req(path, body, t.at, method, extra);
    if (r.status === 401) { const x = tok(); if (x) { x.exp = 0; tokSet(x); } r = await req(path, body, (await auth(createAnon)).at, method, extra); }
    if (!r.ok) { const tx = await r.text().catch(() => ""); throw new Error(path + " " + r.status + " " + tx.slice(0, 160)); }
    const tx = await r.text();
    return tx ? JSON.parse(tx) : null;
  }
  const hasAccount = () => ["anon", "wartet", "passwort", "aktiv"].includes(K.status) && !!tok();
  const cloudOn = () => K.status === "aktiv" && K.cloud;

  function errText(j, st) {
    const c = (j && (j.error_code || j.code)) || "", m = (j && (j.msg || j.error_description || j.message)) || "";
    if (st === 429 || /rate_limit|rate limit|over_email_send_rate/i.test(c + m)) return "Gerade wurden zu viele E-Mails verschickt. Bitte versuch es später nochmal.";
    if (/email_exists|user_already_exists|already been registered/i.test(c + m)) return "Für diese E-Mail gibt es schon ein Konto. Melde dich stattdessen an.";
    if (/weak_password|password should/i.test(c + m)) return "Das Passwort ist zu schwach. Nimm mindestens 8 Zeichen.";
    if (/invalid_credentials|invalid login/i.test(c + m)) return "E-Mail oder Passwort stimmt nicht.";
    if (/email_not_confirmed/i.test(c + m)) return "Bitte bestätige zuerst deine E-Mail-Adresse über den Link in der E-Mail.";
    if (/email_address_invalid|invalid.*email|not authorized/i.test(c + m)) return "An diese E-Mail-Adresse kann gerade nichts gesendet werden. Prüfe die Adresse oder versuch eine andere.";
    if (/same_password/i.test(c + m)) return "Das neue Passwort muss sich vom alten unterscheiden.";
    return "Das hat nicht geklappt" + (m ? ": " + m : ".");
  }
  const mailOk = (m) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m || "");

  // ---------- Läufe hoch-/runterladen ----------
  function toRow(r, withTrack) {
    return {
      id: r.id, park: r.park || null, trail: r.tname || r.trail, trail_key: r.trail,
      started_at: new Date(r.start).toISOString(), dur_ms: Math.round(r.dur), dist_m: r.dist || 0,
      vmax: Math.round((r.vmax || 0) * 10) / 10, drop_m: r.drop || 0, air_s: Math.round((r.air || 0) * 10) / 10, jumps: r.jumps || 0,
      sectors: r.sectors || null, track: withTrack ? (r.track || null) : null
    };
  }
  function fromRow(x) {
    return {
      id: x.id, trail: x.trail_key, park: x.park || "", tname: x.trail || "", start: new Date(x.started_at).getTime(),
      dur: x.dur_ms, dist: x.dist_m || 0, vmax: x.vmax || 0, drop: x.drop_m || 0, air: x.air_s || 0, jumps: x.jumps || 0,
      sectors: x.sectors || null, track: x.track || null, synced: true
    };
  }
  const wantsUpload = (r) => cloudOn() || (K.ranked && r.park);
  function runSaved(r) {
    if (!wantsUpload(r)) return;
    Q.push({ op: "up", id: r.id }); saveQ(); flush();
  }
  function runDeleted(id) {
    if (!hasAccount()) return;
    Q = Q.filter((x) => x.id !== id); Q.push({ op: "del", id }); saveQ(); flush();
  }
  let flushing = null;
  function flush() { if (!flushing) flushing = doFlush().finally(() => { flushing = null; }); return flushing; }
  async function doFlush() {
    if (!navigator.onLine || !hasAccount()) return;
    while (Q.length) {
      const it = Q[0];
      try {
        if (it.op === "up") {
          const r = runs.find((x) => x.id === it.id);
          if (r && r.dur >= 5000) {
            await api("/rest/v1/runs?on_conflict=user_id,id", toRow(r, cloudOn()), "POST", { Prefer: "resolution=merge-duplicates,return=minimal" });
            r.synced = true; saveRuns();
          }
        } else if (it.op === "del") {
          await api("/rest/v1/runs?id=eq." + encodeURIComponent(it.id), null, "DELETE");
        } else if (it.op === "data") {
          await pushData();
        }
      } catch (e) {
        if (/ 4\d\d /.test(e.message) && !/ 401 | 429 /.test(e.message)) { /* dauerhaft fehlerhaft: verwerfen */ }
        else break;
      }
      Q.shift(); saveQ();
    }
  }
  window.addEventListener("online", () => flush());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { checkData(); flush(); } });

  // Einstellungen, Setup, Favoriten, eigene Strecken
  function localData() {
    const { favs, custom, sel, auto, crashOn, crashG, osm, osmAt } = settings;
    return { setup, prefs: { favs, custom, sel, auto, crashOn, crashG, osm, osmAt } };
  }
  async function pushData() {
    const d = localData();
    await api("/rest/v1/user_data?on_conflict=user_id", { setup: d.setup, prefs: d.prefs, updated_at: new Date().toISOString() }, "POST", { Prefer: "resolution=merge-duplicates,return=minimal" });
    store.set("dh_data_hash", JSON.stringify(d)); store.set("dh_data_at", Date.now());
  }
  function checkData() {
    if (!cloudOn()) return;
    const h = JSON.stringify(localData());
    if (h !== store.get("dh_data_hash", "")) { if (!Q.some((x) => x.op === "data")) { Q.push({ op: "data" }); saveQ(); } flush(); }
  }
  setInterval(checkData, 30000);

  async function pullAll(replaceData) {
    const rows = await api("/rest/v1/runs?select=*&order=started_at.desc&limit=2000", null, "GET");
    const have = new Set(runs.map((r) => r.id));
    let added = 0;
    for (const x of rows || []) if (!have.has(x.id)) { runs.push(fromRow(x)); added++; }
    runs.sort((a, b) => b.start - a.start); saveRuns();
    const d = await api("/rest/v1/user_data?select=*", null, "GET");
    if (d && d[0] && (replaceData || new Date(d[0].updated_at).getTime() > store.get("dh_data_at", 0))) {
      if (d[0].setup) { Object.assign(setup, d[0].setup); saveSetup(); }
      if (d[0].prefs) { Object.assign(settings, d[0].prefs); saveSettings(); }
      store.set("dh_data_hash", JSON.stringify(localData())); store.set("dh_data_at", Date.now());
      if (typeof renderSel === "function") renderSel();
      if (typeof setPart === "function") { $("#bike-name").value = setup.bike || ""; $("#setup-notes").value = setup.notes || ""; setPart("fork"); }
    }
    return added;
  }
  async function uploadAll() {
    for (const r of runs) if (!r.synced && wantsUpload(r)) Q.push({ op: "up", id: r.id });
    if (cloudOn()) Q.push({ op: "data" });
    saveQ(); await flush();
  }

  // ---------- Rangliste ----------
  async function openRanking(key) {
    $("#rank-h").textContent = key;
    $("#rank-body").innerHTML = '<p class="empty">Lade Rangliste …</p>';
    $("#rank").hidden = false;
    $("#rank-close").focus();
    let j;
    try {
      const t = hasAccount() ? await auth(false).catch(() => null) : null;
      const r = await req("/rest/v1/rpc/lb_trail", { p_trail_key: key }, t ? t.at : null);
      if (!r.ok) throw new Error(r.status);
      j = await r.json();
    } catch (e) {
      $("#rank-body").innerHTML = '<p class="empty">Rangliste gerade nicht erreichbar. Bitte später nochmal.</p>';
      return;
    }
    const rows = (j.top || []).map((x) => `<div class="lb-row ${x.me ? "me" : ""}"><span class="lb-pos">${x.pos}</span><span class="lb-nick">${esc(x.nick)}${x.me ? " (du)" : ""}</span><span class="lb-time">${fmtTime(x.dur_ms)}</span></div>`).join("");
    const mine = j.mine && !(j.top || []).some((x) => x.me)
      ? `<div class="lb-row me"><span class="lb-pos">${j.mine.pos}</span><span class="lb-nick">Du</span><span class="lb-time">${fmtTime(j.mine.dur_ms)}</span></div>` : "";
    const cta = K.ranked && K.nick
      ? `<p class="hint small">Du bist in der Rangliste als <b>${esc(K.nick)}</b>. Deine Bestzeiten werden automatisch eingetragen.</p>`
      : `<div class="card col gap8"><span class="strong">Mitmachen?</span><span class="hint small">Mit einem Spitznamen erscheinen deine Bestzeiten hier. Kein E-Mail nötig.</span><button id="rank-join" class="btn primary">Bei Ranglisten mitmachen</button></div>`;
    $("#rank-body").innerHTML = (rows || mine ? `<div class="lb">${rows}${mine}</div><p class="lbl">${j.total} ${j.total === 1 ? "Fahrer" : "Fahrer"} gesamt</p>` : '<p class="empty">Noch keine Zeiten auf dieser Strecke. Sei der Erste!</p>') + cta;
    const b = $("#rank-join");
    if (b) b.addEventListener("click", () => { $("#rank").hidden = true; openSheet("rank"); });
  }
  $("#rank-close").addEventListener("click", () => { $("#rank").hidden = true; });
  $("#rank").addEventListener("click", (e) => { if (e.target.id === "rank") $("#rank").hidden = true; });

  // ---------- Darstellung: Karte im Läufe-Tab ----------
  function render() {
    const box = $("#account-card");
    if (!box) return;
    let line, btn;
    if (K.status === "aktiv") { line = `Angemeldet als ${esc(K.email)} · Cloud-Sicherung ${K.cloud ? "an" : "aus"}`; btn = "Konto"; }
    else if (K.status === "wartet") { line = `Bitte bestätige deine E-Mail (${esc(K.email)}).`; btn = "Weiter"; }
    else if (K.status === "passwort") { line = "E-Mail bestätigt – leg noch ein Passwort fest."; btn = "Passwort"; }
    else if (K.status === "abgemeldet") { line = "Abgemeldet. Deine Läufe bleiben auf diesem Gerät."; btn = "Anmelden"; }
    else { line = "Sichere deine Läufe in der Cloud und tritt in Ranglisten an."; btn = "Konto"; }
    const rank = K.ranked && K.nick ? ` · Rangliste als ${esc(K.nick)}` : "";
    const pending = Q.length ? ` · ${Q.length} wartet auf Upload` : "";
    box.innerHTML = `<div class="card row between gap12"><span class="col"><span class="strong">Konto & Sicherung</span><span class="lbl">${line}${rank}${pending}</span></span><button id="acct-open" class="btn ghost">${btn}</button></div>`;
    $("#acct-open").addEventListener("click", () => openSheet());
  }

  // ---------- Konto-Sheet ----------
  const legal = 'Mit der Nutzung stimmst du den <a href="nutzungsbedingungen.html" target="_blank">Nutzungsbedingungen</a> zu. Infos: <a href="datenschutz.html" target="_blank">Datenschutz</a>.';
  function openSheet(view) {
    $("#acct").hidden = false;
    show2(view || (RECOV ? "newpw" : K.status === "wartet" ? "wait" : K.status === "passwort" ? "setpw" : K.status === "aktiv" ? "home" : K.status === "abgemeldet" ? "login" : "start"));
  }
  function closeSheet() { $("#acct").hidden = true; render(); }
  $("#acct-close").addEventListener("click", closeSheet);
  $("#acct").addEventListener("click", (e) => { if (e.target.id === "acct") closeSheet(); });
  const msg = (t, ok) => { const m = $("#k-msg"); if (m) { m.textContent = t; m.className = "hint small " + (ok ? "good" : "danger-text"); } };

  function show2(v) {
    const b = $("#acct-body");
    const V = {
      start: `<p class="hint">Mit einem Konto sind deine Läufe, Bestzeiten, Setup und Favoriten gesichert und auf jedem Gerät verfügbar.</p>
        <button data-go="create" class="btn primary">Konto erstellen</button>
        <button data-go="login" class="btn ghost">Ich habe schon ein Konto</button>
        <button data-go="rank" class="btn ghost">Nur Ranglisten (ohne E-Mail)</button>`,
      create: `<form id="k-form" class="col gap12">
        <label class="mini">E-Mail<input id="k-mail" type="email" autocomplete="email" required></label>
        <label class="check"><input id="k-ok" type="checkbox"> <span>Ich willige ein, dass meine Läufe (mit GPS-Spur), mein Setup und meine Einstellungen auf dem Server in Frankfurt gespeichert werden. Widerruf jederzeit durch Abschalten der Sicherung oder Löschen des Kontos. ${legal}</span></label>
        <button id="k-go" class="btn primary">Bestätigungs-E-Mail senden</button><p id="k-msg" class="hint small" role="alert"></p></form>`,
      wait: `<p class="hint">Wir haben dir eine E-Mail an <b>${esc(K.email)}</b> geschickt. Tippe auf den Link darin (auch im Spam-Ordner nachsehen) und komm dann hierher zurück.</p>
        <button id="k-check" class="btn primary">Ich habe bestätigt</button><button id="k-resend" class="btn ghost">E-Mail nochmal senden</button>
        <button data-go="cancel" class="more">Abbrechen</button><p id="k-msg" class="hint small" role="alert"></p>`,
      setpw: `<form id="k-form" class="col gap12"><p class="hint">Leg ein Passwort fest, damit du dich auf anderen Geräten anmelden kannst.</p>
        <label class="mini">Passwort (mind. 8 Zeichen)<input id="k-pw" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="mini">Passwort wiederholen<input id="k-pw2" type="password" autocomplete="new-password" minlength="8" required></label>
        <button id="k-go" class="btn primary">Passwort speichern</button><p id="k-msg" class="hint small" role="alert"></p></form>`,
      newpw: `<form id="k-form" class="col gap12"><p class="hint">Neues Passwort festlegen.</p>
        <label class="mini">Neues Passwort (mind. 8 Zeichen)<input id="k-pw" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="mini">Wiederholen<input id="k-pw2" type="password" autocomplete="new-password" minlength="8" required></label>
        <button id="k-go" class="btn primary">Speichern</button><p id="k-msg" class="hint small" role="alert"></p></form>`,
      login: `<form id="k-form" class="col gap12">
        <label class="mini">E-Mail<input id="k-mail" type="email" autocomplete="email" value="${esc(K.email || "")}" required></label>
        <label class="mini">Passwort<input id="k-pw" type="password" autocomplete="current-password" required></label>
        <button id="k-go" class="btn primary">Anmelden</button>
        <button type="button" id="k-forgot" class="more">Passwort vergessen?</button>
        <p id="k-msg" class="hint small" role="alert"></p></form>`,
      home: `<div class="col gap12">
        <div class="card row between gap12"><span class="col"><label for="k-cloud" class="strong">Cloud-Sicherung</label><span class="lbl">Läufe mit GPS-Spur, Setup, Favoriten</span></span><input id="k-cloud" type="checkbox" class="switch" ${K.cloud ? "checked" : ""}></div>
        <button id="k-sync" class="btn ghost">Jetzt synchronisieren</button>
        <button data-go="rank" class="btn ghost">Ranglisten-Profil</button>
        <button id="k-logout" class="btn ghost">Abmelden</button>
        <button id="k-delete" class="more danger-text">Konto löschen</button>
        <p id="k-msg" class="hint small" role="alert"></p></div>`,
      rank: `<form id="k-form" class="col gap12">
        <p class="hint">In Ranglisten erscheinen dein Spitzname und deine Bestzeit pro Strecke (nicht deine GPS-Spur). ${K.status === "aktiv" ? "" : "Dafür legt die App ein anonymes Konto an – ohne E-Mail."}</p>
        <label class="mini">Spitzname (2–24 Zeichen)<input id="k-nick" maxlength="24" minlength="2" value="${esc(K.nick || "")}" required></label>
        <label class="check"><input id="k-rank" type="checkbox" ${K.ranked ? "checked" : ""}> <span>Ich willige ein, dass mein Spitzname und meine Bestzeiten öffentlich in den Ranglisten angezeigt werden. Widerruf jederzeit durch Abwählen. ${legal}</span></label>
        <button id="k-go" class="btn primary">Speichern</button><p id="k-msg" class="hint small" role="alert"></p></form>`
    }[v];
    b.innerHTML = V;
    b.querySelectorAll("[data-go]").forEach((x) => x.addEventListener("click", () => {
      if (x.dataset.go === "cancel") { K.status = tok() ? "anon" : "keins"; saveK(); closeSheet(); return; }
      show2(x.dataset.go);
    }));
    const f = $("#k-form");
    if (f) f.addEventListener("submit", (e) => { e.preventDefault(); ({ create: doCreate, setpw: doSetPw, newpw: doSetPw, login: doLogin, rank: doRank })[v](); });
    if (v === "wait") { $("#k-check").addEventListener("click", () => doCheck(false)); $("#k-resend").addEventListener("click", doResend); }
    if (v === "login") $("#k-forgot").addEventListener("click", doForgot);
    if (v === "home") {
      $("#k-cloud").addEventListener("change", async (e) => {
        if (e.target.checked && !confirm("Cloud-Sicherung einschalten? Deine Läufe mit GPS-Spur, dein Setup und deine Favoriten werden auf dem Server in Frankfurt gespeichert.")) { e.target.checked = false; return; }
        K.cloud = e.target.checked; saveK();
        if (K.cloud) { msg("Sichere …", true); await uploadAll(); msg("Gesichert.", true); }
      });
      $("#k-sync").addEventListener("click", async () => { msg("Synchronisiere …", true); try { const n = await pullAll(false); await uploadAll(); msg(`Fertig. ${n} Läufe vom Server übernommen.`, true); renderRuns(); } catch (e) { msg("Keine Verbindung zum Server."); } });
      $("#k-logout").addEventListener("click", doLogout);
      $("#k-delete").addEventListener("click", doDelete);
    }
    const first = b.querySelector("input,button"); if (first) first.focus();
  }

  async function doCreate() {
    const em = ($("#k-mail").value || "").trim().toLowerCase(), go = $("#k-go");
    if (!mailOk(em)) return msg("Bitte gib eine gültige E-Mail-Adresse ein.");
    if (!$("#k-ok").checked) return msg("Bitte bestätige die Einwilligung.");
    go.disabled = true; go.textContent = "Wird gesendet …";
    try {
      const t = await auth(true);
      const r = await req("/auth/v1/user?redirect_to=" + encodeURIComponent(SITE), { email: em }, t.at, "PUT"), j = await js(r);
      if (!r.ok) { msg(errText(j, r.status)); go.disabled = false; go.textContent = "Bestätigungs-E-Mail senden"; return; }
      Object.assign(K, { status: "wartet", email: em, cloud: true }); saveK();
      show2("wait");
    } catch (e) { msg("Keine Verbindung zum Server."); go.disabled = false; go.textContent = "Bestätigungs-E-Mail senden"; }
  }
  async function doResend() {
    try {
      const t = await auth(false);
      const r = await req("/auth/v1/user?redirect_to=" + encodeURIComponent(SITE), { email: K.email }, t.at, "PUT"), j = await js(r);
      msg(r.ok ? "E-Mail wurde erneut gesendet." : errText(j, r.status), r.ok);
    } catch (e) { msg("Keine Verbindung zum Server."); }
  }
  async function doCheck(silent) {
    try {
      const t = await auth(false);
      const r = await req("/auth/v1/user", null, t.at, "GET"), u = await js(r);
      if (u.email && u.email_confirmed_at && !u.is_anonymous) {
        const x = tok(); if (x) { x.exp = 0; tokSet(x); } await auth(false);
        K.status = "passwort"; K.email = u.email; saveK(); render();
        if (!$("#acct").hidden || !silent) { $("#acct").hidden = false; show2("setpw"); }
        return true;
      }
      if (!silent) msg("Noch nicht bestätigt. Tippe auf den Link in der E-Mail (auch im Spam-Ordner nachsehen).");
    } catch (e) { if (!silent) msg("Keine Verbindung zum Server."); }
    return false;
  }
  async function doSetPw() {
    const a = $("#k-pw").value || "", b = $("#k-pw2").value || "", go = $("#k-go");
    if (a.length < 8) return msg("Das Passwort braucht mindestens 8 Zeichen.");
    if (a !== b) return msg("Die beiden Passwörter sind nicht gleich.");
    go.disabled = true;
    try {
      const at = RECOV ? RECOV.at : (await auth(false)).at;
      const r = await req("/auth/v1/user", { password: a }, at, "PUT"), j = await js(r);
      if (!r.ok) { msg(errText(j, r.status)); go.disabled = false; return; }
      const wasReset = !!RECOV;
      if (RECOV) { remember(RECOV.raw); K.email = j.email || K.email; RECOV = null; }
      K.status = "aktiv"; saveK();
      if (wasReset) await afterLogin(); else { K.cloud = true; saveK(); await uploadAll(); }
      closeSheet(); renderRuns();
    } catch (e) { msg("Keine Verbindung zum Server."); go.disabled = false; }
  }
  async function doLogin() {
    const em = ($("#k-mail").value || "").trim().toLowerCase(), pw = $("#k-pw").value || "", go = $("#k-go");
    if (!mailOk(em) || !pw) return msg("Bitte E-Mail und Passwort eingeben.");
    go.disabled = true; go.textContent = "Anmelden …";
    try {
      const r = await req("/auth/v1/token?grant_type=password", { email: em, password: pw }), j = await js(r);
      if (!r.ok) { msg(errText(j, r.status)); go.disabled = false; go.textContent = "Anmelden"; return; }
      const old = tok();
      // altes anonymes Konto dieses Geräts aufräumen
      if (old && old.uid && old.uid !== (j.user && j.user.id) && K.status === "anon") { try { await req("/rest/v1/rpc/me_delete", {}, old.at); } catch (e) {} }
      remember(j);
      Object.assign(K, { status: "aktiv", email: em, cloud: true }); saveK();
      await afterLogin();
      closeSheet(); renderRuns();
    } catch (e) { msg("Keine Verbindung zum Server."); go.disabled = false; go.textContent = "Anmelden"; }
  }
  async function afterLogin() {
    try {
      const p = await api("/rest/v1/profiles?select=nick,ranked", null, "GET");
      if (p && p[0]) { K.nick = p[0].nick || ""; K.ranked = !!p[0].ranked; saveK(); }
      await pullAll(true);
      await uploadAll();
    } catch (e) {}
  }
  async function doForgot() {
    const em = ($("#k-mail").value || "").trim().toLowerCase();
    if (!mailOk(em)) return msg("Gib oben deine E-Mail-Adresse ein, dann schicken wir dir einen Link.");
    try {
      const r = await req("/auth/v1/recover?redirect_to=" + encodeURIComponent(SITE), { email: em }), j = await js(r);
      msg(r.ok ? "Falls es ein Konto gibt, kommt gleich eine E-Mail mit einem Link zum Zurücksetzen." : errText(j, r.status), r.ok);
    } catch (e) { msg("Keine Verbindung zum Server."); }
  }
  async function doRank() {
    const nick = ($("#k-nick").value || "").trim(), on = $("#k-rank").checked, go = $("#k-go");
    if (on && (nick.length < 2 || nick.length > 24)) return msg("Der Spitzname braucht 2 bis 24 Zeichen.");
    go.disabled = true;
    try {
      const t = await auth(true);
      await api("/rest/v1/profiles?on_conflict=user_id", { user_id: t.uid, nick: nick || null, ranked: on, updated_at: new Date().toISOString() }, "POST", { Prefer: "resolution=merge-duplicates,return=minimal" }, true);
      K.nick = nick; K.ranked = on; saveK();
      if (on) await uploadAll();
      msg(on ? "Gespeichert. Deine Bestzeiten erscheinen jetzt in den Ranglisten." : "Gespeichert. Du erscheinst nicht mehr in Ranglisten.", true);
      render();
    } catch (e) {
      msg(/ 409 /.test(e.message) || /duplicate|unique/i.test(e.message) ? "Dieser Spitzname ist schon vergeben." : "Keine Verbindung zum Server.");
    }
    go.disabled = false;
  }
  async function doLogout() {
    if (!confirm("Abmelden? Deine Läufe bleiben auf diesem Gerät. Sicherung und Rangliste pausieren, bis du dich wieder anmeldest.")) return;
    try { await flush(); } catch (e) {}
    tokSet(null); Q = []; saveQ();
    Object.assign(K, { status: "abgemeldet", cloud: false, ranked: false, nick: "" }); saveK();
    closeSheet();
  }
  async function doDelete() {
    if (!confirm("Konto endgültig löschen? Konto, gesicherte Läufe und Ranglisten-Einträge werden auf dem Server gelöscht. Die Daten auf diesem Gerät bleiben.")) return;
    if (!confirm("Wirklich löschen? Das lässt sich nicht rückgängig machen.")) return;
    try { await api("/rest/v1/rpc/me_delete", {}, "POST"); }
    catch (e) { msg("Keine Verbindung zum Server. Bitte mit Internet nochmal versuchen."); return; }
    tokSet(null); Q = []; saveQ();
    runs.forEach((r) => { delete r.synced; }); saveRuns();
    Object.assign(K, { status: "keins", email: "", cloud: false, ranked: false, nick: "" }); saveK();
    closeSheet();
  }

  // ---------- Rückkehr über Links aus E-Mails ----------
  (function handleHash() {
    if (!location.hash || location.hash.length < 5) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const at = h.get("access_token"), type = h.get("type"), err = h.get("error_description");
    if (!at && !err) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (err) { setTimeout(() => { openSheet("start"); msg("Der Link ist ungültig oder abgelaufen: " + err); }, 0); return; }
    const raw = { access_token: at, refresh_token: h.get("refresh_token"), expires_in: +h.get("expires_in") || 3600 };
    if (type === "recovery") { RECOV = { at, raw }; setTimeout(() => openSheet("newpw"), 0); return; }
    // E-Mail bestätigt (Konto-Erstellung oder E-Mail-Wechsel)
    remember(raw, tok());
    setTimeout(async () => { const ok = await doCheck(true); if (!ok) { K.status = "passwort"; saveK(); openSheet("setpw"); } }, 0);
  })();

  // ---------- Start ----------
  render();
  if (K.status === "wartet") doCheck(true);
  if (hasAccount()) flush();

  return { runSaved, runDeleted, openRanking, render, flush, get state() { return K; } };
})();
