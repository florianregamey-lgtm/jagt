// Jagd – GPS-Geländespiel-Server
// Startet einen Webserver (statische Dateien aus ./public) und einen WebSocket-Server
// für die Spiellogik. Der Server ist die einzige "Wahrheit": Er kennt alle echten
// Positionen und schickt jedem Handy nur das, was dieser Spieler sehen darf.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ---------- Statische Dateien ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- Hilfsfunktionen ----------
const now = () => Date.now();
function dist(a, b) { // Meter zwischen zwei {lat,lng}
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clean = (s, n = 20) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (games.has(c));
  return c;
}

const DEFAULTS = {
  headStart: 120,     // Sekunden Vorsprung für die Gejagten
  duration: 1800,     // Spieldauer in Sekunden (nach dem Vorsprung)
  pingInterval: 90,   // alle X Sekunden werden die Gejagten aufgedeckt
  tagRadius: 12,      // Meter: so nah muss man sein, um zu fangen
  showSeekers: false, // sehen die Gejagten die Jäger?
  zoneShrink: true,   // Zone schrumpft im Lauf des Spiels
  endRadiusPct: 35,   // Zone am Schluss in % des Startradius
  capsToWin: 3,       // CTF: so viele Eroberungen zum Sieg
  baseRadius: 15,     // CTF: Radius der Basis / Flagge in Metern
};

const MODES = ['classic', 'zombie', 'ctf'];
const games = new Map();

function makeGame(hostPid) {
  return {
    code: newCode(), hostPid, mode: 'classic', settings: { ...DEFAULTS },
    zone: null, flags: { A: null, B: null },
    phase: 'lobby', startAt: 0, runAt: 0, endAt: 0, winner: null, reason: '',
    players: new Map(), pingSnap: {}, lastPing: 0, nextPing: 0, log: [], touched: now(),
  };
}

