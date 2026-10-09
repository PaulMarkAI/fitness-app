'use strict';

/* =========================================================
   Fitness-App
   Daten liegen als Markdown/JSON in einem privaten GitHub-Repository.
   Lokal (localhost) spricht die App mit werkzeuge/dev_server.py,
   der die GitHub-Schnittstelle nachbildet.
   ========================================================= */

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API = LOCAL ? '/api' : 'https://api.github.com';

const FILES = { gewicht: 'gewicht.md', masse: 'masse.md', log: 'trainingslog.md', plan: 'trainingsplan.json', kalender: 'kalender.json', bewertung: 'fotobewertung.json' };
const FOTO_RE = /^(\d{4}-\d{2}-\d{2})-(vorne|seite|hinten)\.jpg$/;
const FOTO_POS = [['vorne', 'Vorne'], ['seite', 'Seite'], ['hinten', 'Hinten']];
const HEAD = { eintraege: '## Einträge', wochen: '## Wochendurchschnitte', einheiten: '## Einheiten', saetze: '## Sätze' };
const COLS = {
  gewicht: ['Datum', 'Gewicht (kg)', 'Notiz'],
  wochen: ['Woche', 'Durchschnitt (kg)', 'Tage gemessen', 'Veränderung (kg)'],
  masse: ['Datum', 'Größe (cm)', 'Hals (cm)', 'Bauch (cm)', 'Oberarm (cm)', 'Unterarm (cm)', 'Brust (cm)', 'Oberschenkel (cm)', 'Wade (cm)', 'KFA Navy (%)', 'Notiz'],
  einheiten: ['Datum', 'Einheit', 'Ort', 'Gefühl', 'Notiz'],
  saetze: ['Datum', 'Einheit', 'Übung', 'S1 Wdh', 'S1 kg', 'S2 Wdh', 'S2 kg', 'S3 Wdh', 'S3 kg', 'ID'],
};
const TEMPLATES = {
  gewicht: '# Gewicht\n\n## Einträge\n\n## Wochendurchschnitte\n',
  masse: '# Körpermaße\n\n## Einträge\n',
  log: '# Trainingslog\n\n## Einheiten\n\n## Sätze\n',
};
const NAVY_UNSICHERHEIT = 3; // Prozentpunkte
const LAST_LABEL = { rucksack: 'kg Rucksack', stange: 'kg gesamt', scheiben: 'kg je Hand', koerper: '' };
const MAX_SETS = 3;

/* ---------- Speicher im Browser (nur Zugangsdaten und Kleinigkeiten) ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* egal */ } },
};

const cfg = {
  owner: store.get('fit.owner') || (LOCAL ? 'lokal' : ''),
  repo: store.get('fit.repo') || 'fitness-daten',
  token: store.get('fit.token') || '',
};

let S = { plan: null, weights: [], masse: [], sessions: [], sets: [] };
const ui = { tab: 'start', unit: null, ort: store.get('fit.ort') || 'zuhause', busy: false };

/* ---------- Hilfsfunktionen ---------- */
const $ = (sel) => document.querySelector(sel);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function today() { return isoDate(new Date()); }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function shortDate(s) { const d = parseDate(s); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`; }
function longDate(s) { return `${shortDate(s)}${parseDate(s).getFullYear()}`; }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); }
function monday(s) { const d = parseDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDate(d); }
function isoWeek(s) {
  const d = parseDate(s);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
}
function weekLabel(mon) {
  const w = isoWeek(mon);
  return `${w.year}-KW${w.week} (${shortDate(mon)}–${shortDate(addDays(mon, 6))})`;
}
function num(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function fmt(n, d = 1) { return n == null ? '' : n.toFixed(d).replace('.', ','); }
function fmtKg(n) { return n == null ? '' : String(Math.round(n * 100) / 100).replace('.', ','); }
function signed(x) { return Math.abs(x) < 0.05 ? '±0,0' : (x > 0 ? '+' : '') + fmt(x, 1); }
function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }
function validDate(s) { return DATE_RE.test(s) && s <= today(); }
function norm(t) { return t == null ? null : t.replace(/\r\n/g, '\n'); }

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isErr ? 5000 : 2500);
}

/* ---------- Markdown-Tabellen ---------- */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function findTable(text, heading) {
  const lines = text.split('\n');
  const h = lines.findIndex((l) => l.trim() === heading);
  if (h < 0) return { lines, h: -1 };
  let i = h + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|') && !lines[i].trim().startsWith('#')) i++;
  if (i >= lines.length || !lines[i].trim().startsWith('|')) return { lines, h, start: -1 };
  const start = i;
  let end = i;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  return { lines, h, start, end, header: splitRow(lines[start]), rows: lines.slice(start + 2, end).map(splitRow) };
}

function readTable(text, heading) {
  if (!text) return [];
  return findTable(text, heading).rows || [];
}

function cell(v) { return String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').trim(); }

function writeTable(text, heading, header, rows) {
  const table = [
    '| ' + header.join(' | ') + ' |',
    '|' + header.map(() => '---').join('|') + '|',
    ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |'),
  ];
  const t = findTable(text || '', heading);
  const lines = t.lines;
  if (t.h < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', heading, '', ...table, '');
  } else if (t.start < 0) {
    lines.splice(t.h + 1, 0, '', ...table);
  } else {
    lines.splice(t.start, t.end - t.start, ...table);
  }
  return lines.join('\n');
}

/* ---------- Daten lesen ---------- */
function parseWeights(text) {
  return readTable(text, HEAD.eintraege)
    .filter((r) => DATE_RE.test(r[0]) && num(r[1]) != null)
    .map((r) => ({ date: r[0], kg: num(r[1]), note: r[2] || '' }))
    .sort(byDate);
}

function navy(groesse, hals, bauch) {
  if (!groesse || !hals || !bauch || bauch <= hals) return null;
  // US-Navy-Formel für Männer (Hodgdon & Beckett), Werte in cm
  const kfa = 495 / (1.0324 - 0.19077 * Math.log10(bauch - hals) + 0.15456 * Math.log10(groesse)) - 450;
  return Number.isFinite(kfa) && kfa > 0 && kfa < 60 ? kfa : null;
}

// Umfänge für den Muskel-Fortschritt (monatlich, rechte Körperseite)
const UMFAENGE = [['oberarm', 'Oberarm'], ['unterarm', 'Unterarm'], ['brust', 'Brust'], ['oberschenkel', 'Oberschenkel'], ['wade', 'Wade']];

// Spalten werden über ihren Namen gefunden, damit neue Spalten alte Einträge nicht verschieben
function parseMasse(text) {
  if (!text) return [];
  const t = findTable(text, HEAD.eintraege);
  if (!t.rows) return [];
  const idx = (label) => t.header.findIndex((h) => h.toLowerCase().startsWith(label.toLowerCase()));
  const col = { groesse: idx('Größe'), hals: idx('Hals'), bauch: idx('Bauch'), kfa: idx('KFA'), note: idx('Notiz') };
  UMFAENGE.forEach(([k, label]) => { col[k] = idx(label); });
  const get = (r, k) => (col[k] >= 0 ? r[col[k]] : undefined);
  return t.rows
    .filter((r) => DATE_RE.test(r[0]))
    .map((r) => {
      const m = { date: r[0], groesse: num(get(r, 'groesse')), hals: num(get(r, 'hals')), bauch: num(get(r, 'bauch')), note: get(r, 'note') || '' };
      UMFAENGE.forEach(([k]) => { m[k] = num(get(r, k)); });
      m.kfa = num(get(r, 'kfa')) ?? navy(m.groesse, m.hals, m.bauch);
      return m;
    })
    .sort(byDate);
}

// Muskelmasse-Score aus dem FFMI (Kouri et al. 1995): normalisierter FFMI ÷ 25 (natürliche Obergrenze) × 100
function ffmiInfo() {
  const m = [...S.masse].reverse().find((x) => x.kfa != null && x.groesse);
  if (!m || !S.weights.length) return null;
  const mon = monday(m.date);
  const wk = S.weights.filter((w) => w.date >= mon && w.date <= addDays(mon, 6));
  const nearest = S.weights.reduce((best, w) =>
    Math.abs(parseDate(w.date) - parseDate(m.date)) < Math.abs(parseDate(best.date) - parseDate(m.date)) ? w : best);
  const kg = wk.length ? avgOf(wk) : nearest.kg;
  const h = m.groesse / 100;
  const calc = (kfa) => (kg * (1 - kfa / 100)) / (h * h) + 6.1 * (1.8 - h);
  const norm = calc(m.kfa);
  return {
    date: m.date, kg, kfa: m.kfa, norm,
    lo: calc(m.kfa + NAVY_UNSICHERHEIT), hi: calc(Math.max(m.kfa - NAVY_UNSICHERHEIT, 0)),
    score: Math.min(100, Math.round((norm / 25) * 100)),
  };
}

function parseLog(text) {
  const sessions = readTable(text, HEAD.einheiten)
    .filter((r) => DATE_RE.test(r[0]) && r[1])
    .map((r) => ({ date: r[0], unit: r[1], ort: r[2] || '', feel: r[3] || '', note: r[4] || '' }))
    .sort(byDate);
  const sets = readTable(text, HEAD.saetze)
    .filter((r) => DATE_RE.test(r[0]) && r[1])
    .map((r) => ({
      date: r[0], unit: r[1], name: r[2] || '', id: r[9] || r[2] || '',
      s: [[r[3], r[4]], [r[5], r[6]], [r[7], r[8]]].map(([w, k]) => ({ r: num(w), kg: num(k) })),
    }))
    .sort(byDate);
  return { sessions, sets };
}

function weekStats(ws) {
  const map = new Map();
  ws.forEach((w) => {
    const k = monday(w.date);
    const e = map.get(k) || { monday: k, sum: 0, n: 0 };
    e.sum += w.kg; e.n += 1;
    map.set(k, e);
  });
  return [...map.values()].sort((a, b) => (a.monday < b.monday ? -1 : 1)).map((e) => ({ monday: e.monday, avg: e.sum / e.n, n: e.n }));
}

/* ---------- GitHub-Schnittstelle ---------- */
class ApiError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function headers(extra = {}) {
  const h = { Accept: 'application/vnd.github+json', ...extra };
  if (!LOCAL) h.Authorization = 'Bearer ' + cfg.token;
  return h;
}
const FOTO_REPO = 'fitness-fotos'; // eigenes privates Repository nur für Körperbilder
function repoUrl(repo = cfg.repo) { return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repo)}`; }
function fileUrl(path, repo = cfg.repo) { return `${repoUrl(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`; }

