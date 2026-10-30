// Passt das von Capacitor erzeugte Android-Projekt an:
// Versionsnummer, Text und Symbol der Mitteilung «Die Jagd läuft».
import fs from 'fs';

const run = parseInt(process.argv[2] || '1', 10);
const A = 'android/app';

// Versionsnummer: jeder Bau ist höher, damit die App sich als Update installieren lässt
const gradle = `${A}/build.gradle`;
let g = fs.readFileSync(gradle, 'utf8');
g = g.replace(/versionCode \d+/, `versionCode ${run}`).replace(/versionName "[^"]*"/, `versionName "1.${run}"`);
fs.writeFileSync(gradle, g);

// Texte und Farbe der Hintergrund-Mitteilung
const strings = `${A}/src/main/res/values/strings.xml`;
let s = fs.readFileSync(strings, 'utf8');
const add = `
    <string name="capacitor_background_geolocation_notification_channel_name">Spielposition</string>
    <string name="capacitor_background_geolocation_notification_icon">drawable/ic_stat_jagd</string>
    <string name="capacitor_background_geolocation_notification_color">#ff7a2f</string>
`;
if (!s.includes('capacitor_background_geolocation')) s = s.replace('</resources>', add + '</resources>');
fs.writeFileSync(strings, s);

// Symbol für die Mitteilung (Vektor, weiss auf transparent – so verlangt es Android)
fs.mkdirSync(`${A}/src/main/res/drawable`, { recursive: true });
fs.writeFileSync(`${A}/src/main/res/drawable/ic_stat_jagd.xml`, `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="M12,4a8,8 0,1 1,0 16a8,8 0,1 1,0 -16zM12,6a6,6 0,1 0,0 12a6,6 0,1 0,0 -12z"/>
  <path android:fillColor="#FFFFFFFF" android:pathData="M12,9.5a2.5,2.5 0,1 1,0 5a2.5,2.5 0,1 1,0 -5z"/>
  <path android:fillColor="#FFFFFFFF" android:pathData="M11,1h2v4h-2zM11,19h2v4h-2zM1,11h4v2h-4zM19,11h4v2h-4z"/>
</vector>
`);

console.log(`Android-Projekt angepasst (Version 1.${run}).`);
