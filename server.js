// Die Jagd – GPS-Geländespiel-Server
// Statische Dateien aus ./public + WebSocket-Spiellogik.
// Der Server kennt alle echten Positionen und schickt jedem Handy nur, was dieser Spieler sehen darf.
//
// Datenverbrauch sparen:
//  - Nachrichten werden komprimiert (permessage-deflate)
//  - "meta" (Regeln, Karte, Spielerliste, Verlauf) nur bei Änderungen
//  - "s" (Positionen) alle 2 Sekunden, kompakt

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createLibrary } = require('./library');
const LIB = createLibrary(); // Online-Speicher für Karten und Einstellungen (oder null)

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const STATE_EVERY = 2000; // ms zwischen Positions-Updates an die Handys
const ADMIN_PW = process.env.ADMIN_PASSWORD || '9655'; // Passwort für den Einstellungen-Reiter

// ---------- Statische Dateien ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (p === '/api/pos' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body), g = games.get(clean(m.code, 6).toUpperCase()), me = g && g.players.get(clean(m.pid, 40));
        if (me) updatePos(g, me, m);
        res.writeHead(me ? 204 : 404); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- Geometrie ----------
const now = () => Date.now();
const toR = Math.PI / 180;
function dist(a, b) { // Meter
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}
function bearing(a, b) { // Grad, 0 = Norden
  const y = Math.sin((b.lng - a.lng) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lng - a.lng) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}
function offset(p, meters, deg) {
  const dLat = meters * Math.cos(deg * toR) / 111320;
  const dLng = meters * Math.sin(deg * toR) / (111320 * Math.cos(p.lat * toR));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}
// Polygone als [[lat,lng], ...]
function inPoly(p, poly) {
  if (!poly || p.lat == null) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function centroid(poly) { let a = 0, b = 0; for (const [y, x] of poly) { a += y; b += x; } return [a / poly.length, b / poly.length]; }
function scalePoly(poly, f) { const [cy, cx] = centroid(poly); return poly.map(([y, x]) => [cy + (y - cy) * f, cx + (x - cx) * f]); }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clean = (s, n = 20) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const r5 = v => Math.round(v * 1e5) / 1e5;

// ---------- Regeln ----------
const DEFAULTS = {
  headStart: 600,      // Sek. Vorsprung für die Runner
  duration: 3600,      // Sek. Spielzeit nach dem Vorsprung
  pingInterval: 120,   // Sek. zwischen den Pings
  tagRadius: 12,       // m Fangdistanz
  showHunters: false,  // Runner sehen Hunter live auf der Karte
  convert: true,       // gefangene Runner werden Hunter
  confirmTag: true,    // Runner muss den Fang bestätigen
  confirmSecs: 30,     // Sek. bis ein unbeantworteter Fang automatisch zählt
  zoneShrink: false,   // Zone schrumpft
  endPct: 50,          // Zonengrösse am Schluss in % (Länge)
  outGrace: 30,        // Sek. ausserhalb der Zone bis "tot"
  proxAlert: 50,       // m: Warnung, wenn Runner und Hunter so nah sind
  missionEvery: 1200,  // Sek.: alle so viel bekommt jeder Runner einen Auftragsort (und so lange hat er Zeit)
  missionReveal: 600,  // Sek.: danach sehen die Hunter den Ort, falls der Runner noch nicht dort war
  missionRadius: 20,   // m: so nah muss man an den Auftragsort
  radarEvery: 1200,    // Sek.: Runner können das Radar so oft einsetzen
  radarSecs: 60,       // Sek.: so lange sieht man die Hunter live
  distPts: 1,          // Hunter-Punkte pro 100 m Weg
  catchPts: 20,        // Hunter-Punkte pro Fang
  spotRadius: 20,      // m: Power-up-Ort einsammeln
  spotCooldown: 300,   // Sek. bis ein Power-up-Ort wieder etwas hergibt
  spotPts: 10,         // Hunter-Punkte beim Einsammeln an einem Power-up-Ort
  capsToWin: 3,        // Flaggenraub
  baseRadius: 15,
};
const LIMITS = {
  headStart: [0, 3600], duration: [60, 6 * 3600], pingInterval: [15, 1800], tagRadius: [3, 50], endPct: [5, 100],
  outGrace: [5, 300], proxAlert: [10, 300], missionEvery: [120, 7200], missionReveal: [0, 7200], missionRadius: [5, 100],
  radarEvery: [60, 7200], radarSecs: [10, 300],
  distPts: [0, 20], catchPts: [0, 200], spotRadius: [5, 100], confirmSecs: [10, 120], spotPts: [0, 200],
  spotCooldown: [10, 3600], capsToWin: [1, 20], baseRadius: [5, 60],
};
const ITEMS = {
  xping: { name: 'Extra-Ping', cost: 30, who: 'hunter', desc: 'Deckt sofort alle Runner auf.' },
  nose: { name: 'Spürnase', cost: 35, who: 'hunter', desc: 'Du siehst den nächsten Runner 45 Sekunden lang live.' },
};
const MODES = ['manhunt', 'ctf'];
const games = new Map();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (games.has(c));
  return c;
}
function makeGame(hostPid) {
  return { code: newCode(), hostPid, mode: 'manhunt', settings: { ...DEFAULTS },
    map: { zone: null, starts: [], targets: [], spots: [], flags: { A: null, B: null } },
    phase: 'lobby', startAt: 0, runAt: 0, endAt: 0, nextPing: 0, winner: null, reason: '',
    players: new Map(), pending: new Map(), pingSnap: {}, spotReady: {}, flagHome: { A: true, B: true }, log: [],
    metaDirty: true, metaJson: null, touched: now() };
}
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const dirty = g => { g.metaDirty = true; };
function addLog(g, text) { g.log.unshift([now(), text]); if (g.log.length > 30) g.log.length = 30; dirty(g); }
function ev(g, pids, text, kind = 'info', vib) { const m = JSON.stringify({ t: 'ev', kind, text, vib }); for (const id of pids) { const p = g.players.get(id); if (p) send(p.ws, m); } }
const all = g => [...g.players.keys()];
const P = g => [...g.players.values()];

// Rollen
const isRunner = p => p.role === 'runner';
const isHunter = p => p.role === 'hunter';
const isGM = p => p.role === 'gm';
const team = p => (p.role === 'A' || p.role === 'B' ? p.role : null);
const other = t => (t === 'A' ? 'B' : 'A');
const teamName = t => (t === 'A' ? 'Rot' : 'Blau');
const fresh = (p, ms = 60000) => p.lat != null && now() - p.t < ms;

