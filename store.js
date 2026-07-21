'use strict';

// Armazenamento a prova de crash, zero dependência nativa.
// - captures.jsonl : tráfego bruto da rede (fonte "rede")
// - events.jsonl   : eventos do jogo (capturas, shiny, raridade, prints) — fonte "tela"
// - latest.json    : último snapshot por conta (pro painel)
// - settings.json  : preferências de alerta
// - shots/         : prints .png

const fs = require('fs');
const path = require('path');

let DIR = null, RAW = null, EVENTS = null, LATEST = null, SETTINGS = null, SHOTS = null, CAUGHT = null, PROGRESS = null;

const DEFAULT_SETTINGS = {
  soundOn: true,
  alertRarity: 'Rara',   // dispara alerta em Rara ou acima
  ivAlertFrac: 0.9,      // ...ou IV >= 90% do máximo
  screenshotOnShiny: true,
  ballsAlert: 200,       // alerta quando o total de bolas úteis cai até aqui
  potionsAlert: 30,      // alerta quando o total de potions cai até aqui
  gameClean: true,       // declutter da UI do jogo (esconde chat/apaga barras que sobrepõem)
  sellProtect: true,     // bloqueia venda de poke shiny/lendário e itens protegidos (pheromone/picture/cards)
  netCapture: true,      // captura de rede (CDP); só anexa após o login
  activeSlots: [1],      // telas abertas (slots 1..4); lembrado entre execuções
  accountNames: {},      // { slot: "nome" } — apelidos das contas
};

function init(userData) {
  DIR = path.join(userData, 'poke-coletor-data');
  SHOTS = path.join(DIR, 'shots');
  fs.mkdirSync(SHOTS, { recursive: true });
  RAW = path.join(DIR, 'captures.jsonl');
  EVENTS = path.join(DIR, 'events.jsonl');
  LATEST = path.join(DIR, 'latest.json');
  SETTINGS = path.join(DIR, 'settings.json');
  CAUGHT = path.join(DIR, 'caught.json');
  PROGRESS = path.join(DIR, 'progress.json');
}

// cache durável por conta: analyzer/profissão/correio — pra o painel mostrar SEM re-abrir nada
function getProgress(account) { const p = _readJson(PROGRESS) || {}; return account ? (p[account] || {}) : p; }
function saveProgress(account, patch) {
  if (!PROGRESS || !patch) return;
  const p = _readJson(PROGRESS) || {};
  p[account] = Object.assign({}, p[account] || {}, patch);
  _writeJson(PROGRESS, p);
}

// pokédex: dex das espécies que a conta já teve/capturou (acumula pra sempre)
function addCaught(account, ids) {
  if (!CAUGHT || !ids || !ids.length) return;
  const c = _readJson(CAUGHT) || {};
  const set = new Set(c[account] || []);
  let ch = false;
  for (const id of ids) if (id != null && !set.has(id)) { set.add(id); ch = true; }
  if (ch) { c[account] = [...set]; _writeJson(CAUGHT, c); }
}
function getCaught(account) { const c = _readJson(CAUGHT) || {}; return c[account] || []; }

function _appendJsonl(file, rec) {
  if (!file) return;
  if (!rec.ts) rec.ts = Date.now();
  try { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch {}
}
function _readJsonl(file, limit) {
  if (!file || !fs.existsSync(file)) return [];
  let data; try { data = fs.readFileSync(file, 'utf8').trim(); } catch { return []; }
  if (!data) return [];
  const lines = data.split('\n');
  const slice = limit ? lines.slice(-limit) : lines;
  return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function _readJson(f) { if (!f || !fs.existsSync(f)) return null; try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function _writeJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch {} }

function appendRaw(rec) {
  // NUNCA gravar o token de login: a URL do WebSocket vem como ws12?token=<JWT>.
  if (rec && rec.url) rec.url = String(rec.url).split('?')[0];
  _appendJsonl(RAW, rec);
}
function appendEvent(ev) { if (!ev.ts) ev.ts = Date.now(); _appendJsonl(EVENTS, ev); return ev; }
function readEvents(limit) { return _readJsonl(EVENTS, limit || 200).reverse(); }

function setLatest(account, snap) {
  const cur = _readJson(LATEST) || {};
  cur[account] = Object.assign({}, snap, { ts: Date.now() });
  _writeJson(LATEST, cur);
}
function getLatest() { return _readJson(LATEST) || {}; }

function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, _readJson(SETTINGS) || {}); }
function setSettings(patch) { const s = Object.assign(getSettings(), patch || {}); _writeJson(SETTINGS, s); return s; }

function saveShot(account, pngBuffer) {
  const file = path.join(SHOTS, `${account}_${Date.now()}.png`);
  try { fs.writeFileSync(file, pngBuffer); return file; } catch { return null; }
}
function readShotDataURL(p) {
  try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch { return null; }
}

function summarize() {
  const latest = getLatest();
  const events = _readJsonl(EVENTS, 5000);
  const per = {};
  const ensure = (acc) => per[acc] || (per[acc] = { account: acc, latest: latest[acc] || null, captures: 0, shiny: 0, rare: 0 });
  for (const acc of Object.keys(latest)) ensure(acc);
  for (const e of events) {
    const a = ensure(e.account || '?');
    if (e.type === 'capture' || e.type === 'rare_capture' || e.type === 'shiny_capture') a.captures++;
    if (e.type === 'shiny_capture' || e.type === 'shiny_encounter') a.shiny++;
    if (e.type === 'rare_capture') a.rare++;
  }
  const shots = events.filter((e) => e.type === 'shot').slice(-24).reverse();
  return {
    accounts: Object.values(per).sort((a, b) => a.account.localeCompare(b.account)),
    totalEvents: events.length,
    recent: events.filter((e) => e.type !== 'shot').slice(-80).reverse(),
    shots,
  };
}

function exportResumo() {
  const s = summarize();
  const lines = [`# Poke Idle Launcher — ${new Date().toLocaleString()}`, ''];
  for (const a of s.accounts) {
    lines.push(`## ${a.account} — ${a.captures} capturas · ✨ shiny ${a.shiny} · raras ${a.rare}`);
    const L = a.latest || {};
    if (L.session) lines.push('Sessão: ' + JSON.stringify(L.session));
    if (L.drops && L.drops.length) lines.push('Drops: ' + L.drops.map((d) => `${d.item} ×${d.qty}`).join(', '));
    lines.push('');
  }
  lines.push('## Últimos eventos');
  s.recent.slice(0, 50).forEach((e) =>
    lines.push(`- [${e.account}] ${e.type} ${e.name || ''} ${e.rarity || ''} ${e.iv ? 'IV ' + e.iv + '/' + (e.ivMax || '?') : ''}`.trim()));
  const file = path.join(DIR, `resumo-${Date.now()}.md`);
  const content = lines.join('\n');
  try { fs.writeFileSync(file, content, 'utf8'); } catch {}
  return { path: file, content };
}

module.exports = {
  init, appendRaw, appendEvent, readEvents, setLatest, getLatest,
  getSettings, setSettings, saveShot, readShotDataURL, summarize, exportResumo,
  addCaught, getCaught, getProgress, saveProgress,
};
