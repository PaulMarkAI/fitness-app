'use strict';

/* =========================================================
   Fitness-App
   Daten liegen als Markdown/JSON in einem privaten GitHub-Repository.
   Lokal (localhost) spricht die App mit werkzeuge/dev_server.py,
   der die GitHub-Schnittstelle nachbildet.
   ========================================================= */

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API = LOCAL ? '/api' : 'https://api.github.com';

const FILES = { gewicht: 'gewicht.md', masse: 'masse.md', log: 'trainingslog.md', plan: 'trainingsplan.json' };
const HEAD = { eintraege: '## Einträge', wochen: '## Wochendurchschnitte', einheiten: '## Einheiten', saetze: '## Sätze' };
const COLS = {
  gewicht: ['Datum', 'Gewicht (kg)', 'Notiz'],
  wochen: ['Woche', 'Durchschnitt (kg)', 'Tage gemessen', 'Veränderung (kg)'],
  masse: ['Datum', 'Größe (cm)', 'Hals (cm)', 'Bauch (cm)', 'KFA Navy (%)', 'Notiz'],
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
  return { lines, h, start, end, rows: lines.slice(start + 2, end).map(splitRow) };
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

function parseMasse(text) {
  return readTable(text, HEAD.eintraege)
    .filter((r) => DATE_RE.test(r[0]))
    .map((r) => {
      const m = { date: r[0], groesse: num(r[1]), hals: num(r[2]), bauch: num(r[3]), note: r[5] || '' };
      m.kfa = num(r[4]) ?? navy(m.groesse, m.hals, m.bauch);
      return m;
    })
    .sort(byDate);
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
function repoUrl() { return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`; }
function fileUrl(path) { return `${repoUrl()}/contents/${path.split('/').map(encodeURIComponent).join('/')}`; }

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

async function loadAll() {
  const [g, m, l, p] = await Promise.all([FILES.gewicht, FILES.masse, FILES.log, FILES.plan].map(getFile));
  if (!p.text) throw new ApiError('data', '„trainingsplan.json“ fehlt im Daten-Repository.');
  let plan;
  try { plan = JSON.parse(p.text); } catch (e) { throw new ApiError('data', '„trainingsplan.json“ ist fehlerhaft.'); }
  const log = parseLog(l.text);
  S = { plan, weights: parseWeights(g.text), masse: parseMasse(m.text), sessions: log.sessions, sets: log.sets };
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
  masse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8" width="20" height="8" rx="2"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
};
const TABS = [['start', 'Übersicht'], ['training', 'Training'], ['masse', 'Maße'], ['plan', 'Plan']];

function render() {
  const views = { start: viewStart, training: viewTraining, masse: viewMasse, plan: viewPlan };
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
  window.scrollTo(0, 0);
}

/* Übersicht */
function viewStart() {
  const ws = S.weights;
  const weeks = weekStats(ws);
  const cur = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  const t = today();
  const todayEntry = ws.find((w) => w.date === t);
  const m = S.masse[S.masse.length - 1];
  const nu = nextUnit();
  const lastSession = S.sessions[S.sessions.length - 1];

  const weightCard = cur ? `
    <p class="label">Gewicht · Wochenschnitt ${esc(weekLabel(cur.monday))}</p>
    <div class="row" style="align-items:baseline;gap:10px">
      <span class="big">${fmt(cur.avg, 1)} kg</span>
      ${prev ? `<span class="small ${cur.avg - prev.avg > 0 ? 'up' : 'down'}">${signed(cur.avg - prev.avg)} kg zur Vorwoche</span>` : ''}
    </div>
    <p class="label">${cur.n} ${cur.n === 1 ? 'Tag' : 'Tage'} gemessen</p>
    ${weightChart(ws)}` : '<p class="label">Gewicht</p><p class="muted">Noch keine Werte. Trag unten dein erstes Gewicht ein.</p>';

  const kfaCard = m && m.kfa != null ? `
    <p class="label">Körperfett · Navy-Methode · ${longDate(m.date)}</p>
    <div class="big">${fmt(Math.max(m.kfa - NAVY_UNSICHERHEIT, 0), 0)}–${fmt(m.kfa + NAVY_UNSICHERHEIT, 0)} %</div>
    <p class="label">Rechenwert ${fmt(m.kfa, 1)} %, Unsicherheit ca. ±${NAVY_UNSICHERHEIT} Prozentpunkte</p>` : `
    <p class="label">Körperfett · Navy-Methode</p>
    <p class="muted" style="margin:4px 0 0">Noch keine Messung.</p>
    <button class="full" data-tab="masse">Maße eintragen</button>`;

  return `
    <section class="card">${weightCard}</section>
    <section class="card">
      <h2>Gewicht eintragen</h2>
      ${todayEntry ? `<p class="label">Heute schon eingetragen: ${fmt(todayEntry.kg, 1)} kg. Neuer Wert überschreibt ihn.</p>` : '<p class="label">Morgens, nach der Toilette, vor dem Essen.</p>'}
      <div class="row" style="margin-top:8px">
        <input id="w-date" type="date" value="${t}" max="${t}" class="grow" aria-label="Datum">
        <div class="unit-in grow"><input id="w-kg" inputmode="decimal" placeholder="${ws.length ? fmt(ws[ws.length - 1].kg, 1) : '74,5'}" aria-label="Gewicht in kg"><em>kg</em></div>
      </div>
      <button class="primary full" data-action="save-weight">Speichern</button>
    </section>
    <section class="card">${kfaCard}</section>
    <section class="card">
      <div class="row between">
        <div>
          <p class="label">Nächste Einheit</p>
          <div style="font-size:20px;font-weight:600">${esc(S.plan.einheiten[nu].name)}</div>
          <p class="label">${lastSession ? `Zuletzt: ${esc(lastSession.unit)} am ${longDate(lastSession.date)}` : 'Noch keine Einheit eingetragen'}</p>
        </div>
        <button class="primary" data-action="go-training" data-unit="${esc(nu)}">Starten</button>
      </div>
    </section>
    ${ws.length ? `<section class="card"><h2>Letzte Werte</h2><ul class="list">
      ${ws.slice(-7).reverse().map((w) => `<li><span>${longDate(w.date)}</span><span>${fmt(w.kg, 1)} kg</span></li>`).join('')}
    </ul></section>` : ''}`;
}

function weightChart(all) {
  const pts = all.slice(-56);
  if (pts.length < 2) return '';
  const W = 320, H = 150, pl = 36, pr = 8, pt = 10, pb = 22;
  const t0 = parseDate(pts[0].date).getTime();
  const t1 = parseDate(pts[pts.length - 1].date).getTime();
  const span = Math.max(t1 - t0, 6 * 86400000);
  let lo = Math.min(...pts.map((p) => p.kg));
  let hi = Math.max(...pts.map((p) => p.kg));
  const padKg = Math.max(0.3, (hi - lo) * 0.15);
  lo -= padKg; hi += padKg;
  const x = (t) => pl + ((t - t0) / span) * (W - pl - pr);
  const y = (k) => pt + ((hi - k) / (hi - lo)) * (H - pt - pb);
  const dots = pts.map((p) => `<circle cx="${x(parseDate(p.date).getTime()).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="3" fill="#5b6675"/>`).join('');
  const weeks = weekStats(pts).map((w) => {
    const t = Math.min(Math.max(parseDate(addDays(w.monday, 3)).getTime(), t0), t0 + span);
    return `${x(t).toFixed(1)},${y(w.avg).toFixed(1)}`;
  });
  const line = weeks.length > 1
    ? `<polyline points="${weeks.join(' ')}" fill="none" stroke="#2dd4a7" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
    : `<circle cx="${weeks[0].split(',')[0]}" cy="${weeks[0].split(',')[1]}" r="4.5" fill="#2dd4a7"/>`;
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">
      <line x1="${pl}" y1="${pt}" x2="${W - pr}" y2="${pt}" stroke="#2a313b"/>
      <line x1="${pl}" y1="${H - pb}" x2="${W - pr}" y2="${H - pb}" stroke="#2a313b"/>
      <text x="${pl - 6}" y="${pt + 4}" text-anchor="end">${fmt(hi, 1)}</text>
      <text x="${pl - 6}" y="${H - pb + 4}" text-anchor="end">${fmt(lo, 1)}</text>
      <text x="${pl}" y="${H - 6}">${shortDate(pts[0].date)}</text>
      <text x="${W - pr}" y="${H - 6}" text-anchor="end">${shortDate(pts[pts.length - 1].date)}</text>
      ${dots}${line}
    </svg>
    <div class="legend"><span><i style="background:#5b6675"></i>Tageswert</span><span><i style="background:#2dd4a7"></i>Wochenschnitt</span></div>`;
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

/* Maße */
function viewMasse() {
  const t = today();
  const last = S.masse[S.masse.length - 1];
  const hist = S.masse.slice().reverse();
  return `
    <section class="card">
      <h2>Maße eintragen</h2>
      <p class="label">Einmal im Monat, morgens. Bauch entspannt auf Höhe des Bauchnabels, Hals direkt unter dem Kehlkopf.</p>
      <label class="field"><span>Datum</span><input id="m-date" type="date" value="${t}" max="${t}"></label>
      <label class="field"><span>Größe</span><div class="unit-in"><input id="m-groesse" inputmode="decimal" value="${last && last.groesse ? fmtKg(last.groesse) : ''}" placeholder="z. B. 175"><em>cm</em></div></label>
      <label class="field"><span>Hals</span><div class="unit-in"><input id="m-hals" inputmode="decimal" placeholder="${last && last.hals ? fmtKg(last.hals) : 'z. B. 37,5'}"><em>cm</em></div></label>
      <label class="field"><span>Bauch</span><div class="unit-in"><input id="m-bauch" inputmode="decimal" placeholder="${last && last.bauch ? fmtKg(last.bauch) : 'z. B. 82'}"><em>cm</em></div></label>
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

/* Plan */
function viewPlan() {
  const p = S.plan;
  return `
    <section class="card">
      <p class="label">Version ${esc(p.version)} · Stand ${esc(p.stand)}</p>
      <p class="small" style="margin:6px 0 0">Reihenfolge ${p.reihenfolge.map(esc).join(' → ')}, immer im Wechsel, egal an welchem Wochentag. 1–2 Wiederholungen in Reserve. Erreichst du in allen Sätzen das obere Ende, wird gesteigert.</p>
      <p class="label" style="margin-top:6px">Änderungen am Plan macht Claude. Die App zeigt ihn nur an.</p>
    </section>
    ${p.reihenfolge.map((k) => {
      const E = p.einheiten[k];
      return `<section class="card">
        <h2>${esc(E.name)} <span class="muted small">· ${esc(E.ort)}</span></h2>
        ${E.uebungen.map((ex) => `
          <details>
            <summary><span style="color:var(--text)">${esc(ex.name)}</span>${ex.nur ? ` <span class="muted">(${ex.nur === 'park' ? 'Park' : 'zu Hause'})</span>` : ''} · ${ex.saetze} × ${ex.wdh[0]}–${ex.wdh[1]}${ex.start ? ` · Start ${fmtKg(ex.start)} ${LAST_LABEL[ex.last]}` : ''}</summary>
            <p>${esc(ex.technik)}</p>
            <p class="muted">Steigerung: ${esc(ex.steigerung)}</p>
          </details>`).join('')}
      </section>`;
    }).join('')}`;
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

async function saveWeight(btn) {
  const date = $('#w-date').value;
  const kg = num($('#w-kg').value);
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
    toast(`${fmt(kg, 1)} kg gespeichert`);
    render();
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
  await busy(btn, async () => {
    const text = await updateFile(FILES.masse, (t) => {
      const ms = parseMasse(t).filter((m) => m.date !== date);
      ms.push({ date, groesse, hals, bauch, kfa, note });
      ms.sort(byDate);
      return writeTable(t || TEMPLATES.masse, HEAD.eintraege, COLS.masse,
        ms.map((m) => [m.date, fmtKg(m.groesse), fmtKg(m.hals), fmtKg(m.bauch), m.kfa != null ? fmt(m.kfa, 1) : '', m.note]));
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

document.addEventListener('change', (ev) => {
  // Datum gewechselt: neu anzeigen, damit „Letztes Mal“ und gespeicherte Werte zum Datum passen
  if (ev.target.id === 't-date' && validDate(ev.target.value)) { ui.tDate = ev.target.value; render(); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'w-kg') saveWeight($('[data-action="save-weight"]'));
  if (ev.key === 'Enter' && ev.target.id === 'l-token') login($('[data-action="login"]'));
});

if ('serviceWorker' in navigator && !LOCAL) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* App funktioniert auch ohne */ });
}

boot();
