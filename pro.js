"use strict";
// Gravity – Pro (Abo). Grundgerüst: Während der Beta sind alle Pro-Funktionen frei.
// Sicherheitsfunktionen (Sturzerkennung, Crew, Alarm, SOS) sind bewusst NIE Teil von Pro.
// Später: In der Android-App kauft man über Google Play (RevenueCat), Pro.setEntitled() schaltet frei.

window.Pro = (() => {
  const BETA = true; // vor dem Start des Abos auf false setzen
  const FEATURES = {
    sectors: { name: "Sektorzeiten", text: "Live-Vergleich mit deiner Bestzeit in drei Abschnitten." },
    heat: { name: "Speed-Linie", text: "Deine gefahrene Linie nach Tempo eingefärbt – sieh, wo du Zeit liegen lässt." },
    gpx: { name: "GPX-Export", text: "Läufe als GPX-Datei für Strava, Komoot & Co." },
    compare: { name: "Mehr kommt", text: "Lauf-Vergleich, Ghost-Modus und Saison-Statistiken sind in Arbeit." }
  };
  // Preise sind Vorschläge – endgültig festgelegt in der Google Play Console.
  const PLANS = [
    { id: "year", name: "Jährlich", price: "19,99 €", note: "≈ 1,67 € im Monat" },
    { id: "month", name: "Monatlich", price: "2,99 €", note: "monatlich kündbar" }
  ];

  let ent = store.get("dh_pro", null); // { until: ms, plan }
  const entitled = () => !!(ent && ent.until > Date.now());
  const has = () => BETA || entitled();

  function setEntitled(until, plan) {
    ent = until ? { until, plan } : null;
    store.set("dh_pro", ent);
    render();
  }

  const tag = () => `<span class="pro-tag">PRO</span>`;

  function sheet(focus) {
    const f = FEATURES[focus];
    const state = entitled()
      ? `<div class="card col gap6"><span class="strong">Pro ist aktiv</span><span class="hint small">bis ${new Date(ent.until).toLocaleDateString("de-DE")}</span></div>`
      : BETA
        ? `<div class="best-card"><span class="lbl">Beta</span><span class="strong">Alle Pro-Funktionen sind während der Beta kostenlos.</span></div>`
        : "";
    $("#pro-body").innerHTML = `
      ${f ? `<p class="hint">${f.name} gehört zu Gravity Pro.</p>` : ""}
      ${state}
      <div class="col gap8">${Object.values(FEATURES).map((x) =>
        `<div class="row gap8 pro-feat"><span class="pro-dot" aria-hidden="true"></span><div class="col"><span class="strong">${x.name}</span><span class="hint small">${x.text}</span></div></div>`).join("")}</div>
      <div class="col gap8">${PLANS.map((p) =>
        `<button class="btn ${p.id === "year" ? "primary" : ""} pro-plan" data-plan="${p.id}" ${BETA ? "disabled" : ""}>
          <span>${p.name} · ${p.price}</span><span class="small">${p.note}</span></button>`).join("")}
        <p class="hint small">${BETA ? "Kaufen ist erst nach der Beta möglich – in der Android-App über Google Play." : "Abo über Google Play, jederzeit in Google Play kündbar."}</p>
      </div>
      <div class="card col gap6"><span class="strong">Immer kostenlos</span><span class="hint small">Sturzerkennung, Crew mit Live-Karte, Alarm und SOS, Aufzeichnung, Bestzeiten, Ranglisten und Fahrwerk-Setup. Sicherheit verkaufen wir nicht.</span></div>`;
    $("#pro").hidden = false;
    $("#pro-close").focus();
  }

  function open(feature) { sheet(feature); }

  // Karte im Tab „Läufe“
  function render() {
    const box = $("#pro-card");
    if (!box) return;
    box.innerHTML = `<button class="card row between pro-card" id="pro-open">
      <span class="col"><span class="strong">Gravity Pro ${tag()}</span>
      <span class="hint small">${entitled() ? "Aktiv – danke für deine Unterstützung!" : BETA ? "Beta: alle Pro-Funktionen gratis" : "Sektorzeiten, Speed-Linie, GPX-Export"}</span></span>
      <span aria-hidden="true">›</span></button>`;
    $("#pro-open").addEventListener("click", () => open());
  }

  // Lauf als GPX
  function gpx(r) {
    if (!r.track || r.track.length < 2) { alert("Dieser Lauf hat keine GPS-Spur."); return; }
    if (!has()) { open("gpx"); return; }
    const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const pts = r.track.map((p) => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"><time>${new Date(r.start + p[2] * 1000).toISOString()}</time></trkpt>`).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Gravity" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${esc(r.trail)}</name><type>mountain_biking</type><trkseg>
${pts}
</trkseg></trk></gpx>`;
    const name = `gravity-${(r.tname || r.trail).replace(/[^\wäöüÄÖÜß-]+/g, "-").slice(0, 40)}-${new Date(r.start).toISOString().slice(0, 10)}.gpx`;
    const file = new File([xml], name, { type: "application/gpx+xml" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: r.trail }).catch(() => {});
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }

  $("#pro-close").addEventListener("click", () => { $("#pro").hidden = true; });
  $("#pro").addEventListener("click", (e) => { if (e.target.id === "pro") $("#pro").hidden = true; });
  render();

  return { has, open, tag, gpx, setEntitled, get beta() { return BETA; }, get entitled() { return entitled(); } };
})();