function defaultRole(g) {
  if (g.mode === 'ctf') { const a = P(g).filter(p => p.role === 'A').length, b = P(g).filter(p => p.role === 'B').length; return a <= b ? 'A' : 'B'; }
  return 'runner';
}
function normalizeRoles(g) {
  for (const p of P(g)) {
    if (isGM(p)) continue;
    if (g.mode === 'ctf' && !team(p)) p.role = defaultRole(g);
    if (g.mode !== 'ctf' && team(p)) p.role = p.role === 'A' ? 'hunter' : 'runner';
  }
}

// ---------- Zone ----------
function zoneNow(g) {
  const z = g.map.zone; if (!z) return null;
  if (!g.settings.zoneShrink) return z;
  let f = 1;
  if (g.phase === 'running') f = 1 + (g.settings.endPct / 100 - 1) * clamp((now() - g.runAt) / (g.endAt - g.runAt), 0, 1);
  else if (g.phase === 'ended') f = g.settings.endPct / 100;
  return f === 1 ? z : scalePoly(z, f);
}
const isOut = (g, p, z) => !!z && p.lat != null && !inPoly(p, z);

// ---------- Ablauf ----------
function resetPlayer(p, g) {
  Object.assign(p, { caught: false, carrying: null, respawn: false, caps: 0, tags: 0, pts: 0, dist: 0, distPaid: 0,
    outSince: 0, near: new Set(), eff: {}, inv: [], lastStep: null, mission: null, lastTarget: -1, cloakUsed: false, radarNext: 0, seen: null, seenAt: 0, caughtAt: 0, caughtBy: '', track: [], trackLen: 0,
    st: { dist: 0, catch: 0, spot: 0, spent: 0, items: 0, missions: 0, hides: 0, radars: 0 },
    ready: !(isHunter(p) && g.map.starts.length) });
}
function startGame(g) {
  const t = now();
  for (const p of P(g)) { resetPlayer(p, g); p.wasRunner = isRunner(p); }
  g.pending = new Map();
  g.startAt = t; g.runAt = t + g.settings.headStart * 1000; g.endAt = g.runAt + g.settings.duration * 1000;
  g.phase = g.settings.headStart > 0 ? 'headstart' : 'running';
  g.nextPing = g.runAt + g.settings.pingInterval * 1000; g.pingSnap = {}; g.spotReady = {}; g.lastPingAt = 0;
  g.nextMission = g.runAt;
  g.flagHome = { A: true, B: true }; g.winner = null; g.reason = '';
  addLog(g, 'Spiel gestartet');
  if (g.mode === 'ctf') ev(g, all(g), 'Los! Holt euch die gegnerische Flagge.', 'start', [300, 100, 300]);
  else {
    const hs = fmtSec(g.settings.headStart);
    for (const p of P(g)) {
      if (isRunner(p)) send(p.ws, { t: 'ev', kind: 'start', text: g.settings.headStart ? `Los! Du hast ${hs}, um dich zu verstecken.` : 'Los! Lauf!', vib: [300, 100, 300] });
      if (isHunter(p)) send(p.ws, { t: 'ev', kind: 'start', text: g.map.starts.length ? `Geh zu einer Startzone. Fangen darfst du, sobald du dort warst und die ${hs} Vorsprung vorbei sind.` : `Die Runner haben ${hs} Vorsprung.`, vib: [300, 100, 300] });
    }
  }
  if (g.phase === 'running') doPing(g, true);
}
const fmtSec = s => (s >= 60 ? `${Math.round(s / 60)} Min.` : `${s} Sek.`);

function endGame(g, winner, reason) {
  if (g.phase === 'ended') return;
  g.phase = 'ended'; g.winner = winner; g.reason = reason; g.endedAt = now();
  addLog(g, reason); ev(g, all(g), reason, 'end', [500, 200, 500, 200, 500]);
}

// Ping: regular = planmässig (zählt für den Ping-Bonus), sonst Extra-Ping
function doPing(g, regular, by) {
  const t = now();
  if (regular) g.nextPing = t + g.settings.pingInterval * 1000;
  g.lastPingAt = t;
  for (const p of P(g)) {
    if (isGM(p) || p.lat == null) continue;
    if (g.mode === 'ctf') { g.pingSnap[p.pid] = { lat: p.lat, lng: p.lng, t: p.t }; continue; }
    if (isHunter(p)) { g.pingSnap[p.pid] = { lat: p.lat, lng: p.lng, t: p.t }; continue; } // für die Runner
    if (!isRunner(p) || p.caught) continue;
    if (p.eff.cloak) { delete p.eff.cloak; delete g.pingSnap[p.pid]; send(p.ws, { t: 'ev', kind: 'item', text: 'Ping verborgen: Die Hunter haben dich diesmal nicht gesehen.' }); continue; }
    g.pingSnap[p.pid] = { lat: p.lat, lng: p.lng, t: p.t };
  }
  for (const p of P(g)) { p.seen = null; } // alte Radar-Positionen ersetzt der Ping
  const msg = g.mode === 'ctf' ? 'Ping! Alle Positionen wurden aufgedeckt.' : by ? `Extra-Ping von ${by.name}! Die Runner wurden aufgedeckt.` : 'Ping! Runner und Hunter wurden aufgedeckt.';
  ev(g, all(g), msg, 'ping', [150, 80, 150]);
}

function catchPlayer(g, target, by, how) {
  if (target.caught) return;
  clearPending(g, target);
  target.caught = true; target.eff = {}; target.mission = null;
  delete g.pingSnap[target.pid];
  if (by) { by.tags++; by.pts += g.settings.catchPts; by.st.catch += g.settings.catchPts; }
  target.caughtAt = now(); target.caughtBy = by ? by.name : how === 'zone' ? 'Zone verlassen' : how === 'mission' ? 'Auftrag verpasst' : how === 'gm' ? 'Spielleitung' : 'selbst gemeldet';
  const conv = g.settings.convert;
  if (conv) { target.role = 'hunter'; target.ready = true; }
  const what = how === 'zone' ? `${target.name} war zu lange ausserhalb der Zone` : how === 'mission' ? `${target.name} hat den Auftragsort nicht rechtzeitig erreicht` : by ? `${by.name} hat ${target.name} gefangen` : `${target.name} wurde gefangen`;
  addLog(g, what + (conv ? ' und jagt jetzt mit' : ''));
  send(target.ws, { t: 'ev', kind: 'caught', text: (how === 'zone' ? 'Du warst zu lange ausserhalb der Zone. ' : how === 'mission' ? 'Du hast deinen Auftragsort nicht rechtzeitig erreicht. ' : 'Du wurdest gefangen. ') + (conv ? 'Jetzt bist du Hunter – jag die anderen!' : ''), vib: [800] });
  ev(g, all(g).filter(x => x !== target.pid), what + '!', 'info', [100]);
  dirty(g); checkWin(g);
}
const teamScore = (g, t) => P(g).filter(p => p.role === t).reduce((s, p) => s + (p.caps || 0), 0);
function checkWin(g) {
  if (g.phase !== 'running' && g.phase !== 'headstart') return;
  if (g.mode === 'ctf') {
    for (const t of ['A', 'B']) { const c = teamScore(g, t); if (c >= g.settings.capsToWin) endGame(g, t, `Team ${teamName(t)} gewinnt mit ${c} Eroberungen!`); }
    return;
  }
  const left = P(g).filter(p => isRunner(p) && !p.caught);
  if (P(g).some(isHunter) && left.length === 0) endGame(g, 'hunter', 'Alle Runner wurden gefangen – die Hunter gewinnen!');
}