async function request(url, opts = {}) {
  let r;
  try {
    r = await fetch(url, { cache: 'no-store', ...opts });
  } catch (e) {
    throw new ApiError('offline', 'Keine Verbindung. Bist du online?');
  }
  if (r.status === 401) throw new ApiError('auth', 'Der Schlüssel ist ungültig oder abgelaufen.');
  return r;
}

async function getFile(path) {
  const r = await request(fileUrl(path), { headers: headers() });
  if (r.status === 404) return { text: null, sha: null };
  if (r.status === 403) throw new ApiError('auth', 'Der Schlüssel hat keinen Zugriff auf das Repository.');
  if (!r.ok) throw new ApiError('http', `Laden fehlgeschlagen (${r.status}).`);
  const j = await r.json();
  return { text: norm(b64decode(j.content || '')), sha: j.sha };
}

async function putFile(path, text, sha, message) {
  const body = { message, content: b64encode(text) };
  if (sha) body.sha = sha;
  const r = await request(fileUrl(path), {
    method: 'PUT',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (r.status === 409 || r.status === 422) return false; // Datei hat sich zwischendurch geändert
  if (r.status === 403) throw new ApiError('auth', 'Der Schlüssel darf nicht schreiben. Prüfe die Rechte („Contents: Read and write“).');
  if (!r.ok) throw new ApiError('http', `Speichern fehlgeschlagen (${r.status}).`);
  return true;
}

// Immer frisch laden, ändern, speichern. So gehen Änderungen von Obsidian nicht verloren.
async function updateFile(path, mutate, message) {
  for (let i = 0; i < 3; i++) {
    const { text, sha } = await getFile(path);
    const next = mutate(text);
    if (await putFile(path, next, sha, message)) return next;
  }
  throw new ApiError('conflict', 'Die Datei wurde gleichzeitig woanders geändert. Bitte nochmal speichern.');
}

/* ---------- Fotos (Repository fitness-fotos) ---------- */
const FOTO_NOACCESS = 'Kein Zugriff auf „fitness-fotos“. Prüfe, ob das Repository existiert und dein Schlüssel es bei „Repository access“ enthält.';

async function fotoList() {
  const r = await request(fileUrl('fotos', FOTO_REPO), { headers: headers() });
  if (r.status === 404) {
    // leerer Ordner oder kein Zugriff: am Repository selbst unterscheiden
    const repo = await request(repoUrl(FOTO_REPO), { headers: headers() });
    if (!repo.ok) throw new ApiError('noaccess', FOTO_NOACCESS);
    return [];
  }
  if (r.status === 403) throw new ApiError('noaccess', FOTO_NOACCESS);
  if (!r.ok) throw new ApiError('http', `Fotos laden fehlgeschlagen (${r.status}).`);
  const j = await r.json();
  return Array.isArray(j) ? j.filter((f) => f.type === 'file' && FOTO_RE.test(f.name)).map((f) => f.name).sort() : [];
}

async function fotoBlob(name) {
  const url = fileUrl(`fotos/${name}`, FOTO_REPO);
  // Zeitgrenze, damit ein hängendes Foto nicht ewig „lädt“
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    if (LOCAL) {
      const j = await (await request(url, { headers: headers(), signal: ctrl.signal })).json();
      const bin = atob(j.content.replace(/\s/g, ''));
      return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: 'image/jpeg' });
    }
    const r = await request(url, { headers: headers({ Accept: 'application/vnd.github.raw' }), signal: ctrl.signal });
    if (!r.ok) throw new ApiError('http', `Foto laden fehlgeschlagen (${r.status}).`);
    return await r.blob();
  } finally {
    clearTimeout(timer);
  }
}

async function fotoUpload(name, b64) {
  const url = fileUrl(`fotos/${name}`, FOTO_REPO);
  const old = await request(url, { headers: headers() });
  const sha = old.ok ? (await old.json()).sha : null; // gleicher Tag, gleiche Ansicht: Foto ersetzen
  const body = { message: `Foto ${name}`, content: b64 };
  if (sha) body.sha = sha;
  const r = await request(url, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (r.status === 403 || r.status === 404) throw new ApiError('noaccess', FOTO_NOACCESS);
  if (!r.ok) throw new ApiError('http', `Hochladen fehlgeschlagen (${r.status}).`);
}

// Verkleinert das Foto (längste Seite 1600 px, JPEG) – ca. 200–400 KB statt mehrerer MB
async function shrinkImage(file, maxSide = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new ApiError('http', 'Das Bild konnte nicht gelesen werden.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function listDir(path) {
  const r = await request(fileUrl(path), { headers: headers() });
  if (r.status === 404) return [];
  if (r.status === 403) throw new ApiError('auth', 'Der Schlüssel hat keinen Zugriff auf das Repository.');
  if (!r.ok) throw new ApiError('http', `Laden fehlgeschlagen (${r.status}).`);
  const j = await r.json();
  return Array.isArray(j) ? j.filter((f) => f.type === 'file').map((f) => f.name) : [];
}

async function loadAll() {
  const [g, m, l, p, k, fb, dir] = await Promise.all([
    getFile(FILES.gewicht), getFile(FILES.masse), getFile(FILES.log), getFile(FILES.plan), getFile(FILES.kalender),
    getFile(FILES.bewertung), listDir('essen'),
  ]);
  if (!p.text) throw new ApiError('data', '„trainingsplan.json“ fehlt im Daten-Repository.');
  let plan;
  try { plan = JSON.parse(p.text); } catch (e) { throw new ApiError('data', '„trainingsplan.json“ ist fehlerhaft.'); }
  const log = parseLog(l.text);
  const weeks = dir.filter((n) => WEEK_FILE_RE.test(n)).sort();
  const keep = S.essen && weeks.includes(S.essen.name) ? S.essen.name : defaultWeek(weeks);
  const essen = { weeks, ...(await loadWeek(keep)) };
  let kalender = null;
  if (k.text) { try { kalender = JSON.parse(k.text); } catch (e) { /* defekt: Kachel zeigt Hinweis */ } }
  let bewertung = null;
  if (fb.text) { try { bewertung = JSON.parse(fb.text); } catch (e) { /* defekt: wird ignoriert */ } }
  // Fotos werden erst beim Öffnen des Reiters geladen (spart Datenvolumen)
  const fotos = S.fotos || { loaded: false, files: [], error: null };
  S = { plan, weights: parseWeights(g.text), masse: parseMasse(m.text), sessions: log.sessions, sets: log.sets, essen, kalender, bewertung, fotos };
}

/* ---------- Essen: Wochenrezepte und Einkaufsliste ---------- */
const WEEK_FILE_RE = /^(\d{4})-KW(\d{1,2})\.json$/;
const ABTEILUNGEN = ['Obst & Gemüse', 'Brot & Backwaren', 'Kühlregal', 'Fleisch', 'Tiefkühl', 'Konserven & Trockenware', 'Vorrat'];

function kwMonday(year, week) {
  const jan4 = new Date(year, 0, 4);
  const d = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  return isoDate(d);
}
function weekFileMonday(name) { const m = name.match(WEEK_FILE_RE); return m ? kwMonday(+m[1], +m[2]) : null; }
function selPath(name) { return `essen/${name.replace('.json', '-auswahl.json')}`; }
function emptySel() { return { auswahl: {}, gestrichen: [] }; }

// Standard: die Woche, in der heute liegt; sonst die nächste kommende; sonst die letzte vorhandene
function defaultWeek(names) {
  const t = today();
  const list = names.map((n) => ({ n, mon: weekFileMonday(n) })).sort((a, b) => (a.mon < b.mon ? -1 : 1));
  const cur = list.find((w) => w.mon <= t && t <= addDays(w.mon, 6));
  if (cur) return cur.n;
  const next = list.find((w) => w.mon > t);
  return next ? next.n : (list.length ? list[list.length - 1].n : null);
}

async function loadWeek(name) {
  if (!name) return { name: null, data: null, sel: emptySel() };
  const [w, a] = await Promise.all([getFile(`essen/${name}`), getFile(selPath(name))]);
  let data;
  try { data = JSON.parse(w.text); } catch (e) { throw new ApiError('data', `„essen/${name}“ ist fehlerhaft.`); }
  let sel = emptySel();
  if (a.text) { try { sel = { ...emptySel(), ...JSON.parse(a.text) }; } catch (e) { /* defekte Auswahl: neu anfangen */ } }
  return { name, data, sel };
}

function fmtAmount(n) { return n.toLocaleString('de-DE', { maximumFractionDigits: 2 }); }
const PLURAL = { Dose: 'Dosen', Packung: 'Packungen', Zehe: 'Zehen' };
function unitFor(einheit, n) { return n !== 1 && PLURAL[einheit] ? PLURAL[einheit] : (einheit || ''); }
function fmtEuro(n) { return n.toFixed(2).replace('.', ',') + ' €'; }

// Einkaufsliste in bis zu zwei Einkäufen:
// Einkauf 1 = großer Einkauf. Einkauf 2 = nur Frischware („frisch“ im Artikelkatalog) von Blöcken
// mit „zweiteinkauf“, weil Paul keinen Gefrierschrank hat und Fleisch nur 1–2 Tage hält.
function shoppingList(E) {
  const d = E.data;
  const trips = [new Map(), new Map()];
  const add = (z, trip) => {
    const map = trips[trip];
    const e = map.get(z.name) || { name: z.name, mengen: {} };
    const u = z.einheit || '';
    e.mengen[u] = z.menge == null ? (e.mengen[u] ?? null) : (e.mengen[u] || 0) + z.menge;
    map.set(z.name, e);
  };
  const tripFor = (b, z) => (b && b.zweiteinkauf && (d.artikel[z.name] || {}).frisch ? 1 : 0);
  const missing = [];
  const lateDays = [];
  d.bloecke.forEach((b) => {
    const g = b.gerichte.find((x) => x.id === E.sel.auswahl[b.id]);
    if (!g) { missing.push(b.name); return; }
    g.zutaten.forEach((z) => add(z, tripFor(b, z)));
    if (b.zweiteinkauf && g.zutaten.some((z) => tripFor(b, z))) lateDays.push(b.kochen);
  });
  (d.snacks || []).forEach((s) => s.zutaten.forEach((z) => add(z, 0)));

  let total = 0;
  const result = trips.map((map, ti) => {
    const groups = new Map(ABTEILUNGEN.map((a) => [a, []]));
    let sum = 0;
    for (const e of map.values()) {
      const art = d.artikel[e.name] || {};
      const abt = art.vorrat ? 'Vorrat' : (art.abteilung || 'Sonstiges');
      const menge = art.einheit != null ? e.mengen[art.einheit] : null;
      let packs = null, preis = null;
      if (!art.vorrat && menge != null && art.packung && art.preis != null) {
        packs = Math.ceil(menge / art.packung - 1e-9);
        preis = packs * art.preis;
      }
      const key = ti === 0 ? e.name : `2|${e.name}`; // Durchstreichen gilt je Einkauf getrennt
      const struck = E.sel.gestrichen.includes(key);
      if (preis != null && !struck) sum += preis;
      if (!groups.has(abt)) groups.set(abt, []);
      groups.get(abt).push({ name: e.name, key, mengen: e.mengen, art, packs, preis, struck });
    }
    groups.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name, 'de')));
    total += sum;
    return { groups, sum, empty: map.size === 0 };
  });
  return { trips: result, total, missing, lateDays };
}

