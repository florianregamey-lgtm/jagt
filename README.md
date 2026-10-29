# Die Jagd – GPS-Geländespiel

Manhunt, Zombie und Flaggenraub (Capture the Flag) im echten Gelände, gespielt mit dem Handy-Browser. Keine App-Installation nötig: Link öffnen, Namen eingeben, Code eintippen.

## Spielmodi

| Modus | So geht's |
|---|---|
| **Manhunt** | Jäger sehen die Gejagten nur bei jedem Ping (z.B. alle 90 s). Wer die Zone verlässt, ist für alle live sichtbar. |
| **Zombie** | Wie Manhunt, aber wer gefangen wird, jagt ab sofort mit. |
| **Flaggenraub** | Rot gegen Blau. Gegnerische Flagge holen (in deren Basis laufen) und in die eigene Basis bringen. Abgeschlagene müssen zurück in die eigene Basis. Flaggenträger sind immer sichtbar. |
| **Schrumpfende Zone** | In jedem Modus einschaltbar: das Spielfeld wird bis zum Schluss kleiner. |

Fangen: Der Jäger tippt auf **Fangen**. Der Server prüft mit den echten GPS-Positionen, ob wirklich jemand innerhalb der Fangdistanz ist (Standard 12 m). Gejagte können sich auch selbst als gefangen melden, und die Spielleitung kann Fänge von Hand eintragen.

Die Rolle **Leitung** spielt nicht mit und sieht alle live – ideal für die Jungschar-Leitung.

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

Der Server schafft locker 100+ Spieler gleichzeitig (Grenze pro Spiel: 150).

## Tipps fürs Spiel

- Bildschirm an lassen: Die App versucht den Bildschirm wach zu halten. Wenn das Handy sperrt, kommen keine Positionen mehr an.
- GPS ist im Wald oft auf 10–20 m ungenau. Darum ist die Fangdistanz grosszügig; bei Bedarf in den Regeln erhöhen.
- Wer die Seite neu lädt, landet automatisch wieder im gleichen Spiel.