// ---------- Takt (jede Sekunde) ----------
let tickN = 0;
function tick() {
  const t = now(); tickN++;
  for (const g of games.values()) {
    if (g.phase === 'headstart' && t >= g.runAt) {
      g.phase = 'running'; dirty(g);
      ev(g, all(g), g.mode === 'ctf' ? 'Das Spiel läuft.' : 'Der Vorsprung ist vorbei – die Jagd beginnt!', 'run', [400, 100, 400]);
      doPing(g, true);
    }
    if (g.phase === 'headstart' || g.phase === 'running') logicTick(g, t);
    if (g.phase === 'running') {
      if (t >= g.nextPing) doPing(g, true);
      if (g.mode === 'ctf') ctfTick(g);
      if (t >= g.endAt) {
        if (g.mode === 'ctf') { const a = teamScore(g, 'A'), b = teamScore(g, 'B'); endGame(g, a === b ? 'draw' : a > b ? 'A' : 'B', a === b ? `Zeit um – unentschieden (${a}:${b}).` : `Zeit um – Team ${a > b ? 'Rot' : 'Blau'} gewinnt ${Math.max(a, b)}:${Math.min(a, b)}!`); }
        else { const left = P(g).filter(p => isRunner(p) && !p.caught).length; endGame(g, 'runner', `Zeit um – ${left} Runner sind entkommen. Die Runner gewinnen!`); }
      }
    }
    if (g.metaDirty) sendMeta(g);
    if (tickN % (STATE_EVERY / 1000) === 0) sendStates(g);
    if (t - g.touched > 12 * 3600 * 1000) games.delete(g.code);
  }
}

function logicTick(g, t) {
  const s = g.settings, running = g.phase === 'running', z = zoneNow(g);
  // Hunter erreichen die Startzone
  if (g.map.starts.length) for (const p of P(g)) {
    if (isHunter(p) && !p.ready && fresh(p, 20000) && g.map.starts.some(z => inPoly(p, z))) {
      p.ready = true; dirty(g);
      send(p.ws, { t: 'ev', kind: 'ready', text: running ? 'Startzone erreicht – du darfst jetzt fangen!' : 'Startzone erreicht. Sobald der Vorsprung vorbei ist, darfst du fangen.', vib: [200, 100, 200] });
    }
  }
  if (!running) return;
  const runners = P(g).filter(p => isRunner(p) && !p.caught && fresh(p));
  const hunters = P(g).filter(p => isHunter(p) && fresh(p));
  for (const p of P(g)) {
    if (isGM(p)) continue;
    // Zone verlassen
    const out = !p.caught && isOut(g, p, z) && fresh(p, 30000);
    if (out && !p.outSince) {
      p.outSince = t; dirty(g);
      send(p.ws, { t: 'ev', kind: 'zone', text: isHunter(p) ? 'Du bist ausserhalb der Zone. Von hier aus kannst du niemanden fangen.' : `Du bist ausserhalb der Zone! Du hast ${s.outGrace} Sekunden, um zurückzukehren.`, vib: [500, 200, 500, 200, 500], siren: true });
    } else if (!out && p.outSince) {
      p.outSince = 0; dirty(g);
      send(p.ws, { t: 'ev', kind: 'ok', text: 'Du bist wieder in der Zone.', vib: [100] });
    } else if (out && !isHunter(p) && t - p.outSince >= s.outGrace * 1000) {
      p.outSince = 0;
      if (g.mode === 'ctf') { p.respawn = true; dropFlag(g, p); send(p.ws, { t: 'ev', kind: 'caught', text: 'Zu lange ausserhalb der Zone – zurück in deine Basis!', vib: [800] }); addLog(g, `${p.name} war zu lange ausserhalb der Zone`); }
      else if (isRunner(p)) catchPlayer(g, p, null, 'zone');
    }
  }
  if (g.mode === 'ctf') return;
  // Radar abgelaufen: die letzten Hunter-Positionen bleiben bis zum nächsten Ping stehen
  for (const p of P(g)) if (p.eff.radar && p.eff.radar <= t) {
    delete p.eff.radar; p.seenAt = t;
    p.seen = Object.fromEntries(hunters.map(h => [h.pid, { lat: h.lat, lng: h.lng, t: h.t }]));
  }
  missionTick(g, t);
  // Power-up-Orte für Hunter
  g.map.spots.forEach((sp, i) => {
    if ((g.spotReady[i] || 0) > t) return;
    const h = hunters.find(p => p.ready && dist(p, { lat: sp[0], lng: sp[1] }) <= s.spotRadius);
    if (!h) return;
    g.spotReady[i] = t + s.spotCooldown * 1000; dirty(g);
    h.pts += s.spotPts; h.st.spot += s.spotPts;
    const pts = s.spotPts ? ` und +${s.spotPts} Punkte` : '';
    if (h.inv.length < 3) {
      const item = Math.random() < 0.5 ? 'xping' : 'nose'; h.inv.push(item);
      send(h.ws, { t: 'ev', kind: 'item', text: `Power-up gefunden: ${ITEMS[item].name}${pts}! Einsetzen über ⚡.`, vib: [200, 100, 200] });
    } else send(h.ws, { t: 'ev', kind: 'pts', text: `Power-up-Ort${pts}. Dein Rucksack ist voll (3 Power-ups).`, vib: [200, 100, 200] });
  });
  // Annäherungs-Warnung
  for (const r of runners) for (const h of hunters) {
    const d = dist(r, h);
    if (d <= s.proxAlert && !r.near.has(h.pid)) {
      r.near.add(h.pid);
      send(r.ws, { t: 'ev', kind: 'near', text: `Achtung! Hunter ${h.name} ist weniger als ${s.proxAlert} m entfernt.`, vib: [400, 100, 400] });
      send(h.ws, { t: 'ev', kind: 'near', text: `Ein Runner ist weniger als ${s.proxAlert} m von dir entfernt!`, vib: [400, 100, 400] });
    } else if (d > s.proxAlert + 25) r.near.delete(h.pid);
  }
  for (const [rid, pend] of g.pending) if (pend.until <= t) { const r = g.players.get(rid); if (r) { answerTag(g, r, pend.id, true, true); send(r.ws, { t: 'confirmDone', id: pend.id }); } else g.pending.delete(rid); }
  // Spürnase beenden, wenn das Ziel weg ist
  for (const h of hunters) if (h.eff.nose && (h.eff.nose.until < t || g.players.get(h.eff.nose.pid)?.caught)) delete h.eff.nose;
}