function addLog(g, text) {
  g.log.unshift({ t: now(), text });
  if (g.log.length > 40) g.log.length = 40;
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function event(g, pids, kind, text, extra = {}) {
  for (const pid of pids) { const p = g.players.get(pid); if (p) send(p.ws, { t: 'event', kind, text, ...extra }); }
}
const everyone = g => [...g.players.keys()];

// ---------- Rollen ----------
const isHunter = p => p.role === 'seeker';
const isHider = p => p.role === 'hider';
const isGM = p => p.role === 'gm';
const team = p => (p.role === 'A' || p.role === 'B' ? p.role : null);
const other = t => (t === 'A' ? 'B' : 'A');

function defaultRole(g) {
  if (g.mode === 'ctf') {
    const a = [...g.players.values()].filter(p => p.role === 'A').length;
    const b = [...g.players.values()].filter(p => p.role === 'B').length;
    return a <= b ? 'A' : 'B';
  }
  return 'hider';
}

function normalizeRoles(g) { // nach Moduswechsel Rollen passend machen
  for (const p of g.players.values()) {
    if (isGM(p)) continue;
    if (g.mode === 'ctf' && !team(p)) p.role = defaultRole(g);
    if (g.mode !== 'ctf' && team(p)) p.role = p.role === 'A' ? 'seeker' : 'hider';
  }
}

// ---------- Zone ----------
function zoneNow(g) {
  if (!g.zone) return null;
  const z = { lat: g.zone.lat, lng: g.zone.lng, r: g.zone.r, rEnd: g.zone.r };
  if (g.settings.zoneShrink) {
    z.rEnd = g.zone.r * g.settings.endRadiusPct / 100;
    if (g.phase === 'running') {
      const f = clamp((now() - g.runAt) / (g.endAt - g.runAt), 0, 1);
      z.r = g.zone.r + (z.rEnd - g.zone.r) * f;
    } else if (g.phase === 'ended') z.r = z.rEnd;
  }
  return z;
}
const outside = (g, p, z) => z && p.lat != null && dist(p, z) > z.r;

// ---------- Spielablauf ----------
function startGame(g) {
  const t = now();
  for (const p of g.players.values()) {
    p.caught = false; p.caughtAt = 0; p.carrying = null; p.respawn = false; p.caps = 0; p.tags = 0; p.wasHider = isHider(p);
  }
  g.startAt = t;
  g.runAt = t + g.settings.headStart * 1000;
  g.endAt = g.runAt + g.settings.duration * 1000;
  g.phase = g.settings.headStart > 0 ? 'headstart' : 'running';
  g.pingSnap = {}; g.lastPing = 0; g.nextPing = g.runAt + g.settings.pingInterval * 1000;
  g.flagHome = { A: true, B: true };
  g.winner = null; g.reason = '';
  addLog(g, 'Spiel gestartet');
  event(g, everyone(g), 'start', g.mode === 'ctf' ? 'Los! Holt euch die gegnerische Flagge.' :
    (g.settings.headStart > 0 ? `Los! Die Gejagten haben ${fmtSec(g.settings.headStart)} Vorsprung.` : 'Los!'), { vibrate: [300, 100, 300] });
  if (g.phase === 'running') doPing(g);
}

function fmtSec(s) { return s >= 60 ? `${Math.round(s / 60)} Min.` : `${s} Sek.`; }

function endGame(g, winner, reason) {
  if (g.phase === 'ended') return;
  g.phase = 'ended'; g.winner = winner; g.reason = reason; g.endedAt = now();
  addLog(g, reason);
  event(g, everyone(g), 'end', reason, { vibrate: [500, 200, 500, 200, 500] });
}

function doPing(g) {
  const t = now();
  g.lastPing = t; g.nextPing = t + g.settings.pingInterval * 1000;
  g.pingSnap = {};
  for (const p of g.players.values()) {
    if (p.lat == null || isGM(p)) continue;
    if (g.mode === 'ctf' || (isHider(p) && !p.caught)) g.pingSnap[p.pid] = { lat: p.lat, lng: p.lng, t: p.t };
  }
  event(g, everyone(g), 'ping', g.mode === 'ctf' ? 'Ping! Alle Positionen wurden aufgedeckt.' : 'Ping! Die Gejagten wurden aufgedeckt.', { vibrate: [150, 80, 150] });
}

function catchPlayer(g, target, by, how) {
  if (target.caught) return;
  target.caught = true; target.caughtAt = now();
  if (by) by.tags = (by.tags || 0) + 1;
  const name = target.name;
  if (g.mode === 'zombie') {
    target.role = 'seeker';
    addLog(g, by ? `${by.name} hat ${name} gefangen – jetzt ein Zombie` : `${name} ist jetzt ein Zombie`);
    event(g, [target.pid], 'caught', 'Du wurdest erwischt und bist jetzt ein Zombie. Jag die anderen!', { vibrate: [800] });
  } else {
    addLog(g, by ? `${by.name} hat ${name} gefangen` : `${name} wurde gefangen (${how})`);
    event(g, [target.pid], 'caught', 'Du wurdest gefangen.', { vibrate: [800] });
  }
  event(g, everyone(g).filter(x => x !== target.pid), 'info', by ? `${by.name} hat ${name} gefangen!` : `${name} wurde gefangen.`, { vibrate: [100] });
  checkWin(g);
}

function checkWin(g) {
  if (g.phase !== 'running' && g.phase !== 'headstart') return;
  if (g.mode === 'ctf') {
    for (const t of ['A', 'B']) {
      const caps = [...g.players.values()].filter(p => p.role === t).reduce((s, p) => s + (p.caps || 0), 0);
      if (caps >= g.settings.capsToWin) endGame(g, t, `Team ${t === 'A' ? 'Rot' : 'Blau'} gewinnt mit ${caps} Eroberungen!`);
    }
    return;
  }
  const hidersLeft = [...g.players.values()].filter(p => isHider(p) && !p.caught);
  const hunters = [...g.players.values()].filter(isHunter);
  if (hunters.length && hidersLeft.length === 0) endGame(g, 'seeker', 'Alle Gejagten wurden gefangen – die Jäger gewinnen!');
}

function teamScore(g, t) { return [...g.players.values()].filter(p => p.role === t).reduce((s, p) => s + (p.caps || 0), 0); }

function tick() {
  const t = now();
  for (const g of games.values()) {
    if (g.phase === 'headstart' && t >= g.runAt) {
      g.phase = 'running';
      event(g, everyone(g), 'run', g.mode === 'ctf' ? 'Das Spiel läuft.' : 'Vorsprung vorbei – die Jagd beginnt!', { vibrate: [400, 100, 400] });
      doPing(g);
    }
    if (g.phase === 'running') {
      if (t >= g.nextPing) doPing(g);
      if (g.mode === 'ctf') ctfTick(g);
      if (t >= g.endAt) {
        if (g.mode === 'ctf') {
          const a = teamScore(g, 'A'), b = teamScore(g, 'B');
          endGame(g, a === b ? 'draw' : (a > b ? 'A' : 'B'), a === b ? `Zeit um – unentschieden (${a}:${b}).` : `Zeit um – Team ${a > b ? 'Rot' : 'Blau'} gewinnt ${Math.max(a, b)}:${Math.min(a, b)}!`);
        } else {
          const left = [...g.players.values()].filter(p => isHider(p) && !p.caught).length;
          endGame(g, 'hider', `Zeit um – ${left} Gejagte sind entkommen. Die Gejagten gewinnen!`);
        }
      }
      // Warnung, wenn jemand die Zone verlässt
      const z = zoneNow(g);
      for (const p of g.players.values()) {
        if (isGM(p) || p.caught) continue;
        const out = outside(g, p, z);
        if (out && !p.wasOut) send(p.ws, { t: 'event', kind: 'zone', text: 'Du bist ausserhalb der Zone! Die anderen sehen dich jetzt live.', vibrate: [200, 100, 200, 100, 200] });
        p.wasOut = out;
      }
    }
    if (g.phase !== 'lobby' || g.players.size) broadcast(g);
    // Aufräumen: Spiele ohne Aktivität seit 12 Stunden löschen
    if (t - g.touched > 12 * 3600 * 1000) games.delete(g.code);
  }
}

function ctfTick(g) {
  const br = g.settings.baseRadius;
  for (const p of g.players.values()) {
    const myT = team(p);
    if (!myT || p.lat == null) continue;
    const home = g.flags[myT], enemyFlag = g.flags[other(myT)];
    if (p.respawn) {
      if (dist(p, home) <= br) { p.respawn = false; send(p.ws, { t: 'event', kind: 'info', text: 'Zurück in der Basis – du bist wieder im Spiel.', vibrate: [100, 50, 100] }); }
      continue;
    }
    // Flagge holen
    if (!p.carrying && g.flagHome[other(myT)] && dist(p, enemyFlag) <= br) {
      p.carrying = other(myT); g.flagHome[other(myT)] = false;
      addLog(g, `${p.name} hat die Flagge von Team ${other(myT) === 'A' ? 'Rot' : 'Blau'} geholt`);
      send(p.ws, { t: 'event', kind: 'flag', text: 'Du hast die Flagge! Bring sie in deine Basis.', vibrate: [300, 100, 300] });
      event(g, everyone(g).filter(x => x !== p.pid), 'info', `${p.name} hat eine Flagge geholt!`, { vibrate: [200] });
    }
    // Flagge in die eigene Basis bringen
    if (p.carrying && dist(p, home) <= br) {
      g.flagHome[p.carrying] = true; p.carrying = null; p.caps = (p.caps || 0) + 1;
      addLog(g, `${p.name} hat eine Flagge erobert (${teamScore(g, 'A')}:${teamScore(g, 'B')})`);
      event(g, everyone(g), 'score', `${p.name} erobert die Flagge! Stand Rot ${teamScore(g, 'A')} : ${teamScore(g, 'B')} Blau`, { vibrate: [300, 100, 300, 100, 300] });
      checkWin(g);
    }
  }
}

// Fang-Versuch: der Server prüft mit den echten Positionen
function tryTag(g, tagger) {
  if (g.phase !== 'running') return send(tagger.ws, { t: 'error', msg: 'Fangen geht erst, wenn die Jagd läuft.' });
  if (tagger.lat == null || now() - tagger.t > 30000) return send(tagger.ws, { t: 'error', msg: 'Dein GPS-Signal ist zu alt.' });
  let best = null, bestD = Infinity;
  for (const p of g.players.values()) {
    if (p === tagger || p.lat == null || now() - p.t > 45000) continue;
    let ok = false;
    if (g.mode === 'ctf') ok = team(tagger) && !tagger.respawn && team(p) && team(p) !== team(tagger) && !p.respawn;
    else ok = isHunter(tagger) && isHider(p) && !p.caught;
    if (!ok) continue;
    const d = dist(tagger, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  const allowed = g.settings.tagRadius + Math.min(15, (tagger.acc || 0) / 2);
  if (!best || bestD > allowed) {
    return send(tagger.ws, { t: 'event', kind: 'miss', text: best ? `Niemand in Reichweite (nächster: ${Math.round(bestD)} m).` : 'Niemand in Reichweite.' });
  }
  if (g.mode === 'ctf') {
    best.respawn = true;
    tagger.tags = (tagger.tags || 0) + 1;
    let extra = '';
    if (best.carrying) { g.flagHome[best.carrying] = true; best.carrying = null; extra = ' Die Flagge ist zurück in ihrer Basis.'; }
    addLog(g, `${tagger.name} hat ${best.name} abgeschlagen`);
    send(best.ws, { t: 'event', kind: 'caught', text: `${tagger.name} hat dich abgeschlagen. Zurück in deine Basis!${extra}`, vibrate: [800] });
    send(tagger.ws, { t: 'event', kind: 'hit', text: `Du hast ${best.name} abgeschlagen!${extra}`, vibrate: [200] });
  } else {
    send(tagger.ws, { t: 'event', kind: 'hit', text: `Du hast ${best.name} gefangen!`, vibrate: [200] });
    catchPlayer(g, best, tagger, 'gefangen');
  }
}

// ---------- Was darf wer sehen? ----------
function viewFor(g, me) {
  const z = zoneNow(g);
  const all = g.phase === 'lobby' || g.phase === 'ended' || isGM(me);
  const list = [];
  for (const p of g.players.values()) {
    const e = { pid: p.pid, name: p.name, role: p.role, online: !!(p.ws && p.ws.readyState === 1), caught: !!p.caught,
      carrying: p.carrying || null, respawn: !!p.respawn, caps: p.caps || 0, tags: p.tags || 0, host: p.pid === g.hostPid, out: false };
    let pos = null, live = false;
    const isOut = (g.phase === 'running') && outside(g, p, z) && !p.caught;
    e.out = isOut && (all || p === me);
    if (all || p === me) { live = true; }
    else if (isGM(p)) { live = false; }
    else if (g.phase === 'headstart' && g.mode !== 'ctf') {
      // Während des Vorsprungs sehen nur die Gejagten einander
      live = isHider(me) && isHider(p);
    } else if (g.mode === 'ctf') {
      if (team(p) === team(me) || p.carrying) live = true; else if (isOut) { live = true; e.out = true; }
      else if (g.pingSnap[p.pid]) pos = g.pingSnap[p.pid];
    } else {
      if (isHunter(me)) {
        if (isHunter(p)) live = true;
        else if (isHider(p) && !p.caught) { if (isOut) { live = true; e.out = true; } else if (g.pingSnap[p.pid]) pos = g.pingSnap[p.pid]; }
      } else { // ich bin gejagt
        if (isHider(p)) live = true;
        else if (isHunter(p) && g.settings.showSeekers) live = true;
      }
    }
    if (live && p.lat != null) pos = { lat: p.lat, lng: p.lng, t: p.t, acc: p.acc };
    if (pos) { e.lat = pos.lat; e.lng = pos.lng; e.t = pos.t; e.acc = pos.acc; e.live = live; }
    list.push(e);
  }
  // Nächstes Ziel in Reichweite (für den Fangen-Knopf)
  let inRange = null;
  if (g.phase === 'running' && me.lat != null) {
    let bd = Infinity;
    for (const p of g.players.values()) {
      if (p === me || p.lat == null) continue;
      const ok = g.mode === 'ctf' ? (team(me) && !me.respawn && team(p) && team(p) !== team(me) && !p.respawn) : (isHunter(me) && isHider(p) && !p.caught);
      if (!ok) continue;
      const d = dist(me, p); if (d < bd) bd = d;
    }
    // Nur grobe Distanz verraten, damit niemand "peilen" kann
    if (bd <= g.settings.tagRadius + Math.min(15, (me.acc || 0) / 2)) inRange = true;
  }
  return {
    t: 'state', serverTime: now(), code: g.code, me: me.pid, hostPid: g.hostPid, mode: g.mode, settings: g.settings,
    phase: g.phase, startAt: g.startAt, runAt: g.runAt, endAt: g.endAt, nextPing: g.nextPing, lastPing: g.lastPing,
    winner: g.winner, reason: g.reason, zone: z, flags: g.flags, flagHome: g.flagHome || { A: true, B: true },
    score: { A: teamScore(g, 'A'), B: teamScore(g, 'B') }, players: list, inRange, log: g.log.slice(0, 15),
  };
}

function broadcast(g) {
  for (const p of g.players.values()) if (p.ws && p.ws.readyState === 1) send(p.ws, viewFor(g, p));
}

// ---------- Nachrichten von den Handys ----------
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); send(ws, { t: 'error', msg: 'Interner Fehler.' }); }
  });
  ws.on('close', () => { const g = games.get(ws.code); if (g) broadcast(g); });
});

