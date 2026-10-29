# Die Jagd – GPS-Geländespiel

Manhunt (mit Punkten und Power-ups) und Flaggenraub (Capture the Flag) im echten Gelände, gespielt mit dem Handy-Browser. Keine App-Installation nötig: Link öffnen, Namen eingeben, Code eintippen.

## Spielmodi

### Manhunt (Runner gegen Hunter)
- **Hunter** sehen die Runner nur bei jedem Ping. Wer die Zone verlässt, ist für alle live sichtbar.
- **Gefangene Runner werden Hunter** (abschaltbar).
- **Startzone der Hunter**: Zu Beginn jeder Runde müssen alle Hunter in die vorher gezeichnete Startzone (z.B. Busbahnhof). Fangen dürfen sie erst, wenn sie dort waren *und* der Vorsprung (Standard 10 Min.) vorbei ist.
- **Kompass** für Runner: die 10 nächsten Hunter mit Richtung und Distanz. Mit 🧭 richten sich die Pfeile nach dem Handy aus.
- **Warnung** an beide, wenn sich Runner und Hunter näher als 50 m kommen.
- **Zone verlassen**: Nur die betroffene Person bekommt ein Popup mit 3 Sekunden Sirene und Countdown. Nach 30 Sekunden ist ein Runner raus.
- **Auslosen**: Die Spielleitung legt fest, wie viele Runner es gibt; wer Runner wird, entscheidet der Zufall.

**Punkte für Runner**
- Risikozonen (rot): Punkte pro Minute, solange man drin ist.
- Zwei Pings nacheinander im Umkreis von 20 m: Bonus.
- Foto eines Hunters (📷): zählt, wenn ein Hunter im Umkreis von 100 m ist. Die Spielleitung kann Fotos prüfen und ablehnen.

**Punkte für Hunter**: pro 100 m zurückgelegter Weg (nur zu Fuss/Velo, bis 8 m/s) und pro Fang.

**Power-ups (⚡)**
| Für | Power-up | Kosten | Wirkung |
|---|---|---|---|
| Runner | Tarnkappe | 40 | Beim nächsten Ping unsichtbar |
| Runner | Falsche Fährte | 30 | Beim nächsten Ping 150–250 m daneben |
| Runner | Radar | 25 | Alle Hunter 60 s live sehen |
| Hunter | Extra-Ping | 30 | Deckt sofort alle Runner auf |
| Hunter | Spürnase | 35 | Nächsten Runner 45 s live sehen |

Hunter bekommen an den ⚡-Orten auf der Karte ein Power-up gratis (danach 5 Min. Pause pro Ort).

### Flaggenraub (Capture the Flag)
Rot gegen Blau. Gegnerische Flagge holen und in die eigene Basis bringen. Abgeschlagene müssen zurück in die eigene Basis.

### Einstellungen mit Passwort
Modus, Karte und Regeln liegen im Reiter **Einstellungen** und sind mit dem Passwort **9655** gesperrt. Ändern lässt es sich auf Render unter *Environment* mit der Variable `ADMIN_PASSWORD`.

### Karte zeichnen und speichern
Im Reiter Einstellungen zeichnet man Spielzone, Startzone, Risikozonen und Power-up-Orte frei auf der Karte (Eckpunkte antippen, dann «Fertig»). Fertige Karten lassen sich unter einem Namen speichern und später mit einem Tipp laden. Gespeichert wird auf dem Gerät der Spielleitung.

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