function dropFlag(g, p) { if (p.carrying) { g.flagHome[p.carrying] = true; p.carrying = null; dirty(g); return true; } return false; }
function ctfTick(g) {
  const br = g.settings.baseRadius, F = g.map.flags;
  for (const p of P(g)) {
    const my = team(p); if (!my || !fresh(p, 20000)) continue;
    const home = F[my] && { lat: F[my][0], lng: F[my][1] }, enemy = F[other(my)] && { lat: F[other(my)][0], lng: F[other(my)][1] };
    if (p.respawn) { if (dist(p, home) <= br) { p.respawn = false; dirty(g); send(p.ws, { t: 'ev', kind: 'ok', text: 'Zurück in der Basis – du bist wieder im Spiel.', vib: [100, 50, 100] }); } continue; }
    if (!p.carrying && g.flagHome[other(my)] && dist(p, enemy) <= br) {
      p.carrying = other(my); g.flagHome[other(my)] = false; dirty(g);
      addLog(g, `${p.name} hat die Flagge von Team ${teamName(other(my))} geholt`);
      send(p.ws, { t: 'ev', kind: 'item', text: 'Du hast die Flagge! Bring sie in deine Basis.', vib: [300, 100, 300] });
      ev(g, all(g).filter(x => x !== p.pid), `${p.name} hat eine Flagge geholt!`, 'info', [200]);
    }
    if (p.carrying && dist(p, home) <= br) {
      g.flagHome[p.carrying] = true; p.carrying = null; p.caps++; dirty(g);
      addLog(g, `${p.name} erobert eine Flagge (${teamScore(g, 'A')}:${teamScore(g, 'B')})`);
      ev(g, all(g), `${p.name} erobert die Flagge! Rot ${teamScore(g, 'A')} : ${teamScore(g, 'B')} Blau`, 'pts', [300, 100, 300, 100, 300]);
      checkWin(g);
    }
  }
}

// ---------- Gelaufene Strecke aufzeichnen ----------
// Ein Punkt pro 8 m Bewegung (oder alle 30 s bei kleiner Bewegung). Sehr lange Strecken werden ausgedünnt.
function recordTrack(g, p, lat, lng, t) {
  const tr = p.track, last = tr[tr.length - 1], pt = { lat, lng };
  if (last) {
    const d = dist({ lat: last[0], lng: last[1] }, pt), dt = (t - g.startAt) / 1000 - last[2];
    if (d < 8 && !(dt >= 30 && d >= 3)) return;
    if (d / Math.max(dt, 1) <= 40) p.trackLen += d; // GPS-Sprünge nicht mitzählen
  }
  tr.push([r5(lat), r5(lng), Math.round((t - g.startAt) / 1000)]);
  if (tr.length > 3000) p.track = tr.filter((_, i) => i % 2 === 0 || i === tr.length - 1);
}

// ---------- Aufträge ----------
// Ab Ende des Vorsprungs bekommt jeder Runner alle missionEvery Sekunden zufällig einen Auftragsort.
// Wer ihn nicht innert dieser Zeit erreicht, ist raus (wird Hunter). Nach missionReveal sehen die Hunter den Ort.
function missionTick(g, t) {
  const s = g.settings, T = g.map.targets;
  if (g.mode !== 'manhunt' || !T.length) return;
  for (const p of P(g)) {
    const m = p.mission; if (!m) continue;
    if (!isRunner(p) || p.caught) { p.mission = null; continue; }
    if (fresh(p, 20000) && dist(p, { lat: m.lat, lng: m.lng }) <= s.missionRadius) {
      p.mission = null; p.st.missions++; dirty(g);
      send(p.ws, { t: 'ev', kind: 'ok', text: 'Auftragsort erreicht! Der nächste Auftrag kommt in ' + fmtSec(Math.max(0, Math.round((g.nextMission - t) / 1000))) + '.', vib: [200, 100, 200] });
      addLog(g, `${p.name} hat einen Auftragsort erreicht`);
    } else if (t >= m.until) catchPlayer(g, p, null, 'mission');
  }
  if (t < g.nextMission || g.phase !== 'running') return;
  g.nextMission += s.missionEvery * 1000;
  if (t + 60000 > g.endAt) return; // kurz vor Schluss kein neuer Auftrag mehr
  for (const p of P(g)) {
    if (!isRunner(p) || p.caught) continue;
    let i = Math.floor(Math.random() * T.length);
    if (T.length > 1 && i === p.lastTarget) i = (i + 1 + Math.floor(Math.random() * (T.length - 1))) % T.length;
    p.lastTarget = i;
    p.mission = { i, lat: T[i][0], lng: T[i][1], at: t, until: t + s.missionEvery * 1000 };
    send(p.ws, { t: 'ev', kind: 'mission', text: `Neuer Auftrag! Erreiche den markierten Ort innert ${fmtSec(s.missionEvery)}, sonst bist du raus.`, vib: [300, 100, 300, 100, 300] });
  }
  addLog(g, 'Neue Aufträge für die Runner'); dirty(g);
}

// ---------- Fähigkeiten der Runner ----------
function runnerAbility(g, p, what) {
  const t = now(), s = g.settings;
  if (g.mode !== 'manhunt' || g.phase !== 'running' || !isRunner(p) || p.caught) return send(p.ws, { t: 'ev', kind: 'miss', text: 'Das geht nur als Runner während der Jagd.' });
  if (what === 'hide') {
    if (p.cloakUsed) return send(p.ws, { t: 'ev', kind: 'miss', text: 'Du hast dein Verbergen schon eingesetzt.' });
    p.cloakUsed = true; p.eff.cloak = true; p.st.hides++;
    return send(p.ws, { t: 'ev', kind: 'item', text: 'Beim nächsten Ping wirst du nicht angezeigt.', vib: [100, 50, 100] });
  }
  if (what === 'radar') {
    if (p.radarNext > t) return send(p.ws, { t: 'ev', kind: 'miss', text: `Radar wieder bereit in ${fmtSec(Math.ceil((p.radarNext - t) / 1000))}.` });
    p.radarNext = t + s.radarEvery * 1000; p.eff.radar = t + s.radarSecs * 1000; p.st.radars++;
    return send(p.ws, { t: 'ev', kind: 'item', text: `Radar an: Du siehst alle Hunter ${s.radarSecs} Sekunden lang live.`, vib: [100, 50, 100] });
  }
}

