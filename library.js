// Bibliothek für gespeicherte Karten und Spieleinstellungen.
//
// Zwei Speicherorte, je nachdem was eingerichtet ist:
//  1. Firebase Firestore – wenn die Umgebungsvariable FIREBASE_SERVICE_ACCOUNT gesetzt ist
//     (Inhalt der heruntergeladenen JSON-Schlüsseldatei). Ideal für Render, das selbst nichts speichern kann.
//  2. Datei – wenn LIB_FILE gesetzt ist (z.B. ./data/bibliothek.json). Ideal für den Raspberry Pi.
// Ist beides nicht gesetzt, gibt es keine Online-Bibliothek; die App speichert dann nur auf dem Gerät.
//
// Firestore wird direkt über die REST-Schnittstelle angesprochen (kein zusätzliches Paket nötig).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KINDS = { map: 'jagd_karten', set: 'jagd_einstellungen' };
const docId = name => encodeURIComponent(name).replace(/\./g, '%2E').replace(/%/g, '_');

// ---------- Firestore ----------
function firestoreStore(sa) {
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
  let token = null, tokenUntil = 0;
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

  async function auth() {
    if (token && Date.now() < tokenUntil - 60000) return token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), sa.private_key).toString('base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Firebase-Anmeldung fehlgeschlagen: ' + (j.error_description || j.error || r.status));
    token = j.access_token; tokenUntil = Date.now() + (j.expires_in || 3600) * 1000;
    return token;
  }
  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + await auth(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    if (r.status === 404) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Firebase: ' + ((j.error && j.error.message) || r.status));
    return j;
  }
  const fromDoc = d => d && d.fields ? { name: d.fields.name?.stringValue || '', mode: d.fields.mode?.stringValue || '',
    saved: Number(d.fields.saved?.integerValue || 0), data: JSON.parse(d.fields.data?.stringValue || 'null') } : null;

  return {
    kind: 'firebase',
    async list(kind) {
      const out = []; let page = '';
      do {
        const j = await call('GET', `${base}/${KINDS[kind]}?pageSize=300${page ? '&pageToken=' + page : ''}`);
        for (const d of (j && j.documents) || []) { const x = fromDoc(d); if (x) out.push({ name: x.name, mode: x.mode, saved: x.saved }); }
        page = j && j.nextPageToken;
      } while (page);
      return out;
    },
    async get(kind, name) { return fromDoc(await call('GET', `${base}/${KINDS[kind]}/${docId(name)}`)); },
    async set(kind, name, rec) {
      await call('PATCH', `${base}/${KINDS[kind]}/${docId(name)}`, { fields: {
        name: { stringValue: name }, mode: { stringValue: rec.mode || '' },
        saved: { integerValue: String(Date.now()) }, data: { stringValue: JSON.stringify(rec.data) } } });
    },
    async del(kind, name) { await call('DELETE', `${base}/${KINDS[kind]}/${docId(name)}`); },
  };
}

// ---------- Datei ----------
function fileStore(file) {
  let db = { map: {}, set: {} };
  try { db = { map: {}, set: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); };
  return {
    kind: 'file',
    async list(kind) { return Object.values(db[kind]).map(({ name, mode, saved }) => ({ name, mode, saved })); },
    async get(kind, name) { return db[kind][name] || null; },
    async set(kind, name, rec) { db[kind][name] = { name, mode: rec.mode || '', saved: Date.now(), data: rec.data }; save(); },
    async del(kind, name) { delete db[kind][name]; save(); },
  };
}

function createLibrary() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      if (!sa.project_id || !sa.private_key || !sa.client_email) throw new Error('Schlüssel unvollständig');
      console.log(`Bibliothek: Firebase-Projekt ${sa.project_id}`);
      return firestoreStore(sa);
    } catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT ist ungültig:', e.message); }
  }
  if (process.env.LIB_FILE) { console.log(`Bibliothek: Datei ${process.env.LIB_FILE}`); return fileStore(process.env.LIB_FILE); }
  console.log('Bibliothek: keine (Karten werden nur auf den Geräten gespeichert)');
  return null;
}

module.exports = { createLibrary };