function mengenText(mengen) {
  const parts = Object.entries(mengen).filter(([, m]) => m != null).map(([u, m]) => `${fmtAmount(m)}${u ? ' ' + unitFor(u, m) : ''}`);
  return parts.length ? parts.join(' + ') : 'nach Bedarf';
}

// Auswahl und Durchgestrichenes werden kurz gesammelt und dann gespeichert (nicht bei jedem Tippen)
let pendingSel = null;
let selTimer = null;
function queueSelSave() {
  pendingSel = { name: S.essen.name, sel: S.essen.sel };
  clearTimeout(selTimer);
  selTimer = setTimeout(flushSel, 800);
}
async function flushSel() {
  clearTimeout(selTimer);
  if (!pendingSel) return;
  const { name, sel } = pendingSel;
  pendingSel = null;
  try {
    await updateFile(selPath(name), () => JSON.stringify(sel, null, 2) + '\n', `Essen ${name.replace('.json', '')}: Auswahl`);
  } catch (e) {
    if (e.kind === 'auth') return logout(e.message);
    toast('Auswahl nicht gespeichert: ' + e.message, true);
  }
}

async function switchEssenWeek(step) {
  const E = S.essen;
  const i = E.weeks.indexOf(E.name) + step;
  if (i < 0 || i >= E.weeks.length) return;
  await flushSel();
  try {
    S.essen = { weeks: E.weeks, ...(await loadWeek(E.weeks[i])) };
    render();
  } catch (e) {
    if (e.kind === 'auth') return logout(e.message);
    toast(e.message, true);
  }
}

/* ---------- Training: Logik ---------- */
function nextUnit() {
  const order = S.plan.reihenfolge;
  const last = S.sessions[S.sessions.length - 1];
  if (!last) return order[0];
  const i = order.indexOf(last.unit);
  return order[(i + 1) % order.length];
}

function lastSets(exId, date, unit) {
  for (let i = S.sets.length - 1; i >= 0; i--) {
    const s = S.sets[i];
    if (s.id !== exId) continue;
    if (s.date === date && s.unit === unit) continue; // die Einheit, die gerade bearbeitet wird
    if (s.date > date) continue;
    return s;
  }
  return null;
}

function setsText(row, ex) {
  const done = row.s.filter((x) => x.r != null);
  if (!done.length) return '–';
  const reps = done.map((x) => x.r).join(' / ');
  if (ex.last === 'koerper') return reps;
  const kgs = [...new Set(done.map((x) => fmtKg(x.kg ?? 0)))];
  if (kgs.length === 1) return `${reps} · ${kgs[0]} ${LAST_LABEL[ex.last]}`;
  return done.map((x) => `${x.r}×${fmtKg(x.kg ?? 0)}`).join(' / ') + ' kg';
}

function readyToProgress(row, ex) {
  if (!row) return false;
  const planned = row.s.slice(0, ex.saetze);
  return planned.length === ex.saetze && planned.every((x) => x.r != null && x.r >= ex.wdh[1]);
}

/* ---------- Ansichten ---------- */
const ICONS = {
  start: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
  training: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 7v10M18 7v10M3 9v6M21 9v6M6 12h12"/></svg>',
  essen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v18M4 3v5a3 3 0 0 0 6 0V3M17 21V3c-2.5 1.5-4 4-4 7v3h4"/></svg>',
  masse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8" width="20" height="8" rx="2"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/></svg>',
  fotos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
};
const TABS = [['start', 'Übersicht'], ['training', 'Training'], ['essen', 'Essen'], ['masse', 'Maße'], ['fotos', 'Fotos']];