// ---------- Aktionen ----------
function tagRange(g, p) { return g.settings.tagRadius + Math.min(15, (p.acc || 0) / 2); }
function canTag(g, p) {
  if (g.phase !== 'running' || !fresh(p, 30000)) return false;
  if (g.mode === 'ctf') return !!team(p) && !p.respawn;
  return isHunter(p) && p.ready && !p.outSince;
}
function targets(g, tagger) {
  return P(g).filter(p => p !== tagger && fresh(p, 45000) && (g.mode === 'ctf'
    ? team(p) && team(p) !== team(tagger) && !p.respawn
    : isRunner(p) && !p.caught));
}
function tryTag(g, me) {
  if (!canTag(g, me)) {
    const why = g.phase !== 'running' ? 'Fangen geht erst, wenn die Jagd läuft.' : !me.ready ? 'Geh zuerst in die Startzone.' : me.outSince ? 'Ausserhalb der Zone kannst du niemanden fangen.' : 'Dein GPS-Signal ist zu alt.';
    return send(me.ws, { t: 'ev', kind: 'miss', text: why });
  }
  let best = null, bd = Infinity;
  for (const p of targets(g, me)) { const d = dist(me, p); if (d < bd) { bd = d; best = p; } }
  if (!best || bd > tagRange(g, me)) return send(me.ws, { t: 'ev', kind: 'miss', text: 'Niemand in Reichweite.' });
  if (g.mode === 'ctf') {
    best.respawn = true; me.tags++; const dropped = dropFlag(g, best); dirty(g);
    addLog(g, `${me.name} hat ${best.name} abgeschlagen`);
    send(best.ws, { t: 'ev', kind: 'caught', text: `${me.name} hat dich abgeschlagen. Zurück in deine Basis!`, vib: [800] });
    send(me.ws, { t: 'ev', kind: 'hit', text: `Du hast ${best.name} abgeschlagen!${dropped ? ' Die Flagge ist zurück.' : ''}`, vib: [200] });
  } else if (g.settings.confirmTag) {
    if (g.pending.has(best.pid)) return send(me.ws, { t: 'ev', kind: 'miss', text: `${best.name} muss schon einen Fang bestätigen.` });
    const id = Math.random().toString(36).slice(2, 10), secs = g.settings.confirmSecs;
    g.pending.set(best.pid, { id, hunter: me.pid, until: now() + secs * 1000 });
    send(best.ws, { t: 'confirm', id, hunter: me.name, secs, vib: [300, 100, 300, 100, 300] });
    send(me.ws, { t: 'ev', kind: 'info', text: `Warte, bis ${best.name} den Fang bestätigt …` });
  } else {
    send(me.ws, { t: 'ev', kind: 'hit', text: `Du hast ${best.name} gefangen! +${g.settings.catchPts} Punkte`, vib: [200] });
    catchPlayer(g, best, me);
  }
}

// Antwort des Runners auf eine Fang-Anfrage
function answerTag(g, runner, id, yes, auto) {
  const pend = g.pending.get(runner.pid);
  if (!pend || pend.id !== id) return;
  g.pending.delete(runner.pid);
  const hunter = g.players.get(pend.hunter);
  if (yes) {
    if (hunter) send(hunter.ws, { t: 'ev', kind: 'hit', text: `${runner.name} hat den Fang ${auto ? 'nicht beantwortet – er zählt' : 'bestätigt'}! +${g.settings.catchPts} Punkte`, vib: [200] });
    if (auto) addLog(g, `${runner.name} hat nicht geantwortet – Fang zählt automatisch`);
    catchPlayer(g, runner, hunter || null, hunter ? undefined : 'gm');
  } else {
    if (hunter) send(hunter.ws, { t: 'ev', kind: 'miss', text: `${runner.name} sagt: nicht gefangen. Bei Streit entscheidet die Spielleitung.`, vib: [100] });
    addLog(g, `${runner.name} hat den Fang von ${hunter ? hunter.name : '?'} abgelehnt`);
  }
}
function clearPending(g, runner) {
  const pend = g.pending.get(runner.pid);
  if (pend) { g.pending.delete(runner.pid); send(runner.ws, { t: 'confirmDone', id: pend.id }); }
}

function useItem(g, p, item) {
  const it = ITEMS[item]; const t = now();
  if (item === 'xping') { doPing(g, false, p); }
  else if (item === 'nose') {
    let best = null, bd = Infinity;
    for (const r of P(g)) if (isRunner(r) && !r.caught && fresh(r)) { const d = dist(p, r); if (d < bd) { bd = d; best = r; } }
    if (!best) return send(p.ws, { t: 'ev', kind: 'miss', text: 'Kein Runner gefunden.' });
    p.eff.nose = { pid: best.pid, until: t + 45000 };
  }
  send(p.ws, { t: 'ev', kind: 'item', text: `${it.name} aktiviert. ${it.desc}`, vib: [100, 50, 100] });
}


// ---------- Was darf wer sehen? ----------
function metaFor(g) {
  if (!g.metaDirty && g.metaJson) return g.metaJson;
  g.metaDirty = false;
  const playing = g.phase === 'headstart' || g.phase === 'running';
  g.metaJson = JSON.stringify({ t: 'meta', code: g.code, hostPid: g.hostPid, mode: g.mode, settings: g.settings, map: playing ? { ...g.map, targets: [] } : g.map, nTargets: g.map.targets.length,
    phase: g.phase, startAt: g.startAt, runAt: g.runAt, endAt: g.endAt, winner: g.winner, reason: g.reason, log: g.log, items: ITEMS,
    roster: P(g).map(p => ({ pid: p.pid, name: p.name, role: p.role, caught: !!p.caught, ready: p.ready !== false, caps: p.caps || 0, tags: p.tags || 0, inv: (p.inv || []).length,
      // Auswertung am Spielende
      ...(g.phase === 'ended' ? { res: { start: p.wasRunner ? 'runner' : p.role === 'A' || p.role === 'B' || p.role === 'gm' ? p.role : 'hunter', pts: Math.floor(p.pts || 0), earned: Math.floor((p.st ? p.st.dist + p.st.catch + p.st.spot : 0)),
        dist: Math.round(p.dist || 0), walked: Math.round(p.trackLen || 0), caughtMin: p.caughtAt ? Math.round((p.caughtAt - g.runAt) / 60000) : null, caughtBy: p.caughtBy || '',
        st: Object.fromEntries(Object.entries(p.st || {}).map(([k, v]) => [k, Math.floor(v)])) } } : {}) })),
    started: g.startAt, ended: g.endedAt || 0 });
  return g.metaJson;
}
function sendMeta(g) { const m = metaFor(g); for (const p of P(g)) send(p.ws, m); }

