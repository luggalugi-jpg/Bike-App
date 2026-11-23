# Gravity – Downhill-App

Web-App (PWA) für Downhill-Fahrer. Läuft im Handy-Browser und lässt sich auf den Startbildschirm legen.

## Funktionen
- **Live:** Lauf per GPS aufzeichnen: Speed, Vmax, Zeit, Strecke, Tiefenmeter. Sprünge und Airtime erkennt die App über den Bewegungssensor.
- **Läufe:** Verlauf, Bestzeit pro Trail, Teilen.
- **Setup:** Fahrwerk-Werte für Gabel und Dämpfer, SAG-Rechner, Notizen.
- **Sicherheit:** Sturzerkennung (Aufprall + Stillstand) mit 30-s-Alarm. Danach öffnet sich eine vorbereitete SMS mit Standort an den Notfallkontakt.

Alle Daten bleiben lokal auf dem Gerät (localStorage).

## Veröffentlichen (GitHub Pages)
Settings → Pages → Source: „Deploy from a branch“ → Branch `main`, Ordner `/ (root)`.
Die App läuft dann unter https://luggalugi-jpg.github.io/Bike-App/. GPS und Sensoren gibt es nur über https.

## Neue Fassung
In `sw.js` die Kennung `CACHE` hochzählen und in `index.html` und `sw.js` die `?v=`-Nummern anpassen.
