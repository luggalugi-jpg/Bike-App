# Gravity – Downhill-App

Web-App (PWA) für Downhill-Fahrer. Läuft im Handy-Browser und lässt sich auf den Startbildschirm legen.

## Funktionen
- **Parks:** Bikeparks in der EU mit ihren Strecken (Daten aus OpenStreetMap). Suche, Länderfilter, „In der Nähe“, Favoriten, eigene Strecken. Pro Park lassen sich die Strecken live aus OSM aktualisieren.
- **Live:** Strecke wählen und Lauf per GPS aufzeichnen: Speed, Vmax, Zeit, Strecke, Tiefenmeter. Sprünge und Airtime erkennt die App über den Bewegungssensor.
- **Läufe:** Verlauf, Bestzeit pro Trail, Teilen.
- **Setup:** Fork/Shock-Werte (Air Pressure, Rebound, LSC, HSC, Volume Spacers), Sag Calculator, Tire Pressure, Notes.
- **Sicherheit:** Sturzerkennung (Aufprall + Stillstand) mit 30-s-Alarm. Danach öffnet sich eine vorbereitete SMS mit Standort an den Notfallkontakt.

Streckendaten: © OpenStreetMap-Mitwirkende, ODbL. Die Liste der Parks steht in `parks.js`.

Alle eigenen Daten bleiben lokal auf dem Gerät (localStorage).

## Veröffentlichen (GitHub Pages)
Settings → Pages → Source: „Deploy from a branch“ → Branch `main`, Ordner `/ (root)`.
Die App läuft dann unter https://luggalugi-jpg.github.io/Bike-App/. GPS und Sensoren gibt es nur über https.

## Neue Fassung
In `sw.js` die Kennung `CACHE` hochzählen und in `index.html` und `sw.js` die `?v=`-Nummern anpassen.