// Flags pro Spieler in "s": 1 online, 2 live, 4 ausserhalb, 8 trägt Flagge, 16 respawn, 32 Spürnase-Ziel
function stateFor(g, me) {
  const t = now(), z = zoneNow(g), seeAll = g.phase === 'lobby' || g.phase === 'ended' || isGM(me);
  const ps = {};
  for (const p of P(g)) {
    let pos = null, live = false, f = p.ws && p.ws.readyState === 1 ? 1 : 0;
    const out = g.phase === 'running' && !!p.outSince;
    if (seeAll || p === me) live = true;
    else if (isGM(p)) live = false;
    else if (g.mode === 'ctf') {
      if (g.phase === 'headstart') live = team(p) === team(me);
      else if (team(p) === team(me) || p.carrying || out) live = true; else pos = g.pingSnap[p.pid];
    } else if (isHunter(me)) {
      if (isHunter(p)) live = true;
      else if (isRunner(p) && !p.caught && g.phase === 'running') {
        if (out || (me.eff.nose && me.eff.nose.pid === p.pid)) live = true; else pos = g.pingSnap[p.pid];
        if (me.eff.nose && me.eff.nose.pid === p.pid) f |= 32;
      }
    } else { // Runner
      if (isRunner(p)) live = true;
      else if (isHunter(p) && g.phase === 'running') {
        if (g.settings.showHunters || (me.eff.radar || 0) > t) live = true;
        else if (me.seen && me.seenAt > (g.lastPingAt || 0) && me.seen[p.pid]) pos = me.seen[p.pid];
        else pos = g.pingSnap[p.pid];
      }
    }
    if (live && p.lat != null) pos = p;
    if (out) f |= 4; if (p.carrying) f |= 8; if (p.respawn) f |= 16;
    if (pos) { if (live) f |= 2; ps[p.pid] = [r5(pos.lat), r5(pos.lng), Math.round((t - pos.t) / 1000), f, Math.floor(p.pts || 0)]; }
    else ps[p.pid] = [null, null, 0, f, Math.floor(p.pts || 0)];
  }
  const msg = { t: 's', now: t, nextPing: g.nextPing, flagHome: g.flagHome, score: { A: teamScore(g, 'A'), B: teamScore(g, 'B') }, ps,
    me: { pts: Math.floor(me.pts || 0), inv: me.inv || [], ready: me.ready !== false, outLeft: me.outSince ? Math.max(0, Math.ceil(g.settings.outGrace - (t - me.outSince) / 1000)) : null,
      radar: Math.max(0, Math.ceil((((me.eff && me.eff.radar) || 0) - t) / 1000)), nose: me.eff?.nose ? Math.ceil((me.eff.nose.until - t) / 1000) : 0,
      cloak: !!me.eff?.cloak, hideLeft: !me.cloakUsed, radarIn: Math.max(0, Math.ceil(((me.radarNext || 0) - t) / 1000)) } };
  if (g.mode === 'manhunt' && g.phase === 'running') {
    if (me.mission) msg.me.mission = [me.mission.lat, me.mission.lng, Math.max(0, Math.ceil((me.mission.until - t) / 1000))];
    msg.nextMission = g.map.targets.length ? g.nextMission : 0;
    // Auftragsorte, die ein Runner nach missionReveal noch nicht erreicht hat: für Hunter sichtbar (ohne Namen)
    if (isHunter(me) || isGM(me)) {
      const seen = new Set(), list = [];
      for (const r of P(g)) {
        const m = r.mission; if (!m) continue;
        const open = t - m.at >= g.settings.missionReveal * 1000;
        if (isGM(me)) list.push([m.lat, m.lng, open ? 1 : 0, r.name]);
        else if (open && !seen.has(m.i)) { seen.add(m.i); list.push([m.lat, m.lng, 1]); }
      }
      msg.revealed = list;
    }
  }
  msg.spots = g.map.spots.map((_, i) => (g.spotReady[i] || 0) > t ? Math.ceil((g.spotReady[i] - t) / 1000) : 0);
  // Fangen-Knopf
  if (canTag(g, me)) msg.me.inRange = targets(g, me).some(p => dist(me, p) <= tagRange(g, me));
  // Kompass für Runner: nur die Richtung zum nächsten Hunter
  if (g.mode === 'manhunt' && isRunner(me) && !me.caught && me.lat != null && g.phase !== 'ended') {
    let best = null, bd = Infinity;
    for (const h of P(g)) if (isHunter(h) && fresh(h)) { const d = dist(me, h); if (d < bd) { bd = d; best = h; } }
    if (best) msg.me.comp = Math.round(bearing(me, best));
  }
  return JSON.stringify(msg);
}
function sendStates(g) { for (const p of P(g)) if (p.ws && p.ws.readyState === 1) send(p.ws, stateFor(g, p)); }
const pushNow = g => { if (g.metaDirty) sendMeta(g); sendStates(g); };

// ---------- Nachrichten ----------
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024, perMessageDeflate: { threshold: 200 } });
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Interner Fehler.' }); } });
  ws.on('close', () => { const g = games.get(ws.code); if (g) dirty(g); });
});

function validPoly(a) {
  if (!Array.isArray(a) || a.length < 3 || a.length > 300) return null;
  const out = a.map(v => Array.isArray(v) ? [num(v[0], NaN), num(v[1], NaN)] : null);
  return out.every(v => v && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180) ? out.map(([y, x]) => [r5(y), r5(x)]) : null;
}
const validPt = v => (Array.isArray(v) && Math.abs(num(v[0], 999)) <= 90 && Math.abs(num(v[1], 999)) <= 180 ? [r5(v[0]), r5(v[1])] : null);