function render(opts = {}) {
  const views = { start: viewStart, training: viewTraining, essen: viewEssen, masse: viewMasse, fotos: viewFotos };
  const scroll = window.scrollY;
  const title = TABS.find((t) => t[0] === ui.tab)[1];
  $('#app').innerHTML = `
    <header class="top">
      <h1>${title}</h1>
      <div class="right">
        ${LOCAL ? '<span class="badge">Lokal (Test)</span>' : ''}
        <button class="ghost" data-action="reload" aria-label="Neu laden">↻</button>
        ${LOCAL ? '' : '<button class="ghost" data-action="logout">Abmelden</button>'}
      </div>
    </header>
    <main>${views[ui.tab]()}</main>
    <nav class="tabs"><div class="inner">
      ${TABS.map(([k, l]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${ICONS[k]}${l}</button>`).join('')}
    </div></nav>`;
  if (ui.tab === 'masse') updateNavyPreview();
  if (ui.tab === 'fotos') {
    if (!S.fotos.loaded && !ui.fotosLoading) { ui.fotosLoading = true; loadFotos().finally(() => { ui.fotosLoading = false; }); }
    else hydrateFotos();
  }
  window.scrollTo(0, opts.keep ? scroll : 0);
}

/* Übersicht */
const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEK_RANGE = 3; // kg, feste Höhe des Wochendiagramms

function avgOf(list) { return list.length ? list.reduce((s, w) => s + w.kg, 0) / list.length : null; }

function weekBounds() {
  const ws = S.weights;
  const cur = monday(today());
  return { cur, first: ws.length ? monday(ws[0].date) : cur };
}

function shiftWeek(n) {
  const { cur, first } = weekBounds();
  const next = addDays(ui.wWeek || cur, 7 * n);
  if (next > cur || next < first) return;
  Object.assign(ui, { wWeek: next, wSel: null, wEdit: null, wDel: null });
  render({ keep: true });
}

function weekCard() {
  const ws = S.weights;
  const t = today();
  const { cur, first } = weekBounds();
  if (!ui.wWeek) ui.wWeek = cur;
  const mon = ui.wWeek;
  const sun = addDays(mon, 6);
  const inWeek = ws.filter((w) => w.date >= mon && w.date <= sun);
  const avg = avgOf(inWeek);
  const prevAvg = avgOf(ws.filter((w) => w.date >= addDays(mon, -7) && w.date < mon));
  const byDay = new Map(inWeek.map((w) => [w.date, w]));
  // Angezeigter Tag: der angetippte, sonst heute, sonst der letzte gemessene Tag der Woche
  const fallback = byDay.has(t) ? t : (inWeek.length ? inWeek[inWeek.length - 1].date : null);
  const shown = ui.wSel && byDay.has(ui.wSel) ? ui.wSel : fallback;
  const day = shown ? byDay.get(shown) : null;
  const w = isoWeek(mon);

  let info = '';
  if (day && ui.wEdit === day.date) {
    info = `<div class="day-info">
      <span>${WEEKDAY_SHORT[parseDate(day.date).getDay()]}, ${shortDate(day.date)}</span>
      <div class="unit-in" style="width:110px"><input id="we-kg" inputmode="decimal" value="${fmt(day.kg, 1)}" aria-label="Neues Gewicht"><em>kg</em></div>
      <span class="acts"><button class="primary" data-action="wedit-save" data-date="${day.date}">OK</button><button data-action="wedit-cancel">Abbrechen</button></span>
    </div>`;
  } else if (day && ui.wDel === day.date) {
    info = `<div class="day-info">
      <span>${fmt(day.kg, 1)} kg vom ${shortDate(day.date)} löschen?</span>
      <span class="acts"><button class="danger" data-action="wdel-yes" data-date="${day.date}">Löschen</button><button data-action="wdel-no">Nein</button></span>
    </div>`;
  } else if (day) {
    info = `<div class="day-info">
      <span>${day.date === t ? 'Heute' : WEEKDAY_SHORT[parseDate(day.date).getDay()]}, ${shortDate(day.date)}: <b>${fmt(day.kg, 1)} kg</b></span>
      <span class="acts"><button class="ghost" data-action="wedit" data-date="${day.date}">Ändern</button><button class="ghost" data-action="wdel" data-date="${day.date}">Löschen</button></span>
    </div>`;
  }

  return `
    <div class="week-nav">
      <button class="ghost nav" data-action="wprev" ${mon > first ? '' : 'disabled'} aria-label="Vorherige Woche">‹</button>
      <div class="center">
        <p class="label">Gewicht · ${mon === cur ? 'diese Woche' : 'Wochenschnitt'}</p>
        <div class="wk">KW ${w.week} · ${shortDate(mon)}–${shortDate(sun)}</div>
      </div>
      <button class="ghost nav" data-action="wnext" ${mon < cur ? '' : 'disabled'} aria-label="Nächste Woche">›</button>
    </div>
    <div class="center-big">
      ${avg != null ? `<span class="big">${fmt(avg, 1)} kg</span>` : '<span class="muted">Keine Werte in dieser Woche</span>'}
      <p class="label">${avg != null && prevAvg != null ? `<span class="${avg - prevAvg > 0 ? 'up' : 'down'}">${signed(avg - prevAvg)} kg zur Vorwoche</span> · ` : ''}${inWeek.length} ${inWeek.length === 1 ? 'Tag' : 'Tage'} gemessen</p>
    </div>
    ${weekChart(mon, byDay, avg, shown, t)}
    ${info}`;
}

// Gewicht eintragen: nur ein Knopf, das Formular klappt erst beim Antippen auf
function weightAdd() {
  const ws = S.weights;
  const t = today();
  const todayEntry = ws.find((w) => w.date === t);
  if (!ui.wAdd) {
    return `<button class="full ${todayEntry ? '' : 'primary'}" data-action="wadd">+ Gewicht${todayEntry ? '' : ' für heute'} eintragen</button>`;
  }
  return `<div class="add-form">
    ${todayEntry ? `<p class="label">Heute schon eingetragen: ${fmt(todayEntry.kg, 1)} kg. Ein neuer Wert überschreibt ihn.</p>` : '<p class="label">Morgens, nach der Toilette, vor dem Essen.</p>'}
    <div class="row" style="margin-top:8px">
      <input id="w-date" type="date" value="${t}" max="${t}" class="grow" aria-label="Datum">
      <div class="unit-in grow"><input id="w-kg" inputmode="decimal" placeholder="${ws.length ? fmt(ws[ws.length - 1].kg, 1) : '74,5'}" aria-label="Gewicht in kg"><em>kg</em></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="grow" data-action="wadd-cancel">Abbrechen</button>
      <button class="primary grow" data-action="save-weight">Speichern</button>
    </div>
  </div>`;
}

// Kalender-Kachel: zeigt den heutigen Tag aus kalender.json (Stand der letzten Wochenplanung)
function calTile() {
  const open = !!ui.calOpen;
  const head = `<div class="cal-head" data-action="cal-toggle" role="button" aria-expanded="${open}">
      <span class="cal-title">Kalender</span><span class="chev ${open ? 'open' : ''}" aria-hidden="true">›</span>
    </div>`;
  if (!open) return `<section class="card cal">${head}</section>`;

  const K = S.kalender;
  const t = today();
  const now = new Date();
  const nowHM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  let body;
  if (!K || !K.tage || t < K.von || t > K.bis) {
    body = '<p class="muted small" style="margin:8px 0 0">Für heute liegen keine Kalenderdaten vor. Schreib Claude „Wochenplanung“, dann werden sie aktualisiert.</p>';
  } else {
    const items = (K.tage[t] || []).slice().sort((a, b) => (a.ganztags ? -1 : b.ganztags ? 1 : a.start < b.start ? -1 : 1));
    body = items.length ? `<ul class="cal-list">${items.map((e) => `
        <li class="${!e.ganztags && e.ende <= nowHM ? 'past' : ''}">
          <span class="bar ${esc(e.farbe || 'gruen')}"></span>
          <span class="time">${e.ganztags ? 'ganztägig' : `${esc(e.start)}–${esc(e.ende)}`}</span>
          <span class="grow">${esc(e.titel)}</span>
        </li>`).join('')}</ul>`
      : '<p class="muted small" style="margin:8px 0 0">Heute keine Einträge.</p>';
  }
  const stand = K && K.stand ? `${shortDate(K.stand.slice(0, 10))}, ${K.stand.slice(11, 16)} Uhr` : '–';
  return `<section class="card cal">${head}
    <p class="label" style="margin-top:6px">Heute, ${WEEKDAY_SHORT[parseDate(t).getDay()]} ${shortDate(t)}</p>
    ${body}
    <p class="label small" style="margin-top:8px">Stand: ${stand} · wird bei jeder Wochenplanung aktualisiert</p>
  </section>`;
}

function viewStart() {
  const ws = S.weights;
  const nu = nextUnit();
  const lastSession = S.sessions[S.sessions.length - 1];

  const weightCard = ws.length ? weekCard()
    : '<p class="label">Gewicht</p><p class="muted">Noch keine Werte. Trag dein erstes Gewicht ein.</p>';

  return `
    <section class="card" id="wcard">${weightCard}${weightAdd()}</section>
    ${shopTile()}
    ${calTile()}
    <section class="card">
      <div class="row between">
        <div>
          <p class="label">Nächste Einheit</p>
          <div style="font-size:20px;font-weight:600">${esc(S.plan.einheiten[nu].name)}</div>
          <p class="label">${lastSession ? `Zuletzt: ${esc(lastSession.unit)} am ${longDate(lastSession.date)}` : 'Noch keine Einheit eingetragen'}</p>
        </div>
        <button class="primary" data-action="go-training" data-unit="${esc(nu)}">Starten</button>
      </div>
    </section>`;
}

// Wochendiagramm: 7 feste Spalten Mo–So, feste Höhe von WEEK_RANGE kg um den Wochenschnitt.
// Nur der angezeigte Tag bekommt eine Zahl; die anderen Punkte zeigen ihren Wert beim Antippen.
function weekChart(mon, byDay, avg, shown, t) {
  const W = 320, H = 170, pl = 34, pr = 8, pt = 26, pb = 24;
  const ws = S.weights;
  const ref = avg ?? (ws.length ? ws[ws.length - 1].kg : 75);
  const center = Math.round(ref * 2) / 2;
  const lo = center - WEEK_RANGE / 2;
  const hi = center + WEEK_RANGE / 2;
  const colW = (W - pl - pr) / 7;
  const x = (i) => pl + (i + 0.5) * colW;
  const y = (k) => pt + ((hi - Math.min(Math.max(k, lo), hi)) / (hi - lo)) * (H - pt - pb);
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const pts = days.map((d, i) => (byDay.has(d) ? { i, d, kg: byDay.get(d).kg } : null)).filter(Boolean);

  const grid = [hi, center, lo].map((k) => `
    <line x1="${pl}" y1="${y(k).toFixed(1)}" x2="${W - pr}" y2="${y(k).toFixed(1)}" stroke="#232a33"/>
    <text x="${pl - 6}" y="${(y(k) + 3.5).toFixed(1)}" text-anchor="end">${fmt(k, 1)}</text>`).join('');
  const avgLine = avg != null
    ? `<line x1="${pl}" y1="${y(avg).toFixed(1)}" x2="${W - pr}" y2="${y(avg).toFixed(1)}" stroke="#2dd4a7" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.8"/>`
    : '';
  const line = pts.length > 1
    ? `<polyline points="${pts.map((p) => `${x(p.i).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ')}" fill="none" stroke="#4a5564" stroke-width="1.5" stroke-linejoin="round"/>`
    : '';
  const dots = pts.map((p) => {
    const cx = x(p.i).toFixed(1), cy = y(p.kg).toFixed(1);
    if (p.d !== shown) return `<circle cx="${cx}" cy="${cy}" r="4.5" fill="#8a94a1"/>`;
    const ly = Math.max(y(p.kg) - 12, 12).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="6.5" fill="#2dd4a7" stroke="#0e1115" stroke-width="2"/>
      <text class="val" x="${cx}" y="${ly}" text-anchor="middle">${fmt(p.kg, 1)}</text>`;
  }).join('');
  const labels = days.map((d, i) =>
    `<text class="${d === t ? 'today' : ''}" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${WEEKDAY_SHORT[parseDate(d).getDay()]}</text>`).join('');
  // unsichtbare Tippflächen über die ganze Spaltenhöhe, damit man den Punkt nicht genau treffen muss
  const hits = pts.map((p) =>
    `<rect class="hit" data-action="wsel" data-date="${p.d}" x="${(pl + p.i * colW).toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="${H}" fill="transparent"/>`).join('');

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewicht dieser Woche">
      ${grid}${avgLine}${line}${dots}${labels}${hits}
    </svg>
    <div class="legend"><span><i style="background:#8a94a1"></i>Tageswert (antippen)</span><span><i style="background:#2dd4a7"></i>Wochenschnitt (gestrichelt)</span></div>`;
}

/* Training */
function unitExercises(u) {
  const E = S.plan.einheiten[u];
  const hasOrt = E.uebungen.some((e) => e.nur);
  return { E, hasOrt, exs: E.uebungen.filter((e) => !e.nur || e.nur === ui.ort) };
}

function viewTraining() {
  const order = S.plan.reihenfolge;
  const nu = nextUnit();
  if (!ui.unit || !S.plan.einheiten[ui.unit]) ui.unit = nu;
  const u = ui.unit;
  const { E, hasOrt, exs } = unitExercises(u);
  const date = ui.tDate || today();
  const done = S.sessions.find((s) => s.date === date && s.unit === u);

  const cards = exs.map((ex) => {
    const last = lastSets(ex.id, date, u);
    const prog = readyToProgress(last, ex);
    // schon gespeicherte Werte dieser Einheit (beim erneuten Öffnen) vorausfüllen
    const saved = done ? S.sets.find((s) => s.date === date && s.unit === u && s.id === ex.id) : null;
    const lastKg = (i) => {
      if (saved && saved.s[i] && saved.s[i].kg != null) return saved.s[i].kg;
      if (last && last.s[i] && last.s[i].kg != null) return last.s[i].kg;
      if (last && last.s[0] && last.s[0].kg != null) return last.s[0].kg;
      return ex.start ?? 0;
    };
    const rows = Array.from({ length: Math.min(ex.saetze, MAX_SETS) }, (_, i) => {
      const ph = last && last.s[i] && last.s[i].r != null ? last.s[i].r : '';
      const val = saved && saved.s[i] && saved.s[i].r != null ? saved.s[i].r : '';
      return `<div class="set ${ex.last === 'koerper' ? 'nokg' : ''}">
        <span class="n">Satz ${i + 1}</span>
        <div class="unit-in"><input inputmode="numeric" data-r="${esc(ex.id)}" data-i="${i}" value="${val}" placeholder="${ph}" aria-label="${esc(ex.name)} Satz ${i + 1} Wiederholungen"><em>Wdh</em></div>
        ${ex.last === 'koerper' ? '' : `<div class="unit-in"><input inputmode="decimal" data-k="${esc(ex.id)}" data-i="${i}" value="${fmtKg(lastKg(i))}" aria-label="${esc(ex.name)} Satz ${i + 1} Gewicht"><em>kg</em></div>`}
      </div>`;
    }).join('');
    return `<section class="card">
      <div class="ex-head"><h2>${esc(ex.name)}</h2><span class="pill">${ex.saetze} × ${ex.wdh[0]}–${ex.wdh[1]}</span></div>
      <p class="label">${last ? `Letztes Mal (${shortDate(last.date)}): ${esc(setsText(last, ex))}` : 'Noch kein Eintrag'}${ex.last !== 'koerper' ? ` · Gewicht = ${LAST_LABEL[ex.last]}` : ''} · Pause ${fmtKg((ex.pause || 120) / 60)} Min.</p>
      ${prog ? `<div class="hint">Alle Sätze am oberen Ende geschafft. Jetzt steigern: ${esc(ex.steigerung)}</div>` : ''}
      ${rows}
      <details><summary>Technik und Steigerung</summary><p>${esc(ex.technik)}</p><p class="muted">Steigerung: ${esc(ex.steigerung)}</p></details>
    </section>`;
  }).join('');

  return `
    <div class="seg" role="tablist">
      ${order.map((k) => `<button data-action="unit" data-unit="${esc(k)}" class="${k === u ? 'on' : ''}">${esc(k)}${k === nu ? '<span class="dot" title="Nächste Einheit"></span>' : ''}</button>`).join('')}
    </div>
    ${hasOrt ? `<div class="seg">
      <button data-action="ort" data-ort="zuhause" class="${ui.ort === 'zuhause' ? 'on' : ''}">Zu Hause</button>
      <button data-action="ort" data-ort="park" class="${ui.ort === 'park' ? 'on' : ''}">Park</button>
    </div>` : ''}
    <section class="card">
      <div class="row between">
        <div><p class="label">${esc(E.name)} · ${esc(hasOrt ? (ui.ort === 'park' ? 'Park' : 'zu Hause') : E.ort)}</p>
        <p class="label">1–2 Wiederholungen in Reserve lassen.</p></div>
      </div>
      <label class="field"><span>Datum</span><input id="t-date" type="date" value="${date}" max="${today()}"></label>
      ${done ? '<p class="label" style="margin-top:6px">Für dieses Datum ist die Einheit schon gespeichert. Speichern überschreibt sie.</p>' : ''}
    </section>
    ${(S.plan.aufwaermen || []).length ? `<section class="card warmup">
      <h2>Aufwärmen · ca. 8 Min.</h2>
      <ol class="steps">${S.plan.aufwaermen.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </section>` : ''}
    ${cards}
    <section class="card">
      <h2>Abschluss</h2>
      <label class="field"><span>Wie war es?</span>
        <select id="t-feel"><option value="">bitte wählen</option>${['leicht', 'okay', 'schwer'].map((f) => `<option${done && done.feel === f ? ' selected' : ''}>${f}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Notiz (optional)</span><textarea id="t-note" placeholder="z. B. Schulter hat gezogen, wenig geschlafen">${done ? esc(done.note) : ''}</textarea></label>
      <button class="primary full" data-action="save-training">Einheit speichern</button>
    </section>`;
}

/* Essen */
function dishMeta(p) {
  return `${fmtAmount(p.kcal)} kcal · ${fmtAmount(p.protein)} g Protein · ca. ${fmtEuro(p.preis)}`;
}

function recipeDetails(g, label = 'Rezept anzeigen') {
  return `<details><summary>${label}</summary>
    <p class="small muted">Zutaten (${g.portionenText || 'für den ganzen Block'}):</p>
    <ul class="ing">${g.zutaten.map((z) => `<li>${z.menge != null ? `${fmtAmount(z.menge)} ${esc(unitFor(z.einheit, z.menge))} ` : ''}${esc(z.name)}${z.hinweis ? ` <span class="muted">(${esc(z.hinweis)})</span>` : ''}</li>`).join('')}</ul>
    ${g.schritte ? `<ol class="steps">${g.schritte.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${g.anleitung ? `<p>${esc(g.anleitung)}</p>` : ''}
    ${g.aufbewahrung ? `<p class="small muted">Aufbewahrung: ${esc(g.aufbewahrung)}</p>` : ''}
  </details>`;
}

function viewEssen() {
  const E = S.essen;
  if (!E || !E.data) {
    return `<section class="card"><h2>Noch keine Rezepte</h2>
      <p class="muted">Schreib Claude im Chat „Wochenplanung“. Sobald die Rezepte fertig sind, erscheinen sie hier.</p></section>`;
  }
  const d = E.data;
  const i = E.weeks.indexOf(E.name);
  const wk = isoWeek(d.von);

  const blocks = d.bloecke.map((b) => {
    const chosen = E.sel.auswahl[b.id];
    return `<section class="card">
      <div class="ex-head"><h2>${esc(b.name)} · ${esc(b.tage)}</h2><span class="pill">${b.portionen} Portionen</span></div>
      <p class="label">Kochen: ${esc(b.kochen)}${chosen ? '' : ' · <span class="up">bitte ein Gericht wählen</span>'}</p>
      ${b.gerichte.map((g) => `
        <div class="dish ${chosen === g.id ? 'on' : ''}">
          <div class="dish-head" data-action="pick" data-block="${esc(b.id)}" data-dish="${esc(g.id)}" role="button" aria-pressed="${chosen === g.id}">
            <span class="radio" aria-hidden="true"></span>
            <div class="grow">
              <div class="dish-name">${esc(g.name)}</div>
              <div class="label">${dishMeta(g.portion)} pro Portion · ${g.zeit} Min.</div>
              ${g.kurz ? `<div class="small muted">${esc(g.kurz)}</div>` : ''}
            </div>
          </div>
          ${recipeDetails({ ...g, portionenText: `für ${b.portionen} Portionen` })}
        </div>`).join('')}
    </section>`;
  }).join('');

  const snacks = (d.snacks || []).length ? `<section class="card">
      <h2>Snacks</h2>
      <p class="label">Ca. 3 pro Tag. Die Mengen sind schon in der Einkaufsliste.</p>
      ${d.snacks.map((s) => `<div class="dish">
        <div class="dish-name">${esc(s.name)} <span class="muted small">· ${s.proWoche}× pro Woche</span></div>
        <div class="label">${dishMeta(s.portion)} pro Portion</div>
        ${recipeDetails({ ...s, portionenText: `für ${s.proWoche} Portionen` }, 'So geht’s')}
      </div>`).join('')}
    </section>` : '';

  return `
    <div class="week-nav">
      <button class="ghost nav" data-action="eprev" ${i > 0 ? '' : 'disabled'} aria-label="Vorherige Woche">‹</button>
      <div class="center">
        <p class="label">Rezepte</p>
        <div class="wk">KW ${wk.week} · ${shortDate(d.von)}–${shortDate(d.bis)}</div>
      </div>
      <button class="ghost nav" data-action="enext" ${i < E.weeks.length - 1 ? '' : 'disabled'} aria-label="Nächste Woche">›</button>
    </div>
    ${d.tagesrahmen || d.hinweis ? `<section class="card">
      ${d.tagesrahmen ? `<p class="small" style="margin:0">${esc(d.tagesrahmen)}</p>` : ''}
      ${d.hinweis ? `<p class="label" style="margin-top:6px">${esc(d.hinweis)}</p>` : ''}
    </section>` : ''}
    ${blocks}
    ${snacks}
    <p class="label" style="text-align:center;margin-top:14px">Die Einkaufsliste findest du in der Übersicht.</p>`;
}

// Einkaufsliste als aufklappbare Kachel in der Übersicht (Woche wie im Bereich „Essen“)
function shopTile() {
  const open = !!ui.shopOpen;
  const E = S.essen;
  const head = `<div class="cal-head" data-action="shop-toggle" role="button" aria-expanded="${open}">
      <span class="cal-title">Einkaufsliste</span><span class="chev ${open ? 'open' : ''}" aria-hidden="true">›</span>
    </div>`;
  if (!open) return `<section class="card cal">${head}</section>`;
  if (!E || !E.data) {
    return `<section class="card cal">${head}
      <p class="muted small" style="margin:8px 0 0">Noch keine Rezepte. Schreib Claude „Wochenplanung“.</p></section>`;
  }
  const sl = shoppingList(E);
  const wk = isoWeek(E.data.von);
  const listOf = (groups) => [...groups.entries()].filter(([, items]) => items.length).map(([abt, items]) => `
    <h3 class="abt">${esc(abt)}</h3>
    ${abt === 'Vorrat' ? '<p class="label">Hast du das noch? Sonst mitnehmen.</p>' : ''}
    <ul class="shop">${items.map((it) => `
      <li class="${it.struck ? 'struck' : ''}" data-action="strike" data-name="${esc(it.key)}" role="button" aria-pressed="${it.struck}">
        <span class="check" aria-hidden="true">${it.struck ? '✓' : ''}</span>
        <span class="grow"><span class="it-name">${esc(it.name)}</span>
          <span class="label">${mengenText(it.mengen)}${it.packs ? ` → kaufen: ${it.art.packung === 1 ? `${it.packs} ${esc(unitFor(it.art.einheit, it.packs))}` : `${it.packs}× ${fmtAmount(it.art.packung)} ${esc(it.art.einheit)}`}` : ''}</span></span>
        ${it.preis != null ? `<span class="price">${fmtEuro(it.preis)}</span>` : ''}
      </li>`).join('')}</ul>`).join('');
  return `<section class="card cal">${head}
    <div class="row between" style="margin-top:6px">
      <span class="label">KW ${wk.week} · ${shortDate(E.data.von)}–${shortDate(E.data.bis)}</span>
      <span class="price big-price">ca. ${fmtEuro(sl.total)}</span>
    </div>
    <p class="label">Tippe an, was du schon hast. Preise sind Schätzungen für Edeka, ganze Packungen.</p>
    ${sl.missing.length ? `<p class="hint warn">Noch nicht gewählt: ${sl.missing.map(esc).join(', ')}. Die Gerichte wählst du unter „Essen“.</p>` : ''}
    ${sl.trips[1].empty ? listOf(sl.trips[0].groups) : `
      <div class="trip"><span>Einkauf 1 · großer Einkauf</span><span class="price">ca. ${fmtEuro(sl.trips[0].sum)}</span></div>
      ${listOf(sl.trips[0].groups)}
      <div class="trip"><span>Einkauf 2 · am ${esc(sl.lateDays[0])} vor dem Kochen</span><span class="price">ca. ${fmtEuro(sl.trips[1].sum)}</span></div>
      <p class="label">Nur Frischfleisch – hält ohne Gefrierschrank nur 1–2 Tage.</p>
      ${listOf(sl.trips[1].groups)}`}
  </section>`;
}

/* Maße */
function viewMasse() {
  const t = today();
  const last = S.masse[S.masse.length - 1];
  const hist = S.masse.slice().reverse();
  return `
    ${last && last.kfa != null ? `<section class="card">
      <p class="label">Körperfett · letzte Messung ${longDate(last.date)}</p>
      <div class="big">${fmt(Math.max(last.kfa - NAVY_UNSICHERHEIT, 0), 0)}–${fmt(last.kfa + NAVY_UNSICHERHEIT, 0)} %</div>
      <p class="label">Navy-Methode, Rechenwert ${fmt(last.kfa, 1)} %, Unsicherheit ca. ±${NAVY_UNSICHERHEIT} Prozentpunkte</p>
    </section>` : ''}
    <section class="card">
      <h2>Maße eintragen</h2>
      <p class="label">Einmal im Monat, morgens. Bauch entspannt auf Höhe des Bauchnabels, Hals direkt unter dem Kehlkopf.</p>
      <label class="field"><span>Datum</span><input id="m-date" type="date" value="${t}" max="${t}"></label>
      <label class="field"><span>Größe</span><div class="unit-in"><input id="m-groesse" inputmode="decimal" value="${last && last.groesse ? fmtKg(last.groesse) : ''}" placeholder="z. B. 175"><em>cm</em></div></label>
      <label class="field"><span>Hals</span><div class="unit-in"><input id="m-hals" inputmode="decimal" placeholder="${last && last.hals ? fmtKg(last.hals) : 'z. B. 37,5'}"><em>cm</em></div></label>
      <label class="field"><span>Bauch</span><div class="unit-in"><input id="m-bauch" inputmode="decimal" placeholder="${last && last.bauch ? fmtKg(last.bauch) : 'z. B. 82'}"><em>cm</em></div></label>
      <h3 class="abt">Umfänge für den Muskel-Fortschritt</h3>
      <p class="label">Rechte Seite, stehend. Oberarm angespannt an der dicksten Stelle, Unterarm und Wade entspannt an der dicksten Stelle, Brust entspannt auf Höhe der Brustwarzen nach normalem Ausatmen, Oberschenkel entspannt direkt unter der Gesäßfalte.</p>
      <div class="umf-grid">
        ${UMFAENGE.map(([k, label]) => `<label class="field"><span>${label}</span><div class="unit-in"><input id="m-${k}" inputmode="decimal" placeholder="${last && last[k] ? fmtKg(last[k]) : ''}"><em>cm</em></div></label>`).join('')}
      </div>
      <label class="field"><span>Notiz (optional)</span><input id="m-note"></label>
      <div class="card" style="background:var(--surface-2);margin-top:12px">
        <p class="label">Körperfett (Navy-Methode)</p>
        <div id="m-preview" class="big">–</div>
        <p class="label">Unsicherheit ca. ±${NAVY_UNSICHERHEIT} Prozentpunkte. Für den Verlauf zählt der Trend, nicht der Einzelwert.</p>
      </div>
      <button class="primary full" data-action="save-masse">Speichern</button>
    </section>
    ${hist.length ? `<section class="card"><h2>Verlauf</h2><ul class="list">
      ${hist.map((m) => `<li><span>${longDate(m.date)}</span><span class="muted">Bauch ${fmtKg(m.bauch)} · Hals ${fmtKg(m.hals)}</span><span>${m.kfa != null ? fmt(m.kfa, 1) + ' %' : '–'}</span></li>`).join('')}
    </ul></section>` : ''}`;
}

function updateNavyPreview() {
  const el = $('#m-preview');
  if (!el) return;
  const k = navy(num($('#m-groesse').value), num($('#m-hals').value), num($('#m-bauch').value));
  el.textContent = k == null ? '–' : `${fmt(Math.max(k - NAVY_UNSICHERHEIT, 0), 0)}–${fmt(k + NAVY_UNSICHERHEIT, 0)} % (${fmt(k, 1)} %)`;
}

/* Fotos */
function fotoDates() {
  return [...new Set(S.fotos.files.map((n) => n.match(FOTO_RE)[1]))].sort();
}

function fotoImg(name, cls = '') {
  return name ? `<img class="foto ${cls}" data-foto="${esc(name)}" alt="Foto ${esc(name)}">` : '<div class="foto empty">kein Foto</div>';
}

function viewFotos() {
  const F = S.fotos;
  const t = today();
  const upload = `<section class="card">
    <h2>Foto hinzufügen</h2>
    <p class="label">Einmal pro Woche, gleiches Licht, gleiche Uhrzeit (am besten morgens), gleiche Haltung.</p>
    <div class="row" style="margin-top:10px">
      ${FOTO_POS.map(([k, l]) => {
        const done = F.files.includes(`${t}-${k}.jpg`);
        return `<button class="grow ${done ? '' : 'primary'}" data-action="foto-pick" data-pos="${k}">${done ? '✓ ' : '+ '}${l}</button>
          <input type="file" accept="image/*" data-pos="${k}" hidden>`;
      }).join('')}
    </div>
    <p class="label" style="margin-top:8px">Fotos von heute ersetzen das alte Foto derselben Ansicht.</p>
  </section>`;

  if (!F.loaded) return upload + '<p class="loading" style="margin-top:20px">Fotos werden geladen …</p>';
  if (F.error) return upload + `<section class="card"><p class="error">${esc(F.error)}</p><button class="full" data-action="foto-reload">Nochmal versuchen</button></section>`;

  const dates = fotoDates();
  const pos = ui.fotoPos || 'vorne';
  const name = (d, p) => (F.files.includes(`${d}-${p}.jpg`) ? `${d}-${p}.jpg` : null);
  const first = dates.find((d) => name(d, pos));
  const last = [...dates].reverse().find((d) => name(d, pos));

  const compare = dates.length ? `<section class="card">
    <h2>Vergleich</h2>
    <div class="seg" style="margin-top:6px">${FOTO_POS.map(([k, l]) => `<button data-action="foto-pos" data-pos="${k}" class="${pos === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${first && last && first !== last ? `<div class="pair">
        <figure>${fotoImg(name(first, pos))}<figcaption>Start · ${shortDate(first)}</figcaption></figure>
        <figure>${fotoImg(name(last, pos))}<figcaption>Aktuell · ${shortDate(last)}</figcaption></figure>
      </div>` : `<div class="pair one"><figure>${fotoImg(last && name(last, pos))}<figcaption>${last ? shortDate(last) : ''}</figcaption></figure></div>
      <p class="label">Der Vergleich erscheint, sobald es Fotos von zwei verschiedenen Tagen gibt.</p>`}
  </section>` : '';

  const history = dates.length ? `<section class="card">
    <h2>Alle Fotos</h2>
    ${[...dates].reverse().map((d) => `<details class="foto-day">
      <summary>${WEEKDAY_SHORT[parseDate(d).getDay()]}, ${longDate(d)}</summary>
      <div class="trio">${FOTO_POS.map(([k]) => fotoImg(name(d, k), 'small')).join('')}</div>
    </details>`).join('')}
  </section>` : '';

  return upload + bewertungCard() + compare + history;
}

// Bewertung: FFMI-Score (berechnet), Umfang-Fortschritt (gemessen), Claudes Einschätzung (aus Fotos)
function bewertungCard() {
  const f = ffmiInfo();
  const ms = S.masse;
  const prog = UMFAENGE.map(([k, label]) => {
    const withVal = ms.filter((m) => m[k] != null);
    if (!withVal.length) return null;
    const a = withVal[0], b = withVal[withVal.length - 1];
    return { label, now: b[k], diff: withVal.length > 1 ? b[k] - a[k] : null, since: a.date };
  }).filter(Boolean);
  const B = S.bewertung && S.bewertung.bewertungen && S.bewertung.bewertungen[S.bewertung.bewertungen.length - 1];

  const ffmi = f ? `
    <p class="label">Muskelmasse-Score (FFMI) · Messung ${longDate(f.date)}</p>
    <div class="row" style="align-items:baseline;gap:10px"><span class="big">${f.score}/100</span><span class="small muted">FFMI ${fmt(f.norm, 1)} (Bereich ${fmt(f.lo, 1)}–${fmt(f.hi, 1)})</span></div>
    <p class="label">Normalisierter FFMI ÷ 25 × 100. 25 gilt als natürliche Obergrenze ohne Doping (Kouri et al. 1995). Der Bereich kommt von der Unsicherheit beim Körperfett.</p>`
    : '<p class="label">Muskelmasse-Score (FFMI)</p><p class="muted small">Erscheint nach der ersten Messung unter „Maße“ (Größe, Hals, Bauch).</p>';

  const umf = prog.length ? `<h3 class="abt">Umfänge</h3><ul class="list umf-list">${prog.map((p) => `
      <li><span>${p.label}</span><span>${fmtKg(p.now)} cm</span>
      <span class="${p.diff == null ? 'muted' : p.diff > 0 ? 'down' : 'up'}">${p.diff == null ? 'Startwert' : `${p.diff > 0 ? '+' : ''}${fmt(p.diff, 1)} cm`}</span></li>`).join('')}</ul>`
    : '<h3 class="abt">Umfänge</h3><p class="muted small">Noch keine Umfänge gemessen (unter „Maße“, einmal im Monat).</p>';

  const claude = B ? `<h3 class="abt">Claudes Einschätzung · ${longDate(B.datum)}</h3>
    <p class="label">Aus deinen Fotos vom ${longDate(B.fotosVom)}. Einschätzung, keine Messung.</p>
    <ul class="list">${(B.muskeln || []).map((m) => `<li class="col"><div class="row between"><b>${esc(m.name)}</b><span class="pill">${esc(m.note)}/10</span></div><span class="small muted">${esc(m.text)}</span></li>`).join('')}</ul>
    ${B.fazit ? `<p class="small" style="margin-top:8px">${esc(B.fazit)}</p>` : ''}`
    : '<h3 class="abt">Claudes Einschätzung</h3><p class="muted small">Kommt bei der nächsten „Wochenplanung“, sobald Fotos da sind.</p>';

  return `<section class="card"><h2>Bewertung</h2>${ffmi}${umf}${claude}</section>`;
}

async function loadFotos() {
  try {
    S.fotos = { loaded: true, files: await fotoList(), error: null };
  } catch (e) {
    if (e.kind === 'auth') return logout(e.message);
    S.fotos = { loaded: true, files: [], error: e.message };
  }
  if (ui.tab === 'fotos') { render({ keep: true }); hydrateFotos(); }
}

// Fotos erst laden, wenn sie sichtbar sind (nicht in zugeklappten Tagen)
// Pro Foto nur eine Anfrage, auch wenn es mehrfach gleichzeitig angezeigt wird
const fotoCache = new Map(); // Name → Promise mit Bild-URL
function fotoUrl(n) {
  if (!fotoCache.has(n)) {
    fotoCache.set(n, fotoBlob(n).then((b) => URL.createObjectURL(b)).catch((e) => { fotoCache.delete(n); throw e; }));
  }
  return fotoCache.get(n);
}
async function hydrateFotos() {
  for (const img of document.querySelectorAll('img[data-foto]:not([src])')) {
    if (img.closest('details:not([open])')) continue;
    try {
      img.src = await fotoUrl(img.dataset.foto);
    } catch (e) {
      img.replaceWith(Object.assign(document.createElement('div'), { className: 'foto empty', textContent: 'Fehler beim Laden' }));
    }
  }
}

async function uploadFoto(pos, file) {
  if (!file) return;
  const name = `${today()}-${pos}.jpg`;
  toast('Foto wird verkleinert und hochgeladen …');
  try {
    const b64 = await shrinkImage(file);
    await fotoUpload(name, b64);
    fotoCache.delete(name);
    if (!S.fotos.files.includes(name)) S.fotos.files.push(name);
    S.fotos.files.sort();
    toast('Foto gespeichert');
    render({ keep: true });
    hydrateFotos();
  } catch (e) {
    if (e.kind === 'auth') return logout(e.message);
    toast(e.message, true);
  }
}

/* Sperrbildschirm */
function renderLock(message = '') {
  $('#app').innerHTML = `
    <div class="lock">
      <img class="logo" src="icons/icon-192.png" alt="">
      <h1>Fitness</h1>
      <p class="sub muted">Privat. Bitte mit deinem Schlüssel anmelden.</p>
      <section class="card">
        <label class="field"><span>GitHub-Benutzername</span><input id="l-owner" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(cfg.owner)}"></label>
        <label class="field"><span>Daten-Repository</span><input id="l-repo" autocapitalize="off" spellcheck="false" value="${esc(cfg.repo)}"></label>
        <label class="field"><span>Schlüssel (Token)</span><input id="l-token" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false"></label>
        ${message ? `<p class="error">${esc(message)}</p>` : ''}
        <button class="primary full" data-action="login">Anmelden</button>
      </section>
    </div>`;
}

function renderError(message) {
  $('#app').innerHTML = `
    <section class="card" style="margin-top:20vh">
      <h2>Das hat nicht geklappt</h2>
      <p class="error">${esc(message)}</p>
      <button class="full" data-action="reload">Nochmal versuchen</button>
      ${LOCAL ? '' : '<button class="full ghost" data-action="logout">Abmelden</button>'}
    </section>`;
}

/* ---------- Aktionen ---------- */
async function busy(btn, fn) {
  if (ui.busy) return;
  ui.busy = true;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Speichert …'; }
  try {
    await fn();
  } catch (e) {
    if (e.kind === 'auth') { logout(e.message); return; }
    toast(e.message || 'Unbekannter Fehler.', true);
  } finally {
    ui.busy = false;
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = label; }
  }
}

function weightFile(text, weights) {
  let t = text || TEMPLATES.gewicht;
  t = writeTable(t, HEAD.eintraege, COLS.gewicht, weights.map((w) => [w.date, fmt(w.kg, 1), w.note]));
  const weeks = weekStats(weights);
  t = writeTable(t, HEAD.wochen, COLS.wochen, weeks.map((w, i) => [
    weekLabel(w.monday), fmt(w.avg, 1), String(w.n), i ? signed(w.avg - weeks[i - 1].avg) : 'Start',
  ]));
  return t;
}

async function storeWeight(btn, date, kg) {
  if (!validDate(date)) return toast('Bitte ein gültiges Datum wählen (nicht in der Zukunft).', true);
  if (kg == null || kg < 30 || kg > 250) return toast('Bitte ein Gewicht in kg eingeben, z. B. 74,5.', true);
  await busy(btn, async () => {
    const text = await updateFile(FILES.gewicht, (t) => {
      const ws = parseWeights(t).filter((w) => w.date !== date);
      ws.push({ date, kg, note: '' });
      ws.sort(byDate);
      return weightFile(t, ws);
    }, `Gewicht ${date}: ${fmt(kg, 1)} kg`);
    S.weights = parseWeights(text);
    Object.assign(ui, { wWeek: monday(date), wSel: null, wEdit: null, wDel: null, wAdd: false });
    toast(`${fmt(kg, 1)} kg gespeichert`);
    render({ keep: true });
  });
}

function saveWeight(btn) { return storeWeight(btn, $('#w-date').value, num($('#w-kg').value)); }

async function deleteWeight(btn, date) {
  await busy(btn, async () => {
    const text = await updateFile(FILES.gewicht,
      (t) => weightFile(t, parseWeights(t).filter((w) => w.date !== date)),
      `Gewicht ${date} gelöscht`);
    S.weights = parseWeights(text);
    Object.assign(ui, { wSel: null, wEdit: null, wDel: null });
    toast('Wert gelöscht');
    render({ keep: true });
  });
}

async function saveMasse(btn) {
  const date = $('#m-date').value;
  const groesse = num($('#m-groesse').value);
  const hals = num($('#m-hals').value);
  const bauch = num($('#m-bauch').value);
  const note = $('#m-note').value.trim();
  if (!validDate(date)) return toast('Bitte ein gültiges Datum wählen (nicht in der Zukunft).', true);
  if (!groesse || groesse < 120 || groesse > 230) return toast('Bitte die Größe in cm eingeben.', true);
  if (!hals || hals < 20 || hals > 70) return toast('Bitte den Halsumfang in cm eingeben.', true);
  if (!bauch || bauch < 50 || bauch > 200) return toast('Bitte den Bauchumfang in cm eingeben.', true);
  const kfa = navy(groesse, hals, bauch);
  if (kfa == null) return toast('Mit diesen Werten lässt sich nichts berechnen. Bauch muss größer als Hals sein.', true);
  const umf = {};
  for (const [k, label] of UMFAENGE) {
    const el = $(`#m-${k}`);
    const v = el && el.value.trim() !== '' ? num(el.value) : null;
    if (el && el.value.trim() !== '' && (v == null || v < 15 || v > 150)) return toast(`${label}: bitte einen Umfang in cm eingeben.`, true);
    umf[k] = v;
  }
  await busy(btn, async () => {
    const text = await updateFile(FILES.masse, (t) => {
      const ms = parseMasse(t).filter((m) => m.date !== date);
      ms.push({ date, groesse, hals, bauch, ...umf, kfa, note });
      ms.sort(byDate);
      return writeTable(t || TEMPLATES.masse, HEAD.eintraege, COLS.masse,
        ms.map((m) => [m.date, fmtKg(m.groesse), fmtKg(m.hals), fmtKg(m.bauch),
          ...UMFAENGE.map(([k]) => fmtKg(m[k])), m.kfa != null ? fmt(m.kfa, 1) : '', m.note]));
    }, `Maße ${date}`);
    S.masse = parseMasse(text);
    toast(`Gespeichert: ${fmt(kfa, 1)} % Körperfett`);
    render();
  });
}

async function saveTraining(btn) {
  const u = ui.unit;
  const { E, hasOrt, exs } = unitExercises(u);
  const date = $('#t-date').value;
  if (!validDate(date)) return toast('Bitte ein gültiges Datum wählen (nicht in der Zukunft).', true);
  const rows = [];
  for (const ex of exs) {
    const s = [];
    for (let i = 0; i < MAX_SETS; i++) {
      const rIn = document.querySelector(`input[data-r="${CSS.escape(ex.id)}"][data-i="${i}"]`);
      const kIn = document.querySelector(`input[data-k="${CSS.escape(ex.id)}"][data-i="${i}"]`);
      const r = rIn ? num(rIn.value) : null;
      const kg = kIn ? num(kIn.value) : null;
      if (rIn && rIn.value.trim() !== '' && (r == null || r < 0 || r > 200 || !Number.isInteger(r))) {
        rIn.focus();
        return toast(`${ex.name}, Satz ${i + 1}: bitte eine ganze Zahl eingeben.`, true);
      }
      if (kIn && kIn.value.trim() !== '' && (kg == null || kg < 0 || kg > 300)) {
        kIn.focus();
        return toast(`${ex.name}, Satz ${i + 1}: Gewicht prüfen.`, true);
      }
      s.push({ r, kg: r == null ? null : (ex.last === 'koerper' ? null : (kg ?? 0)) });
    }
    if (s.some((x) => x.r != null)) rows.push({ ex, s });
  }
  if (!rows.length) return toast('Bitte mindestens einen Satz eintragen.', true);
  const feel = $('#t-feel').value;
  const note = $('#t-note').value.trim();
  const ort = hasOrt ? (ui.ort === 'park' ? 'Park' : 'zu Hause') : E.ort;

  await busy(btn, async () => {
    const text = await updateFile(FILES.log, (t) => {
      t = t || TEMPLATES.log;
      const cur = parseLog(t);
      const ses = cur.sessions.filter((x) => !(x.date === date && x.unit === u));
      ses.push({ date, unit: u, ort, feel, note });
      ses.sort(byDate);
      const sets = cur.sets.filter((x) => !(x.date === date && x.unit === u));
      rows.forEach((r) => sets.push({ date, unit: u, name: r.ex.name, id: r.ex.id, s: r.s }));
      sets.sort(byDate);
      t = writeTable(t, HEAD.einheiten, COLS.einheiten, ses.map((x) => [x.date, x.unit, x.ort, x.feel, x.note]));
      t = writeTable(t, HEAD.saetze, COLS.saetze, sets.map((x) => [
        x.date, x.unit, x.name,
        ...x.s.flatMap((y) => [y.r != null ? String(y.r) : '', y.r != null && y.kg != null ? fmtKg(y.kg) : '']),
        x.id,
      ]));
      return t;
    }, `Training ${u} am ${date}`);
    const log = parseLog(text);
    S.sessions = log.sessions;
    S.sets = log.sets;
    ui.unit = null;
    ui.tDate = null;
    ui.tab = 'start';
    toast(`${E.name} gespeichert. Stark!`);
    render();
  });
}

function logout(message = '') {
  store.del('fit.token');
  cfg.token = '';
  renderLock(message);
}

async function login(btn) {
  const owner = $('#l-owner').value.trim();
  const repo = $('#l-repo').value.trim();
  const token = $('#l-token').value.trim();
  if (!owner || !repo || !token) return renderLock('Bitte alle drei Felder ausfüllen.');
  Object.assign(cfg, { owner, repo, token });
  btn.disabled = true;
  btn.textContent = 'Prüfe …';
  try {
    const r = await request(repoUrl(), { headers: headers() });
    if (r.status === 404 || r.status === 403) throw new ApiError('auth', 'Repository nicht gefunden oder der Schlüssel hat keinen Zugriff darauf.');
    if (!r.ok) throw new ApiError('http', `GitHub antwortet mit Fehler ${r.status}.`);
    store.set('fit.owner', owner);
    store.set('fit.repo', repo);
    store.set('fit.token', token);
    await boot();
  } catch (e) {
    cfg.token = '';
    renderLock(e.message);
  }
}

async function boot() {
  if (!LOCAL && !cfg.token) return renderLock();
  try {
    await loadAll();
    render();
  } catch (e) {
    if (e.kind === 'auth') return logout(e.message);
    renderError(e.message || 'Unbekannter Fehler.');
  }
}

/* ---------- Ereignisse ---------- */
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-tab], [data-action]');
  if (!el) return;
  if (el.dataset.tab) {
    ui.tab = el.dataset.tab;
    render();
    return;
  }
  switch (el.dataset.action) {
    case 'save-weight': saveWeight(el); break;
    case 'cal-toggle': ui.calOpen = !ui.calOpen; render({ keep: true }); break;
    case 'foto-pick': document.querySelector(`input[type="file"][data-pos="${el.dataset.pos}"]`).click(); break;
    case 'foto-pos': ui.fotoPos = el.dataset.pos; render({ keep: true }); break;
    case 'foto-reload': S.fotos = { loaded: false, files: [], error: null }; render(); break;
    case 'shop-toggle': ui.shopOpen = !ui.shopOpen; render({ keep: true }); break;
    case 'wadd': ui.wAdd = true; render({ keep: true }); $('#w-kg').focus(); break;
    case 'wadd-cancel': ui.wAdd = false; render({ keep: true }); break;
    case 'pick': {
      const a = S.essen.sel.auswahl;
      a[el.dataset.block] = a[el.dataset.block] === el.dataset.dish ? undefined : el.dataset.dish;
      if (!a[el.dataset.block]) delete a[el.dataset.block];
      queueSelSave();
      render({ keep: true });
      break;
    }
    case 'strike': {
      const g = S.essen.sel.gestrichen;
      const i = g.indexOf(el.dataset.name);
      if (i >= 0) g.splice(i, 1); else g.push(el.dataset.name);
      queueSelSave();
      render({ keep: true });
      break;
    }
    case 'eprev': switchEssenWeek(-1); break;
    case 'enext': switchEssenWeek(1); break;
    case 'wprev': shiftWeek(-1); break;
    case 'wnext': shiftWeek(1); break;
    case 'wsel':
      // erneutes Antippen des gewählten Tags springt zurück zum Standard (heute bzw. letzter Tag)
      Object.assign(ui, { wSel: ui.wSel === el.dataset.date ? null : el.dataset.date, wEdit: null, wDel: null });
      render({ keep: true });
      break;
    case 'wedit': Object.assign(ui, { wSel: el.dataset.date, wEdit: el.dataset.date, wDel: null }); render({ keep: true }); $('#we-kg').focus(); break;
    case 'wedit-cancel': case 'wdel-no': Object.assign(ui, { wEdit: null, wDel: null }); render({ keep: true }); break;
    case 'wedit-save': storeWeight(el, el.dataset.date, num($('#we-kg').value)); break;
    case 'wdel': Object.assign(ui, { wSel: el.dataset.date, wDel: el.dataset.date, wEdit: null }); render({ keep: true }); break;
    case 'wdel-yes': deleteWeight(el, el.dataset.date); break;
    case 'save-masse': saveMasse(el); break;
    case 'save-training': saveTraining(el); break;
    case 'go-training': ui.unit = el.dataset.unit; ui.tDate = null; ui.tab = 'training'; render(); break;
    case 'unit': ui.unit = el.dataset.unit; render(); break;
    case 'ort': ui.ort = el.dataset.ort; store.set('fit.ort', ui.ort); render(); break;
    case 'login': login(el); break;
    case 'logout': logout(); break;
    case 'reload': $('#app').innerHTML = '<p class="loading">Lädt …</p>'; boot(); break;
  }
});

document.addEventListener('input', (ev) => {
  if (['m-groesse', 'm-hals', 'm-bauch'].includes(ev.target.id)) updateNavyPreview();
});

// Fotos in einem Tag erst beim Aufklappen laden („toggle“ blubbert nicht, daher Capture)
document.addEventListener('toggle', (ev) => { if (ev.target.matches && ev.target.matches('details.foto-day') && ev.target.open) hydrateFotos(); }, true);

document.addEventListener('change', (ev) => {
  if (ev.target.matches('input[type="file"][data-pos]')) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ''; // gleiches Foto später erneut wählbar
    uploadFoto(ev.target.dataset.pos, file);
    return;
  }
  // Datum gewechselt: neu anzeigen, damit „Letztes Mal“ und gespeicherte Werte zum Datum passen
  if (ev.target.id === 't-date' && validDate(ev.target.value)) { ui.tDate = ev.target.value; render(); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'w-kg') saveWeight($('[data-action="save-weight"]'));
  if (ev.key === 'Enter' && ev.target.id === 'we-kg') $('[data-action="wedit-save"]').click();
  if (ev.key === 'Enter' && ev.target.id === 'l-token') login($('[data-action="login"]'));
});

// Wenn die App in den Hintergrund geht: offene Essens-Auswahl sofort speichern
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSel(); });

// Wischen auf der Gewichtskarte: nach rechts = Vorwoche, nach links = nächste Woche
let touchStart = null;
document.addEventListener('touchstart', (ev) => {
  touchStart = ev.target.closest('#wcard') && !ev.target.closest('input') ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (ev) => {
  if (!touchStart) return;
  const dx = ev.changedTouches[0].clientX - touchStart.x;
  const dy = ev.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 40) shiftWeek(dx > 0 ? -1 : 1);
}, { passive: true });

if ('serviceWorker' in navigator && !LOCAL) {
  // Neue App-Version gefunden: einmal automatisch neu laden, damit sie sofort gilt
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; flushSel().finally(() => location.reload()); }
  });
  navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => { /* App funktioniert auch ohne */ });
}

boot();