function handle(ws, m) {
  if (m.t === 'create' || m.t === 'join') {
    const pid = clean(m.pid, 40), name = clean(m.name, 20);
    if (!pid || !name) return send(ws, { t: 'error', msg: 'Bitte gib einen Namen ein.' });
    let g;
    if (m.t === 'create') { g = makeGame(pid); games.set(g.code, g); addLog(g, `${name} hat das Spiel eröffnet`); }
    else {
      g = games.get(clean(m.code, 6).toUpperCase());
      if (!g) return send(ws, { t: 'error', msg: 'Kein Spiel mit diesem Code gefunden.' });
    }
    let p = g.players.get(pid);
    if (p) { // Wiedereinstieg
      if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch {} }
      p.ws = ws; p.name = name;
    } else {
      if (g.players.size >= 150) return send(ws, { t: 'error', msg: 'Das Spiel ist voll.' });
      if (g.phase !== 'lobby' && g.phase !== 'ended') {
        // Späteinsteiger: im Klassik-/Zombie-Modus als Jäger, bei CTF ins kleinere Team
        p = { pid, name, role: g.mode === 'ctf' ? defaultRole(g) : 'seeker', ws, lat: null, lng: null, t: 0 };
      } else p = { pid, name, role: g.players.size === 0 ? 'hider' : defaultRole(g), ws, lat: null, lng: null, t: 0 };
      g.players.set(pid, p);
      if (m.t === 'join') addLog(g, `${name} ist beigetreten`);
    }
    ws.code = g.code; ws.pid = pid; g.touched = now();
    send(ws, { t: 'joined', code: g.code, pid });
    return broadcast(g);
  }

  const g = games.get(ws.code); if (!g) return;
  const me = g.players.get(ws.pid); if (!me || me.ws !== ws) return;
  g.touched = now();
  const host = me.pid === g.hostPid;

  switch (m.t) {
    case 'pos': {
      const lat = num(m.lat, null), lng = num(m.lng, null);
      if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      me.lat = lat; me.lng = lng; me.acc = clamp(num(m.acc, 50), 0, 5000); me.t = now();
      return; // wird mit dem nächsten Tick verteilt
    }
    case 'tag': return tryTag(g, me);
    case 'selfCaught':
      if (g.mode === 'ctf' || !isHider(me) || g.phase !== 'running') return;
      return catchPlayer(g, me, null, 'selbst gemeldet');
    case 'leave':
      g.players.delete(me.pid); ws.code = null;
      if (host) { const next = [...g.players.values()][0]; if (next) { g.hostPid = next.pid; addLog(g, `${next.name} leitet jetzt das Spiel`); } else games.delete(g.code); }
      return broadcast(g);
  }

  if (!host) return send(ws, { t: 'error', msg: 'Nur die Spielleitung kann das ändern.' });
  switch (m.t) {
    case 'mode':
      if (g.phase !== 'lobby' || !MODES.includes(m.mode)) return;
      g.mode = m.mode; normalizeRoles(g); break;
    case 'settings': {
      if (g.phase !== 'lobby') return;
      const s = g.settings, i = m.settings || {};
      s.headStart = clamp(Math.round(num(i.headStart, s.headStart)), 0, 1800);
      s.duration = clamp(Math.round(num(i.duration, s.duration)), 60, 6 * 3600);
      s.pingInterval = clamp(Math.round(num(i.pingInterval, s.pingInterval)), 15, 1800);
      s.tagRadius = clamp(num(i.tagRadius, s.tagRadius), 3, 50);
      s.endRadiusPct = clamp(num(i.endRadiusPct, s.endRadiusPct), 5, 100);
      s.capsToWin = clamp(Math.round(num(i.capsToWin, s.capsToWin)), 1, 20);
      s.baseRadius = clamp(num(i.baseRadius, s.baseRadius), 5, 60);
      if (typeof i.showSeekers === 'boolean') s.showSeekers = i.showSeekers;
      if (typeof i.zoneShrink === 'boolean') s.zoneShrink = i.zoneShrink;
      break;
    }
    case 'role': {
      const p = g.players.get(clean(m.pid, 40));
      const ok = g.mode === 'ctf' ? ['A', 'B', 'gm'] : ['hider', 'seeker', 'gm'];
      if (!p || !ok.includes(m.role)) return;
      if (g.phase !== 'lobby' && m.role !== 'gm' && p.role === 'gm') return; // Spielleitung bleibt im laufenden Spiel draussen
      p.role = m.role;
      if (g.phase !== 'lobby') { if (m.role === 'hider') p.caught = false; checkWin(g); }
      break;
    }
    case 'shuffle': {
      if (g.phase !== 'lobby') return;
      const ps = [...g.players.values()].filter(p => !isGM(p)).sort(() => Math.random() - 0.5);
      if (g.mode === 'ctf') ps.forEach((p, i) => { p.role = i % 2 ? 'B' : 'A'; });
      else { const n = clamp(Math.round(num(m.seekers, 1)), 1, Math.max(1, ps.length - 1)); ps.forEach((p, i) => { p.role = i < n ? 'seeker' : 'hider'; }); }
      addLog(g, 'Rollen wurden zufällig verteilt');
      break;
    }
    case 'zone': {
      if (g.phase !== 'lobby') return;
      if (m.clear) { g.zone = null; break; }
      const lat = num(m.lat, null), lng = num(m.lng, null);
      if (lat == null || lng == null) return;
      g.zone = { lat, lng, r: clamp(num(m.r, 300), 30, 20000) };
      break;
    }
    case 'flag': {
      if (g.phase !== 'lobby' || !['A', 'B'].includes(m.team)) return;
      const lat = num(m.lat, null), lng = num(m.lng, null);
      if (lat == null || lng == null) return;
      g.flags[m.team] = { lat, lng };
      break;
    }
    case 'catch': { // Spielleitung trägt einen Fang von Hand ein
      const p = g.players.get(clean(m.pid, 40));
      if (!p || g.phase !== 'running') return;
      if (g.mode === 'ctf') { p.respawn = true; if (p.carrying) { g.flagHome[p.carrying] = true; p.carrying = null; } send(p.ws, { t: 'event', kind: 'caught', text: 'Die Spielleitung hat dich abgeschlagen. Zurück in die Basis!', vibrate: [800] }); }
      else if (isHider(p)) catchPlayer(g, p, null, 'von der Spielleitung');
      break;
    }
    case 'kick': {
      const p = g.players.get(clean(m.pid, 40));
      if (!p || p === me) return;
      send(p.ws, { t: 'kicked' }); g.players.delete(p.pid); addLog(g, `${p.name} wurde entfernt`);
      checkWin(g); break;
    }
    case 'start': {
      if (g.phase !== 'lobby') return;
      const ps = [...g.players.values()].filter(p => !isGM(p));
      if (g.mode === 'ctf') {
        if (!g.flags.A || !g.flags.B) return send(ws, { t: 'error', msg: 'Setze zuerst beide Flaggen auf der Karte.' });
        if (!ps.some(p => p.role === 'A') || !ps.some(p => p.role === 'B')) return send(ws, { t: 'error', msg: 'Beide Teams brauchen mindestens eine Person.' });
      } else if (!ps.some(isHunter) || !ps.some(isHider)) return send(ws, { t: 'error', msg: 'Es braucht mindestens einen Jäger und einen Gejagten.' });
      startGame(g); break;
    }
    case 'ping': if (g.phase === 'running') doPing(g); break;
    case 'stop': if (g.phase === 'running' || g.phase === 'headstart') endGame(g, 'draw', 'Die Spielleitung hat das Spiel beendet.'); break;
    case 'reset': {
      g.phase = 'lobby'; g.winner = null; g.reason = ''; g.pingSnap = {};
      for (const p of g.players.values()) {
        p.caught = false; p.carrying = null; p.respawn = false; p.caps = 0; p.tags = 0;
        if (g.mode === 'zombie' && p.wasHider) p.role = 'hider'; // Zombies werden wieder Menschen
      }
      addLog(g, 'Neue Runde vorbereitet'); break;
    }
    case 'host': {
      const p = g.players.get(clean(m.pid, 40));
      if (p) { g.hostPid = p.pid; addLog(g, `${p.name} leitet jetzt das Spiel`); }
      break;
    }
  }
  broadcast(g);
}

// Tote Verbindungen erkennen
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 20000);
setInterval(tick, 1000);

server.listen(PORT, () => console.log(`Jagd läuft auf http://localhost:${PORT}`));

module.exports = { dist, games };