function cleanMap(i) {
  i = i || {};
  return {
    zone: i.zone ? validPoly(i.zone) : null,
    starts: (Array.isArray(i.starts) ? i.starts : i.start ? [i.start] : []).slice(0, 10).map(validPoly).filter(Boolean),
    targets: (Array.isArray(i.targets) ? i.targets : []).slice(0, 60).map(validPt).filter(Boolean),
    spots: (Array.isArray(i.spots) ? i.spots : []).slice(0, 50).map(validPt).filter(Boolean),
    flags: { A: i.flags && validPt(i.flags.A), B: i.flags && validPt(i.flags.B) },
  };
}
function applySettings(s, i) {
  for (const k of Object.keys(LIMITS)) if (k in i) s[k] = clamp(num(i[k], s[k]), ...LIMITS[k]);
  for (const k of ['showHunters', 'convert', 'zoneShrink', 'confirmTag']) if (typeof i[k] === 'boolean') s[k] = i[k];
  return s;
}

// ---------- Bibliothek (Karten und Einstellungen online speichern) ----------
async function sendLib(ws) {
  if (!LIB) return send(ws, { t: 'lib', online: false });
  try {
    const [maps, sets] = await Promise.all([LIB.list('map'), LIB.list('set')]);
    const names = a => a.map(x => x.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
    send(ws, { t: 'lib', online: true, where: LIB.kind, maps: names(maps), sets: names(sets) });
  } catch (e) { console.error(e.message); send(ws, { t: 'lib', online: false, error: 'Online-Speicher nicht erreichbar.' }); }
}
async function handleLib(ws, g, m) {
  if (!ws.admin) return send(ws, { t: 'error', msg: 'Für die Bibliothek braucht es das Passwort.' });
  if (m.t === 'libList') return sendLib(ws);
  if (!LIB) return send(ws, { t: 'error', msg: 'Der Online-Speicher ist nicht eingerichtet.' });
  const kind = m.kind === 'set' ? 'set' : 'map', name = clean(m.name, 40);
  const what = kind === 'map' ? 'Karte' : 'Einstellungen';
  if (!name) return send(ws, { t: 'error', msg: 'Gib zuerst einen Namen ein.' });
  try {
    if (m.t === 'libSave') {
      // Daten vom Gerät (Hochladen alter Karten / Import) werden gleich geprüft wie beim Zeichnen
      let data, mode = g.mode;
      if (m.data) { data = kind === 'map' ? cleanMap(m.data) : applySettings({ ...DEFAULTS }, m.data); if (MODES.includes(m.mode)) mode = m.mode; }
      else data = kind === 'map' ? g.map : { ...g.settings };
      await LIB.set(kind, name, { mode, data });
      send(ws, { t: 'ev', kind: 'ok', text: `${what} «${name}» online gespeichert.` });
    } else if (m.t === 'libLoad') {
      if (g.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Laden geht nur vor dem Spiel.' });
      const rec = await LIB.get(kind, name);
      if (!rec) return send(ws, { t: 'error', msg: `${what} «${name}» nicht gefunden.` });
      if (rec.mode && MODES.includes(rec.mode) && rec.mode !== g.mode) { g.mode = rec.mode; normalizeRoles(g); }
      if (kind === 'map') g.map = cleanMap(rec.data); else applySettings(g.settings, rec.data || {});
      dirty(g); pushNow(g);
      send(ws, { t: 'libLoaded', kind, name });
    } else if (m.t === 'libDelete') {
      await LIB.del(kind, name);
      send(ws, { t: 'ev', kind: 'ok', text: `${what} «${name}» gelöscht.` });
    }
  } catch (e) { console.error(e.message); return send(ws, { t: 'error', msg: 'Online-Speicher: ' + e.message }); }
  sendLib(ws);
}

function updatePos(g, me, m) {
  const running = g.phase === 'running';
  const lat = num(m.lat, null), lng = num(m.lng, null);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const acc = clamp(num(m.acc, 50), 0, 5000), t = now();
  g.touched = t;
      // Hunter: Punkte für zurückgelegte Strecke (nur zu Fuss/Velo-Tempo, nur mit gutem GPS)
      if (running && isHunter(me) && g.settings.distPts && acc <= 30) {
        if (me.lastStep) {
          const d = dist(me.lastStep, { lat, lng }), dt = (t - me.lastStep.t) / 1000;
          if (d >= 5) {
            if (dt > 0 && d / dt <= 8) {
              me.dist += d;
              const due = Math.floor(me.dist / 100) * g.settings.distPts;
              if (due > me.distPaid) { me.pts += due - me.distPaid; me.st.dist += due - me.distPaid; me.distPaid = due; }
            }
            me.lastStep = { lat, lng, t };
          }
        } else me.lastStep = { lat, lng, t };
      }
      if ((g.phase === 'headstart' || running) && acc <= 50) recordTrack(g, me, lat, lng, t);
      me.lat = lat; me.lng = lng; me.acc = acc; me.t = t;
}

function handle(ws, m) {
  if (m.t === 'create' || m.t === 'join') {
    const pid = clean(m.pid, 40), name = clean(m.name, 20);
    if (!pid || !name) return send(ws, { t: 'error', msg: 'Bitte gib einen Namen ein.' });
    let g;
    if (m.t === 'create') { g = makeGame(pid); games.set(g.code, g); addLog(g, `${name} hat das Spiel eröffnet`); }
    else { g = games.get(clean(m.code, 6).toUpperCase()); if (!g) return send(ws, { t: 'error', msg: 'Kein Spiel mit diesem Code gefunden.', gone: true }); }
    let p = g.players.get(pid);
    if (p) { if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch {} } p.ws = ws; if (p.name !== name) { p.name = name; dirty(g); } }
    else {
      if (g.players.size >= 150) return send(ws, { t: 'error', msg: 'Das Spiel ist voll (150 Spieler).' });
      const running = g.phase === 'headstart' || g.phase === 'running';
      p = { pid, name, ws, lat: null, lng: null, t: 0, role: running && g.mode === 'manhunt' ? 'hunter' : defaultRole(g) };
      resetPlayer(p, g);
      g.players.set(pid, p);
      if (m.t === 'join') addLog(g, `${name} ist beigetreten`);
    }
    ws.code = g.code; ws.pid = pid; g.touched = now(); dirty(g);
    send(ws, { t: 'joined', code: g.code, pid });
    return pushNow(g);
  }
  const g = games.get(ws.code); if (!g) return;
  const me = g.players.get(ws.pid); if (!me || me.ws !== ws) return;
  g.touched = now();
  const host = me.pid === g.hostPid, running = g.phase === 'running';

  switch (m.t) {
    case 'pos': return updatePos(g, me, m);
    case 'tag': tryTag(g, me); return pushNow(g);

    case 'tracks': if (g.phase === 'ended') send(ws, { t: 'tracks', startAt: g.startAt, list: P(g).filter(p => !isGM(p) && p.track.length).map(p => ({ pid: p.pid, name: p.name, len: Math.round(p.trackLen), pts: p.track })) }); return;
    case 'confirmTag': answerTag(g, me, String(m.id || ''), m.yes === true); return pushNow(g);
    case 'selfCaught': if (g.mode === 'manhunt' && isRunner(me) && running) { catchPlayer(g, me, null, 'self'); pushNow(g); } return;
    case 'buy': {
      const it = ITEMS[m.item];
      if (!it || g.mode !== 'manhunt' || !running || !isHunter(me)) return send(ws, { t: 'ev', kind: 'miss', text: 'Das geht gerade nicht.' });
      if ((me.pts || 0) < it.cost) return send(ws, { t: 'ev', kind: 'miss', text: `Zu wenig Punkte (${it.cost} nötig).` });
      me.pts -= it.cost; me.st.spent += it.cost; me.st.items++; useItem(g, me, m.item); return pushNow(g);
    }
    case 'use': {
      const i = (me.inv || []).indexOf(m.item);
      if (i < 0 || !running || !isHunter(me)) return;
      me.inv.splice(i, 1); me.st.items++; dirty(g); useItem(g, me, m.item); return pushNow(g);
    }
    case 'hide': runnerAbility(g, me, 'hide'); return pushNow(g);
    case 'radar': runnerAbility(g, me, 'radar'); return pushNow(g);
    case 'leave':
      g.players.delete(me.pid); ws.code = null;
      if (host) { const next = P(g)[0]; if (next) { g.hostPid = next.pid; addLog(g, `${next.name} leitet jetzt das Spiel`); } else games.delete(g.code); }
      dirty(g); return pushNow(g);
  }

  if (m.t === 'unlock') {
    ws.tries = (ws.tries || 0) + 1;
    if (ws.tries > 10) return send(ws, { t: 'unlocked', ok: false, msg: 'Zu viele Versuche. Lade die Seite neu.' });
    ws.admin = String(m.pw || '') === ADMIN_PW;
    send(ws, { t: 'unlocked', ok: ws.admin, msg: ws.admin ? '' : 'Falsches Passwort.' });
    if (ws.admin) sendLib(ws);
    return;
  }
  if (m.t.startsWith('lib')) { handleLib(ws, g, m); return; }
  // Einstellungen (Modus, Regeln, Karte): nur mit Passwort
  if (['mode', 'settings', 'setMap'].includes(m.t) && !ws.admin) return send(ws, { t: 'error', msg: 'Für die Einstellungen braucht es das Passwort.' });
  if (!host && !['mode', 'settings', 'setMap'].includes(m.t)) return send(ws, { t: 'error', msg: 'Nur die Spielleitung kann das ändern.' });
  switch (m.t) {
    case 'mode': if (g.phase !== 'lobby' || !MODES.includes(m.mode)) return; g.mode = m.mode; normalizeRoles(g); break;
    case 'settings': {
      if (g.phase !== 'lobby') return;
      applySettings(g.settings, m.settings || {});
      break;
    }
    case 'setMap': {
      if (g.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Die Karte kann nur vor dem Spiel geändert werden.' });
      g.map = cleanMap(m.map);
      break;
    }
    case 'role': {
      const p = g.players.get(clean(m.pid, 40));
      const ok = g.mode === 'ctf' ? ['A', 'B', 'gm'] : ['runner', 'hunter', 'gm'];
      if (!p || !ok.includes(m.role)) return;
      p.role = m.role;
      if (g.phase !== 'lobby') { if (m.role === 'runner') p.caught = false; if (m.role === 'hunter') p.ready = true; checkWin(g); }
      break;
    }
    case 'shuffle': {
      if (g.phase !== 'lobby') return;
      const ps = P(g).filter(p => !isGM(p));
      for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; }
      if (g.mode === 'ctf') ps.forEach((p, i) => { p.role = i % 2 ? 'B' : 'A'; });
      else { const n = clamp(Math.round(num(m.runners, 1)), 1, Math.max(1, ps.length - 1)); ps.forEach((p, i) => { p.role = i < n ? 'runner' : 'hunter'; }); }
      addLog(g, g.mode === 'ctf' ? 'Teams wurden ausgelost' : 'Hunter und Runner wurden ausgelost');
      ev(g, all(g), 'Rollen ausgelost! Schau nach, was du bist.', 'roll', [100, 50, 100]);
      break;
    }
    case 'catch': {
      const p = g.players.get(clean(m.pid, 40)); if (!p || !running) return;
      if (g.mode === 'ctf') { p.respawn = true; dropFlag(g, p); send(p.ws, { t: 'ev', kind: 'caught', text: 'Die Spielleitung hat dich abgeschlagen. Zurück in die Basis!', vib: [800] }); }
      else if (isRunner(p)) catchPlayer(g, p, null, 'gm');
      break;
    }
    case 'kick': { const p = g.players.get(clean(m.pid, 40)); if (!p || p === me) return; send(p.ws, { t: 'kicked' }); g.players.delete(p.pid); addLog(g, `${p.name} wurde entfernt`); checkWin(g); break; }
    case 'start': {
      if (g.phase !== 'lobby') return;
      const ps = P(g).filter(p => !isGM(p));
      if (g.mode === 'ctf') {
        if (!g.map.flags.A || !g.map.flags.B) return send(ws, { t: 'error', msg: 'Setze zuerst beide Flaggen auf der Karte.' });
        if (!ps.some(p => p.role === 'A') || !ps.some(p => p.role === 'B')) return send(ws, { t: 'error', msg: 'Beide Teams brauchen mindestens eine Person.' });
      } else if (!ps.some(isHunter) || !ps.some(isRunner)) return send(ws, { t: 'error', msg: 'Es braucht mindestens einen Hunter und einen Runner.' });
      startGame(g); break;
    }
    case 'ping': if (running) doPing(g, false); break;
    case 'stop': if (running || g.phase === 'headstart') endGame(g, 'draw', 'Die Spielleitung hat das Spiel beendet.'); break;
    case 'reset': {
      g.phase = 'lobby'; g.winner = null; g.reason = ''; g.pingSnap = {}; g.pending = new Map();
      for (const p of P(g)) { if (g.mode === 'manhunt' && p.wasRunner) p.role = 'runner'; resetPlayer(p, g); }
      addLog(g, 'Neue Runde vorbereitet'); break;
    }
    case 'host': { const p = g.players.get(clean(m.pid, 40)); if (p) { g.hostPid = p.pid; addLog(g, `${p.name} leitet jetzt das Spiel`); } break; }
    default: return;
  }
  dirty(g); pushNow(g);
}

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 20000);
setInterval(tick, 1000);
server.listen(PORT, () => console.log(`Jagd läuft auf http://localhost:${PORT}`));
