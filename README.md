# Die Jagd – GPS-Geländespiel

Manhunt (mit Punkten und Power-ups) und Flaggenraub (Capture the Flag) im echten Gelände, gespielt mit dem Handy-Browser. Keine App-Installation nötig: Link öffnen, Namen eingeben, Code eintippen.

## Spielmodi

### Manhunt (Runner gegen Hunter)
- **Ping** (Standard alle 2 Min.): Hunter sehen, wo die Runner sind, und Runner sehen, wo die Hunter sind. Die Positionen bleiben gestrichelt stehen, bis der nächste Ping kommt. Wer die Zone verlässt, ist für alle live sichtbar.
- **Gefangene Runner werden Hunter** (abschaltbar).
- **Startzonen der Hunter**: Man kann mehrere Startzonen zeichnen (z.B. Busbahnhof und Bahnhof). Jeder Hunter muss in eine davon. Fangen darf er erst, wenn er dort war *und* der Vorsprung (Standard 10 Min.) vorbei ist.
- **Aufträge**: Ab Ende des Vorsprungs bekommt jeder Runner alle 20 Minuten zufällig einen der gezeichneten Auftragsorte (📍). Er hat bis zum nächsten Auftrag Zeit, dorthin zu gehen (20 m Umkreis). Schafft er es nicht, wird er Hunter. Ist er nach 10 Minuten noch nicht dort, sehen die Hunter den Ort auf der Karte (aber nicht, wem er gehört).
- **Kompass** für Runner: ein Pfeil in Richtung des nächsten Hunters, ohne Distanz. Mit «🧭 ausrichten» dreht er sich mit dem Handy.
- **Verbergen (1× pro Spiel)**: Runner können vor einem Ping «🙈 Verbergen» tippen und erscheinen dann beim nächsten Ping nicht.
- **Radar (alle 20 Min.)**: Runner sehen alle Hunter 60 Sekunden live. Danach bleiben die letzten Positionen bis zum nächsten Ping stehen.
- **Warnung** an beide, wenn sich Runner und Hunter näher als 50 m kommen.
- **Zone verlassen**: Nur die betroffene Person bekommt ein Popup mit 3 Sekunden Sirene und Countdown. Nach 30 Sekunden ist ein Runner raus.
- **Fang bestätigen**: Der Hunter berührt den Runner und tippt auf «Fangen». Ist der Runner laut GPS in Reichweite, erscheint bei ihm «Gefangen? Ja / Nein». Antwortet er nicht innert 30 Sekunden, zählt der Fang. Abschaltbar.
- **Auslosen**: Die Spielleitung legt fest, wie viele Runner es gibt; wer Runner wird, entscheidet der Zufall.
- **Runner sammeln keine Punkte.** Punkte und der Power-up-Shop gibt es nur für Hunter.

**Punkte für Hunter**: pro 100 m zurückgelegter Weg (nur zu Fuss/Velo, bis 8 m/s), pro Fang und an jedem ⚡-Power-up-Ort (einstellbar, Standard 10).

**Auswertung**: Am Spielende zeigt die App eine Rangliste nach **gesammelten Punkten** – also allen Punkten, die jemand verdient hat, auch wenn er einen Teil davon für Power-ups ausgegeben hat. Im Download stehen zusätzlich die ausgegebenen und die übrigen Punkte. Mit «⬇ Auswertung herunterladen» gibt es eine CSV-Datei (öffnet sich in Excel) mit allen Punkten, erfüllten Aufträgen, Radar/Verbergen, Laufen, Fängen, Power-up-Orten, ausgegebenen Punkten und wer wann von wem gefangen wurde. Am Handy öffnet sich direkt das Teilen-Menü (z.B. für WhatsApp).

**Strecken**: Während des Spiels zeichnet der Server auf, wo alle gelaufen sind. Nach Spielende zeigt «🗺 Strecken ansehen» alle Wege farbig auf der Karte; einzelne Personen lassen sich ein- und ausblenden. Die Länge steht auch in der Auswertung.

**Power-ups für Hunter (⚡)**
| Für | Power-up | Kosten | Wirkung |
|---|---|---|---|
| Hunter | Extra-Ping | 30 | Deckt sofort alle Runner auf |
| Hunter | Spürnase | 35 | Nächsten Runner 45 s live sehen |

