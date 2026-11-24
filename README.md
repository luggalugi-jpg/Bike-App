# Gravity – Downhill-App

Web-App (PWA) für Downhill-Fahrer. Läuft im Handy-Browser und lässt sich auf den Startbildschirm legen.

## Funktionen
- **Parks:** Bikeparks in Europa (EU, Schweiz, Andorra) mit ihren Strecken (Daten aus OpenStreetMap). Suche, Länderfilter, „In der Nähe“, Favoriten, eigene Strecken. Pro Park lassen sich die Strecken live aus OSM aktualisieren.
- **Live:** Strecke wählen und Lauf per GPS aufzeichnen (manuell oder Auto-Start/Stopp), mit Sektorzeiten gegen die Bestzeit: Speed, Vmax, Zeit, Strecke, Tiefenmeter. Sprünge und Airtime erkennt die App über den Bewegungssensor.
- **Läufe:** Verlauf mit gefahrener Linie auf der Karte, Bestzeit pro Trail, Ranglisten pro Strecke, Teilen.
- **Konto (freiwillig):** anonymes Konto für Ranglisten oder E-Mail + Passwort für Cloud-Sicherung (Läufe, Setup, Favoriten).
- **Setup:** Fork/Shock-Werte (Air Pressure, Rebound, LSC, HSC, Volume Spacers), Sag Calculator, Tire Pressure, Notes.
- **Crew:** Crew erstellen oder per Code/Link beitreten, Live-Karte aller Mitglieder, „Live teilen“, Treffpunkt, SOS an die Crew. Erkennt ein Handy einen Sturz, bekommen die anderen sofort einen Alarm mit Navigation. Server: Supabase-Projekt „Bike-App“ (Frankfurt); Zugriff nur über abgesicherte Funktionen (siehe `crew.js`).
- **Sicherheit:** Sturzerkennung (Aufprall + Stillstand) mit 30-s-Alarm. Danach öffnet sich eine vorbereitete SMS mit Standort an den Notfallkontakt.

Streckendaten: © OpenStreetMap-Mitwirkende, ODbL. Die Liste der Parks steht in `parks.js`.

Alle eigenen Daten bleiben lokal auf dem Gerät (localStorage).

## Veröffentlichen (GitHub Pages)
Settings → Pages → Source: „Deploy from a branch“ → Branch `main`, Ordner `/ (root)`.
Die App läuft dann unter https://luggalugi-jpg.github.io/Bike-App/. GPS und Sensoren gibt es nur über https.

## Neue Fassung
In `sw.js` die Kennung `CACHE` hochzählen und in `index.html` und `sw.js` die `?v=`-Nummern anpassen.

## Rechtliches
`impressum.html`, `datenschutz.html`, `nutzungsbedingungen.html` – vor dem Store-Start anwaltlich prüfen lassen.

## Server (Supabase „Bike-App“)
Tabellen `crews`, `crew_members`, `profiles`, `runs`, `user_data`, `rate_limits`. Crew nur über RPC-Funktionen mit Mitgliedsschlüssel, Konto-Daten per RLS nur für den Besitzer, Rangliste über `lb_trail`, Missbrauchsbremse über `_rl`.