Hunter bekommen an den ⚡-Orten auf der Karte ein Power-up gratis plus Punkte (danach 5 Min. Pause pro Ort; mit vollem Rucksack von 3 Power-ups gibt es nur die Punkte).

### Flaggenraub (Capture the Flag)
Rot gegen Blau. Gegnerische Flagge holen und in die eigene Basis bringen. Abgeschlagene müssen zurück in die eigene Basis.

### Einstellungen mit Passwort
Modus, Karte und Regeln liegen im Reiter **Einstellungen** und sind mit dem Passwort **9655** gesperrt. Ändern lässt es sich auf Render unter *Environment* mit der Variable `ADMIN_PASSWORD`.

### Spieleinstellungen speichern
Im Reiter Einstellungen lassen sich alle Regeln (Zeiten, Distanzen, Punkte, Schalter) zusammen mit dem Spielmodus unter einem Namen speichern und später mit einem Tipp laden – unabhängig von der Karte. Gespeichert wird auf dem Gerät der Spielleitung.

### Karte zeichnen und speichern
Im Reiter Einstellungen zeichnet man Spielzone, Startzonen, Auftragsorte und Power-up-Orte frei auf der Karte (Eckpunkte antippen, dann «Fertig»). Fertige Karten lassen sich unter einem Namen speichern und später mit einem Tipp laden. Gespeichert wird auf dem Gerät der Spielleitung.

## Datenverbrauch
Der Server schickt alle 2 Sekunden komprimierte Updates. Gemessen: etwa 3 MB pro Stunde bei 20 Spielern und 60 MB pro Stunde bei 100 Spielern. Mit echten Daten rechne mit dem Zwei- bis Dreifachen. Der Render-Gratisplan hat 5 GB pro Monat.

## Online stellen (gratis, mit Render)

GPS funktioniert auf Handys nur über **https**. Render liefert das automatisch.

1. Konto auf [github.com](https://github.com) erstellen, neues Repository anlegen und den Inhalt dieses Ordners hochladen (ohne `node_modules`).
2. Konto auf [render.com](https://render.com) erstellen → **New → Web Service** → das GitHub-Repository wählen.
3. Einstellungen:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. Nach ein paar Minuten bekommst du eine Adresse wie `https://jagd-xyz.onrender.com`. Diese an alle schicken.

Hinweis zum Gratis-Plan: Der Server schläft nach ca. 15 Minuten ohne Besucher ein und braucht beim ersten Aufruf rund eine Minute zum Aufwachen. Öffne die Seite also kurz vor dem Spiel. Laufende Spiele liegen nur im Arbeitsspeicher; ein Neustart des Servers beendet sie.

## Lokal ausprobieren

```bash
npm install
npm start
```

Dann `http://localhost:3000/?test` im Browser öffnen. Mit `?test` (oder dem Häkchen «Testmodus») setzt ein Klick auf die Karte deine Position. Mehrere Browserfenster (z.B. ein privates Fenster) = mehrere Spieler.

## Später auf dem Raspberry Pi

1. Node.js installieren: `sudo apt install nodejs npm`
2. Ordner auf den Pi kopieren, darin `npm install` und `npm start`.
3. Damit Handys GPS freigeben, braucht es **https**. Am einfachsten mit einem Cloudflare Tunnel (`cloudflared`), der dem Pi eine https-Adresse gibt, ohne dass du am Router etwas öffnen musst.
4. Dauerhaft laufen lassen, z.B. mit `pm2` (`npm i -g pm2`, dann `pm2 start server.js --name jagd` und `pm2 startup`).

Grenze pro Spiel: 150 Spieler.

## Tipps fürs Spiel

- Bildschirm an lassen: Die App versucht den Bildschirm wach zu halten. Wenn das Handy sperrt, kommen keine Positionen mehr an.
- GPS ist im Wald oft auf 10–20 m ungenau. Darum ist die Fangdistanz grosszügig; bei Bedarf in den Regeln erhöhen.
- Wer die Seite neu lädt, landet automatisch wieder im gleichen Spiel.
